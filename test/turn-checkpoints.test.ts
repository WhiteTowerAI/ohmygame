import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import {
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import {
  AgentManager,
  conversationItems,
  createPiSession,
} from "../src/daemon/agent.js";
import { CheckpointStore } from "../src/daemon/checkpoints.js";
import { CheckpointFileTooLargeError } from "../src/daemon/checkpoint-objects.js";
import {
  turnRange,
  CHECKPOINT_ENTRY,
  parseStoredCheckpoint,
} from "../src/daemon/checkpoint-extension.js";
import { ProjectWrites } from "../src/daemon/project-writes.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import type { ProjectState } from "../src/shared/contracts.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function stream(message: AssistantMessage): AssistantMessageEventStream {
  const result = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted")
      result.push({
        type: "error",
        reason: message.stopReason,
        error: message,
      });
    else
      result.push({
        type: "done",
        reason: message.stopReason === "pending" ? "stop" : message.stopReason,
        message,
      });
  });
  return result;
}
async function fixture(
  snapshotOverride?: (project: ProjectState) => Promise<string>,
  loading?: Promise<void>,
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-turn-checkpoints-"),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const project: ProjectState = {
    id: "project",
    name: "Project",
    type: "web-game",
    workspacePath: path.join(directory, "workspace"),
    storagePath: directory,
    updatedAt: new Date().toISOString(),
    preview: { status: "waiting" },
  };
  await mkdir(project.workspacePath);
  const agentDir = path.join(directory, "agent");
  await mkdir(agentDir);
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey("anthropic", "test");
  const model = runtime.getModels("anthropic")[0]!;
  const sessionManager = SessionManager.create(
    project.workspacePath,
    path.join(directory, "sessions"),
  );
  const store = new CheckpointStore();
  const snapshot = vi.fn(
    snapshotOverride ?? ((state: ProjectState) => store.snapshot(state)),
  );
  const session = (await createPiSession(
    project,
    sessionManager,
    [],
    runtime,
    model,
    agentDir,
    undefined,
    undefined,
    undefined,
    () => snapshot(project),
  )) as AgentSession;
  const events = new RuntimeEventBus();
  const manager = new AgentManager(events, {
    createSession: async () => {
      await loading;
      return session;
    },
    checkpoints: {
      snapshot,
      changed: async (state, before, after) =>
        store.summarize(state, before, after),
    },
  });
  cleanups.push(() => manager.close());
  const conversation = {
    sessionPath: sessionManager.getSessionFile()!,
    summary: {
      id: sessionManager.getSessionId(),
      projectId: project.id,
      title: "Test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    },
  };
  return {
    directory,
    project,
    session,
    sessionManager,
    store,
    manager,
    conversation,
    snapshot,
    events,
    runtime,
  };
}

function checkpointId(
  events: RuntimeEventBus,
  turnId: string,
): string | undefined {
  const event = events
    .since("project")
    .find(
      (candidate) =>
        candidate.type === "checkpoint.created" && candidate.turnId === turnId,
    );
  return event?.type === "checkpoint.created"
    ? event.data.checkpointId
    : undefined;
}
function rangeFor(
  session: SessionManager,
  events: RuntimeEventBus,
  turnId: string,
) {
  const id = checkpointId(events, turnId);
  return id ? turnRange(session.getBranch(), id) : undefined;
}

