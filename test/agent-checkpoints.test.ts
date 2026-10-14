import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/daemon/agent.js";
import { createApp } from "../src/daemon/app.js";
import {
  CheckpointIncompleteError,
  CheckpointStore,
  checkpointDirectory,
} from "../src/daemon/checkpoints.js";
import { ConversationManager } from "../src/daemon/conversations.js";
import type {
  CheckpointChangeItem,
  CheckpointFileView,
  ConversationDetail,
  ProjectState,
  RuntimeEvent,
  RuntimeEventType,
  ThreadItem,
} from "../src/shared/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * Makes one call of a method of the store wait, after it really did its
 * work, until it is released: the nth call from now.
 */
function hold(method: "snapshot" | "undo" | "restore", nth = 1) {
  const original = CheckpointStore.prototype[method] as (
    this: CheckpointStore,
    ...args: unknown[]
  ) => Promise<unknown>;
  const reached = gate();
  const released = gate();
  let calls = 0;
  vi.spyOn(CheckpointStore.prototype, method).mockImplementation(
    async function (this: CheckpointStore, ...args: unknown[]) {
      const result = await original.apply(this, args);
      if (++calls === nth) {
        reached.open();
        await released.opened;
      }
      return result;
    } as never,
  );
  return { reached: reached.opened, release: released.open };
}

type Step =
  | { write: Record<string, string> }
  | { run: string }
  | { say: string; delayMs?: number }
  | { fail: number }
  | { hang: true };

interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * A model that answers each request with the next scripted step: files to
 * write with the `write` tool, a command for the `bash` tool, a final reply,
 * an HTTP error, or no answer at all, which keeps the turn open until it is
 * stopped. It keeps what it was sent.
 */
async function scriptedModel(steps: Step[]) {
  let calls = 0;
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(chunk as Buffer);
    requests.push(
      JSON.parse(Buffer.concat(body).toString("utf8")) as ModelRequest,
    );
    const step = steps.shift() ?? { say: "Nothing left to do." };
    if ("hang" in step) return;
    if ("fail" in step) {
      response.writeHead(step.fail, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "The fixture model failed" } }),
      );
      return;
    }
    if ("delayMs" in step && step.delayMs)
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    const tools =
      "say" in step
        ? []
        : "write" in step
          ? Object.entries(step.write).map(([file, content]) => ({
              name: "write",
              arguments: { path: file, content },
            }))
          : [{ name: "bash", arguments: { command: step.run } }];
    const delta =
      "say" in step
        ? { role: "assistant", content: step.say }
        : {
            role: "assistant",
            tool_calls: tools.map((tool, index) => ({
              index,
              id: `call-${calls++}`,
              type: "function",
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.arguments),
              },
            })),
          };
    const chunk = (choice: object) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk({ delta, finish_reason: null }));
    response.write(
      chunk({
        delta: {},
        finish_reason: "say" in step ? "stop" : "tool_calls",
      }),
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
  };
}

