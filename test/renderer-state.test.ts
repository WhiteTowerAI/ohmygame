import { describe, expect, it } from "vitest";
import type { ConversationDetail, ConversationSummary, ProjectState, RuntimeEvent, RuntimeEventData, RuntimeEventType, ThreadItem, Turn } from "../src/shared/contracts.js";
import { initialRendererState, rendererReducer } from "../src/renderer/state.js";

describe("rendererReducer", () => {
  it("loads shared turns without deriving a parallel item list", () => {
    const turns = [turn("turn-1", "completed", [user("turn-1", "Hi")])];
    const state = rendererReducer(initialRendererState, { type: "initialized", project: project(), detail: detail({ turns }) });

    expect(state.turns).toEqual(turns);
    expect("items" in state).toBe(false);
  });

  it("creates and completes one turn from normalized events", () => {
    let state = initialized();
    state = event(state, runtimeEvent(1, "agent.started", { prompt: "Build a clock" }));
    state = event(state, runtimeEvent(2, "item.started", { item: assistant("turn-1", "assistant-1", "", "inProgress") }));
    state = event(state, runtimeEvent(3, "item.agentMessage.delta", { itemId: "assistant-1", delta: "Done" }));
    state = event(state, runtimeEvent(4, "item.completed", { item: { ...assistant("turn-1", "assistant-1", "Done", "completed"), phase: "final_answer" } }));
    state = event(state, runtimeEvent(5, "agent.completed", {}));

    expect(state.turns).toEqual([expect.objectContaining({
      id: "turn-1",
      status: "completed",
      items: [
        expect.objectContaining({ type: "userMessage", text: "Build a clock" }),
        expect.objectContaining({ type: "agentMessage", text: "Done", status: "completed" }),
      ],
    })]);
    expect(state.agent).toEqual({ status: "idle" });
  });

  it("keeps questionnaire lifecycle inside its ThreadItem", () => {
    let state = initialized();
    state = event(state, runtimeEvent(1, "agent.started", { prompt: "Plan" }));
    const request: Extract<ThreadItem, { type: "userInputRequest" }> = {
      id: "turn-1:input:q1",
      turnId: "turn-1",
      type: "userInputRequest",
      requestId: "q1",
      questions: [{ id: "scope", prompt: "Scope?", options: [{ value: "small", label: "Small" }], allowOther: true }],
      status: "inProgress",
    };
    state = event(state, runtimeEvent(2, "item.started", { item: request }));
    expect(state.turns[0]?.items.at(-1)).toMatchObject({ type: "userInputRequest", status: "inProgress" });

    state = event(state, runtimeEvent(3, "item.completed", { item: { ...request, status: "completed", answers: [{ questionId: "scope", value: "small", label: "Small", custom: false }] } }));
    expect(state.turns[0]?.items.at(-1)).toMatchObject({ type: "userInputRequest", status: "completed" });
  });

  it("replaces the latest turn when revising the last prompt", () => {
    const state = { ...initialized(), lastEventId: 1, turns: [
      turn("turn-1", "completed", [user("turn-1", "First")]),
      turn("turn-2", "completed", [user("turn-2", "Second")]),
      turn("compact-1", "completed", [{ id: "compact-1:item", turnId: "compact-1", type: "contextCompaction", status: "completed" }]),
    ] };
    const next = event(state, { ...runtimeEvent(2, "agent.started", { prompt: "Revised", revision: "last-turn" }), turnId: "turn-3" });

    expect(next.turns.map((item) => item.id)).toEqual(["turn-1", "compact-1", "turn-3"]);
    expect(next.turns.at(-1)?.items[0]).toMatchObject({ type: "userMessage", text: "Revised" });
  });

  it("removes a transient retry item after reconnection succeeds", () => {
    let state = initialized();
    state = event(state, runtimeEvent(1, "agent.started", { prompt: "Build" }));
    const retry: ThreadItem = {
      id: "turn-1:retry:1",
      turnId: "turn-1",
      type: "retry",
      status: "inProgress",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      error: { message: "fetch failed" },
    };
    state = event(state, runtimeEvent(2, "item.started", { item: retry }));

    expect(state.turns[0]?.items.at(-1)).toMatchObject({ type: "retry", status: "inProgress", error: { message: "fetch failed" } });
    state = event(state, runtimeEvent(3, "item.completed", { item: { ...retry, status: "completed" } }));
    expect(state.turns[0]?.items.some((item) => item.type === "retry")).toBe(false);
  });

  it("keeps a retry item when reconnection finally fails", () => {
    let state = initialized();
    state = event(state, runtimeEvent(1, "agent.started", { prompt: "Build" }));
    const retry: ThreadItem = {
      id: "turn-1:retry",
      turnId: "turn-1",
      type: "retry",
      status: "inProgress",
      attempt: 3,
      maxAttempts: 3,
      delayMs: 4_000,
      error: { message: "fetch failed" },
    };
    state = event(state, runtimeEvent(2, "item.started", { item: retry }));
    state = event(state, runtimeEvent(3, "item.completed", { item: { ...retry, status: "failed", error: { message: "connection failed" } } }));

    expect(state.turns[0]?.items.at(-1)).toMatchObject({ type: "retry", status: "failed", error: { message: "connection failed" } });
  });

  it("keeps an agent error state even when the event has no message", () => {
    let state = initialized();
    state = event(state, runtimeEvent(1, "agent.started", { prompt: "Build" }));
    state = event(state, runtimeEvent(2, "agent.error", { error: "" }));

    expect(state.turns[0]?.status).toBe("failed");
    expect(state.agent).toEqual({ status: "error" });
  });

  it("creates a turn for manual compaction and closes it on agent completion", () => {
    let state = initialized();
    state = event(state, runtimeEvent(1, "item.started", { item: { id: "turn-1:compaction", turnId: "turn-1", type: "contextCompaction", status: "inProgress" } }));
    expect(state.turns[0]?.status).toBe("inProgress");
    expect(state.agent.status).toBe("running");

    state = event(state, runtimeEvent(2, "item.completed", { item: { id: "turn-1:compaction", turnId: "turn-1", type: "contextCompaction", status: "completed" } }));
    state = event(state, runtimeEvent(3, "agent.completed", {}));
    expect(state.turns[0]?.status).toBe("completed");
    expect(state.agent.status).toBe("idle");
  });

  it("ignores scoped events from another conversation", () => {
    const state = event(initialized(), { ...runtimeEvent(1, "agent.started", { prompt: "Other" }), conversationId: "conversation-2" });
    expect(state.turns).toEqual([]);
    expect(state.lastEventId).toBe(1);
  });

  it("replaces all turns when another conversation loads", () => {
    const loaded = turn("other-turn", "inProgress", [user("other-turn", "Other")], "conversation-2");
    const state = rendererReducer(initialized(), {
      type: "conversation-loaded",
      detail: detail({ conversation: { ...conversation(), id: "conversation-2" }, agent: { status: "running" }, turns: [loaded], cursor: 8 }),
    });
    expect(state.turns).toEqual([loaded]);
    expect(state.lastEventId).toBe(8);
  });
});