it("projects real edit/write diffs before the turn ends and restores them from disk", async () => {
  const { events, project, manager, conversation, runtime, sessionManager } =
    await fixture();
  await mkdir(path.join(project.workspacePath, "src"));
  await writeFile(
    path.join(project.workspacePath, "src/render.ts"),
    "const color = 'red';\nconst width = 1;\n",
  );
  const edited = deferred(),
    release = deferred();
  cleanups.push(() => release.resolve());
  let calls = 0;
  runtime.streamSimple = () => {
    if (calls++ === 0)
      return stream(
        assistant(
          [
            {
              type: "toolCall",
              id: "edit",
              name: "edit",
              arguments: {
                path: "src/render.ts",
                edits: [
                  {
                    oldText: "const color = 'red';",
                    newText: "const color = 'green';",
                  },
                  {
                    oldText: "const width = 1;",
                    newText: "const width = 2;\nconst height = 3;",
                  },
                ],
              },
            },
            {
              type: "toolCall",
              id: "write",
              name: "write",
              arguments: { path: "notes.txt", content: "first\nsecond\n" },
            },
          ],
          "toolUse",
        ),
      );
    const output = createAssistantMessageEventStream();
    edited.resolve();
    void release.promise.then(() =>
      output.push({
        type: "done",
        reason: "stop",
        message: assistant([{ type: "text", text: "Done" }]),
      }),
    );
    return output;
  };
  const turn = manager.prompt(
    project,
    conversation,
    "Edit two blocks and write notes",
  );
  await Promise.race([
    edited.promise,
    turn.result!.then(() => {
      throw new Error("Turn ended before inspection");
    }),
  ]);
  const live = events
    .since(project.id)
    .flatMap((event) =>
      event.type === "item.completed" &&
      event.data.item.type === "dynamicToolCall"
        ? [event.data.item]
        : [],
    );
  expect(live).toHaveLength(2);
  expect(live[0]).toMatchObject({
    tool: "edit",
    status: "completed",
    output: "Successfully replaced 2 block(s) in src/render.ts.",
    lineChanges: { added: 3, removed: 2 },
  });
  expect(live[0]?.fileDiff?.hunks.flat().map((line) => line.text)).toContain(
    "const color = 'green';",
  );
  expect(live[1]).toMatchObject({
    tool: "write",
    lineChanges: { added: 2, removed: 0 },
    fileDiff: {
      hunks: [
        [
          { kind: "added", text: "first", after: 1 },
          { kind: "added", text: "second", after: 2 },
        ],
      ],
    },
  });
  expect(
    events.since(project.id).some((event) => event.type === "agent.completed"),
  ).toBe(false);
  release.resolve();
  await turn.result;
  const savedItems = conversationItems(
    SessionManager.open(sessionManager.getSessionFile()!).getBranch(),
  );
  expect(savedItems.find((item) => item.type === "userMessage")).toMatchObject({
    changes: {
      files: 2,
      items: [
        { path: "notes.txt", kind: "added", lines: { added: 2, removed: 0 } },
        {
          path: "src/render.ts",
          kind: "modified",
          lines: { added: 3, removed: 2 },
        },
      ],
    },
  });
  const restored = conversationItems(
    SessionManager.open(sessionManager.getSessionFile()!).getBranch(),
  ).filter((item) => item.type === "dynamicToolCall");
  expect(
    restored.map(({ lineChanges, fileDiff }) => ({ lineChanges, fileDiff })),
  ).toEqual(
    live.map(({ lineChanges, fileDiff }) => ({ lineChanges, fileDiff })),
  );
  const olderEntries = SessionManager.open(
    sessionManager.getSessionFile()!,
  ).getBranch();
  for (const entry of olderEntries) {
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "edit"
    ) {
      const details = entry.message.details as { patch?: string };
      delete details.patch;
    }
  }
  expect(
    conversationItems(olderEntries).find(
      (item) => item.type === "dynamicToolCall" && item.tool === "edit",
    ),
  ).toMatchObject({
    lineChanges: { added: 3, removed: 2 },
    fileDiff: { hunks: expect.any(Array) },
  });
});

it("sanitizes leaked thinking before saving and sending the next prompt", async () => {
  const { manager, project, conversation, sessionManager, runtime } = await fixture();
  const contexts: unknown[] = [];
  let calls = 0;
  runtime.streamSimple = (_model, context) => {
    contexts.push(context);
    calls += 1;
    return stream(assistant([{ type: "text", text: calls === 1 ? "<thinking>private</thinking>Answer" : "Follow-up" }]));
  };

  await expect(manager.prompt(project, conversation, "Build").result).resolves.toBe("completed");
  const saved = sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  expect(saved?.type === "message" && saved.message.role === "assistant" ? saved.message.content : undefined).toEqual([
    { type: "text", text: "Answer" },
  ]);

  await expect(manager.prompt(project, conversation, "Continue").result).resolves.toBe("completed");
  const previous = contexts[1] as { messages: Array<{ role: string; content: unknown }> } | undefined;
  expect(previous?.messages.findLast((message) => message.role === "assistant")?.content).toEqual([
    { type: "text", text: "Answer" },
  ]);
});

