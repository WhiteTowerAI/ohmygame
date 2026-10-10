import type { FastifyInstance } from "fastify";
import type {
  CreateMcpPluginRequest,
  PluginConfigurationValues,
} from "../shared/plugins.js";
import type { PluginCatalogService } from "./plugin-catalog.js";
import { LocalPluginError } from "./local-plugins.js";
import { PluginConfigurationError } from "./plugin-configuration.js";
import type { PluginCapabilities } from "./plugin-capabilities.js";

export function registerPluginCapabilityRoutes(
  app: FastifyInstance,
  {
    capabilities,
    plugins,
    invalidate,
  }: {
    capabilities: PluginCapabilities;
    plugins: PluginCatalogService;
    invalidate: () => void;
  },
) {
  app.post<{ Body: CreateMcpPluginRequest }>(
    "/plugins/mcp",
    async (request, reply) => {
      try {
        const plugin = await capabilities.create(request.body);
        invalidate();
        return reply.code(201).send(await capabilities.decorate(plugin));
      } catch (cause) {
        if (
          cause instanceof LocalPluginError ||
          cause instanceof PluginConfigurationError
        )
          return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
      }
    },
  );
  app.get<{ Params: { pluginId: string } }>(
    "/plugins/:pluginId/configuration",
    async (request, reply) => {
      const plugin = await plugins.read(request.params.pluginId);
      return plugin
        ? capabilities.configuration.view(plugin)
        : reply.code(404).send({ error: "Plugin not found" });
    },
  );
  app.put<{
    Params: { pluginId: string };
    Body: { values: PluginConfigurationValues };
  }>(
    "/plugins/:pluginId/configuration",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["values"],
          properties: {
            values: {
              type: "object",
              additionalProperties: {
                anyOf: [
                  { type: "string" },
                  { type: "boolean" },
                  { type: "null" },
                ],
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const plugin = await plugins.read(request.params.pluginId);
      if (!plugin) return reply.code(404).send({ error: "Plugin not found" });
      try {
        const config = await capabilities.configuration.update(
          plugin,
          request.body.values,
        );
        invalidate();
        return config;
      } catch (cause) {
        if (cause instanceof PluginConfigurationError)
          return reply.code(400).send({ error: cause.message });
        throw cause;
      }
    },
  );
  app.get<{ Params: { pluginId: string; serverId: string } }>(
    "/plugins/:pluginId/mcp/:serverId/definition",
    async (request, reply) => {
      const plugin = await plugins.read(request.params.pluginId);
      if (!plugin) return reply.code(404).send({ error: "Plugin not found" });
      try {
        return {
          definition: await capabilities.editableTemplate(
            plugin,
            request.params.serverId,
          ),
        };
      } catch (cause) {
        return reply.code(400).send({ error: String(cause) });
      }
    },
  );
  app.put<{
    Params: { pluginId: string; serverId: string };
    Body: { definition: import("../shared/plugins.js").McpServerDefinition };
  }>(
    "/plugins/:pluginId/mcp/:serverId/definition",
    {
      schema: {
        body: {
          type: "object",
          required: ["definition"],
          additionalProperties: false,
          properties: {
            definition: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) => {
      const plugin = await plugins.read(request.params.pluginId);
      if (!plugin) return reply.code(404).send({ error: "Plugin not found" });
      try {
        await capabilities.setDefinition(
          plugin,
          request.params.serverId,
          request.body.definition,
        );
        invalidate();
        return capabilities.decorate(plugin);
      } catch (cause) {
        return reply
          .code(400)
          .send({
            error: capabilities.configuration.redact(plugin, String(cause)),
          });
      }
    },
  );
  for (const action of ["test", "auth-start", "auth-complete"] as const) {
    app.post<{
      Params: { pluginId: string; serverId: string };
      Body: { input?: string };
    }>(
      `/plugins/:pluginId/mcp/:serverId/${action}`,
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: { input: { type: "string", maxLength: 16_000 } },
          },
        },
      },
      async (request, reply) => {
        const plugin = await plugins.read(request.params.pluginId);
        if (!plugin) return reply.code(404).send({ error: "Plugin not found" });
        try {
          const result = await capabilities.test(
            plugin,
            request.params.serverId,
            action,
            request.body?.input,
          );
          if (action === "auth-complete") invalidate();
          return result;
        } catch (cause) {
          return reply
            .code(cause instanceof LocalPluginError ? cause.statusCode : 400)
            .send({
              error: capabilities.configuration.redact(
                plugin,
                cause instanceof Error ? cause.message : String(cause),
              ),
            });
        }
      },
    );
  }
}