function event(state: ReturnType<typeof initialized>, value: RuntimeEvent) {
  return rendererReducer(state, { type: "runtime-event", event: value });
}

function turn(id: string, status: Turn["status"], items: ThreadItem[], conversationId = "conversation-1"): Turn {
  return { id, conversationId, status, items };
}

function user(turnId: string, text: string): Extract<ThreadItem, { type: "userMessage" }> {
  return { id: `${turnId}:user`, turnId, type: "userMessage", text };
}

function assistant(turnId: string, id: string, text: string, status: Extract<ThreadItem, { type: "agentMessage" }>["status"]): Extract<ThreadItem, { type: "agentMessage" }> {
  return { id, turnId, type: "agentMessage", text, status };
}

function project(): ProjectState {
  return { id: "project-1", name: "Untitled project", type: "web-game", updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/project-1", preview: { status: "waiting" } };
}

function conversation(): ConversationSummary {
  return { id: "conversation-1", projectId: "project-1", title: "Conversation", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), messageCount: 0 };
}

function detail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return { conversation: conversation(), agent: { status: "idle" }, settings: {}, plan: { mode: "normal" }, turns: [], cursor: 0, pendingPrompts: [], ...overrides };
}

function initialized() {
  return rendererReducer(initialRendererState, { type: "initialized", project: project(), detail: detail() });
}

function runtimeEvent<T extends RuntimeEventType>(id: number, type: T, data: RuntimeEventData[T]): RuntimeEvent<T> {
  const scoped = type.startsWith("agent.") || type.startsWith("item.") || type.startsWith("plan.") || type.startsWith("prompt.");
  return { id, projectId: "project-1", ...(scoped ? { conversationId: "conversation-1", turnId: "turn-1" } : {}), type, timestamp: new Date(0).toISOString(), data } as RuntimeEvent<T>;
}