/** A daemon with a project, a conversation and the scripted model selected. */
async function studio(steps: Step[], type = "web-game") {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-agent-checkpoints-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const { baseUrl, requests } = await scriptedModel(steps);
  // A model request that fails is not tried again, so a step that fails ends the turn at once.
  await writeFile(
    path.join(directory, "settings.json"),
    JSON.stringify({ retry: { enabled: false } }),
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(directory, "auth.json"),
    modelsPath: path.join(directory, "models.json"),
    modelsStorePath: path.join(directory, "catalog.json"),
    allowModelNetwork: false,
  });
  const start = () => {
    const app = createApp({
      dataDirectory: directory,
      piAgentDirectory: directory,
      createModelRuntime: async () => runtime,
    });
    cleanup.push(() => app.close());
    return app;
  };
  const app = start();
  const provider = await app.inject({
    method: "POST",
    url: "/settings/models/providers/custom",
    payload: {
      name: "Fixture model",
      baseUrl,
      api: "openai-completions",
      authentication: "api_key",
      apiKey: "fixture",
      models: [
        {
          id: "fixture",
          name: "Fixture",
          api: "openai-completions",
          contextWindow: 32_000,
          maxTokens: 4_000,
          reasoning: false,
          supportsImages: false,
        },
      ],
    },
  });
  expect(provider.statusCode, provider.body).toBe(201);
  const project = (
    await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Checkpoints", type },
    })
  ).json();
  const converse = async () =>
    (
      await app.inject({
        method: "POST",
        url: `/projects/${project.id}/conversations`,
        payload: { model: { provider: provider.json().id, id: "fixture" } },
      })
    ).json();
  const conversation = await converse();
  const base = `/projects/${project.id}/conversations/${conversation.id}`;
  /** Opens another conversation of the project and returns where its routes start. */
  const another = async () =>
    `/projects/${project.id}/conversations/${(await converse()).id}`;
  type App = ReturnType<typeof createApp>;
  const detail = async (from: App = app) =>
    (
      await from.inject({ method: "GET", url: base })
    ).json() as ConversationDetail;
  const userMessages = async (from: App = app) =>
    (await detail(from)).turns
      .flatMap((turn) => turn.items)
      .filter(
        (item): item is Extract<ThreadItem, { type: "userMessage" }> =>
          item.type === "userMessage",
      );
  /** Sends a message and returns the answer, whatever it is. */
  const post = (prompt: string, to = base) =>
    app.inject({ method: "POST", url: `${to}/turns`, payload: { prompt } });
  const send = async (prompt: string, from: App = app) => {
    const response = await from.inject({
      method: "POST",
      url: `${base}/turns`,
      payload: { prompt },
    });
    expect(response.statusCode, response.body).toBe(202);
    return response.json() as { turnId: string; queued: boolean };
  };
  const idle = (turns: number) =>
    vi.waitFor(
      async () => {
        const current = await detail();
        expect(current.agent, JSON.stringify(current.agent)).toMatchObject({
          status: "idle",
        });
        expect(
          current.turns.filter((turn) => turn.status === "completed"),
        ).toHaveLength(turns);
      },
      { timeout: 15_000 },
    );
  const file = (name: string) =>
    readFile(path.join(project.workspacePath, name), "utf8");
  const missing = (name: string) =>
    stat(path.join(project.workspacePath, name)).then(
      () => false,
      () => true,
    );
  const restore = (checkpointId: string, from: App = app) =>
    from.inject({
      method: "POST",
      url: `${base}/checkpoints/${checkpointId}/restore`,
    });
  /** Waits until the turn of a message has ended, however it ended, and returns the message, which then says what the turn changed. */
  const ended = (text: string, from: App = app) =>
    vi.waitFor(
      async () => {
        const message = (await userMessages(from)).find(
          (candidate) => candidate.text === text,
        );
        expect(message?.changes, JSON.stringify(message)).toBeDefined();
        return message!;
      },
      { timeout: 15_000 },
    );
  const changes = async (checkpointId: string, from: App = app) => {
    const response = await from.inject({
      method: "GET",
      url: `${base}/checkpoints/${checkpointId}/changes`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { changes: CheckpointChangeItem[] }).changes;
  };
  const view = async (checkpointId: string, name: string, from: App = app) => {
    const response = await from.inject({
      method: "GET",
      url: `${base}/checkpoints/${checkpointId}/file`,
      query: { path: name },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as CheckpointFileView;
  };
  /** Undoes a turn. To overwrite, it names the files the player was shown. */
  const undo = (
    checkpointId: string,
    conflicts?: "keep" | string[],
    from: App = app,
  ) =>
    from.inject({
      method: "POST",
      url: `${base}/checkpoints/${checkpointId}/undo`,
      payload: !conflicts
        ? {}
        : conflicts === "keep"
          ? { conflicts }
          : { conflicts: "overwrite", expected: conflicts },
    });
  let address: Promise<string> | undefined;
  /** Reads the project's events from the first one on, as the app does, until so many of one type have come, and returns those. */
  const published = async <T extends RuntimeEventType>(type: T, count = 1) => {
    address ??= app.listen({ host: "127.0.0.1", port: 0 });
    const stream = await fetch(
      `${await address}/projects/${project.id}/events?cursor=0`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const reader = stream
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    const events: Array<RuntimeEvent<T>> = [];
    let text = "";
    while (events.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      const blocks = (text + value).split("\n\n");
      text = blocks.pop()!;
      const data = blocks
        .flatMap((block) => block.split("\n"))
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as RuntimeEvent);
      events.push(
        ...data.filter(
          (event): event is RuntimeEvent<T> => event.type === type,
        ),
      );
    }
    await reader.cancel();
    return events;
  };
  return {
    app,
    start,
    project,
    conversation,
    base,
    requests,
    another,
    detail,
    userMessages,
    post,
    send,
    idle,
    file,
    missing,
    restore,
    ended,
    changes,
    view,
    undo,
    published,
  };
}

describe("Agent checkpoints", () => {
  it("restores the workspace and the conversation to before a message, and the result survives a restart", async () => {
    const {
      app,
      start,
      project,
      conversation,
      userMessages,
      send,
      idle,
      file,
      missing,
      restore,
      published,
    } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "notes.txt": "second", "extra/added.txt": "added" } },
      { say: "Changed the notes." },
    ]);
    await writeFile(
      path.join(project.workspacePath, "player.txt"),
      "written by the player before any turn",
    );

    await send("Write the notes");
    await idle(1);
    expect(await file("notes.txt")).toBe("first");
    await send("Change the notes");
    await idle(2);
    expect(await file("notes.txt")).toBe("second");
    expect(await file("extra/added.txt")).toBe("added");

    const messages = await userMessages();
    expect(messages.map((message) => message.text)).toEqual([
      "Write the notes",
      "Change the notes",
    ]);
    expect(
      messages.every((message) => typeof message.checkpointId === "string"),
    ).toBe(true);
    expect(messages[0]!.checkpointId).not.toBe(messages[1]!.checkpointId);

    // Back to before the second message: its changes are gone, the first turn's stay.
    const second = await restore(messages[1]!.checkpointId!);
    expect(second.statusCode, second.body).toBe(204);
    expect(await file("notes.txt")).toBe("first");
    expect(await missing("extra/added.txt")).toBe(true);
    expect(await missing("extra")).toBe(true);
    expect((await userMessages()).map((message) => message.text)).toEqual([
      "Write the notes",
    ]);
    // The message that checkpoint belonged to is gone, so the checkpoint is too.
    expect((await restore(messages[1]!.checkpointId!)).statusCode).toBe(404);
    // Every window learns of it, and the preview is not left stopped as if the player had stopped it.
    const [restored] = await published("workspace.restored");
    expect(restored).toMatchObject({
      conversationId: conversation.id,
      data: { checkpointId: messages[1]!.checkpointId },
    });
    const state = (
      await app.inject({ method: "GET", url: `/projects/${project.id}` })
    ).json() as ProjectState;
    expect(state.preview.stopReason).not.toBe("manual");

    await app.close();
    const restarted = start();
    expect(
      (await userMessages(restarted)).map((message) => message.text),
    ).toEqual(["Write the notes"]);

    // Back to before the first message: only what the player had is left.
    const first = await restore(messages[0]!.checkpointId!, restarted);
    expect(first.statusCode, first.body).toBe(204);
    expect(await missing("notes.txt")).toBe(true);
    expect(await file("player.txt")).toBe(
      "written by the player before any turn",
    );
    expect(await userMessages(restarted)).toEqual([]);
  });

  it("restores to before a message that was the last thing saved when the app quit", async () => {
    const { app, start, project, userMessages, send, missing, restore } =
      await studio([{ hang: true }]);
    await send("Write the notes");
    const folder = path.join(
      project.storagePath ?? path.dirname(project.workspacePath),
      "session",
    );
    let saved = "";
    await vi.waitFor(
      async () => {
        const [name] = await readdir(folder);
        saved = await readFile(path.join(folder, name!), "utf8");
        expect(saved).toContain('"role":"user"');
      },
      { timeout: 10_000 },
    );
    const [name] = await readdir(folder);
    await app.close();
    // As the app left it when it was killed while the model answered: the message is the last entry.
    await writeFile(path.join(folder, name!), saved);

    const restarted = start();
    const [message] = await userMessages(restarted);
    await writeFile(path.join(project.workspacePath, "later.txt"), "later");
    const restored = await restore(message!.checkpointId!, restarted);
    expect(restored.statusCode, restored.body).toBe(204);
    expect(await missing("later.txt")).toBe(true);
    expect(await userMessages(restarted)).toEqual([]);
    // The message is gone from what is saved too.
    await restarted.close();
    expect(await userMessages(start())).toEqual([]);
  });

  it("continues the conversation from the restored point", async () => {
    const { userMessages, send, idle, file, restore } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "notes.txt": "second" } },
      { say: "Changed the notes." },
      { write: { "notes.txt": "third" } },
      { say: "Changed the notes another way." },
    ]);
    await send("Write the notes");
    await idle(1);
    await send("Change the notes");
    await idle(2);
    const [, second] = await userMessages();
    expect((await restore(second!.checkpointId!)).statusCode).toBe(204);

    await send("Change the notes another way");
    await idle(2);
    expect(await file("notes.txt")).toBe("third");
    const messages = await userMessages();
    expect(messages.map((message) => message.text)).toEqual([
      "Write the notes",
      "Change the notes another way",
    ]);
    // The new message has its own checkpoint, taken after the restore.
    expect(messages[1]!.checkpointId).not.toBe(second!.checkpointId);
    expect((await restore(messages[1]!.checkpointId!)).statusCode).toBe(204);
    expect(await file("notes.txt")).toBe("first");
  });

  it("takes a checkpoint for a message that was queued behind a running turn", async () => {
    const { userMessages, send, idle, file, restore } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes.", delayMs: 400 },
      { write: { "notes.txt": "second" } },
      { say: "Changed the notes." },
    ]);
    await send("Write the notes");
    await vi.waitFor(
      async () => expect(await file("notes.txt")).toBe("first"),
      { timeout: 15_000 },
    );
    expect((await send("Change the notes")).queued).toBe(true);
    await idle(2);
    expect(await file("notes.txt")).toBe("second");

    const messages = await userMessages();
    expect(messages.map((message) => message.text)).toEqual([
      "Write the notes",
      "Change the notes",
    ]);
    expect((await restore(messages[1]!.checkpointId!)).statusCode).toBe(204);
    expect(await file("notes.txt")).toBe("first");
  });

  it("takes a checkpoint for a message that was steered into a running turn", async () => {
    const { app, base, userMessages, send, file, restore } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes.", delayMs: 400 },
      { write: { "notes.txt": "second" } },
      { say: "Changed the notes." },
    ]);
    await send("Write the notes");
    await vi.waitFor(
      async () => expect(await file("notes.txt")).toBe("first"),
      { timeout: 15_000 },
    );
    const queued = await send("Change the notes");
    expect(queued.queued).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/queue/${queued.turnId}/steer`,
        })
      ).statusCode,
    ).toBe(204);
    await vi.waitFor(
      async () => expect(await file("notes.txt")).toBe("second"),
      { timeout: 15_000 },
    );
    await vi.waitFor(
      async () =>
        expect(
          (await (await app.inject({ method: "GET", url: base })).json()).agent,
        ).toMatchObject({ status: "idle" }),
      { timeout: 15_000 },
    );

    const messages = await userMessages();
    expect(messages.map((message) => message.text)).toEqual([
      "Write the notes",
      "Change the notes",
    ]);
    expect((await restore(messages[1]!.checkpointId!)).statusCode).toBe(204);
    expect(await file("notes.txt")).toBe("first");
  });

  it("lets the turn run without a checkpoint when the snapshot fails", async () => {
    const { project, userMessages, send, idle, file } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
    ]);
    // A file where the checkpoint store belongs makes every snapshot fail.
    await writeFile(
      path.join(path.dirname(project.workspacePath), "checkpoints"),
      "not a folder",
    );
    await send("Write the notes");
    await idle(1);
    expect(await file("notes.txt")).toBe("first");
    const [message] = await userMessages();
    expect(message).toMatchObject({ text: "Write the notes" });
    expect(message!.checkpointId).toBeUndefined();
  });

  it("restores an Interactive Story project", async () => {
    const { project, userMessages, send, idle, file, missing, restore } =
      await studio(
        [
          {
            write: {
              "nodes/intro/index.html": "<main>changed by the Agent</main>",
              "notes.txt": "first",
            },
          },
          { say: "Changed the intro." },
        ],
        "interactive-story",
      );
    const graph = await file("graph.json");
    await mkdir(path.join(project.workspacePath, "nodes/intro"), {
      recursive: true,
    });
    await writeFile(
      path.join(project.workspacePath, "nodes/intro/index.html"),
      "<main>written by the author</main>",
    );
    await send("Change the intro");
    await idle(1);
    expect(await file("nodes/intro/index.html")).toBe(
      "<main>changed by the Agent</main>",
    );

    const [message] = await userMessages();
    expect((await restore(message!.checkpointId!)).statusCode).toBe(204);
    expect(await missing("notes.txt")).toBe(true);
    expect(await file("graph.json")).toBe(graph);
    expect(await file("nodes/intro/index.html")).toBe(
      "<main>written by the author</main>",
    );
  });

  it("refuses to restore while the Agent is working and for checkpoints it does not have", async () => {
    const { base, app, userMessages, send, idle, file, restore } = await studio(
      [
        { write: { "notes.txt": "first" } },
        { say: "Wrote the notes." },
        { write: { "notes.txt": "second" } },
        { say: "Changed the notes.", delayMs: 600 },
      ],
    );
    await send("Write the notes");
    await idle(1);
    const [first] = await userMessages();

    await send("Change the notes");
    await vi.waitFor(
      async () => expect(await file("notes.txt")).toBe("second"),
      { timeout: 15_000 },
    );
    const busy = await restore(first!.checkpointId!);
    expect(busy.statusCode, busy.body).toBe(409);
    expect(await file("notes.txt")).toBe("second");
    await idle(2);

    expect((await restore("missing")).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base.replace(/[^/]+$/, "missing")}/checkpoints/${first!.checkpointId}/restore`,
        })
      ).statusCode,
    ).toBe(404);
    expect(await file("notes.txt")).toBe("second");
  });

  it("takes no checkpoints in a Canvas project", async () => {
    const { userMessages, send, idle } = await studio(
      [{ say: "Nothing to change." }],
      "asset-canvas",
    );
    await send("Hello");
    await idle(1);
    const [message] = await userMessages();
    expect(message).toMatchObject({ text: "Hello" });
    expect(message!.checkpointId).toBeUndefined();
  });
});