it("captures consumed follow-ups and steering at file boundaries, rather than enqueue time", async () => {
  const {
    events,
    project,
    session,
    sessionManager,
    store,
    manager,
    conversation,
    snapshot,
    runtime,
  } = await fixture();
  const firstRequest = deferred(),
    release = deferred();
  cleanups.push(() => release.resolve());
  let calls = 0;
  runtime.streamSimple = (_model, context) => {
    if (calls++ === 0) {
      firstRequest.resolve();
      const output = createAssistantMessageEventStream();
      void release.promise.then(() =>
        output.push({
          type: "done",
          reason: "toolUse",
          message: assistant(
            [
              {
                type: "toolCall",
                id: "write-first",
                name: "write",
                arguments: { path: "game.txt", content: "first" },
              },
            ],
            "toolUse",
          ),
        }),
      );
      return output;
    }
    const user = context.messages.findLast(
      (message) => message.role === "user",
    );
    const text = JSON.stringify(user?.content);
    if (context.messages.at(-1)?.role === "toolResult")
      return stream(assistant([{ type: "text", text: "Done" }]));
    return stream(
      assistant(
        [
          {
            type: "toolCall",
            id: `write-${calls}`,
            name: "write",
            arguments: {
              path: "game.txt",
              content: text.includes("Steer") ? "steered" : "followed",
            },
          },
        ],
        "toolUse",
      ),
    );
  };
  const first = manager.prompt(project, conversation, "First");
  await Promise.race([
    firstRequest.promise,
    first.result!.then(() => {
      throw new Error("Run settled before inference");
    }),
  ]);
  const follow = manager.prompt(project, conversation, "Follow");
  await follow.result;
  const steer = manager.prompt(project, conversation, "Steer");
  await steer.result;
  await manager.steerPending(project.id, conversation.summary.id, steer.turnId);
  expect(snapshot).toHaveBeenCalledTimes(1);
  release.resolve();
  await first.result;
  expect(snapshot).toHaveBeenCalledTimes(4);
  const firstRange = rangeFor(sessionManager, events, first.turnId)!;
  const steerRange = rangeFor(sessionManager, events, steer.turnId)!;
  const followRange = rangeFor(sessionManager, events, follow.turnId)!;
  expect(
    Buffer.from(
      (await store.read(project, firstRange.after!, "game.txt"))!,
    ).toString(),
  ).toBe("first");
  expect(
    Buffer.from(
      (await store.read(project, steerRange.before, "game.txt"))!,
    ).toString(),
  ).toBe("first");
  expect(
    Buffer.from(
      (await store.read(project, followRange.before, "game.txt"))!,
    ).toString(),
  ).toBe("steered");
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("followed");
  const restarted = SessionManager.open(
    sessionManager.getSessionFile()!,
  ).getBranch();
  const users = conversationItems(restarted, false).filter(
    (item) => item.type === "userMessage",
  );
  expect(users.map((item) => item.checkpointId)).toEqual([
    checkpointId(events, first.turnId),
    checkpointId(events, steer.turnId),
    checkpointId(events, follow.turnId),
  ]);
});

