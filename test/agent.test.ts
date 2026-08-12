import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentManager, lastAssistantError, type CodingSession } from "../src/daemon/agent.js";
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
    await firstRun;
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
    await run;
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
    canUndo: false,
    preview: { status: "stopped" },
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