describe("Agent turn changes", () => {
  it("lists what each turn changed", async () => {
    const { project, send, ended, changes, published } = await studio([
      { write: { "notes.txt": "first", "player.txt": "changed by the Agent" } },
      { run: "rm old.txt" },
      { say: "Wrote the notes." },
      { write: { "notes.txt": "second", "extra/added.txt": "added" } },
      { say: "Changed the notes." },
    ]);
    await writeFile(
      path.join(project.workspacePath, "player.txt"),
      "written by the player",
    );
    await writeFile(
      path.join(project.workspacePath, "old.txt"),
      "written by the player",
    );

    await send("Write the notes");
    const first = await ended("Write the notes");
    await send("Change the notes");
    const second = await ended("Change the notes");
    expect(first.changes).toEqual({ files: 3 });
    expect(second.changes).toEqual({ files: 2 });

    // Each turn lists its own files only. The second turn changed the notes again after the first one.
    expect(await changes(first.checkpointId!)).toEqual([
      { path: "notes.txt", kind: "added", state: "changed" },
      { path: "old.txt", kind: "removed", state: "applied" },
      { path: "player.txt", kind: "modified", state: "applied" },
    ]);
    expect(await changes(second.checkpointId!)).toEqual([
      { path: "extra/added.txt", kind: "added", state: "applied" },
      { path: "notes.txt", kind: "modified", state: "applied" },
    ]);
    expect(
      (await published("checkpoint.completed", 2)).map((event) => event.data),
    ).toEqual([
      { checkpointId: first.checkpointId, files: 3 },
      { checkpointId: second.checkpointId, files: 2 },
    ]);
  });

  it("undoes the files of a turn and keeps the conversation", async () => {
    const {
      conversation,
      detail,
      userMessages,
      send,
      file,
      missing,
      ended,
      undo,
      published,
    } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "notes.txt": "second", "extra/added.txt": "added" } },
      { say: "Changed the notes." },
    ]);
    await send("Write the notes");
    await ended("Write the notes");
    await send("Change the notes");
    const second = await ended("Change the notes");

    const undone = await undo(second.checkpointId!);
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json()).toEqual({
      changed: ["extra/added.txt", "notes.txt"],
      conflicts: [],
    });
    expect(await file("notes.txt")).toBe("first");
    expect(await missing("extra")).toBe(true);

    // Only the files went back: both turns are still there, and the second one says that its changes were undone.
    expect((await detail()).turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    const messages = await userMessages();
    expect(messages.map((message) => message.text)).toEqual([
      "Write the notes",
      "Change the notes",
    ]);
    expect(messages.map((message) => message.changes)).toEqual([
      { files: 1 },
      { files: 2, undone: true },
    ]);
    const [event] = await published("workspace.undone");
    expect(event).toMatchObject({
      conversationId: conversation.id,
      data: { checkpointId: second.checkpointId, kept: 0 },
    });
  });

  it("keeps a turn marked as undone when a later message is edited", async () => {
    const {
      app,
      base,
      userMessages,
      send,
      file,
      missing,
      ended,
      undo,
      restore,
    } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "other.txt": "other" } },
      { say: "Wrote another file." },
      { write: { "title.txt": "A title" } },
      { say: "Wrote a title." },
    ]);
    await send("Write the notes");
    const first = await ended("Write the notes");
    await send("Write another file");
    await ended("Write another file");
    expect((await undo(first.checkpointId!)).json()).toEqual({
      changed: ["notes.txt"],
      conflicts: [],
    });
    expect((await userMessages()).map((message) => message.changes)).toEqual([
      { files: 1, undone: true },
      { files: 1 },
    ]);

    // The edit takes the entries after the last message away, the one that says the first turn was undone among them. The files stay.
    const revised = await app.inject({
      method: "POST",
      url: `${base}/revise-last`,
      payload: { prompt: "Write a title" },
    });
    expect(revised.statusCode, revised.body).toBe(202);
    const edited = await ended("Write a title");
    expect(await missing("notes.txt")).toBe(true);
    expect(
      (await userMessages()).map((message) => [message.text, message.changes]),
    ).toEqual([
      ["Write the notes", { files: 1, undone: true }],
      ["Write a title", { files: 1 }],
    ]);

    // The mark now stands before the edited message, as the undo did: going back to before that message keeps both.
    expect((await restore(edited.checkpointId!)).statusCode).toBe(204);
    expect(await missing("notes.txt")).toBe(true);
    expect(await file("other.txt")).toBe("other");
    expect(
      (await userMessages()).map((message) => [message.text, message.changes]),
    ).toEqual([["Write the notes", { files: 1, undone: true }]]);
  });

  it("lets a turn be undone again when a restore brings its files back", async () => {
    const { userMessages, send, file, ended, undo, restore } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "other.txt": "other" } },
      { say: "Wrote another file." },
    ]);
    await send("Write the notes");
    const first = await ended("Write the notes");
    await send("Write another file");
    const second = await ended("Write another file");
    expect((await undo(first.checkpointId!)).json()).toEqual({
      changed: ["notes.txt"],
      conflicts: [],
    });

    // The files go back to before the second message, when the notes had not been undone yet.
    expect((await restore(second.checkpointId!)).statusCode).toBe(204);
    expect(await file("notes.txt")).toBe("first");
    expect(
      (await userMessages()).map((message) => [message.text, message.changes]),
    ).toEqual([["Write the notes", { files: 1 }]]);
  });

  it("does not undo over a file a later turn changed until it is told what to do with it", async () => {
    const twoTurns = async () => {
      const made = await studio([
        { write: { "notes.txt": "first", "other.txt": "other" } },
        { say: "Wrote the notes." },
        { write: { "notes.txt": "second" } },
        { say: "Changed the notes." },
      ]);
      await made.send("Write the notes");
      const first = await made.ended("Write the notes");
      await made.send("Change the notes");
      await made.ended("Change the notes");
      return { ...made, first };
    };

    const { first, userMessages, file, missing, undo } = await twoTurns();
    const refused = await undo(first.checkpointId!);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toEqual({
      error: expect.any(String),
      conflicts: ["notes.txt"],
    });
    expect(await file("notes.txt")).toBe("second");
    expect(await file("other.txt")).toBe("other");
    expect((await userMessages())[0]!.changes).toEqual({ files: 2 });

    const kept = await undo(first.checkpointId!, "keep");
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json()).toEqual({
      changed: ["other.txt"],
      conflicts: ["notes.txt"],
    });
    expect(await file("notes.txt")).toBe("second");
    expect(await missing("other.txt")).toBe(true);
    expect((await userMessages())[0]!.changes).toEqual({
      files: 2,
      undone: true,
      kept: 1,
    });

    const again = await twoTurns();
    const overwritten = await again.undo(again.first.checkpointId!, [
      "notes.txt",
    ]);
    expect(overwritten.statusCode, overwritten.body).toBe(200);
    expect(overwritten.json()).toEqual({
      changed: ["notes.txt", "other.txt"],
      conflicts: [],
    });
    expect(await again.missing("notes.txt")).toBe(true);
    expect(await again.missing("other.txt")).toBe(true);
  });

  it("says so when a file can never be put back", async () => {
    const { project, send, file, missing, ended, undo } = await studio([
      { write: { "notes.txt": "first" } },
      { run: "rm old.txt" },
      { say: "Wrote the notes." },
    ]);
    await writeFile(
      path.join(project.workspacePath, "old.txt"),
      "written by the player",
    );
    await send("Write the notes");
    const turn = await ended("Write the notes");
    // Where the removed file was there is now a folder with files that checkpoints never touch.
    await mkdir(path.join(project.workspacePath, "old.txt/node_modules"), {
      recursive: true,
    });
    await writeFile(
      path.join(project.workspacePath, "old.txt/node_modules/kept.js"),
      "kept",
    );

    const refused = await undo(turn.checkpointId!);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toEqual({
      error: expect.any(String),
      conflicts: ["old.txt"],
    });
    const blocked = await undo(turn.checkpointId!, ["old.txt"]);
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toEqual({
      error: expect.any(String),
      conflicts: ["old.txt"],
      blocked: true,
    });
    expect(await file("notes.txt")).toBe("first");

    const kept = await undo(turn.checkpointId!, "keep");
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json()).toEqual({
      changed: ["notes.txt"],
      conflicts: ["old.txt"],
    });
    expect(await missing("notes.txt")).toBe(true);
    expect(await file("old.txt/node_modules/kept.js")).toBe("kept");
  });

  it("leaves alone what the player changed between two turns", async () => {
    const { project, send, file, missing, ended, changes, undo } = await studio(
      [
        { write: { "notes.txt": "first" } },
        { say: "Wrote the notes." },
        { write: { "extra.txt": "added" } },
        { say: "Added a file." },
      ],
    );
    await writeFile(
      path.join(project.workspacePath, "player.txt"),
      "written by the player",
    );
    await send("Write the notes");
    const first = await ended("Write the notes");
    await writeFile(
      path.join(project.workspacePath, "player.txt"),
      "edited by the player between the turns",
    );
    await send("Add a file");
    const second = await ended("Add a file");

    expect(
      (await changes(first.checkpointId!)).map((change) => change.path),
    ).toEqual(["notes.txt"]);
    expect(
      (await changes(second.checkpointId!)).map((change) => change.path),
    ).toEqual(["extra.txt"]);
    expect((await undo(second.checkpointId!)).json()).toEqual({
      changed: ["extra.txt"],
      conflicts: [],
    });
    expect((await undo(first.checkpointId!)).json()).toEqual({
      changed: ["notes.txt"],
      conflicts: [],
    });
    expect(await missing("extra.txt")).toBe(true);
    expect(await missing("notes.txt")).toBe(true);
    expect(await file("player.txt")).toBe(
      "edited by the player between the turns",
    );
  });

  it("gives a turn that was stopped its end, so it can be undone", async () => {
    const { app, base, detail, send, file, missing, ended, undo } =
      await studio([{ write: { "notes.txt": "first" } }, { hang: true }]);
    const { turnId } = await send("Write the notes");
    await vi.waitFor(
      async () => expect(await file("notes.txt")).toBe("first"),
      { timeout: 15_000 },
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/turns/${turnId}/cancel`,
        })
      ).statusCode,
    ).toBe(202);

    const turn = await ended("Write the notes");
    expect((await detail()).turns.map((item) => item.status)).toEqual([
      "cancelled",
    ]);
    expect(turn.changes).toEqual({ files: 1 });
    expect((await undo(turn.checkpointId!)).json()).toEqual({
      changed: ["notes.txt"],
      conflicts: [],
    });
    expect(await missing("notes.txt")).toBe(true);
  });

  it("gives a turn that failed its end, so it can be undone", async () => {
    const { detail, send, file, missing, ended, undo } = await studio([
      { write: { "notes.txt": "first" } },
      { fail: 500 },
    ]);
    await send("Write the notes");
    const turn = await ended("Write the notes");
    expect((await detail()).turns.map((item) => item.status)).toEqual([
      "failed",
    ]);
    expect(await file("notes.txt")).toBe("first");
    expect(turn.changes).toEqual({ files: 1 });
    expect((await undo(turn.checkpointId!)).json()).toEqual({
      changed: ["notes.txt"],
      conflicts: [],
    });
    expect(await missing("notes.txt")).toBe(true);
  });

  it.each(["queued behind", "steered into"])(
    "gives a message %s a running turn its own changes",
    async (how) => {
      const { app, base, send, file, missing, ended, changes, undo } =
        await studio([
          { write: { "first.txt": "first" } },
          { say: "Wrote the first file.", delayMs: 400 },
          { write: { "second.txt": "second" } },
          { say: "Wrote the second file." },
        ]);
      await send("Write the first file");
      await vi.waitFor(
        async () => expect(await file("first.txt")).toBe("first"),
        { timeout: 15_000 },
      );
      const queued = await send("Write the second file");
      expect(queued.queued).toBe(true);
      if (how === "steered into")
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${base}/queue/${queued.turnId}/steer`,
            })
          ).statusCode,
        ).toBe(204);

      // Both messages were handled in one run, and each turn ends where the next one starts.
      const second = await ended("Write the second file");
      const first = await ended("Write the first file");
      expect(await changes(first.checkpointId!)).toEqual([
        { path: "first.txt", kind: "added", state: "applied" },
      ]);
      expect(await changes(second.checkpointId!)).toEqual([
        { path: "second.txt", kind: "added", state: "applied" },
      ]);

      expect((await undo(first.checkpointId!)).json()).toEqual({
        changed: ["first.txt"],
        conflicts: [],
      });
      expect(await missing("first.txt")).toBe(true);
      expect(await file("second.txt")).toBe("second");
    },
  );

  it("shows and undoes the changes of a turn after a restart", async () => {
    const {
      app,
      start,
      userMessages,
      send,
      file,
      missing,
      ended,
      changes,
      view,
      undo,
    } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "notes.txt": "second", "extra/added.txt": "added" } },
      { say: "Changed the notes." },
    ]);
    await send("Write the notes");
    await ended("Write the notes");
    await send("Change the notes");
    const second = await ended("Change the notes");

    await app.close();
    const restarted = start();
    expect(
      (await userMessages(restarted)).map((message) => message.changes),
    ).toEqual([{ files: 1 }, { files: 2 }]);
    expect(await changes(second.checkpointId!, restarted)).toEqual([
      { path: "extra/added.txt", kind: "added", state: "applied" },
      { path: "notes.txt", kind: "modified", state: "applied" },
    ]);
    expect(await view(second.checkpointId!, "notes.txt", restarted)).toEqual({
      path: "notes.txt",
      before: { binary: false, content: "first" },
      after: { binary: false, content: "second" },
    });

    const undone = await undo(second.checkpointId!, undefined, restarted);
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json()).toEqual({
      changed: ["extra/added.txt", "notes.txt"],
      conflicts: [],
    });
    expect(await file("notes.txt")).toBe("first");
    expect(await missing("extra/added.txt")).toBe(true);
    expect(
      (await userMessages(restarted)).map((message) => message.changes),
    ).toEqual([{ files: 1 }, { files: 2, undone: true }]);
  });

  it("tells how each changed file stands now", async () => {
    const { project, send, ended, changes, undo } = await studio([
      { write: { "notes.txt": "first", "other.txt": "other" } },
      { say: "Wrote the notes." },
    ]);
    await send("Write the notes");
    const turn = await ended("Write the notes");
    const states = async () =>
      Object.fromEntries(
        (await changes(turn.checkpointId!)).map((change) => [
          change.path,
          change.state,
        ]),
      );
    expect(await states()).toEqual({
      "notes.txt": "applied",
      "other.txt": "applied",
    });

    await writeFile(
      path.join(project.workspacePath, "notes.txt"),
      "edited by the player",
    );
    expect(await states()).toEqual({
      "notes.txt": "changed",
      "other.txt": "applied",
    });

    expect((await undo(turn.checkpointId!, "keep")).json()).toEqual({
      changed: ["other.txt"],
      conflicts: ["notes.txt"],
    });
    expect(await states()).toEqual({
      "notes.txt": "changed",
      "other.txt": "undone",
    });
    expect((await undo(turn.checkpointId!, ["notes.txt"])).json()).toEqual({
      changed: ["notes.txt"],
      conflicts: [],
    });
    expect(await states()).toEqual({
      "notes.txt": "undone",
      "other.txt": "undone",
    });
  });

  it("shows a changed file as it was before and after the turn", async () => {
    const long = "x".repeat(300 * 1024);
    const { app, base, project, send, ended, view } = await studio([
      {
        write: {
          "notes.txt": "second",
          "added.txt": "added",
          "data.bin": "a\u0000b",
          "art/hero.png": "not really a picture",
        },
      },
      { run: "rm old.txt long.txt story.txt" },
      { say: "Changed the notes." },
    ]);
    // Three bytes a character, so the cut after 256 KB falls inside one.
    const story = "\u4e2d".repeat(100_000);
    await writeFile(path.join(project.workspacePath, "notes.txt"), "first");
    await writeFile(path.join(project.workspacePath, "old.txt"), "old");
    await writeFile(path.join(project.workspacePath, "long.txt"), long);
    await writeFile(path.join(project.workspacePath, "story.txt"), story);
    await writeFile(
      path.join(project.workspacePath, "player.txt"),
      "not touched by the turn",
    );
    await send("Change the notes");
    const id = (await ended("Change the notes")).checkpointId!;

    expect(await view(id, "notes.txt")).toEqual({
      path: "notes.txt",
      before: { binary: false, content: "first" },
      after: { binary: false, content: "second" },
    });
    expect(await view(id, "added.txt")).toEqual({
      path: "added.txt",
      before: null,
      after: { binary: false, content: "added" },
    });
    expect(await view(id, "old.txt")).toEqual({
      path: "old.txt",
      before: { binary: false, content: "old" },
      after: null,
    });
    // A file is binary by what it holds, and media by its name alone.
    expect(await view(id, "data.bin")).toEqual({
      path: "data.bin",
      before: null,
      after: { binary: true },
    });
    expect(await view(id, "art/hero.png")).toEqual({
      path: "art/hero.png",
      before: null,
      after: { binary: true },
    });
    expect(await view(id, "long.txt")).toEqual({
      path: "long.txt",
      before: {
        binary: false,
        content: long.slice(0, 256 * 1024),
        truncated: true,
      },
      after: null,
    });
    // The cut moves back to where a character starts, so text in another script is still text.
    expect(await view(id, "story.txt")).toEqual({
      path: "story.txt",
      before: {
        binary: false,
        content: story.slice(0, Math.floor((256 * 1024) / 3)),
        truncated: true,
      },
      after: null,
    });

    const get = (checkpointId: string, query: Record<string, string>) =>
      app.inject({
        method: "GET",
        url: `${base}/checkpoints/${checkpointId}/file`,
        query,
      });
    // Only the files of the turn can be read.
    expect((await get(id, { path: "player.txt" })).statusCode).toBe(404);
    expect((await get(id, { path: "../project.json" })).statusCode).toBe(404);
    expect((await get(id, {})).statusCode).toBe(400);
    expect((await get("missing", { path: "notes.txt" })).statusCode).toBe(404);
  });

  it("tells the Agent which files an undo put back", async () => {
    const { app, start, requests, userMessages, send, ended, undo } =
      await studio([
        { write: { "notes.txt": "first", "extra/added.txt": "added" } },
        { say: "Wrote the notes." },
        { say: "Understood." },
        { say: "Still understood." },
      ]);
    await send("Write the notes");
    const turn = await ended("Write the notes");
    expect((await undo(turn.checkpointId!)).statusCode).toBe(200);
    await send("What is there now?");
    await ended("What is there now?");

    const told = (request: ModelRequest) =>
      request.messages
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content))
        .join("\n");
    const note =
      /undid the file changes of an earlier turn.*: extra\/added\.txt, notes\.txt\./;
    expect(
      requests.slice(0, -1).some((request) => note.test(told(request))),
    ).toBe(false);
    expect(told(requests.at(-1)!)).toMatch(note);
    expect(told(requests.at(-1)!)).toContain("What is there now?");
    // The note is for the model; the player sees the turn marked as undone instead.
    expect((await userMessages()).map((message) => message.text)).toEqual([
      "Write the notes",
      "What is there now?",
    ]);

    // It is part of the stored conversation, so the model still has it after a restart.
    await app.close();
    const restarted = start();
    await send("And now?", restarted);
    await ended("And now?", restarted);
    expect(told(requests.at(-1)!)).toMatch(note);
    expect(told(requests.at(-1)!)).toContain("And now?");
  });

  it("refuses to undo while the Agent is working, for checkpoints it does not have, and in a Canvas project", async () => {
    const { app, base, send, file, ended, changes, undo } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "notes.txt": "second" } },
      { hang: true },
    ]);
    await send("Write the notes");
    const first = await ended("Write the notes");

    const running = await send("Change the notes");
    await vi.waitFor(
      async () => expect(await file("notes.txt")).toBe("second"),
      { timeout: 15_000 },
    );
    const busy = await undo(first.checkpointId!, ["notes.txt"]);
    expect(busy.statusCode, busy.body).toBe(409);
    expect(await file("notes.txt")).toBe("second");
    // The files do not hold still, so the list does not say how they stand.
    expect(await changes(first.checkpointId!)).toEqual([
      { path: "notes.txt", kind: "added" },
    ]);
    await app.inject({
      method: "POST",
      url: `${base}/turns/${running.turnId}/cancel`,
    });
    await ended("Change the notes");

    expect((await undo("missing")).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${base}/checkpoints/missing/changes`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/checkpoints/${first.checkpointId}/undo`,
          payload: { conflicts: "merge" },
        })
      ).statusCode,
    ).toBe(400);
    expect(await file("notes.txt")).toBe("second");

    const canvas = await studio(
      [{ say: "Nothing to change." }],
      "asset-canvas",
    );
    expect((await canvas.undo("missing")).statusCode).toBe(404);
    expect(
      (
        await canvas.app.inject({
          method: "GET",
          url: `${canvas.base}/checkpoints/missing/changes`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await canvas.app.inject({
          method: "GET",
          url: `/projects/${canvas.project.id}/checkpoints/unfinished`,
        })
      ).json(),
    ).toEqual({ unfinished: false });
  });

  it("puts the files back after a restore or an undo that was cut off", async () => {
    const { app, base, project, send, file, ended, published } = await studio([
      { write: { "notes.txt": "written by the Agent" } },
      { hang: true },
    ]);
    const unfinished = `/projects/${project.id}/checkpoints/unfinished`;
    await writeFile(path.join(project.workspacePath, "notes.txt"), "whole");
    expect(
      (await app.inject({ method: "GET", url: unfinished })).json(),
    ).toEqual({ unfinished: false });
    expect(
      (await app.inject({ method: "POST", url: `${unfinished}/restore` }))
        .statusCode,
    ).toBe(404);

    // The store offers no way to stop it half way, so what it leaves behind then is written here under the store's own file name.
    const whole = await new CheckpointStore().snapshot(project);
    await writeFile(
      path.join(checkpointDirectory(project), "ohmygame-unfinished.json"),
      JSON.stringify({ previous: whole }),
    );
    expect(
      (await app.inject({ method: "GET", url: unfinished })).json(),
    ).toEqual({ unfinished: true });

    const { turnId } = await send("Write the notes");
    await vi.waitFor(
      async () => expect(await file("notes.txt")).toBe("written by the Agent"),
      { timeout: 15_000 },
    );
    const busy = await app.inject({
      method: "POST",
      url: `${unfinished}/restore`,
    });
    expect(busy.statusCode, busy.body).toBe(409);
    expect(await file("notes.txt")).toBe("written by the Agent");
    await app.inject({ method: "POST", url: `${base}/turns/${turnId}/cancel` });
    await ended("Write the notes");

    const restored = await app.inject({
      method: "POST",
      url: `${unfinished}/restore`,
    });
    expect(restored.statusCode, restored.body).toBe(204);
    expect(await file("notes.txt")).toBe("whole");
    expect(
      (await app.inject({ method: "GET", url: unfinished })).json(),
    ).toEqual({ unfinished: false });
    // The whole project went back, not one conversation.
    const [event] = await published("workspace.restored");
    expect(event).toMatchObject({ data: {} });
    expect(event).not.toHaveProperty("conversationId");
  });

  it("overwrites only the files the player was shown", async () => {
    const { app, base, project, send, file, ended, undo } = await studio([
      { write: { "a.txt": "after a", "b.txt": "after b" } },
      { say: "Changed both." },
    ]);
    const write = (name: string, content: string) =>
      writeFile(path.join(project.workspacePath, name), content);
    await write("a.txt", "before a");
    await write("b.txt", "before b");
    await send("Change both");
    const turn = await ended("Change both");

    await write("a.txt", "edited by the player");
    const shown = await undo(turn.checkpointId!);
    expect(shown.statusCode, shown.body).toBe(409);
    expect(shown.json()).toEqual({
      error: expect.any(String),
      conflicts: ["a.txt"],
    });
    const unnamed = await app.inject({
      method: "POST",
      url: `${base}/checkpoints/${turn.checkpointId}/undo`,
      payload: { conflicts: "overwrite" },
    });
    expect(unnamed.statusCode, unnamed.body).toBe(400);

    // Before the player answers, another file of the turn is changed as well: the answer does not cover it.
    await write("b.txt", "edited by the player later");
    const grown = await undo(turn.checkpointId!, ["a.txt"]);
    expect(grown.statusCode, grown.body).toBe(409);
    expect(grown.json()).toEqual({
      error: expect.any(String),
      conflicts: ["a.txt", "b.txt"],
    });
    expect(await file("a.txt")).toBe("edited by the player");
    expect(await file("b.txt")).toBe("edited by the player later");

    // A file that is no longer in the way does not have to be named.
    await write("b.txt", "after b");
    const overwritten = await undo(turn.checkpointId!, ["a.txt", "gone.txt"]);
    expect(overwritten.statusCode, overwritten.body).toBe(200);
    expect(overwritten.json()).toEqual({
      changed: ["a.txt", "b.txt"],
      conflicts: [],
    });
    expect(await file("a.txt")).toBe("before a");
    expect(await file("b.txt")).toBe("before b");
    // With nothing in the way there is nothing to overwrite, and the undo is the plain one.
    expect((await undo(turn.checkpointId!, ["a.txt"])).json()).toEqual({
      changed: [],
      conflicts: [],
    });
  });

  it("says how many files an undo left as they are, until those are put back as well", async () => {
    const { project, userMessages, send, ended, undo, published } =
      await studio([
        { write: { "notes.txt": "first", "other.txt": "other" } },
        { say: "Wrote the notes." },
      ]);
    await send("Write the notes");
    const turn = await ended("Write the notes");
    await writeFile(
      path.join(project.workspacePath, "notes.txt"),
      "edited by the player",
    );

    expect((await undo(turn.checkpointId!, "keep")).json()).toEqual({
      changed: ["other.txt"],
      conflicts: ["notes.txt"],
    });
    expect((await userMessages())[0]!.changes).toEqual({
      files: 2,
      undone: true,
      kept: 1,
    });
    expect((await undo(turn.checkpointId!, ["notes.txt"])).json()).toEqual({
      changed: ["notes.txt"],
      conflicts: [],
    });
    expect((await userMessages())[0]!.changes).toEqual({
      files: 2,
      undone: true,
    });
    expect(
      (await published("workspace.undone", 2)).map((event) => event.data),
    ).toEqual([
      { checkpointId: turn.checkpointId, kept: 1 },
      { checkpointId: turn.checkpointId, kept: 0 },
    ]);
  });

  it("marks a turn whose files were already back, and nothing after an undo that left every file as it is", async () => {
    const { app, project, userMessages, send, ended, undo, published } =
      await studio([
        { write: { "notes.txt": "first", "other.txt": "other" } },
        { say: "Wrote the notes." },
      ]);
    const updatedAt = async () =>
      (
        (
          await app.inject({ method: "GET", url: `/projects/${project.id}` })
        ).json() as { updatedAt: string }
      ).updatedAt;
    await send("Write the notes");
    const turn = await ended("Write the notes");
    const edit = (name: string) =>
      writeFile(path.join(project.workspacePath, name), "edited by the player");
    await edit("notes.txt");
    await edit("other.txt");

    // Nothing was put back: the turn is not marked, and the project is as it was.
    const before = await updatedAt();
    expect((await undo(turn.checkpointId!, "keep")).json()).toEqual({
      changed: [],
      conflicts: ["notes.txt", "other.txt"],
    });
    expect((await userMessages())[0]!.changes).toEqual({ files: 2 });
    expect(await updatedAt()).toBe(before);

    // One file went back and one was kept: the project changed.
    await rm(path.join(project.workspacePath, "other.txt"));
    await writeFile(path.join(project.workspacePath, "other.txt"), "other");
    expect((await undo(turn.checkpointId!, "keep")).json()).toEqual({
      changed: ["other.txt"],
      conflicts: ["notes.txt"],
    });
    const afterKeep = await updatedAt();
    expect(afterKeep).not.toBe(before);

    // The player removed the last file themselves, so there is nothing left to put back, and the turn says so.
    await rm(path.join(project.workspacePath, "notes.txt"));
    expect((await undo(turn.checkpointId!)).json()).toEqual({
      changed: [],
      conflicts: [],
    });
    expect((await userMessages())[0]!.changes).toEqual({
      files: 2,
      undone: true,
    });
    expect(await updatedAt()).toBe(afterKeep);
    // The undo that kept every file published nothing: the first event is the one of the undo that put a file back.
    expect(
      (await published("workspace.undone", 2)).map((event) => event.data),
    ).toEqual([
      { checkpointId: turn.checkpointId, kept: 1 },
      { checkpointId: turn.checkpointId, kept: 0 },
    ]);
  });

  it.each(["undo", "restore"] as const)(
    "says that the files are partly changed when the %s could not take back what it had done",
    async (how) => {
      const { app, base, send, ended } = await studio([
        { write: { "notes.txt": "first" } },
        { say: "Wrote the notes." },
      ]);
      await send("Write the notes");
      const turn = await ended("Write the notes");
      // The store gets there only when a write fails and taking it back fails too, so its answer is put in its place.
      vi.spyOn(CheckpointStore.prototype, how).mockRejectedValue(
        new CheckpointIncompleteError(
          "a".repeat(40),
          "a".repeat(40),
          new Error("disk failure"),
        ),
      );

      const response = await app.inject({
        method: "POST",
        url: `${base}/checkpoints/${turn.checkpointId}/${how}`,
        ...(how === "undo" ? { payload: {} } : {}),
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toEqual({
        error: "The workspace is partly changed",
        code: "CHECKPOINT_INCOMPLETE",
      });
    },
  );

  it("lists what putting the files back would do to each file", async () => {
    const { app, project, file, missing } = await studio([]);
    const unfinished = `/projects/${project.id}/checkpoints/unfinished`;
    const write = (name: string, content: string) =>
      writeFile(path.join(project.workspacePath, name), content);
    expect(
      (await app.inject({ method: "GET", url: `${unfinished}/changes` }))
        .statusCode,
    ).toBe(404);

    await write("notes.txt", "whole");
    await write("old.txt", "there before");
    await write("same.txt", "the same");
    const whole = await new CheckpointStore().snapshot(project);
    await writeFile(
      path.join(checkpointDirectory(project), "ohmygame-unfinished.json"),
      JSON.stringify({ previous: whole }),
    );
    // What was done since goes with it: the list is of the workspace as it is now.
    await write("notes.txt", "changed since");
    await write("new.txt", "made since");
    await rm(path.join(project.workspacePath, "old.txt"));

    const listed = await app.inject({
      method: "GET",
      url: `${unfinished}/changes`,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({
      changes: [
        { path: "new.txt", kind: "removed" },
        { path: "notes.txt", kind: "modified" },
        { path: "old.txt", kind: "added" },
      ],
    });
    // Listing changes nothing, and putting back does what was listed.
    expect(await file("notes.txt")).toBe("changed since");
    const updatedAt = async () =>
      (
        (
          await app.inject({ method: "GET", url: `/projects/${project.id}` })
        ).json() as { updatedAt: string }
      ).updatedAt;
    const before = await updatedAt();
    expect(
      (await app.inject({ method: "POST", url: `${unfinished}/restore` }))
        .statusCode,
    ).toBe(204);
    expect(await file("notes.txt")).toBe("whole");
    expect(await file("old.txt")).toBe("there before");
    expect(await missing("new.txt")).toBe(true);
    expect(await updatedAt()).not.toBe(before);
    expect(
      (await app.inject({ method: "GET", url: `${unfinished}/changes` }))
        .statusCode,
    ).toBe(404);
  });

  it("answers with the store's own words when it does not hold a snapshot it is asked for", async () => {
    const { app, base, project, send, ended } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
    ]);
    await send("Write the notes");
    const turn = await ended("Write the notes");
    const unfinished = `/projects/${project.id}/checkpoints/unfinished`;
    await writeFile(
      path.join(checkpointDirectory(project), "ohmygame-unfinished.json"),
      JSON.stringify({ previous: "0".repeat(40) }),
    );
    // The conversation still names the snapshots of its turn, and the store has lost them.
    await rm(path.join(checkpointDirectory(project), "objects"), {
      recursive: true,
    });

    for (const request of [
      {
        method: "GET",
        url: `${base}/checkpoints/${turn.checkpointId}/changes`,
      },
      {
        method: "GET",
        url: `${base}/checkpoints/${turn.checkpointId}/file`,
        query: { path: "notes.txt" },
      },
      {
        method: "POST",
        url: `${base}/checkpoints/${turn.checkpointId}/undo`,
        payload: {},
      },
      {
        method: "POST",
        url: `${base}/checkpoints/${turn.checkpointId}/restore`,
      },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.url} ${response.body}`).toBe(409);
      expect(response.json(), request.url).toEqual({
        error: expect.stringMatching(
          /^Checkpoint object [0-9a-f]{40} does not exist$/,
        ),
      });
    }
    // A note that names a snapshot the store does not hold says nothing a restore could use, so it reads as none.
    expect(
      (await app.inject({ method: "GET", url: unfinished })).json(),
    ).toEqual({ unfinished: false });
    for (const request of [
      { method: "GET", url: `${unfinished}/changes` },
      { method: "POST", url: `${unfinished}/restore` },
    ] as const) {
      expect((await app.inject(request)).statusCode, request.url).toBe(404);
    }
  });

  it("starts no turn in the project while files are being put back, and says why", async () => {
    const { app, base, project, another, post, send, ended, undo } =
      await studio([
        { write: { "notes.txt": "first" } },
        { say: "Wrote the notes." },
        { say: "Hello." },
      ]);
    await send("Write the notes");
    const turn = await ended("Write the notes");
    const elsewhere = await another();
    const unfinished = `/projects/${project.id}/checkpoints/unfinished/restore`;
    const refused = async (response: Awaited<ReturnType<typeof post>>) => {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toEqual({
        error: "Wait until the project's files have been put back",
      });
    };

    const undoing = hold("undo");
    const undone = undo(turn.checkpointId!);
    await undoing.reached;
    await refused(await post("Do it another way"));
    await refused(await post("Hello", elsewhere));
    await refused(await undo(turn.checkpointId!));
    undoing.release();
    expect((await undone).statusCode, (await undone).body).toBe(200);

    // The put-back after an interruption is no conversation's own, and holds the project just the same.
    await writeFile(
      path.join(checkpointDirectory(project), "ohmygame-unfinished.json"),
      JSON.stringify({
        previous: await new CheckpointStore().snapshot(project),
      }),
    );
    await writeFile(
      path.join(project.workspacePath, "notes.txt"),
      "written since",
    );
    const restoring = hold("restore");
    const restored = app.inject({ method: "POST", url: unfinished });
    await restoring.reached;
    await refused(await post("Do it another way"));
    await refused(await post("Hello", elsewhere));
    restoring.release();
    expect((await restored).statusCode, (await restored).body).toBe(204);

    expect((await post("Hello", elsewhere)).statusCode).toBe(202);
    await vi.waitFor(
      async () =>
        expect(
          (
            (
              await app.inject({ method: "GET", url: elsewhere })
            ).json() as ConversationDetail
          ).turns.map((item) => item.status),
        ).toEqual(["completed"]),
      { timeout: 15_000 },
    );
  });

  it("gives an edited message whose snapshot failed no checkpoint, and not the one of the message it replaced", async () => {
    const {
      app,
      base,
      project,
      detail,
      userMessages,
      send,
      file,
      ended,
      undo,
    } = await studio([
      { write: { "first.txt": "written by the first version of the turn" } },
      { say: "Wrote the first file." },
      { write: { "second.txt": "written by the edited turn" } },
      { say: "Wrote the second file." },
    ]);
    await send("Write a file");
    const replaced = await ended("Write a file");
    await writeFile(
      path.join(project.workspacePath, "player.txt"),
      "written by the player after the turn",
    );

    // The snapshot before the edited message fails once, as a full disk would make it.
    vi.spyOn(CheckpointStore.prototype, "snapshot").mockRejectedValueOnce(
      new Error("ENOSPC: no space left on device"),
    );
    const revised = await app.inject({
      method: "POST",
      url: `${base}/revise-last`,
      payload: { prompt: "Write another file" },
    });
    expect(revised.statusCode, revised.body).toBe(202);
    // Once the turn is closed it is read from the stored conversation, where it has another id.
    await vi.waitFor(
      async () => {
        const current = await detail();
        expect(current.turns.map((turn) => turn.status)).toEqual(["completed"]);
        expect(current.turns[0]!.id).not.toBe(revised.json().turnId);
      },
      { timeout: 15_000 },
    );

    const [edited] = await userMessages();
    expect(edited).toMatchObject({ text: "Write another file" });
    expect(edited!.checkpointId).toBeUndefined();
    expect(edited!.changes).toBeUndefined();
    // No range reaches back to before the message that was replaced: its files and the player's stay.
    expect((await undo(replaced.checkpointId!)).statusCode).toBe(404);
    expect(await file("first.txt")).toBe(
      "written by the first version of the turn",
    );
    expect(await file("player.txt")).toBe(
      "written by the player after the turn",
    );
    expect(await file("second.txt")).toBe("written by the edited turn");
  });
});

describe("The end of a turn", () => {
  const turn = (): Step[] => [
    { write: { "notes.txt": "first" } },
    { say: "Wrote the notes." },
  ];

  it("takes a message, ignores Stop and shows the turn as over while its end is being recorded", async () => {
    const { app, base, detail, userMessages, post, send, ended, published } =
      await studio([...turn(), { say: "Added a title." }]);
    // The first snapshot is the checkpoint of the message, the second one closes the turn.
    const closing = hold("snapshot", 2);
    const { turnId } = await send("Write the notes");
    await closing.reached;

    // The run is over and the conversation says so, though what the turn changed is not known yet.
    const during = await detail();
    expect(during.agent).toEqual({ status: "idle" });
    expect(during.turns.map((item) => item.status)).toEqual(["completed"]);
    expect((await userMessages())[0]!.changes).toBeUndefined();

    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/turns/${turnId}/cancel`,
        })
      ).statusCode,
    ).toBe(202);
    expect((await detail()).agent).toEqual({ status: "idle" });

    // The next message waits for the end of the turn and is then taken.
    let answered = false;
    const next = post("Add a title").then((response) => {
      answered = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    closing.release();
    expect((await next).statusCode, (await next).body).toBe(202);
    await ended("Add a title");
    expect(
      (await userMessages()).map((message) => [message.text, message.changes]),
    ).toEqual([
      ["Write the notes", { files: 1 }],
      ["Add a title", { files: 0 }],
    ]);
    expect((await detail()).agent).toEqual({ status: "idle" });
    // Whoever loaded the conversation in between is told what the turn changed by the event that follows.
    const [event] = await published("checkpoint.completed");
    expect(event!.id).toBeGreaterThan(during.cursor);
  });

  it("tells what a turn changed to a conversation that is loaded while the turn is closed", async () => {
    const { detail, send, published } = await studio(turn());
    const closing = hold("snapshot", 2);
    await send("Write the notes");
    await closing.reached;

    // The last read of the session file for one request is kept from returning until the turn is closed, so that
    // request has the file as it was before the end of the turn was written.
    const view = ConversationManager.prototype.view;
    let views = 0;
    const counting = vi
      .spyOn(ConversationManager.prototype, "view")
      .mockImplementation(function (this: ConversationManager, ...args) {
        views += 1;
        return view.apply(this, args);
      });
    await detail();
    const perRequest = views;
    counting.mockRestore();
    const read = gate();
    const resume = gate();
    let seen = 0;
    vi.spyOn(ConversationManager.prototype, "view").mockImplementation(
      async function (this: ConversationManager, ...args) {
        const manager = await view.apply(this, args);
        if (++seen !== perRequest) return manager;
        const branch = manager.getBranch();
        read.open();
        await resume.opened;
        return { getBranch: () => branch } as never;
      },
    );
    const loading = detail();
    await read.opened;
    closing.release();
    const [event] = await published("checkpoint.completed");
    resume.open();

    // Either the answer says what the turn changed, or the event that says so is still to come.
    const loaded = await loading;
    const [message] = loaded.turns
      .flatMap((item) => item.items)
      .filter(
        (item): item is Extract<ThreadItem, { type: "userMessage" }> =>
          item.type === "userMessage",
      );
    expect(loaded.turns.map((item) => item.status)).toEqual(["completed"]);
    expect(
      message!.changes ??
        (loaded.cursor < event!.id ? "told by the event" : "never told"),
    ).not.toBe("never told");
  });

  it("tells what a turn changed to a conversation whose read was answered with one that began before the turn was closed", async () => {
    const { detail, send, published } = await studio(turn());
    const closing = hold("snapshot", 2);
    await send("Write the notes");
    await closing.reached;

    // Reads of one session file that overlap share one answer. Here the turn is closed while a request is on its
    // way, and the read it then does for the conversation is given the file as an earlier read found it.
    const view = ConversationManager.prototype.view;
    const run = vi.spyOn(AgentManager.prototype, "activeStart");
    let views = 0;
    let before: unknown;
    let shared = false;
    vi.spyOn(ConversationManager.prototype, "view").mockImplementation(
      async function (this: ConversationManager, ...args) {
        const manager = await view.apply(this, args);
        if (++views === 1) {
          const branch = manager.getBranch();
          before = { getBranch: () => branch };
          closing.release();
          await published("checkpoint.completed");
        } else if (run.mock.calls.length > 0 && !shared) {
          shared = true;
          return before as never;
        }
        return manager;
      },
    );

    const loaded = await detail();
    const [event] = await published("checkpoint.completed");
    const [message] = loaded.turns
      .flatMap((item) => item.items)
      .filter(
        (item): item is Extract<ThreadItem, { type: "userMessage" }> =>
          item.type === "userMessage",
      );
    expect(shared).toBe(true);
    expect(
      message!.changes ??
        (loaded.cursor < event!.id ? "told by the event" : "never told"),
    ).not.toBe("never told");
  });

  it("lets the last message be edited while its turn is being closed, and does not call the project at work", async () => {
    const { app, base, userMessages, send, ended, file } = await studio([
      ...turn(),
      { write: { "title.txt": "A title" } },
      { say: "Wrote a title." },
    ]);
    const closing = hold("snapshot", 2);
    await send("Write the notes");
    await closing.reached;
    expect(
      (await app.inject({ method: "GET", url: "/projects/activity" })).json(),
    ).toEqual([]);

    // The conversation reads as idle, so the edit is not refused. It waits for the end of the turn and then starts.
    let answered = false;
    const revising = app
      .inject({
        method: "POST",
        url: `${base}/revise-last`,
        payload: { prompt: "Write a title" },
      })
      .then((response) => {
        answered = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    closing.release();
    const revised = await revising;
    expect(revised.statusCode, revised.body).toBe(202);
    expect((await ended("Write a title")).changes).toEqual({ files: 1 });
    expect((await userMessages()).map((message) => message.text)).toEqual([
      "Write a title",
    ]);
    expect(await file("title.txt")).toBe("A title");
  });

  it("says how the files of an earlier turn stand to a list that is read while a later turn is being closed", async () => {
    const { app, base, send, ended } = await studio([
      ...turn(),
      { write: { "title.txt": "A title" } },
      { say: "Wrote a title." },
    ]);
    await send("Write the notes");
    const first = await ended("Write the notes");
    // From here on the first snapshot is the checkpoint of the second message, and the second one closes its turn.
    const closing = hold("snapshot", 2);
    await send("Write a title");
    await closing.reached;

    // The app reads its lists again when a run ends. The project is still busy then, and the answer waits for that.
    let answered = false;
    const reading = app
      .inject({
        method: "GET",
        url: `${base}/checkpoints/${first.checkpointId}/changes`,
      })
      .then((response) => {
        answered = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    closing.release();
    expect((await reading).json()).toEqual({
      changes: [{ path: "notes.txt", kind: "added", state: "applied" }],
    });
  });

  it("deletes a project whose turn is being closed once that is done", async () => {
    const { app, project, send } = await studio(turn());
    const closing = hold("snapshot", 2);
    await send("Write the notes");
    await closing.reached;

    let answered = false;
    const deleting = app
      .inject({ method: "DELETE", url: `/projects/${project.id}` })
      .then((response) => {
        answered = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    closing.release();
    expect((await deleting).statusCode, (await deleting).body).toBe(204);
  });

  it("reads the conversation again when the end of a turn was written during the read with no run under way", async () => {
    const { detail, send, ended } = await studio(turn());
    await send("Write the notes");
    await ended("Write the notes");
    const view = vi.spyOn(ConversationManager.prototype, "view");
    await detail();
    const perRequest = view.mock.calls.length;

    // As when a snapshot that took long comes back while the file is read: the count of ends moves, and no run does.
    vi.spyOn(AgentManager.prototype, "turnEndsRecorded")
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    view.mockClear();
    const [message] = (await detail()).turns
      .flatMap((item) => item.items)
      .filter(
        (item): item is Extract<ThreadItem, { type: "userMessage" }> =>
          item.type === "userMessage",
      );
    expect(view.mock.calls.length).toBe(perRequest + 2);
    expect(message!.changes).toEqual({ files: 1 });
  });

  it("answers a list of changes from a read that began after the turn was closed", async () => {
    const { app, base, detail, userMessages, send } = await studio(turn());
    const closing = hold("snapshot", 2);
    await send("Write the notes");
    await closing.reached;
    const [message] = await userMessages();

    // Reads of one session file that overlap share one answer, so the first read after the wait may be given the
    // file as it was before the end of the turn was written.
    const view = ConversationManager.prototype.view;
    const turnsClosed = AgentManager.prototype.turnsClosed;
    let stale: unknown;
    let waited = false;
    vi.spyOn(AgentManager.prototype, "turnsClosed").mockImplementation(
      async function (this: AgentManager, ...args) {
        await turnsClosed.apply(this, args);
        waited = true;
      },
    );
    vi.spyOn(ConversationManager.prototype, "view").mockImplementation(
      async function (this: ConversationManager, ...args) {
        const manager = await view.apply(this, args);
        if (!stale) {
          const branch = manager.getBranch();
          stale = { getBranch: () => branch };
        }
        if (!waited) return manager;
        waited = false;
        return stale as never;
      },
    );
    await detail();
    const reading = app.inject({
      method: "GET",
      url: `${base}/checkpoints/${message!.checkpointId}/changes`,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    closing.release();
    const response = await reading;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      changes: [{ path: "notes.txt", kind: "added", state: "applied" }],
    });
  });

  it.each(["restored to", "edited"] as const)(
    "keeps what the turn before a queued message changed when that message is %s",
    async (how) => {
      const {
        app,
        base,
        userMessages,
        send,
        idle,
        ended,
        restore,
        changes,
        undo,
        file,
        missing,
      } = await studio([
        { write: { "notes.txt": "first" } },
        { say: "Wrote the notes.", delayMs: 400 },
        { write: { "title.txt": "A title" } },
        { say: "Wrote a title." },
        { write: { "other.txt": "Another title" } },
        { say: "Wrote another title." },
      ]);
      // The second message is queued behind the first, so the ends of both turns are written when the run is over,
      // which is after the second message.
      await send("Write the notes");
      await vi.waitFor(
        async () => expect(await file("notes.txt")).toBe("first"),
        { timeout: 15_000 },
      );
      expect((await send("Write a title")).queued).toBe(true);
      await idle(2);
      const first = await ended("Write the notes");
      const second = await ended("Write a title");
      expect([first.changes, second.changes]).toEqual([
        { files: 1 },
        { files: 1 },
      ]);

      if (how === "restored to") {
        expect((await restore(second.checkpointId!)).statusCode).toBe(204);
        expect(
          (await userMessages()).map((message) => [
            message.text,
            message.changes,
          ]),
        ).toEqual([["Write the notes", { files: 1 }]]);
        expect(await missing("title.txt")).toBe(true);
      } else {
        const revised = await app.inject({
          method: "POST",
          url: `${base}/revise-last`,
          payload: { prompt: "Write another title" },
        });
        expect(revised.statusCode, revised.body).toBe(202);
        await ended("Write another title");
        expect(
          (await userMessages()).map((message) => [
            message.text,
            message.changes,
          ]),
        ).toEqual([
          ["Write the notes", { files: 1 }],
          ["Write another title", { files: 1 }],
        ]);
        expect(await file("other.txt")).toBe("Another title");
      }
      // The first turn can still be looked at and undone.
      expect(await changes(first.checkpointId!)).toEqual([
        { path: "notes.txt", kind: "added", state: "applied" },
      ]);
      expect((await undo(first.checkpointId!)).json()).toEqual({
        changed: ["notes.txt"],
        conflicts: [],
      });
      expect(await missing("notes.txt")).toBe(true);
    },
  );
});
