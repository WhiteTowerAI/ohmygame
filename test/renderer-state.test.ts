import { describe, expect, it } from "vitest";
import type { ConversationState, ProjectState, RuntimeEvent, RuntimeEventData, RuntimeEventType } from "../src/shared/contracts.js";
import { initialRendererState, rendererReducer } from "../src/renderer/state.js";

describe("rendererReducer", () => {
  it("tracks plan mode independently from the active turn", () => {
    const state = rendererReducer(initialized(), { type: "runtime-event", event: runtimeEvent(1, "plan.mode.changed", {
      mode: "awaiting_approval",
      plan: { steps: [{ step: "Inspect", status: "pending" }] },
    }) });

    expect(state.conversation).toMatchObject({
      planMode: "awaiting_approval",
      plan: { steps: [{ step: "Inspect", status: "pending" }] },
    });
  });
  it("upserts the latest structured plan and removes its tool placeholder", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "tool.preparing", {
      itemId: "placeholder", toolCallId: "plan-1", toolName: "tool",
    }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "plan.updated", {
      itemId: "placeholder",
      steps: [{ step: "Inspect", status: "in_progress" }],
    }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "plan.updated", {
      itemId: "turn-1:plan",
      explanation: "Progress",
      steps: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }],
    }) });

    expect(state.items.filter((item) => item.kind === "plan")).toEqual([expect.objectContaining({
      id: "turn-1:plan",
      plan: {
        explanation: "Progress",
        steps: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }],
      },
    })]);
    expect(state.items.some((item) => item.id === "placeholder")).toBe(false);
  });

  it("replaces the final turn when the latest prompt is revised", () => {
    const state = {
      ...initialized(),
      lastEventId: 1,
      items: [
        { id: "user-1", turnId: "turn-1", kind: "user" as const, text: "First" },
        { id: "answer-1", turnId: "turn-1", kind: "assistant" as const, text: "One", status: "complete" as const },
        { id: "user-2", turnId: "turn-2", kind: "user" as const, text: "Second" },
        { id: "answer-2", turnId: "turn-2", kind: "assistant" as const, text: "Two", status: "complete" as const },
      ],
    };
    const event = { ...runtimeEvent(2, "agent.started", { prompt: "Revised", revision: "last-turn" }), turnId: "turn-3" };

    const next = rendererReducer(state, { type: "runtime-event", event });

    expect(next.items.map((item) => [item.turnId, item.kind, "text" in item ? item.text : undefined])).toEqual([
      ["turn-1", "user", "First"],
      ["turn-1", "assistant", "One"],
      ["turn-3", "user", "Revised"],
    ]);
  });
  it("initializes with restored conversation history", () => {
    const items = [
      { id: "user", turnId: "turn-1", kind: "user" as const, text: "Hi" },
      { id: "assistant", turnId: "turn-1", kind: "assistant" as const, text: "Hello", status: "complete" as const },
    ];

    const state = rendererReducer(initialRendererState, { type: "initialized", project: project(), conversation: conversation(), items, cursor: 0 });

    expect(state.items).toEqual(items);
  });

  it("updates the selected conversation agent settings", () => {
    const state = rendererReducer(initialized(), {
      type: "conversation-settings",
      settings: {
        model: { provider: "openai-codex", id: "gpt-5.5" },
        reasoningLevel: "high",
      },
    });

    expect(state.conversation?.model).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(state.conversation?.reasoningLevel).toBe("high");
  });

  it("builds a conversation from normalized runtime events", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build a clock" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "assistant.started", { itemId: "assistant-1" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "assistant.delta", { itemId: "assistant-1", delta: "I will " }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "assistant.delta", { itemId: "assistant-1", delta: "build it." }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(5, "assistant.completed", { itemId: "assistant-1", status: "complete", phase: "final_answer" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(6, "tool.started", { itemId: "tool-1", toolCallId: "tool-1", toolName: "edit", args: { path: "src/app.ts" } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(7, "tool.updated", { itemId: "tool-1", toolCallId: "tool-1", output: "working" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(8, "tool.completed", { itemId: "tool-1", toolCallId: "tool-1", toolName: "edit", isError: false, output: "done" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(9, "agent.completed", {}) });

    expect(state.items).toEqual([
      { id: "turn-1:user", turnId: "turn-1", kind: "user", text: "Build a clock", timestamp: 0 },
      { id: "assistant-1", turnId: "turn-1", kind: "assistant", text: "I will build it.", status: "complete", phase: "final_answer", error: undefined, timestamp: 0 },
      { id: "tool-1", turnId: "turn-1", kind: "tool", toolCallId: "tool-1", toolName: "edit", status: "complete", args: { path: "src/app.ts" }, output: "done", truncated: undefined, timestamp: 0 },
    ]);
    expect(state.conversation?.agent).toEqual({ status: "idle" });
  });

  it("streams Pi thinking into a timeline item", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "tool.started", { itemId: "tool-1", toolCallId: "tool-1", toolName: "read" }) });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "assistant.thinking.started", { itemId: "thinking-1" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "assistant.thinking.delta", { itemId: "thinking-1", delta: "Inspecting" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(5, "assistant.thinking.completed", { itemId: "thinking-1", text: "Inspecting" }) });
    expect(state.items.at(-1)).toMatchObject({ kind: "thinking", text: "Inspecting", status: "complete" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(6, "agent.completed", {}) });
  });

  it("records the latest assistant delta time", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "assistant.started", { itemId: "assistant-1" }) });
    state = rendererReducer(state, {
      type: "runtime-event",
      event: { ...runtimeEvent(3, "assistant.delta", { itemId: "assistant-1", delta: "Working" }), timestamp: new Date(3_000).toISOString() },
    });

    expect(state.items.at(-1)).toMatchObject({ kind: "assistant", text: "Working", timestamp: 3_000 });
  });

  it("transitions a preparing tool into execution on the same item", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "tool.preparing", {
      itemId: "tool-1", toolCallId: "call-1", toolName: "write",
    }) });
    expect(state.items.at(-1)).toMatchObject({ kind: "tool", status: "preparing", toolName: "write" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "tool.started", {
      itemId: "tool-1", toolCallId: "call-1", toolName: "write", args: { path: "src/app.ts" },
    }) });
    expect(state.items).toHaveLength(2);
    expect(state.items.at(-1)).toMatchObject({ kind: "tool", status: "running", args: { path: "src/app.ts" } });
  });

  it("updates preview state and ignores duplicate events", () => {
    let state = initialized();
    const ready = runtimeEvent(3, "preview.ready", { url: "http://127.0.0.1:5173" });
    state = rendererReducer(state, { type: "runtime-event", event: ready });
    state = rendererReducer(state, { type: "runtime-event", event: ready });

    expect(state.project?.preview).toEqual({ status: "ready", url: "http://127.0.0.1:5173" });
    expect(state.lastEventId).toBe(3);
  });

  it("tracks and removes the pending follow-up", () => {
    let state = initialized();
    state = rendererReducer(state, {
      type: "runtime-event",
      event: runtimeEvent(1, "prompt.queued", {
        prompt: "Update the layout",
        references: [{ type: "workspace-file", path: "src/app.ts" }],
      }),
    });

    expect(state.pendingPrompts).toEqual([expect.objectContaining({ prompt: "Update the layout", turnId: "turn-1" })]);
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "prompt.removed", {}) });
    expect(state.pendingPrompts).toEqual([]);
  });

  it("keeps model errors in the assistant timeline", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "agent.error", { error: "Authentication required" }) });

    expect(state.items.at(-1)).toMatchObject({ kind: "assistant", status: "error", error: "Authentication required" });
    expect(state.conversation?.agent).toEqual({ status: "error", error: "Authentication required" });
  });

  it("updates the published game from a completed publish event", () => {
    let state = initialized();
    state = rendererReducer(state, {
      type: "runtime-event",
      event: runtimeEvent(1, "publish.completed", {
        game: {
          id: "game-1",
          title: "Game",
          description: "",
          deploymentId: "deployment-1",
          playUrl: "https://play.example/game",
          publishedAt: new Date(0).toISOString(),
        },
      }),
    });

    expect(state.project?.publication).toEqual({
      gameId: "game-1",
      deploymentId: "deployment-1",
      playUrl: "https://play.example/game",
      publishedAt: new Date(0).toISOString(),
    });
  });

  it("stores retry progress as a timeline item", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, {
      type: "runtime-event",
      event: runtimeEvent(2, "agent.retrying", { attempt: 1, maxAttempts: 3, delayMs: 2_000, error: "fetch failed" }),
    });

    expect(state.items.at(-1)).toMatchObject({ kind: "retry", attempt: 1, maxAttempts: 3, error: "fetch failed" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "assistant.started", { itemId: "assistant-1" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "assistant.delta", { itemId: "assistant-1", delta: "Recovered" }) });
    expect(state.items.at(-1)).toMatchObject({ kind: "assistant", text: "Recovered" });
  });

  it("tracks context compaction", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "agent.compaction.started", { reason: "threshold" }) });

    expect(state.items.at(-1)).toMatchObject({ kind: "compaction", status: "running" });
    expect(state.activeTurn).toEqual({ conversationId: "conversation-1", turnId: "turn-1" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "agent.compaction.completed", { reason: "threshold", aborted: false, willRetry: false }) });
    expect(state.items.at(-1)).toMatchObject({ kind: "compaction", status: "complete" });
    expect(state.activeTurn).toEqual({ conversationId: "conversation-1", turnId: "turn-1" });
    expect(state.conversation?.agent).toEqual({ status: "running", turnId: "turn-1" });
  });

  it("tracks manual compaction as its own active operation", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.compaction.started", { reason: "manual" }) });
    expect(state.activeTurn).toEqual({ conversationId: "conversation-1", turnId: "turn-1" });
    expect(state.conversation?.agent).toEqual({ status: "running", turnId: "turn-1" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "agent.compaction.completed", { reason: "manual", aborted: false, willRetry: false }) });
    expect(state.activeTurn).toBeUndefined();
    expect(state.conversation?.agent).toEqual({ status: "idle" });
  });

  it("does not present an aborted compaction as complete", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "agent.compaction.started", { reason: "overflow" }) });
    state = rendererReducer(state, {
      type: "runtime-event",
      event: runtimeEvent(3, "agent.compaction.completed", { reason: "overflow", aborted: true, willRetry: true }),
    });

    expect(state.items.at(-1)).toMatchObject({
      kind: "compaction",
      status: "error",
      error: "Context compaction interrupted; retrying",
    });
  });

  it("removes an empty completed assistant item before a tool call", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Read" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "assistant.started", { itemId: "assistant-1" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "assistant.completed", { itemId: "assistant-1", status: "complete" }) });

    expect(state.items).toEqual([
      { id: "turn-1:user", turnId: "turn-1", kind: "user", text: "Read", timestamp: 0 },
    ]);
  });

  it("settles a streaming assistant when a run ends without message_end", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "assistant.started", { itemId: "assistant-1" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "assistant.delta", { itemId: "assistant-1", delta: "Done" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "agent.completed", {}) });

    expect(state.items.at(-1)).toMatchObject({ kind: "assistant", text: "Done", status: "complete" });
  });

  it("ignores agent state from another conversation", () => {
    const state = rendererReducer(initialized(), {
      type: "runtime-event",
      event: { ...runtimeEvent(1, "agent.started", { prompt: "Other" }), conversationId: "conversation-2" },
    });

    expect(state.items).toEqual([]);
    expect(state.conversation?.agent.status).toBe("idle");
    expect(state.activeTurn).toBeUndefined();
    expect(state.lastEventId).toBe(1);
  });

  it("does not clear the current conversation for another conversation's event", () => {
    const state = rendererReducer({
      ...initialized(),
      activeTurn: { conversationId: "conversation-1", turnId: "turn-current" },
    }, {
      type: "runtime-event",
      event: { ...runtimeEvent(1, "agent.completed", {}), conversationId: "conversation-2" },
    });

    expect(state.activeTurn).toEqual({ conversationId: "conversation-1", turnId: "turn-current" });
    expect(state.items).toEqual([]);
  });

  it("resets the event cursor when loading another conversation", () => {
    let state = rendererReducer(initialized(), {
      type: "runtime-event",
      event: { ...runtimeEvent(9, "agent.started", { prompt: "Other" }), conversationId: "conversation-2" },
    });
    state = rendererReducer(state, {
      type: "conversation-loaded",
      conversation: { ...conversation(), id: "conversation-2", agent: { status: "running", turnId: "turn-1" } },
      items: [],
      activeTurn: { conversationId: "conversation-2", turnId: "turn-1" },
      cursor: 8,
    });
    state = rendererReducer(state, {
      type: "runtime-event",
      event: { ...runtimeEvent(9, "agent.started", { prompt: "Other" }), conversationId: "conversation-2" },
    });

    expect(state.items).toEqual([{ id: "turn-1:user", turnId: "turn-1", kind: "user", text: "Other", timestamp: 0 }]);
  });

});

function project(): ProjectState {
  return {
    id: "project-1",
    name: "Untitled project",
    type: "general",
    updatedAt: new Date(0).toISOString(),
    workspacePath: "/tmp/project-1",
    preview: { status: "waiting" },
  };
}

function conversation(): ConversationState {
  return {
    id: "conversation-1",
    projectId: "project-1",
    title: "Conversation",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messageCount: 0,
    agent: { status: "idle" },
    planMode: "normal",
  };
}

function initialized() {
  return rendererReducer(initialRendererState, { type: "initialized", project: project(), conversation: conversation(), cursor: 0 });
}

function runtimeEvent<T extends RuntimeEventType>(id: number, type: T, data: RuntimeEventData[T]): RuntimeEvent<T> {
  const agentScoped = type.startsWith("agent.") || type.startsWith("assistant.") || type.startsWith("tool.") || type.startsWith("plan.") || type.startsWith("prompt.");
  return {
    id,
    projectId: "project-1",
    ...(agentScoped ? { conversationId: "conversation-1", turnId: "turn-1" } : {}),
    type,
    timestamp: new Date(0).toISOString(),
    data,
  } as RuntimeEvent<T>;
}
