import { isUtf8 } from "node:buffer";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  CheckpointFile,
  CheckpointFileView,
  CheckpointUndoRequest,
  ProjectState,
} from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import { CheckpointNotFoundError, type AgentManager } from "./agent.js";
import { workspaceMediaInfo } from "./workspace.js";
import type { ConversationManager } from "./conversations.js";
import type { ProjectManager } from "./projects.js";
import type { PreviewManager } from "./preview.js";
import {
  CheckpointConflictError,
  CheckpointIncompleteError,
  CheckpointStore,
} from "./checkpoints.js";
import { CheckpointFileTooLargeError } from "./checkpoint-objects.js";
import { ProjectWriteError, ProjectWrites } from "./project-writes.js";
import {
  turnRange,
  type StoredCheckpointUndone,
} from "./checkpoint-extension.js";
import {
  readWorkspaceNotice,
  writeWorkspaceNotice,
} from "./workspace-notice.js";

export function registerCheckpointRoutes(
  app: FastifyInstance,
  options: {
    store: CheckpointStore;
    writes: ProjectWrites;
    projects: ProjectManager;
    conversations: ConversationManager;
    agents: AgentManager;
    previews: PreviewManager;
    events: RuntimeEventBus;
    busy: (id: string) => boolean;
    snapshot: (project: ProjectState) => Promise<string>;
  },
) {
  const { store, writes, projects, conversations, agents, previews, events } =
    options;
  // Cancel remains available while a boundary waits for generation to settle.
  const exempt = (url: string) =>
    /\/checkpoints\/|\/events(?:\?|$)/.test(url) ||
    /\/cancel(?:\?|$)/.test(url);
  app.addHook("preHandler", async (request, reply) => {
    const id = (request.params as { projectId?: string }).projectId;
    if (!id) return;
    reply.header("x-workspace-version", writes.version(id));
    if (exempt(request.url)) return;
    if (
      request.method === "DELETE" &&
      /^\/projects\/[^/?]+(?:\?|$)/.test(request.url)
    ) {
      try {
        writes.assertVersion(
          id,
          request.headers["x-workspace-version"] as string | undefined,
        );
      } catch (cause) {
        return failure(cause, reply);
      }
      return;
    }
    try {
      const project = projects.get(id);
      if (
        project &&
        (request.method !== "GET" ||
          /\/(?:canvas|playable|preview)(?:\/|\?|$)/.test(request.url)) &&
        (await store.unfinished(project))
      ) {
        return reply.code(409).send({
          error:
            "Recover the interrupted file restore before changing this workspace.",
          code: "workspace_recovery",
        });
      }
      if (/\/conversations(?:\/|\?|$)/.test(request.url)) {
        if (
          request.method !== "GET" &&
          writes.isMutating(id) &&
          !agents.isProjectBusy(id)
        )
          throw new ProjectWriteError(
            "Another workspace operation is running.",
            "workspace_busy",
          );
        if (request.method !== "GET")
          writes.assertVersion(
            id,
            request.headers["x-workspace-version"] as string | undefined,
          );
        return;
      }
      // Wait before entering the drain set: a closing turn's snapshot needs
      // this set empty, while publish/build need that snapshot to finish.
      if (/\/(?:publish|interactive-story\/build)(?:\?|$)/.test(request.url))
        await agents.turnsClosed(id);
      writes.track(
        request,
        writes.enter(
          id,
          request.method === "GET"
            ? writes.version(id)
            : (request.headers["x-workspace-version"] as string | undefined),
        ),
      );
    } catch (cause) {
      return failure(cause, reply);
    }
  });

  app.addHook("onSend", async (request, reply) => {
    const id = (request.params as { projectId?: string }).projectId;
    // A normal read's content belongs to its pre-handler version. A restore
    // can start after its handler settles, before this response is sent.
    if (id && exempt(request.url))
      reply.header("x-workspace-version", writes.version(id));
  });

  async function target(
    projectId: string,
    conversationId: string,
    turnId: string,
  ) {
    const project = projects.get(projectId);
    if (!project)
      throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    const conversation = await conversations.get(project, conversationId);
    if (!conversation)
      throw Object.assign(new Error("Conversation not found"), {
        statusCode: 404,
      });
    const range = turnRange(
      (await conversations.view(project, conversation)).getBranch(),
      turnId,
    );
    if (!range) throw new CheckpointNotFoundError();
    return { project, conversation, range };
  }

  type AfterUnlock = (notify: () => void) => void;
  type WorkspaceChange = {
    kind: "undo" | "reapply" | "restore" | "recovery";
    checkpointId?: string;
    conversationId?: string;
  };

  async function announce(
    project: ProjectState,
    changed: string[],
    context: WorkspaceChange,
    afterUnlock: AfterUnlock,
    incomplete = false,
  ) {
    const { checkpointId, conversationId } = context;
    const recovery = incomplete || context.kind === "recovery";
    const restore = context.kind === "restore";
    const version = writes.changed(project.id);
    // One durable project notice is injected into every later model request,
    // including other conversations and sessions loaded after a restart.
    const content = `The user ${recovery ? "recovered an interrupted file restore" : restore ? "restored the workspace and rewound one conversation" : context.kind === "reapply" ? "reapplied previously undone file changes" : "undid file changes from an earlier turn"}. ${restore ? "Other conversations were preserved." : "The conversation was preserved."} Inspect the current files before continuing. Changed workspace paths: ${JSON.stringify(changed)}.`;
    try {
      await writeWorkspaceNotice(project, content, version);
    } finally {
      // Even a notice I/O error must invalidate editors after file mutation.
      afterUnlock(() =>
        events.publish(
          project.id,
          "workspace.restored",
          {
            version,
            changed,
            ...(recovery ? { recovery } : {}),
            ...(checkpointId ? { checkpointId } : {}),
          },
          conversationId ? { conversationId } : undefined,
        ),
      );
    }
  }
  const assertIdle = (id: string) => {
    if (agents.isProjectBusy(id) || options.busy(id))
      throw new ProjectWriteError(
        "Wait for agents, generation jobs and publishing to finish before undoing files.",
        "workspace_busy",
      );
  };

  type CheckpointParams = {
    projectId: string;
    conversationId: string;
    checkpointId: string;
  };
  const checkpointBase =
    "/projects/:projectId/conversations/:conversationId/checkpoints/:checkpointId";

  async function protect<T>(
    projectId: string,
    operation: (
      project: ProjectState,
      track: (changed: string[]) => void,
      afterUnlock: AfterUnlock,
    ) => Promise<T>,
    context: WorkspaceChange,
  ): Promise<T> {
    const { kind } = context;
    // Closing a turn may itself need the write lock for its final snapshot.
    await agents.turnsClosed(projectId);
    const notifications: Array<() => void> = [];
    const afterUnlock: AfterUnlock = (notify) => notifications.push(notify);
    try {
      return await writes.exclusive(projectId, async () => {
        assertIdle(projectId);
        const project = projects.get(projectId);
        if (!project)
          throw Object.assign(new Error("Project not found"), {
            statusCode: 404,
          });
        if (kind !== "recovery" && (await store.unfinished(project)))
          throw new ProjectWriteError(
            "Recover the interrupted file restore first.",
            "workspace_busy",
          );
        await previews.stop(project);
        const previousNotice = await readWorkspaceNotice(project);
        const changed = new Set<string>();
        let incomplete = false;
        let announced = false;
        await writeWorkspaceNotice(
          project,
          `A workspace ${kind} was requested. Inspect current files before continuing.`,
        );
        try {
          const result = await operation(
            project,
            (paths) => paths.forEach((file) => changed.add(file)),
            afterUnlock,
          );
          if (changed.size > 0 || kind === "recovery" || kind === "restore") {
            announced = true;
            await announce(project, [...changed], context, afterUnlock);
          } else
            await writeWorkspaceNotice(
              project,
              previousNotice ??
                "The workspace and conversation were preserved.",
              writes.version(project.id),
            );
          return result;
        } catch (cause) {
          incomplete = cause instanceof CheckpointIncompleteError;
          if (!announced && (incomplete || changed.size > 0))
            await announce(
              project,
              [...changed],
              context,
              afterUnlock,
              incomplete,
            );
          else if (!announced)
            await writeWorkspaceNotice(
              project,
              previousNotice ??
                "The workspace operation was refused or rolled back.",
              writes.version(project.id),
            );
          throw cause;
        } finally {
          if (changed.size > 0 || incomplete) {
            agents.invalidateProjectSessions(project.id);
            await projects.refreshPreviewReadiness(project.id);
            await projects.touch(project.id);
          }
        }
      });
    } finally {
      // Editors react immediately to these events; their reads must start only
      // after the workspace lock and metadata cleanup have finished.
      for (const notify of notifications) notify();
    }
  }

  app.get<{ Params: CheckpointParams }>(
    `${checkpointBase}/changes`,
    async (request, reply) => {
      try {
        await agents.turnsClosed(request.params.projectId);
        const { project, range } = await target(
          request.params.projectId,
          request.params.conversationId,
          request.params.checkpointId,
        );
        const changes =
          (await store.summarize(project, range.before, range.after)).items ??
          [];
        if (agents.isProjectBusy(project.id) || options.busy(project.id))
          return { changes };
        const now = await options.snapshot(project);
        const differing = async (commit: string) =>
          new Set(
            (await store.diff(project, commit, now)).map(
              (change) => change.path,
            ),
          );
        const [sinceEnd, sinceStart] = await Promise.all([
          differing(range.after),
          differing(range.before),
        ]);
        return {
          changes: changes.map((change) => ({
            ...change,
            state: !sinceEnd.has(change.path)
              ? "applied"
              : !sinceStart.has(change.path)
                ? "undone"
                : "changed",
          })),
        };
      } catch (cause) {
        return failure(cause, reply);
      }
    },
  );

  app.get<{ Params: CheckpointParams; Querystring: { path?: string } }>(
    `${checkpointBase}/file`,
    async (request, reply) => {
      if (!request.query.path)
        return reply.code(400).send({ error: "File path is required" });
      try {
        const { project, range } = await target(
          request.params.projectId,
          request.params.conversationId,
          request.params.checkpointId,
        );
        const filePath = request.query.path;
        const change = (
          await store.diff(project, range.before, range.after)
        ).find((change) => change.path === filePath);
        if (!change) return reply.code(404).send({ error: "File not found" });
        const media = Boolean(workspaceMediaInfo(filePath));
        const side = async (
          commit: string,
          held: boolean,
        ): Promise<CheckpointFile | null> => {
          if (!held) return null;
          if (media) return { binary: true };
          try {
            const content = await store.read(
              project,
              commit,
              filePath,
              256 * 1024,
            );
            if (!content) return null;
            if (!isUtf8(Buffer.from(content)) || content.includes(0))
              return { binary: true };
            return {
              binary: false,
              content: Buffer.from(content).toString("utf8"),
            };
          } catch (cause) {
            if (cause instanceof CheckpointFileTooLargeError) {
              let content = cause.preview;
              // A UTF-8 code point may straddle the display boundary.
              for (let cut = 0; cut <= 3 && !isUtf8(content); cut++)
                content = cause.preview.subarray(
                  0,
                  cause.preview.length - cut - 1,
                );
              return isUtf8(content) && !content.includes(0)
                ? {
                    binary: false,
                    content: content.toString("utf8"),
                    truncated: true,
                  }
                : { binary: true, truncated: true };
            }
            throw cause;
          }
        };
        const [before, after] = await Promise.all([
          side(range.before, change.kind !== "added"),
          side(range.after, change.kind !== "removed"),
        ]);
        return { path: filePath, before, after } satisfies CheckpointFileView;
      } catch (cause) {
        return failure(cause, reply);
      }
    },
  );

  for (const direction of ["undo", "reapply"] as const)
    app.post<{ Params: CheckpointParams; Body: CheckpointUndoRequest }>(
      `${checkpointBase}/${direction}`,
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: {
              conflicts: { enum: ["keep", "overwrite"] },
              expected: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      async (request, reply) => {
        const { conflicts, expected } = request.body ?? {};
        if (conflicts === "overwrite" && !expected)
          return reply
            .code(400)
            .send({ error: "The files to overwrite are required" });
        try {
          return await protect(
            request.params.projectId,
            async (project, track, afterUnlock) => {
              const conversation = await conversations.get(
                project,
                request.params.conversationId,
              );
              if (!conversation)
                throw Object.assign(new Error("Conversation not found"), {
                  statusCode: 404,
                });
              const changeFiles = async (
                range: { before: string; after: string },
                state?: StoredCheckpointUndone,
              ) => {
                let pending = new Map(Object.entries(state?.reapply ?? {}));
                if (state && state.reapply === undefined) {
                  // Old records lack path targets. Only paths still at the before
                  // snapshot can be identified as undone without guessing.
                  const now = await store.snapshot(project);
                  const changed = new Set(
                    (await store.diff(project, range.before, now)).map(
                      (file) => file.path,
                    ),
                  );
                  pending = new Map(
                    (await store.diff(project, range.before, range.after))
                      .filter((file) => !changed.has(file.path))
                      .map((file) => [file.path, state.previous]),
                  );
                }
                const result = await store.undo(project, range, {
                  ...(direction === "reapply"
                    ? { reapply: Object.fromEntries(pending) }
                    : {}),
                  conflicts:
                    conflicts === "overwrite"
                      ? { overwrite: expected! }
                      : conflicts,
                });
                track(result.changed);
                const kept = result.conflicts.filter(
                  (file) => !result.changed.includes(file),
                );
                if (direction === "reapply")
                  for (const file of pending.keys()) {
                    if (!kept.includes(file)) pending.delete(file);
                  }
                // AgentManager owns Undo target accumulation; Reapply alone
                // removes targets that were restored or already matched.
                let remaining = 0;
                if (
                  pending.size ||
                  (direction === "undo" && result.changed.length)
                ) {
                  const turnPaths = new Set(
                    (await store.diff(project, range.before, range.after)).map(
                      (file) => file.path,
                    ),
                  );
                  remaining = (
                    await store.diff(
                      project,
                      range.before,
                      await store.snapshot(project),
                    )
                  ).filter((file) => turnPaths.has(file.path)).length;
                }
                return {
                  ...result,
                  kept: remaining,
                  ...(direction === "reapply"
                    ? { reapply: Object.fromEntries(pending) }
                    : {}),
                  conflicts: kept,
                };
              };
              const result = await agents.undoCheckpoint(
                project,
                conversation,
                request.params.checkpointId,
                changeFiles,
                direction,
              );
              if (result.changed.length || !result.conflicts.length)
                afterUnlock(() => {
                  const status = {
                    checkpointId: request.params.checkpointId,
                    kept: result.kept ?? result.conflicts.length,
                  };
                  const scope = { conversationId: conversation.summary.id };
                  const undone = Object.keys(result.reapply ?? {}).length > 0;
                  if (direction === "undo")
                    events.publish(
                      project.id,
                      "workspace.undone",
                      { ...status, ...(!undone ? { undone: false } : {}) },
                      scope,
                    );
                  else
                    events.publish(
                      project.id,
                      "workspace.reapplied",
                      { ...status, undone },
                      scope,
                    );
                });
              return {
                changed: result.changed,
                conflicts: result.conflicts,
                undone: Object.keys(result.reapply ?? {}).length > 0,
                kept: result.kept,
              };
            },
            { kind: direction },
          );
        } catch (cause) {
          if (cause instanceof CheckpointConflictError) {
            const blocked = cause.blocked.length > 0;
            return reply.code(409).send({
              error: cause.message,
              conflicts:
                conflicts === "overwrite" && blocked
                  ? cause.blocked
                  : cause.conflicts,
              ...(blocked ? { blocked: true } : {}),
            });
          }
          return failure(cause, reply);
        }
      },
    );

  app.post<{ Params: CheckpointParams }>(
    `${checkpointBase}/restore`,
    async (request, reply) => {
      try {
        await protect(
          request.params.projectId,
          async (project, track) => {
            const conversation = await conversations.get(
              project,
              request.params.conversationId,
            );
            if (!conversation)
              throw Object.assign(new Error("Conversation not found"), {
                statusCode: 404,
              });
            await agents.restoreCheckpoint(
              project,
              conversation,
              request.params.checkpointId,
              async (commit, rewind) => {
                const result = await store.restore(project, commit, rewind);
                track(result.changed);
                return result.previous;
              },
            );
          },
          {
            kind: "restore",
            checkpointId: request.params.checkpointId,
            conversationId: request.params.conversationId,
          },
        );
        return reply.code(204).send();
      } catch (cause) {
        return failure(cause, reply);
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/checkpoints/unfinished",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try {
        return { unfinished: Boolean(await store.unfinished(project)) };
      } catch (cause) {
        return failure(cause, reply);
      }
    },
  );
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/checkpoints/unfinished/changes",
    async (request, reply) => {
      try {
        const project = projects.get(request.params.projectId);
        if (!project)
          return reply.code(404).send({ error: "Project not found" });
        const previous = await store.unfinished(project);
        if (!previous)
          return reply
            .code(404)
            .send({ error: "No restore or undo was left unfinished" });
        // Inspection is allowed while recovery is pending; creative writes stay blocked.
        const now = await writes.exclusive(project.id, () =>
          store.snapshot(project),
        );
        return { changes: await store.diff(project, now, previous) };
      } catch (cause) {
        return failure(cause, reply);
      }
    },
  );
  app.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/checkpoints/unfinished/restore",
    async (request, reply) => {
      try {
        await protect(
          request.params.projectId,
          async (project, track) => {
            const previous = await store.unfinished(project);
            if (!previous)
              throw Object.assign(
                new Error("No restore or undo was left unfinished"),
                { statusCode: 404 },
              );
            await agents.restoreUnfinished(project, async () => {
              track((await store.restore(project, previous)).changed);
            });
          },
          { kind: "recovery" },
        );
        return reply.code(204).send();
      } catch (cause) {
        return failure(cause, reply);
      }
    },
  );
}

function failure(cause: unknown, reply: FastifyReply) {
  if (cause instanceof CheckpointConflictError)
    return reply.code(409).send({
      error: cause.message,
      code: "checkpoint_conflict",
      conflicts: cause.conflicts,
    });
  if (cause instanceof CheckpointIncompleteError)
    return reply.code(409).send({
      error: cause.message,
      code: "CHECKPOINT_INCOMPLETE",
    });
  if (cause instanceof CheckpointNotFoundError)
    return reply.code(404).send({ error: cause.message });
  const error = cause as { statusCode?: number; code?: string };
  return reply.code(error.statusCode ?? 409).send({
    error: cause instanceof Error ? cause.message : String(cause),
    ...(error.code ? { code: error.code } : {}),
  });
}
