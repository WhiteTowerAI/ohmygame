import { describe, expect, it } from "vitest";
import type { ProjectState, RuntimeEvent, RuntimeEventData, RuntimeEventType } from "../src/shared/contracts.js";
import { initialRendererState, rendererReducer } from "../src/renderer/state.js";

describe("rendererReducer", () => {
  it("builds a conversation from normalized runtime events", () => {
    let state = rendererReducer(initialRendererState, { type: "initialized", project: project() });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build a clock" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "assistant.delta", { delta: "I will " }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "assistant.delta", { delta: "build it." }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(4, "tool.started", { toolCallId: "tool-1", toolName: "edit" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(5, "tool.completed", { toolCallId: "tool-1", toolName: "edit", isError: false }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(6, "agent.completed", {}) });

    expect(state.items).toEqual([
      { id: "1:user", kind: "user", text: "Build a clock" },
      { id: "1:assistant", kind: "assistant", text: "I will build it.", status: "complete", error: undefined },
      { id: "4:tool", kind: "tool", toolCallId: "tool-1", toolName: "edit", status: "complete" },
    ]);
    expect(state.project?.agent).toEqual({ status: "idle" });
  });

  it("updates preview state and ignores duplicate events", () => {
    let state = rendererReducer(initialRendererState, { type: "initialized", project: project() });
    const ready = runtimeEvent(3, "preview.ready", { url: "http://127.0.0.1:5173" });
    state = rendererReducer(state, { type: "runtime-event", event: ready });
    state = rendererReducer(state, { type: "runtime-event", event: ready });

    expect(state.project?.preview).toEqual({ status: "ready", url: "http://127.0.0.1:5173" });
    expect(state.lastEventId).toBe(3);
  });

  it("keeps model errors in the assistant timeline", () => {
    let state = rendererReducer(initialRendererState, { type: "initialized", project: project() });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(2, "agent.error", { error: "Authentication required" }) });

    expect(state.items.at(-1)).toMatchObject({ kind: "assistant", status: "error", error: "Authentication required" });
    expect(state.project?.agent).toEqual({ status: "error", error: "Authentication required" });
  });

  it("shows retry progress and clears the active retry when output resumes", () => {
    let state = rendererReducer(initialRendererState, { type: "initialized", project: project() });
    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(1, "agent.started", { prompt: "Build" }) });
    state = rendererReducer(state, {
      type: "runtime-event",
      event: runtimeEvent(2, "agent.retrying", { attempt: 1, maxAttempts: 3, delayMs: 2_000, error: "fetch failed" }),
    });

    expect(state.retry).toEqual({ attempt: 1, maxAttempts: 3 });
    expect(state.items.at(-1)).toMatchObject({ retry: "Retrying 1/3: fetch failed" });

    state = rendererReducer(state, { type: "runtime-event", event: runtimeEvent(3, "assistant.delta", { delta: "Recovered" }) });
    expect(state.retry).toBeUndefined();
  });

});

function project(): ProjectState {
  return {
    id: "project-1",
    name: "Untitled project",
    workspacePath: "/tmp/project-1",
    preview: { status: "stopped" },
    agent: { status: "idle" },
  };
}

function runtimeEvent<T extends RuntimeEventType>(id: number, type: T, data: RuntimeEventData[T]): RuntimeEvent<T> {
  return { id, projectId: "project-1", type, timestamp: new Date(0).toISOString(), data } as RuntimeEvent<T>;
}
