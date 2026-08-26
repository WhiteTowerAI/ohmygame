import { describe, expect, it } from "vitest";
import type { ConversationDetail, ConversationSummary, ProjectState, RuntimeEvent, RuntimeEventData, RuntimeEventType } from "../src/shared/contracts.js";
import { initialRendererState, rendererReducer } from "../src/renderer/state.js";

describe("rendererReducer", () => {
  it("tracks plan mode independently from the active turn", () => {
    const state = rendererReducer(initialized(), { type: "runtime-event", event: runtimeEvent(1, "plan.mode.changed", {
      mode: "awaiting_approval",
      plan: { steps: [{ step: "Inspect", status: "pending" }] },
    }) });

    expect(state.plan).toMatchObject({
      mode: "awaiting_approval",
      plan: { steps: [{ step: "Inspect", status: "pending" }] },
    });
  });
  it("upserts the latest structured plan item", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.completed", { item: {
      id: "turn-1:plan", turnId: "turn-1", type: "plan",
      plan: { steps: [{ step: "Inspect", status: "in_progress" }] },
    } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "item.completed", { item: {
      id: "turn-1:plan", turnId: "turn-1", type: "plan",
      plan: { explanation: "Progress", steps: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }] },
    } }) });

    expect(state.items.filter((item) => item.type === "plan")).toEqual([expect.objectContaining({
      id: "turn-1:plan",
      plan: {
        explanation: "Progress",
        steps: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }],
      },
    })]);
  });

  it("replaces the final turn when the latest prompt is revised", () => {
    const state = {
      ...initialized(),
      lastEventId: 1,
      items: [
        { id: "user-1", turnId: "turn-1", type: "userMessage" as const, text: "First" },
        { id: "answer-1", turnId: "turn-1", type: "agentMessage" as const, text: "One", status: "completed" as const },
        { id: "user-2", turnId: "turn-2", type: "userMessage" as const, text: "Second" },
        { id: "answer-2", turnId: "turn-2", type: "agentMessage" as const, text: "Two", status: "completed" as const },
      ],
    };
    const event = { ...runtimeEvent(2, "agent.started", { prompt: "Revised", revision: "last-turn" }), turnId: "turn-3" };

    const next = rendererReducer(state, { type: "runtime-event", event });

    expect(next.items.map((item) => [item.turnId, item.type, "text" in item ? item.text : undefined])).toEqual([
      ["turn-1", "userMessage", "First"],
      ["turn-1", "agentMessage", "One"],
      ["turn-3", "userMessage", "Revised"],
    ]);
  });
  it("initializes with restored conversation history", () => {
    const items = [
      { id: "user", turnId: "turn-1", type: "userMessage" as const, text: "Hi" },
      { id: "assistant", turnId: "turn-1", type: "agentMessage" as const, text: "Hello", status: "completed" as const },
    ];

    const state = rendererReducer(initialRendererState, { type: "initialized", project: project(), detail: detail({ items }) });

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

    expect(state.settings.model).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(state.settings.reasoningLevel).toBe("high");
  });

  it("builds a conversation from normalized runtime events", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build a clock" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.started", { item: { id: "assistant-1", turnId: "turn-1", type: "agentMessage", text: "", status: "inProgress" } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "item.agentMessage.delta", { itemId: "assistant-1", delta: "I will " }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "item.agentMessage.delta", { itemId: "assistant-1", delta: "build it." }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(5, "item.completed", { item: { id: "assistant-1", turnId: "turn-1", type: "agentMessage", text: "I will build it.", status: "completed", phase: "final_answer" } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(6, "item.started", { item: {
      id: "tool-1", turnId: "turn-1", type: "dynamicToolCall", toolCallId: "tool-1", tool: "edit",
      status: "inProgress", arguments: { path: "src/app.ts" },
    } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(7, "item.updated", { item: {
      id: "tool-1", turnId: "turn-1", type: "dynamicToolCall", toolCallId: "tool-1", tool: "edit",
      status: "inProgress", arguments: { path: "src/app.ts" }, output: "working",
    } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(8, "item.completed", { item: {
      id: "tool-1", turnId: "turn-1", type: "dynamicToolCall", toolCallId: "tool-1", tool: "edit",
      status: "completed", arguments: { path: "src/app.ts" }, output: "done",
    } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(9, "agent.completed", {}) });

    expect(state.items).toEqual([
      { id: "turn-1:user", turnId: "turn-1", type: "userMessage", text: "Build a clock", timestamp: 0 },
      { id: "assistant-1", turnId: "turn-1", type: "agentMessage", text: "I will build it.", status: "completed", phase: "final_answer", timestamp: 0 },
      { id: "tool-1", turnId: "turn-1", type: "dynamicToolCall", toolCallId: "tool-1", tool: "edit", status: "completed", arguments: { path: "src/app.ts" }, output: "done", timestamp: 0 },
    ]);
    expect(state.agent).toEqual({ status: "idle" });
  });

  it("streams Pi thinking into a timeline item", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.started", { item: { id: "tool-1", turnId: "turn-1", type: "dynamicToolCall", toolCallId: "tool-1", tool: "read", status: "inProgress" } }) });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "item.started", { item: { id: "thinking-1", turnId: "turn-1", type: "reasoning", text: "", status: "inProgress" } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "item.reasoning.textDelta", { itemId: "thinking-1", delta: "Inspecting" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(5, "item.completed", { item: { id: "thinking-1", turnId: "turn-1", type: "reasoning", text: "Inspecting", status: "completed" } }) });
    expect(state.items.at(-1)).toMatchObject({ type: "reasoning", text: "Inspecting", status: "completed" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(6, "agent.completed", {}) });
  });

  it("records the latest assistant delta time", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.started", { item: { id: "assistant-1", turnId: "turn-1", type: "agentMessage", text: "", status: "inProgress" } }) });
    state = rendererReducer(state, {
      type: "runtime-event",
      event: { ...runtimeEvent(3, "item.agentMessage.delta", { itemId: "assistant-1", delta: "Working" }), timestamp: new Date(3_000).toISOString() },
    });

    expect(state.items.at(-1)).toMatchObject({ type: "agentMessage", text: "Working", timestamp: 3_000 });
  });

  it("transitions a preparing tool into execution on the same item", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.started", { item: {
      id: "tool-1", turnId: "turn-1", type: "dynamicToolCall", toolCallId: "call-1", tool: "write", status: "preparing",
    } }) });
    expect(state.items.at(-1)).toMatchObject({ type: "dynamicToolCall", status: "preparing", tool: "write" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "item.updated", { item: {
      id: "tool-1", turnId: "turn-1", type: "dynamicToolCall", toolCallId: "call-1", tool: "write", status: "inProgress", arguments: { path: "src/app.ts" },
    } }) });
    expect(state.items).toHaveLength(2);
    expect(state.items.at(-1)).toMatchObject({ type: "dynamicToolCall", status: "inProgress", arguments: { path: "src/app.ts" } });
  });

  it("keeps MCP identity as structured timeline data", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Create a scene" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.started", { item: {
      id: "mcp-1", turnId: "turn-1", type: "mcpToolCall", toolCallId: "call-1", server: "opengame-godot", tool: "create_scene",
      status: "inProgress", arguments: { scenePath: "main.tscn" },
    } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "item.completed", { item: {
      id: "mcp-1", turnId: "turn-1", type: "mcpToolCall", toolCallId: "call-1", server: "opengame-godot", tool: "create_scene",
      status: "completed", arguments: { scenePath: "main.tscn" },
    } }) });

    expect(state.items.at(-1)).toMatchObject({
      type: "mcpToolCall",
      server: "opengame-godot",
      tool: "create_scene",
      arguments: { scenePath: "main.tscn" },
      status: "completed",
    });
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

  it("updates agent error state without synthesizing a timeline item", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "agent.error", { error: "Authentication required" }) });

    expect(state.items).toEqual([
      { id: "turn-1:user", turnId: "turn-1", type: "userMessage", text: "Build", timestamp: 0 },
    ]);
    expect(state.agent).toEqual({ status: "error", error: "Authentication required" });
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

    expect(state.items.at(-1)).toMatchObject({ type: "retry", attempt: 1, maxAttempts: 3, error: "fetch failed" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "item.started", { item: { id: "assistant-1", turnId: "turn-1", type: "agentMessage", text: "", status: "inProgress" } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "item.agentMessage.delta", { itemId: "assistant-1", delta: "Recovered" }) });
    expect(state.items.at(-1)).toMatchObject({ type: "agentMessage", text: "Recovered" });
  });

  it("tracks context compaction", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.started", { item: { id: "turn-1:compaction", turnId: "turn-1", type: "contextCompaction", status: "inProgress" } }) });

    expect(state.items.at(-1)).toMatchObject({ type: "contextCompaction", status: "inProgress" });
    expect(state.activeTurn).toEqual({ conversationId: "conversation-1", turnId: "turn-1" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "item.completed", { item: { id: "turn-1:compaction", turnId: "turn-1", type: "contextCompaction", status: "completed" } }) });
    expect(state.items.at(-1)).toMatchObject({ type: "contextCompaction", status: "completed" });
    expect(state.activeTurn).toEqual({ conversationId: "conversation-1", turnId: "turn-1" });
    expect(state.agent).toEqual({ status: "running" });
  });

  it("tracks manual compaction as its own active operation", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "item.started", { item: { id: "turn-1:compaction", turnId: "turn-1", type: "contextCompaction", status: "inProgress" } }) });
    expect(state.activeTurn).toEqual({ conversationId: "conversation-1", turnId: "turn-1" });
    expect(state.agent).toEqual({ status: "running" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.completed", { item: { id: "turn-1:compaction", turnId: "turn-1", type: "contextCompaction", status: "completed" } }) });
    expect(state.activeTurn).toBeUndefined();
    expect(state.agent).toEqual({ status: "idle" });
  });

  it("does not present an aborted compaction as complete", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.started", { item: { id: "turn-1:compaction", turnId: "turn-1", type: "contextCompaction", status: "inProgress" } }) });
    state = rendererReducer(state, {
      type: "runtime-event",
      event: runtimeEvent(3, "item.completed", { item: { id: "turn-1:compaction", turnId: "turn-1", type: "contextCompaction", status: "failed", error: "Context compaction interrupted; retrying" } }),
    });

    expect(state.items.at(-1)).toMatchObject({
      type: "contextCompaction",
      status: "failed",
      error: "Context compaction interrupted; retrying",
    });
  });

  it("removes an empty completed assistant item before a tool call", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Read" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.started", { item: { id: "assistant-1", turnId: "turn-1", type: "agentMessage", text: "", status: "inProgress" } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "item.completed", { item: { id: "assistant-1", turnId: "turn-1", type: "agentMessage", text: "", status: "completed" } }) });

    expect(state.items).toEqual([
      { id: "turn-1:user", turnId: "turn-1", type: "userMessage", text: "Read", timestamp: 0 },
    ]);
  });

  it("leaves item lifecycle changes to item events", () => {
    let state = initialized();
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "item.started", { item: { id: "assistant-1", turnId: "turn-1", type: "agentMessage", text: "", status: "inProgress" } }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "item.agentMessage.delta", { itemId: "assistant-1", delta: "Done" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "agent.completed", {}) });

    expect(state.items.at(-1)).toMatchObject({ type: "agentMessage", text: "Done", status: "inProgress" });
    expect(state.agent).toEqual({ status: "idle" });
  });

  it("ignores agent state from another conversation", () => {
    const state = rendererReducer(initialized(), {
      type: "runtime-event",
      event: { ...runtimeEvent(1, "agent.started", { prompt: "Other" }), conversationId: "conversation-2" },
    });

    expect(state.items).toEqual([]);
    expect(state.agent.status).toBe("idle");
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
      detail: detail({
        conversation: { ...conversation(), id: "conversation-2" },
        agent: { status: "running" },
        activeTurn: { conversationId: "conversation-2", turnId: "turn-1" },
        cursor: 8,
      }),
    });
    state = rendererReducer(state, {
      type: "runtime-event",
      event: { ...runtimeEvent(9, "agent.started", { prompt: "Other" }), conversationId: "conversation-2" },
    });

    expect(state.items).toEqual([{ id: "turn-1:user", turnId: "turn-1", type: "userMessage", text: "Other", timestamp: 0 }]);
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

function conversation(): ConversationSummary {
  return {
    id: "conversation-1",
    projectId: "project-1",
    title: "Conversation",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messageCount: 0,
  };
}

function detail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    conversation: conversation(),
    agent: { status: "idle" },
    settings: {},
    plan: { mode: "normal" },
    items: [],
    cursor: 0,
    pendingPrompts: [],
    ...overrides,
  };
}

function initialized() {
  return rendererReducer(initialRendererState, { type: "initialized", project: project(), detail: detail() });
}

function runtimeEvent<T extends RuntimeEventType>(id: number, type: T, data: RuntimeEventData[T]): RuntimeEvent<T> {
  const agentScoped = type.startsWith("agent.") || type.startsWith("item.") || type.startsWith("plan.") || type.startsWith("prompt.");
  return {
    id,
    projectId: "project-1",
    ...(agentScoped ? { conversationId: "conversation-1", turnId: "turn-1" } : {}),
    type,
    timestamp: new Date(0).toISOString(),
    data,
  } as RuntimeEvent<T>;
}
