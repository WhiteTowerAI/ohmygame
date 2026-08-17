import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentManager, conversationItems, lastAssistantError, type CodingSession } from "../src/daemon/agent.js";
import type { StoredConversation } from "../src/daemon/conversations.js";
import type { AgentReasoningLevel, ProjectState } from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";

describe("lastAssistantError", () => {
  it("surfaces model errors even when Pi resolves the prompt", () => {
    expect(lastAssistantError([
      { role: "user", content: [] },
      { role: "assistant", stopReason: "error", errorMessage: "No API key" },
    ])).toBe("No API key");
  });

  it("does not turn a successful assistant response into an error", () => {
    expect(lastAssistantError([{ role: "assistant", stopReason: "stop" }])).toBeUndefined();
  });
});

describe("conversationItems", () => {
  it("restores user, assistant, and tool activity without internal content", () => {
    expect(conversationItems([
      sessionMessage("user-1", { role: "user", content: [{ type: "text", text: "Build a game" }], timestamp: 1 }),
      sessionMessage("assistant-1", {
        role: "assistant",
        content: [
          { type: "text", text: "I will build it. " },
          { type: "toolCall", id: "call-1", name: "write", arguments: { path: "secret", content: "private source" } },
          { type: "text", text: "Starting now." },
        ],
        stopReason: "toolUse",
      }),
      sessionMessage("tool-1", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "write",
        content: [{ type: "text", text: "large private output" }],
        isError: false,
        timestamp: 2,
      }),
      sessionMessage("assistant-2", {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
      }),
    ] as never)).toEqual([
      { id: "user-1", turnId: "user-1", kind: "user", text: "Build a game", timestamp: 1 },
      { id: "assistant-1:assistant", turnId: "user-1", kind: "assistant", text: "I will build it. Starting now.", status: "complete", timestamp: 0 },
      {
        id: "assistant-1:tool:call-1",
        turnId: "user-1",
        kind: "tool",
        toolCallId: "call-1",
        toolName: "write",
        status: "complete",
        args: { path: "secret" },
        output: "large private output",
        timestamp: 2,
      },
      { id: "assistant-2:assistant", turnId: "user-1", kind: "assistant", text: "Done.", status: "complete", timestamp: 0 },
    ]);
  });

  it("restores assistant errors and cancelled turns", () => {
    expect(conversationItems([
      sessionMessage("error", { role: "assistant", content: [], stopReason: "error", errorMessage: "No API key" }),
      sessionMessage("user", { role: "user", content: "Stop", timestamp: 1 }),
      sessionMessage("cancelled", { role: "assistant", content: [], stopReason: "aborted" }),
    ] as never)).toEqual([
      { id: "error:assistant", turnId: "error", kind: "assistant", text: "", status: "error", error: "No API key", timestamp: 0 },
      { id: "user", turnId: "user", kind: "user", text: "Stop", timestamp: 1 },
      { id: "cancelled:assistant", turnId: "user", kind: "assistant", text: "", status: "cancelled", timestamp: 0 },
    ]);
  });

  it("restores images from Pi user messages", () => {
    expect(conversationItems([
      sessionMessage("user", {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
        timestamp: 1,
      }),
    ] as never, false)).toEqual([{
      id: "user",
      turnId: "user",
      kind: "user",
      text: "",
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      timestamp: 1,
    }]);
  });

  it("marks a turn interrupted when its persisted session has no terminal assistant message", () => {
    expect(conversationItems([
      sessionMessage("user", { role: "user", content: "Build", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "index.html" } }],
        stopReason: "toolUse",
      }),
    ] as never).at(-1)).toMatchObject({ kind: "assistant", status: "interrupted" });
  });

  it("truncates large tool output while keeping its beginning and end", () => {
    const output = `start-${"x".repeat(13_000)}-end`;
    const items = conversationItems([
      sessionMessage("user", { role: "user", content: "Run", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "test" } }],
        stopReason: "toolUse",
      }),
      sessionMessage("tool", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: output }],
        isError: false,
      }),
    ] as never);

    expect(items[1]).toMatchObject({ kind: "tool", truncated: true });
    expect(items[1]?.kind === "tool" && items[1].output).toContain("start-");
    expect(items[1]?.kind === "tool" && items[1].output).toContain("-end");
  });

  it("keeps only display-safe arguments for built-in tools", () => {
    const items = conversationItems([
      sessionMessage("user", { role: "user", content: "Change it", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "write", name: "write", arguments: { path: "src/app.ts", content: "private source" } },
          { type: "toolCall", id: "edit", name: "edit", arguments: { path: "src/app.ts", oldText: "private", newText: "source" } },
          { type: "toolCall", id: "read", name: "read", arguments: { path: "src/app.ts", offset: 2, limit: 20, extra: "drop" } },
          { type: "toolCall", id: "bash", name: "bash", arguments: { command: "npm test", timeout: 30, cwd: "/private" } },
        ],
        stopReason: "toolUse",
      }),
    ] as never).filter((item) => item.kind === "tool");

    expect(items.map((item) => item.args)).toEqual([
      { path: "src/app.ts" },
      { path: "src/app.ts" },
      { path: "src/app.ts", offset: 2, limit: 20 },
      { command: "npm test", timeout: 30 },
    ]);
  });

  it("bounds arguments from custom tools", () => {
    const items = conversationItems([
      sessionMessage("user", { role: "user", content: "Generate", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "custom", name: "custom", arguments: { prompt: "x".repeat(3_000) } }],
        stopReason: "toolUse",
      }),
    ] as never);

    expect(items[1]?.kind === "tool" && typeof items[1].args === "string" && items[1].args.length).toBeLessThan(2_100);
  });
});

