import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentManager, conversationItems, lastAssistantError, type CodingSession } from "../src/daemon/agent.js";
import type { ProjectState } from "../src/shared/contracts.js";
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
          { type: "toolCall", id: "call-1", name: "write", arguments: { path: "secret" } },
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
      { id: "user-1", kind: "user", text: "Build a game" },
      { id: "assistant-1", kind: "assistant", text: "I will build it. Done.", status: "complete" },
      { id: "assistant-1:call-1", kind: "tool", toolCallId: "call-1", toolName: "write", status: "complete" },
    ]);
  });

  it("restores assistant errors and cancelled turns", () => {
    expect(conversationItems([
      sessionMessage("error", { role: "assistant", content: [], stopReason: "error", errorMessage: "No API key" }),
      sessionMessage("user", { role: "user", content: "Stop", timestamp: 1 }),
      sessionMessage("cancelled", { role: "assistant", content: [], stopReason: "aborted" }),
    ] as never)).toEqual([
      { id: "error", kind: "assistant", text: "", status: "error", error: "No API key" },
      { id: "user", kind: "user", text: "Stop" },
      { id: "cancelled", kind: "assistant", text: "", status: "cancelled" },
    ]);
  });
});

describe("AgentManager", () => {
  it("reserves a project before asynchronous session creation", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();

    const firstRun = manager.prompt(project, "First");
    expect(project.agent.status).toBe("running");
    await expect(manager.prompt(project, "Second")).rejects.toThrow("already running");

    prompt.resolve();
    await expect(firstRun).resolves.toBe("completed");
    expect(project.agent.status).toBe("idle");
    await manager.close();
  });

  it("surfaces session initialization failures", async () => {
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => { throw new Error("Auth unavailable"); } });
    const project = createProject();

    await expect(manager.prompt(project, "Build")).rejects.toThrow("Auth unavailable");
    expect(project.agent).toEqual({ status: "error", error: "Auth unavailable" });
    expect(events.since(project.id).at(-1)?.type).toBe("agent.error");
    await manager.close();
  });

  it("rejects when Pi resolves with an assistant error", async () => {
    const session = new FakeSession();
    session.messages.push({ role: "assistant", stopReason: "error", errorMessage: "No API key" });
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();

    await expect(manager.prompt(project, "Build")).rejects.toThrow("No API key");
    expect(project.agent).toEqual({ status: "error", error: "No API key" });
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
    const run = manager.prompt(project, "Build");
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    await manager.close();
    await expect(run).resolves.toBe("cancelled");
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(project.agent.status).toBe("idle");
    expect(events.since(project.id).at(-1)?.type).toBe("agent.cancelled");
  });

  it("publishes only normalized UI events", async () => {
    const session = new FakeSession();
    session.prompt.mockImplementation(async () => {
      session.emit({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} as never },
      });
      session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "fetch failed" });
      session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args: { secret: "omitted" } });
      session.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result: { large: true }, isError: false });
    });
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();

    await manager.prompt(project, "Build");
    expect(events.since(project.id).map(({ type, data }) => ({ type, data }))).toEqual([
      { type: "agent.started", data: { prompt: "Build" } },
      { type: "assistant.delta", data: { delta: "Hello" } },
      { type: "agent.retrying", data: { attempt: 1, maxAttempts: 3, delayMs: 2_000, error: "fetch failed" } },
      { type: "tool.started", data: { toolCallId: "call-1", toolName: "edit" } },
      { type: "tool.completed", data: { toolCallId: "call-1", toolName: "edit", isError: false } },
      { type: "agent.completed", data: {} },
    ]);
    await manager.close();
  });
});

class FakeSession implements CodingSession {
  messages: unknown[] = [];
  prompt = vi.fn<(prompt: string) => Promise<void>>(async () => {});
  abort = vi.fn<() => Promise<void>>(async () => {});
  dispose = vi.fn<() => void>();
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
    workspacePath: "/tmp/project-1",
    preview: { status: "waiting" },
    agent: { status: "idle" },
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