it("fails closed before inference/tools when the before checkpoint fails", async () => {
  const { events, project, session, manager, conversation, runtime } =
    await fixture(async () => {
      throw new Error("snapshot disk failure");
    });
  const inference = vi.fn(() =>
    stream(
      assistant(
        [
          {
            type: "toolCall",
            id: "write",
            name: "write",
            arguments: { path: "bad.txt", content: "bad" },
          },
        ],
        "toolUse",
      ),
    ),
  );
  runtime.streamSimple = inference;
  await expect(
    manager.prompt(project, conversation, "Write").result,
  ).rejects.toThrow("snapshot disk failure");
  expect(inference).not.toHaveBeenCalled();
  await expect(
    readFile(path.join(project.workspacePath, "bad.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("records partial files on cancellation without rewinding the conversation", async () => {
  const {
    events,
    project,
    session,
    sessionManager,
    manager,
    conversation,
    snapshot,
    runtime,
  } = await fixture();
  const written = deferred();
  let calls = 0;
  runtime.streamSimple = (_model, _context, options) => {
    if (calls++ === 0)
      return stream(
        assistant(
          [
            {
              type: "toolCall",
              id: "write",
              name: "write",
              arguments: { path: "partial.txt", content: "partial" },
            },
          ],
          "toolUse",
        ),
      );
    const output = createAssistantMessageEventStream();
    written.resolve();
    options?.signal?.addEventListener(
      "abort",
      () =>
        output.push({
          type: "error",
          reason: "aborted",
          error: assistant([], "aborted"),
        }),
      { once: true },
    );
    return output;
  };
  const turn = manager.prompt(project, conversation, "Write then wait");
  await Promise.race([
    written.promise,
    turn.result!.then(() => {
      throw new Error("Run settled before write");
    }),
  ]);
  await manager.cancel(project.id, conversation.summary.id, turn.turnId);
  await expect(turn.result).resolves.toBe("cancelled");
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(rangeFor(sessionManager, events, turn.turnId)?.after).toBeDefined();
  expect(
    await readFile(path.join(project.workspacePath, "partial.txt"), "utf8"),
  ).toBe("partial");
  expect(
    conversationItems(sessionManager.getBranch()).some(
      (item) => item.type === "userMessage",
    ),
  ).toBe(true);
});

it("bounds preview reads of highly compressed files and validates readable blobs", async () => {
  const { events, project, store } = await fixture();
  await writeFile(
    path.join(project.workspacePath, "huge.txt"),
    "a".repeat(2 * 1024 * 1024),
  );
  await writeFile(path.join(project.workspacePath, "small.txt"), "small");
  const snapshot = await store.snapshot(project);
  await expect(
    store.read(project, snapshot, "huge.txt", 256 * 1024),
  ).rejects.toBeInstanceOf(CheckpointFileTooLargeError);
  expect(
    Buffer.from(
      (await store.read(project, snapshot, "small.txt", 256 * 1024))!,
    ).toString(),
  ).toBe("small");
});

it("keeps failed turn changes reviewable and closes the after checkpoint before reporting failure", async () => {
  const { events, project, manager, conversation, runtime, sessionManager } =
    await fixture();
  let calls = 0;
  runtime.streamSimple = () =>
    calls++ === 0
      ? stream(
          assistant(
            [
              {
                type: "toolCall",
                id: "write",
                name: "write",
                arguments: { path: "failed.txt", content: "partial failure" },
              },
            ],
            "toolUse",
          ),
        )
      : stream({ ...assistant([], "error"), errorMessage: "model failure" });
  const turn = manager.prompt(project, conversation, "Write");
  await expect(turn.result).rejects.toThrow("model failure");
  expect(rangeFor(sessionManager, events, turn.turnId)?.after).toBeDefined();
  expect(
    await readFile(path.join(project.workspacePath, "failed.txt"), "utf8"),
  ).toBe("partial failure");
});

it("marks a missing after snapshot unavailable instead of presenting a complete range", async () => {
  let calls = 0;
  const { project, manager, conversation, runtime, sessionManager, events } =
    await fixture(async () => {
      if (calls++ === 0) return "a".repeat(40);
      throw new Error("after snapshot failure");
    });
  runtime.streamSimple = () =>
    stream(assistant([{ type: "text", text: "Done" }]));
  const turn = manager.prompt(project, conversation, "Read");
  await expect(turn.result).resolves.toBe("completed");
  expect(rangeFor(sessionManager, events, turn.turnId)).toBeUndefined();
  const id = checkpointId(events, turn.turnId);
  const entry = sessionManager.getBranch().find((entry) => entry.id === id);
  expect(
    entry?.type === "custom"
      ? parseStoredCheckpoint(entry.data)?.commit
      : undefined,
  ).toBe("a".repeat(40));
  expect(
    events
      .since(project.id)
      .some((event) => event.type === "checkpoint.completed"),
  ).toBe(false);
});

it("adds the durable workspace notice to later model requests", async () => {
  const { events, project, manager, conversation, runtime } = await fixture();
  const { writeWorkspaceNotice } =
    await import("../src/daemon/workspace-notice.js");
  await writeWorkspaceNotice(
    project,
    "User undid the title change. Inspect current files.",
  );
  const inference = vi.fn((_model, context) => {
    expect(JSON.stringify(context)).toContain("User undid the title change");
    return stream(assistant([{ type: "text", text: "Done" }]));
  });
  runtime.streamSimple = inference;
  await manager.prompt(project, conversation, "Continue").result;
  expect(inference).toHaveBeenCalledOnce();
});

it("drains real writes, refuses new stale writes and lets other projects proceed", async () => {
  const writes = new ProjectWrites(),
    held = writes.enter("one"),
    restored = deferred();
  const operation = writes.exclusive("one", async () => {
    writes.changed("one");
    restored.resolve();
  });
  await Promise.resolve();
  expect(() => writes.enter("one")).toThrow("being checkpointed");
  const other = writes.enter("two");
  other();
  held();
  await operation;
  await restored.promise;
  expect(() => writes.enter("one", "0")).toThrow("was restored");
  const current = writes.enter("one", writes.version("one"));
  current();
  await expect(
    writes.exclusive("one", async () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  const next = writes.enter("one", writes.version("one"));
  next();
});

it("waits for an HTTP write handler even after its client disconnects", async () => {
  const app = Fastify(),
    writes = new ProjectWrites();
  const entered = deferred(),
    release = deferred();
  const order: string[] = [];
  writes.install(app);
  app.addHook("preHandler", async (request) => {
    writes.track(request, writes.enter("one"));
  });
  app.post("/write", async () => {
    entered.resolve();
    await release.promise;
    order.push("write");
    return {};
  });
  cleanups.push(
    () => app.close(),
    () => release.resolve(),
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = httpRequest(`${address}/write`, { method: "POST" });
  client.on("error", () => {});
  client.end();
  cleanups.push(() => client.destroy());
  await entered.promise;
  const restore = writes.exclusive("one", async () => {
    order.push("restore");
  });
  client.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(order).toEqual([]);
  release.resolve();
  await restore;
  expect(order).toEqual(["write", "restore"]);
});

it("waits for a write handler that continues after sending its response", async () => {
  const app = Fastify();
  const writes = new ProjectWrites();
  const release = deferred();
  const order: string[] = [];
  writes.install(app);
  app.addHook("preHandler", async (request) => {
    writes.track(request, writes.enter("one"));
  });
  app.post("/write", async (_request, reply) => {
    reply.send({ accepted: true });
    await release.promise;
    order.push("write");
  });
  cleanups.push(
    () => app.close(),
    () => release.resolve(),
  );
  expect((await app.inject({ method: "POST", url: "/write" })).statusCode).toBe(
    200,
  );
  const restoring = writes.exclusive("one", async () => {
    order.push("restore");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(order).toEqual([]);
  release.resolve();
  await restoring;
  expect(order).toEqual(["write", "restore"]);
});

it("associates an initial consumed message correctly when a follow-up arrives during session loading", async () => {
  const loading = deferred();
  cleanups.push(() => loading.resolve());
  const {
    events,
    project,
    manager,
    conversation,
    runtime,
    sessionManager,
    snapshot,
  } = await fixture(undefined, loading.promise);
  runtime.streamSimple = () =>
    stream(assistant([{ type: "text", text: "Done" }]));
  const first = manager.prompt(project, conversation, "First");
  const queued = manager.prompt(
    project,
    conversation,
    "Queued before first message",
  );
  expect(snapshot).not.toHaveBeenCalled();
  loading.resolve();
  await queued.result;
  await first.result;
  expect(snapshot).toHaveBeenCalledTimes(3);
  expect(
    conversationItems(sessionManager.getBranch())
      .filter((item) => item.type === "userMessage")
      .map((item) => item.checkpointId),
  ).toEqual([
    checkpointId(events, first.turnId),
    checkpointId(events, queued.turnId),
  ]);
});

it("edits conversation history while preserving files and checkpoints the current files for the replacement", async () => {
  const {
    events,
    project,
    manager,
    conversation,
    runtime,
    sessionManager,
    store,
  } = await fixture();
  runtime.streamSimple = () =>
    stream(assistant([{ type: "text", text: "Done" }]));
  const original = manager.prompt(project, conversation, "First");
  await original.result;
  await writeFile(
    path.join(project.workspacePath, "game.txt"),
    "Later manual edit",
  );
  const revised = await manager.reviseLast(
    project,
    conversation,
    "Replacement",
    async (reference) => reference,
  );
  await revised.result;
  const checkpoint = rangeFor(sessionManager, events, revised.turnId)!;
  expect(
    Buffer.from(
      (await store.read(project, checkpoint.before, "game.txt"))!,
    ).toString(),
  ).toBe("Later manual edit");
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("Later manual edit");
  const users = conversationItems(
    SessionManager.open(sessionManager.getSessionFile()!).getBranch(),
  ).filter((item) => item.type === "userMessage");
  expect(users.map((item) => item.text)).toEqual(["Replacement"]);
});

it("reports checkpoint creation and completion as separate immutable events", async () => {
  const { project, manager, conversation, runtime, events } = await fixture();
  runtime.streamSimple = () =>
    stream(assistant([{ type: "text", text: "Done" }]));
  await manager.prompt(project, conversation, "First").result;
  const created = events
    .since(project.id)
    .find((event) => event.type === "checkpoint.created");
  const completed = events
    .since(project.id)
    .find((event) => event.type === "checkpoint.completed");
  expect(created?.data).toEqual({
    checkpointId:
      completed?.type === "checkpoint.completed"
        ? completed.data.checkpointId
        : undefined,
  });
  expect(completed?.data).toMatchObject({ files: 0 });
});

it("blocks inference if the durable workspace notice cannot be read", async () => {
  const { events, project, manager, conversation, runtime } = await fixture();
  await mkdir(path.join(project.storagePath!, "workspace-restore-notice.txt"));
  const inference = vi.fn(() =>
    stream(assistant([{ type: "text", text: "Done" }])),
  );
  runtime.streamSimple = inference;
  await expect(
    manager.prompt(project, conversation, "Continue").result,
  ).rejects.toThrow();
  expect(inference).not.toHaveBeenCalled();
});