describe("AgentManager", () => {
  it("sends images through Pi prompt options", async () => {
    const session = new FakeSession();
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "", [], [{ mediaType: "image/png", data: "aW1hZ2U=" }]).result;

    expect(session.prompt).toHaveBeenCalledWith("", {
      images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
    });
    await manager.close();
  });

  it("keeps image data out of replay events", async () => {
    const session = new FakeSession();
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };

    await manager.prompt(project, conversation, "Describe", [], [image]).result;

    expect(events.since(project.id).find((event) => event.type === "agent.started")?.data).toEqual({ prompt: "Describe" });
    expect(events.canReplay(project.id, 0)).toBe(false);
    await manager.close();
  });

  it("queues one follow-up for the active conversation", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const firstRun = manager.prompt(project, conversation, "First").result;
    expect(manager.state(conversation).agent.status).toBe("running");
    const queued = manager.prompt(project, conversation, "Second");
    expect(queued).toMatchObject({ queued: true, turnId: expect.any(String) });
    expect(manager.pendingPrompt(project.id, conversation.summary.id)).toMatchObject({ prompt: "Second" });

    prompt.resolve();
    await expect(firstRun).resolves.toBe("completed");
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(session.prompt).toHaveBeenNthCalledWith(2, "Second");
    expect(manager.pendingPrompt(project.id, conversation.summary.id)).toBeUndefined();
    await manager.close();
  });

  it("replaces and removes the single pending follow-up", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "First").result;
    const stale = manager.prompt(project, conversation, "Second");
    const replacement = manager.prompt(project, conversation, "Replacement", [{ type: "workspace-file", path: "src/app.ts" }]);
    expect(manager.pendingPrompt(project.id, conversation.summary.id)).toMatchObject({
      prompt: "Replacement",
      references: [{ type: "workspace-file", path: "src/app.ts" }],
    });

    expect(manager.removePending(project.id, conversation.summary.id, stale.turnId)).toBe(false);
    expect(manager.pendingPrompt(project.id, conversation.summary.id)?.turnId).toBe(replacement.turnId);
    expect(manager.removePending(project.id, conversation.summary.id, replacement.turnId)).toBe(true);
    expect(manager.pendingPrompt(project.id, conversation.summary.id)).toBeUndefined();
    expect(events.since(project.id).at(-1)?.type).toBe("prompt.removed");
    prompt.resolve();
    await run;
    expect(session.prompt).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("allows only one active turn across a project's conversations", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const first = createConversation(project, "conversation-1");
    const second = createConversation(project, "conversation-2");

    const run = manager.prompt(project, first, "First").result;
    expect(() => manager.prompt(project, second, "Second")).toThrow("already running in this project");

    prompt.resolve();
    await run;
    await manager.close();
  });

  it("cancels only the exact active conversation and turn", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    session.abort.mockImplementation(async () => prompt.resolve());
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const turn = manager.prompt(project, conversation, "Build");
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    await manager.cancel(project.id, "another-conversation", turn.turnId);
    await manager.cancel(project.id, conversation.summary.id, "another-turn");
    expect(session.abort).not.toHaveBeenCalled();

    await manager.cancel(project.id, conversation.summary.id, turn.turnId);
    await expect(turn.result).resolves.toBe("cancelled");
    expect(session.abort).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("surfaces session initialization failures", async () => {
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => { throw new Error("Auth unavailable"); } });
    const project = createProject();
    const conversation = createConversation(project);

    await expect(manager.prompt(project, conversation, "Build").result).rejects.toThrow("Auth unavailable");
    expect(manager.state(conversation).agent).toEqual({ status: "error", error: "Auth unavailable" });
    expect(events.since(project.id).at(-1)?.type).toBe("agent.error");
    await manager.close();
  });

  it("rejects when Pi resolves with an assistant error", async () => {
    const session = new FakeSession();
    session.messages.push({ role: "assistant", stopReason: "error", errorMessage: "No API key" });
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await expect(manager.prompt(project, conversation, "Build").result).rejects.toThrow("No API key");
    expect(manager.state(conversation).agent).toEqual({ status: "error", error: "No API key" });
    await manager.close();
  });

  it("aborts and waits for active work before closing", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    session.abort.mockImplementation(async () => prompt.resolve());
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const run = manager.prompt(project, conversation, "Build").result;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    await manager.close();
    await expect(run).resolves.toBe("cancelled");
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.state(conversation).agent.status).toBe("idle");
    expect(events.since(project.id).at(-1)?.type).toBe("agent.cancelled");
  });

  it("publishes only normalized UI events", async () => {
    const session = new FakeSession();
    session.prompt.mockImplementation(async () => {
      session.emit({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} as never },
      });
      session.emit({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} as never },
      });
      session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "fetch failed" });
      session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args: { path: "src/app.ts", oldText: "private", newText: "source" } });
      session.emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "edit", args: { path: "src/app.ts" }, partialResult: { content: [{ type: "text", text: "working" }] } });
      session.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result: { content: [{ type: "text", text: "patched" }] }, isError: false });
    });
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "Build").result;
    const published = events.since(project.id);
    expect(published.map(({ type, data }) => ({ type, data }))).toEqual([
      { type: "agent.started", data: { prompt: "Build" } },
      { type: "assistant.thinking", data: {} },
      { type: "assistant.started", data: { itemId: expect.any(String) } },
      { type: "assistant.delta", data: { itemId: expect.any(String), delta: "Hello" } },
      { type: "agent.retrying", data: { attempt: 1, maxAttempts: 3, delayMs: 2_000, error: "fetch failed" } },
      { type: "tool.started", data: { itemId: expect.any(String), toolCallId: "call-1", toolName: "edit", args: { path: "src/app.ts" } } },
      { type: "tool.updated", data: { itemId: expect.any(String), toolCallId: "call-1", output: "working" } },
      { type: "tool.completed", data: { itemId: expect.any(String), toolCallId: "call-1", toolName: "edit", isError: false, output: "patched" } },
      { type: "agent.completed", data: {} },
    ]);
    expect(published.every((event) => (
      event.conversationId === conversation.summary.id && typeof event.turnId === "string"
    ))).toBe(true);
    await manager.close();
  });

  it("forwards Pi compaction lifecycle", async () => {
    const session = new FakeSession();
    session.prompt.mockImplementation(async () => {
      session.emit({ type: "compaction_start", reason: "threshold" });
      session.emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
    });
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "Continue").result;

    expect(events.since(project.id).map((event) => event.type)).toEqual([
      "agent.started",
      "agent.compaction.started",
      "agent.compaction.completed",
      "agent.completed",
    ]);
    expect(events.since(project.id).find((event) => event.type === "agent.compaction.completed")?.data).toEqual({
      aborted: false,
      willRetry: false,
    });
    await manager.close();
  });

  it("disposes the cached session when switching conversations", async () => {
    const firstSession = new FakeSession();
    const secondSession = new FakeSession();
    const createSession = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession });
    const project = createProject();

    await manager.prompt(project, createConversation(project, "conversation-1"), "First").result;
    await manager.prompt(project, createConversation(project, "conversation-2"), "Second").result;

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(firstSession.dispose).toHaveBeenCalledOnce();
    expect(secondSession.dispose).not.toHaveBeenCalled();
    await manager.close();
  });

  it("updates cached session tools without recreating the session", async () => {
    const session = new FakeSession();
    let enabled = false;
    const createSession = vi.fn(async () => session);
    const manager = new AgentManager(new RuntimeEventBus(), {
      createSession,
      activeToolNames: () => ["read", ...(enabled ? ["generate_image"] : [])],
    });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "First").result;
    enabled = true;
    await manager.prompt(project, conversation, "Second").result;

    expect(createSession).toHaveBeenCalledOnce();
    expect(session.setActiveToolsByName).toHaveBeenNthCalledWith(1, ["read"]);
    expect(session.setActiveToolsByName).toHaveBeenNthCalledWith(2, ["read", "generate_image"]);
    expect(session.dispose).not.toHaveBeenCalled();
    await manager.close();
  });

  it("uses Pi to change the model of a cached session", async () => {
    const session = new FakeSession();
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const model = { provider: "openai-codex", id: "gpt-5.5" } as never;
    const persist = vi.fn();

    await manager.prompt(project, conversation, "First").result;
    await manager.setModel(project.id, conversation.summary.id, model, persist);

    expect(session.setModel).toHaveBeenCalledWith(model);
    expect(persist).not.toHaveBeenCalled();
    await manager.close();
  });

  it("uses Pi to change reasoning on a cached session", async () => {
    const session = new FakeSession();
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const persist = vi.fn();

    await manager.prompt(project, conversation, "First").result;
    const reasoning = await manager.setReasoningLevel(project.id, conversation.summary.id, "high", persist);

    expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(reasoning).toBe("high");
    expect(persist).not.toHaveBeenCalled();
    await manager.close();
  });

  it("does not change tools during an active run", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    let enabled = false;
    const manager = new AgentManager(new RuntimeEventBus(), {
      createSession: async () => session,
      activeToolNames: () => ["read", ...(enabled ? ["generate_image"] : [])],
    });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "First").result;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    enabled = true;
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);

    prompt.resolve();
    await run;
    session.prompt.mockResolvedValue();
    await manager.prompt(project, conversation, "Second").result;
    expect(session.setActiveToolsByName).toHaveBeenLastCalledWith(["read", "generate_image"]);
    await manager.close();
  });
});

