import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import type { StoryLibraryMediaResult, StoryUpgradeStatus, StoryUpgradeResult } from "../shared/story-web.js";
import type { AgentManager } from "./agent.js";
import type { AssetLibrary } from "./asset-library.js";
import type { CheckpointStore } from "./checkpoints.js";
import type { ProjectManager } from "./projects.js";
import type { ProjectWrites } from "./project-writes.js";
import { copyLibraryAssets, isWebStory, libraryAssets, upgradeToWebStory } from "./story-web-project.js";
import { writeWorkspaceNotice } from "./workspace-notice.js";

/**
 * Upgrading an Interactive Story made before web stories, which played in a
 * sandbox OhMyGame no longer has. The Story editor upgrades such a story when
 * it opens it. The upgrade runs with the workspace to itself and tells
 * editors and the Agent what changed, as Undo does.
 */
export function registerStoryWebRoutes(
  app: FastifyInstance,
  options: {
    projects: ProjectManager;
    agents: AgentManager;
    writes: ProjectWrites;
    checkpoints: CheckpointStore;
    snapshot: (project: ProjectState) => Promise<string>;
    library: AssetLibrary;
    events: RuntimeEventBus;
    busy: (id: string) => boolean;
  },
): void {
  const { projects, agents, writes, checkpoints, snapshot, library, events } = options;

  const story = (projectId: string): ProjectState => {
    const project = projects.get(projectId);
    if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    if (project.type !== "interactive-story")
      throw Object.assign(new Error("Upgrading requires an Interactive Story project"), { statusCode: 409 });
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

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/interactive-story/upgrade", async (request, reply) =>
    send(reply, async (): Promise<StoryUpgradeStatus> => {
      const project = story(request.params.projectId);
      const web = await isWebStory(project.workspacePath);
      const library = web ? await libraryAssets(project.workspacePath) : [];
      return { web, ...(library.length ? { libraryAssets: library } : {}) };
    }));

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/interactive-story/upgrade", async (request, reply) =>
    send(reply, async (): Promise<StoryUpgradeResult> => {
      const project = story(request.params.projectId);
      assertIdle(project.id);
      if (await isWebStory(project.workspacePath)) throw new Error("This story is already a web story.");
      const before = await snapshot(project);
      const upgrade = await writes.exclusive(project.id, () => upgradeToWebStory(project.workspacePath, libraryFile));
      const after = await snapshot(project);
      const changed = (await checkpoints.diff(project, before, after)).map((change) => change.path);
      await announce(project, changed, `OhMyGame upgraded this Interactive Story to a web story when the user opened it. It now plays as its own page: index.html loads the story runtime under story/, which reads graph.json and loads each Scene's files as they are. Library assets it used were copied under assets/library/. Read AGENTS.md before changing it.${legacyNote(upgrade.removedGraphFields)} Changed workspace paths: ${JSON.stringify(changed)}.`);
      return {
        copiedAssets: upgrade.copiedAssets,
        missingAssets: upgrade.missingAssets,
        rewritten: upgrade.rewritten,
        changed,
      };
    }));

  // A web story can still take in Library media that upgrading could not find then.
  app.post<{ Params: { projectId: string } }>("/projects/:projectId/interactive-story/library-media", async (request, reply) =>
    send(reply, async (): Promise<StoryLibraryMediaResult> => {
      const project = story(request.params.projectId);
      assertIdle(project.id);
      if (!await isWebStory(project.workspacePath)) throw new Error("Upgrade the story first; upgrading copies its Library media.");
      const copied = await writes.exclusive(project.id, () => copyLibraryAssets(project.workspacePath, libraryFile));
      const graph = JSON.parse(await readFile(path.join(project.workspacePath, "graph.json"), "utf8")) as { assets: Record<string, { source: { path?: string } }> };
      const changed = copied.copiedAssets.length
        ? ["graph.json", ...copied.copiedAssets.map((id) => graph.assets[id]?.source.path).filter((file): file is string => !!file)]
        : [];
      if (changed.length) await announce(project, changed, `Library media this story used were copied into the project under assets/library/, and graph.json now points at them: ${JSON.stringify(copied.copiedAssets)}.`);
      return { ...copied, changed };
    }));
}

/** What the Agent is told about fields of an older graph.json the upgrade removed. */
function legacyNote(removed: string[]): string {
  if (!removed.includes("shell")) {
    return removed.length ? " graph.json no longer has `destinations`, which nothing used any more." : "";
  }
  return ` graph.json no longer has ${removed.map((field) => `\`${field}\``).join(" or ")}: the story's former shell, drawn over every Scene, is no longer shown, and its connections were removed. Its files are still under shell/; to bring its interface back, make it a shared component that each Scene imports, with that Scene's Signals and edges (see AGENTS.md).`;
}
