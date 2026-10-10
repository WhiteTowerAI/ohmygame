import { describe, expect, it } from "vitest";
import type { ConversationDetail, ConversationSummary, ProjectState, RuntimeEvent, RuntimeEventData, RuntimeEventType, ThreadItem, Turn } from "../src/shared/contracts.js";
import { initialRendererState, rendererReducer } from "../src/renderer/state.js";

describe("rendererReducer", () => {
  it("preserves unrelated turn and item references when streaming text", () => {
    const historical = turn("previous", "completed", [user("previous", "Earlier")]);
    const prompt = user("turn-1", "Build");
    const active = turn("turn-1", "inProgress", [prompt, assistant("turn-1", "assistant-1", "", "inProgress")]);
    const state = { ...initialized(), turns: [historical, active] };
    const next = event(state, runtimeEvent(1, "item.agentMessage.delta", { itemId: "assistant-1", delta: "Hello" }));
    expect(next.turns[0]).toBe(historical);
    expect(next.turns[0].items).toBe(historical.items);
    expect(next.turns[1]).not.toBe(active);
    expect(next.turns[1].items[0]).toBe(prompt);
    expect(next.turns[1].items[1]).toMatchObject({ text: "Hello" });
  });
  it("stores the publication from the HTTP response without overwriting newer project state", () => {
    const state = initialized();
    const publication = {
      gameId: "game-1", deploymentId: "deployment-1", playUrl: "https://play.example/game-1",
      publishedAt: "2026-10-05T03:00:00.000Z", title: "Published title", description: "Game description",
    };
    const next = rendererReducer(state, { type: "publication-updated", projectId: "project-1", publication });
    expect(next.project).toEqual({ ...state.project, publication });
    expect(next.lastEventId).toBe(state.lastEventId);
    expect(rendererReducer(state, { type: "publication-updated", projectId: "another-project", publication })).toBe(state);
  });

  it("syncs project settings and capability changes from project.updated events", () => {
    const state = initialized();
    const updated: ProjectState = { ...state.project!, type: "general", webPreviewEnabled: true, preview: { status: "waiting" } };
    const next = event(state, runtimeEvent(1, "project.updated", { project: updated }));
    expect(next.project).toEqual(updated);
    expect(next.turns).toBe(state.turns);
  });

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

  it("adds image-reading activity when an image prompt starts", () => {
    const image = { name: "map.png", mediaType: "image/png" as const, data: "aW1hZ2U=" };
    const state = event(initialized(), runtimeEvent(1, "agent.started", { prompt: "Inspect", images: [image] }));

    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({ type: "userMessage", images: [image] }),
      expect.objectContaining({ type: "imageRead", count: 1, status: "completed" }),
    ]);
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

  it("shows a steered prompt immediately and starts it without duplicating the message", () => {
    let state = initialized();
    state = event(state, runtimeEvent(1, "agent.started", { prompt: "First" }));
    state = event(state, { ...runtimeEvent(2, "prompt.queued", { prompt: "Second", references: [] }), turnId: "turn-2" });
    state = event(state, { ...runtimeEvent(3, "prompt.steered", { prompt: "Second", references: [] }), turnId: "turn-2" });

    expect(state.pendingPrompts).toEqual([]);
    expect(state.turns.at(-1)).toMatchObject({
      id: "turn-2",
      status: "completed",
      steering: true,
      items: [expect.objectContaining({ type: "userMessage", text: "Second" })],
    });

    const runningTool: ThreadItem = {
      id: "tool-1",
      turnId: "turn-1",
      type: "dynamicToolCall",
      toolCallId: "tool-1",
      tool: "bash",
      status: "inProgress",
      arguments: { command: "npm test" },
    };
    state = event(state, runtimeEvent(4, "item.started", { item: runningTool }));
    state = event(state, { ...runtimeEvent(5, "agent.started", { prompt: "Second" }), turnId: "turn-2" });

    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({ status: "completed", items: expect.arrayContaining([expect.objectContaining({ id: "tool-1", status: "failed" })]) });
    expect(state.turns[1]).toMatchObject({ id: "turn-2", status: "inProgress" });
    expect(state.turns[1]?.items.filter((item) => item.type === "userMessage")).toHaveLength(1);
  });

  it("materializes restored steering prompts outside the pending queue", () => {
    const pending = {
      turnId: "turn-2",
      prompt: "Change direction",
      mentions: [],
      references: [],
      images: [],
      attachments: [],
      steering: true,
    };
    const state = rendererReducer(initialRendererState, {
      type: "initialized",
      project: project(),
      detail: detail({ pendingPrompts: [pending] }),
    });

    expect(state.pendingPrompts).toEqual([]);
    expect(state.turns.at(-1)).toMatchObject({ id: "turn-2", status: "completed", steering: true });
  });

  it("starts consecutive steered prompts without reversing their display order", () => {
    let state = initialized();
    state = event(state, runtimeEvent(1, "agent.started", { prompt: "First" }));
    state = event(state, { ...runtimeEvent(2, "prompt.steered", { prompt: "Second", references: [] }), turnId: "turn-2" });
    state = event(state, { ...runtimeEvent(3, "prompt.steered", { prompt: "Third", references: [] }), turnId: "turn-3" });
    state = event(state, { ...runtimeEvent(4, "agent.started", { prompt: "Second" }), turnId: "turn-2" });

    expect(state.turns.map((turn) => turn.id)).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(state.turns[1]).toMatchObject({ status: "inProgress" });
    expect(state.turns[1]).not.toHaveProperty("steering");
    expect(state.turns[2]).toMatchObject({ status: "completed", steering: true });
  });

  it("removes a provisional steer but preserves a steer that already started", () => {
    let waiting = initialized();
    waiting = event(waiting, runtimeEvent(1, "agent.started", { prompt: "First" }));
    waiting = event(waiting, { ...runtimeEvent(2, "prompt.steered", { prompt: "Second", references: [] }), turnId: "turn-2" });
    waiting = event(waiting, { ...runtimeEvent(3, "prompt.removed", {}), turnId: "turn-2" });
    expect(waiting.turns.map((turn) => turn.id)).toEqual(["turn-1"]);

    let started = initialized();
    started = event(started, runtimeEvent(1, "agent.started", { prompt: "First" }));
    started = event(started, { ...runtimeEvent(2, "prompt.steered", { prompt: "Second", references: [] }), turnId: "turn-2" });
    started = event(started, { ...runtimeEvent(3, "agent.started", { prompt: "Second" }), turnId: "turn-2" });
    started = event(started, { ...runtimeEvent(4, "prompt.removed", {}), turnId: "turn-2" });
    expect(started.turns.at(-1)).toMatchObject({ id: "turn-2", status: "inProgress" });
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

  it("ignores duplicate and stale events without duplicating queued prompts", () => {
    const queued = { ...runtimeEvent(2, "prompt.queued", { prompt: "Next", references: [] }), turnId: "turn-2" };
    const state = event(initialized(), queued);

    expect(state.pendingPrompts).toHaveLength(1);
    const replayed = event(state, queued);
    expect(replayed.pendingPrompts).toEqual(state.pendingPrompts);
    expect(replayed.lastEventId).toBe(2);
    expect(event(state, { ...queued, id: 1 })).toEqual(state);
    expect(state.pendingPrompts).toHaveLength(1);
  });

  it("updates the active conversation title", () => {
    const renamed = { ...conversation(), title: "Build platform game" };
    const state = event(initialized(), runtimeEvent(1, "conversation.renamed", { conversation: renamed }));

    expect(state.conversation).toEqual(renamed);
  });

  it("adds a completed timeline row when the conversation model changes", () => {
    const item = {
      id: "model-change",
      turnId: "model-change",
      type: "modelChange" as const,
      model: { provider: "openai", id: "gpt-next" },
      name: "GPT Next",
    };
    const state = event(initialized(), runtimeEvent(1, "conversation.model.changed", { item }));

    expect(state.turns.at(-1)).toMatchObject({
      id: "model-change",
      status: "completed",
      items: [expect.objectContaining({ type: "modelChange", name: "GPT Next" })],
    });
  });

  it("updates the active project name", () => {
    const renamed = { ...project(), name: "Platform World" };
    const state = event(initialized(), runtimeEvent(1, "project.renamed", { project: renamed }));

    expect(state.project).toEqual(renamed);
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
  const scoped = type.startsWith("agent.") || type.startsWith("item.") || type.startsWith("plan.") || type.startsWith("prompt.") || type === "conversation.model.changed";
  return { id, projectId: "project-1", ...(scoped ? { conversationId: "conversation-1", turnId: "turn-1" } : {}), type, timestamp: new Date(0).toISOString(), data } as RuntimeEvent<T>;
}