class FakeSession implements CodingSession {
  messages: unknown[] = [];
  thinkingLevel: AgentReasoningLevel = "medium";
  prompt = vi.fn<CodingSession["prompt"]>(async () => {});
  abort = vi.fn<() => Promise<void>>(async () => {});
  dispose = vi.fn<() => void>();
  setModel = vi.fn<NonNullable<CodingSession["setModel"]>>(async () => {});
  setThinkingLevel = vi.fn<NonNullable<CodingSession["setThinkingLevel"]>>((level) => { this.thinkingLevel = level; });
  setActiveToolsByName = vi.fn<(toolNames: string[]) => void>();
  #listener?: (event: AgentSessionEvent) => void;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listener = listener;
    return () => { this.#listener = undefined; };
  }

  emit(event: AgentSessionEvent): void {
    this.#listener?.(event);
  }
}

function createProject(): ProjectState {
  return {
    id: "project-1",
    name: "Project",
    updatedAt: new Date(0).toISOString(),
    workspacePath: "/tmp/project-1",
    preview: { status: "waiting" },
  };
}

function createConversation(project: ProjectState, id = "conversation-1"): StoredConversation {
  return {
    sessionPath: `/tmp/${id}.jsonl`,
    summary: {
      id,
      projectId: project.id,
      title: "Conversation",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      messageCount: 0,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sessionMessage(id: string, message: object): object {
  return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message };
}
