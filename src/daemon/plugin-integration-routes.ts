import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  PLUGIN_INTEGRATION_ACTIONS,
  type PluginIntegrationAction,
} from "../shared/plugin-integration.js";
import type { ProjectState } from "../shared/contracts.js";
import type { PluginDetail } from "../shared/plugins.js";
import type { PluginCatalogService } from "./plugin-catalog.js";
import type { ProjectManager } from "./projects.js";
import type { PluginIntegrationHost } from "./plugin-integration.js";
import { LocalPluginError } from "./local-plugins.js";

/** Recognition is filesystem-only. Import never executes every installed plugin. */
export async function matchesPluginProject(
  plugin: Pick<PluginDetail, "integration">,
  workspace: string,
): Promise<boolean> {
  if (!plugin.integration?.projectFiles?.length) return false;
  let root: string;
  try {
    root = await realpath(workspace);
  } catch (cause) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (cause as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw cause;
  }
  for (const file of plugin.integration.projectFiles) {
    try {
      const target = await realpath(path.resolve(root, file));
      const relative = path.relative(root, target);
      if (
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !(await stat(target)).isFile()
      )
        return false;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
  }
  return true;
}

export async function requireIntegrationPlugin(
  plugins: PluginCatalogService,
  pluginId: string,
  project?: ProjectState,
): Promise<PluginDetail> {
  const plugin = await plugins.read(pluginId);
  if (!plugin?.installed || !plugin.enabled || !plugin.integration)
    throw new LocalPluginError(
      "Enable the project's integration plugin in Settings > Plugins",
      409,
    );
  if (
    project &&
    plugin.projectTypes?.length &&
    !plugin.projectTypes.includes(project.type)
  )
    throw new LocalPluginError(
      "This plugin requires a different project type. Create or import a compatible project.",
      409,
    );
  if (project?.integration && project.integration.pluginId !== pluginId)
    throw new LocalPluginError(
      "This project uses another integration plugin",
      409,
    );
  return plugin;
}

export function registerPluginIntegrationRoutes(
  app: FastifyInstance,
  {
    plugins,
    projects,
    host,
    select,
  }: {
    plugins: PluginCatalogService;
    projects: ProjectManager;
    host: PluginIntegrationHost;
    select: (
      project: ProjectState,
      plugin: PluginDetail,
    ) => Promise<ProjectState>;
  },
) {
  // Select an integration for an existing compatible workspace. It never changes
  // the project type or the upstream binding.
  app.put<{ Params: { projectId: string }; Body: { pluginId: string } }>(
    "/projects/:projectId/integration",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["pluginId"],
          properties: {
            pluginId: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try {
        const plugin = await requireIntegrationPlugin(
          plugins,
          request.body.pluginId,
          project,
        );
        return await select(project, plugin);
      } catch (cause) {
        if (cause instanceof LocalPluginError)
          return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
      }
    },
  );
  const querystring = {
    type: "object",
    additionalProperties: false,
    properties: { projectId: { type: "string", minLength: 1, maxLength: 512 } },
  };
  for (const method of ["GET", "POST", "DELETE"] as const) {
    app.route<{
      Params: { pluginId: string };
      Querystring: { projectId?: string };
      Body: { action: PluginIntegrationAction; projectId?: string };
    }>({
      method,
      url: "/plugins/:pluginId/integration",
      schema: {
        querystring,
        ...(method === "POST"
          ? {
              body: {
                type: "object",
                additionalProperties: false,
                required: ["action"],
                properties: {
                  action: { type: "string", enum: PLUGIN_INTEGRATION_ACTIONS },
                  projectId: { type: "string", minLength: 1, maxLength: 512 },
                },
              },
            }
          : {}),
      },
      handler: async (request, reply) => {
        const project = request.query.projectId
          ? projects.get(request.query.projectId)
          : undefined;
        if (request.query.projectId && !project)
          return reply.code(404).send({ error: "Project not found" });
        try {
          const plugin = await requireIntegrationPlugin(
            plugins,
            request.params.pluginId,
            project,
          );
          if (project?.integration?.pluginId !== plugin.id && project)
            throw new LocalPluginError(
              "Select this plugin for the project first",
              409,
            );
          if (method === "DELETE") {
            host.cancel(plugin.id, project?.id);
            return { ok: true };
          }
          if (method === "GET")
            return (
              host.state(plugin.id, project?.id) ??
              host.start(plugin, "status", project)
            );
          return reply
            .code(202)
            .send(
              host.start(
                plugin,
                request.body.action,
                project,
                request.body.projectId,
              ),
            );
        } catch (cause) {
          if (cause instanceof LocalPluginError)
            return reply.code(cause.statusCode).send({ error: cause.message });
          throw cause;
        }
      },
    });
  }
}

export function projectPreviewTool(
  project: ProjectState,
  plugins: PluginCatalogService,
  host: PluginIntegrationHost,
) {
  return defineTool({
    name: "project_preview",
    label: "Project preview",
    description:
      "Control this project's external native preview. Runtime opens its own window; status alone does not verify gameplay.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("start"),
        Type.Literal("refresh"),
        Type.Literal("stop"),
        Type.Literal("logs"),
      ]),
    }),
    execute: async (_id, { action }, signal) => {
      const plugin = await requireIntegrationPlugin(
        plugins,
        project.integration!.pluginId,
        project,
      );
      const result = await host.execute(
        plugin,
        `preview-${action}`,
        project,
        signal,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
