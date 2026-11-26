import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import type { StoryLibraryMediaResult, StoryStatus } from "../shared/story-web.js";
import type { AgentManager } from "./agent.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";
import type { ProjectWrites } from "./project-writes.js";
import { copyLibraryAssets, isWebStory, libraryAssets, PRE_WEB_STORY } from "./story-web-project.js";
import { writeWorkspaceNotice } from "./workspace-notice.js";

/**
 * What the Story editor asks of an Interactive Story besides its codebase:
 * whether it plays as its own page, and taking in the Library media it still
 * uses. Copying runs with the workspace to itself and tells editors and the
 * Agent what changed, as Undo does.
 */
export function registerStoryWebRoutes(
  app: FastifyInstance,
  options: {
    projects: ProjectManager;
    agents: AgentManager;
    writes: ProjectWrites;
    library: AssetLibrary;
    events: RuntimeEventBus;
    busy: (id: string) => boolean;
  },
): void {
  const { projects, agents, writes, library, events } = options;

  const story = (projectId: string): ProjectState => {
    const project = projects.get(projectId);
    if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    if (project.type !== "interactive-story")
      throw Object.assign(new Error("This needs an Interactive Story project"), { statusCode: 409 });
    return project;
  };
  const assertIdle = (id: string) => {
    if (agents.isProjectBusy(id) || options.busy(id))
      throw Object.assign(new Error("Wait for agents, generation jobs and publishing to finish first."), { statusCode: 409 });
  };
  /** Editors reload and the Agent is told, as after Undo. */
  const announce = async (project: ProjectState, changed: string[], content: string) => {
    const version = writes.changed(project.id);
    try {
      await writeWorkspaceNotice(project, content, version);
    } finally {
      events.publish(project.id, "workspace.restored", { version, changed });
    }
  };
  const libraryFile = async (assetId: string) => {
    try {
      return (await library.content(assetId)).absolutePath;
    } catch {
      return undefined;
    }
  };
  const send = async <T>(reply: { code(status: number): { send(body: unknown): unknown } }, operation: () => Promise<T>) => {
    try {
      return await operation();
    } catch (cause) {
      const statusCode = (cause as { statusCode?: number }).statusCode ?? 409;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/interactive-story/status", async (request, reply) =>
    send(reply, async (): Promise<StoryStatus> => {
      const project = story(request.params.projectId);
      const web = await isWebStory(project.workspacePath);
      const library = web ? await libraryAssets(project.workspacePath) : [];
      return { web, ...(library.length ? { libraryAssets: library } : {}) };
    }));

  // A web story takes in the Library media it still uses, so it can be published.
  app.post<{ Params: { projectId: string } }>("/projects/:projectId/interactive-story/library-media", async (request, reply) =>
    send(reply, async (): Promise<StoryLibraryMediaResult> => {
      const project = story(request.params.projectId);
      assertIdle(project.id);
      if (!await isWebStory(project.workspacePath)) throw new Error(PRE_WEB_STORY);
      const copied = await writes.exclusive(project.id, () => copyLibraryAssets(project.workspacePath, libraryFile));
      const graph = JSON.parse(await readFile(path.join(project.workspacePath, "graph.json"), "utf8")) as { assets: Record<string, { source: { path?: string } }> };
      const changed = copied.copiedAssets.length
        ? ["graph.json", ...copied.copiedAssets.map((id) => graph.assets[id]?.source.path).filter((file): file is string => !!file)]
        : [];
      if (changed.length) await announce(project, changed, `Library media this story used were copied into the project under assets/library/, and graph.json now points at them: ${JSON.stringify(copied.copiedAssets)}.`);
      return { ...copied, changed };
    }));
}
