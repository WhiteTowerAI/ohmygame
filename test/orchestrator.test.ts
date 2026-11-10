import { describe, expect, it } from "vitest";
import { RUNTIME_EVENT_TYPES, type RuntimeEventData, type ThreadItem } from "../src/shared/contracts.js";
import type { OrchestratorState } from "../src/shared/orchestrator.js";

describe("orchestrator events", () => {
  it("registers both event names", () => {
    expect(RUNTIME_EVENT_TYPES).toContain("orchestrator.state");
    expect(RUNTIME_EVENT_TYPES).toContain("orchestrator.message");
  });

  it("carries the roster on a state event and the endpoints on a message event", () => {
    const state: RuntimeEventData["orchestrator.state"] = {
      state: { config: { version: 1, goal: "g", roles: [], updatedAt: new Date(0).toISOString() }, status: "running", roles: [] } satisfies OrchestratorState,
    };
    const message: RuntimeEventData["orchestrator.message"] = { fromRoleId: "critic", toRoleId: "programmer", text: "The jump feels floaty." };
    expect(state.state.status).toBe("running");
    expect(message.toRoleId).toBe("programmer");
  });

  it("labels a user message with its real author", () => {
    const item: Extract<ThreadItem, { type: "userMessage" }> = {
      id: "item-1", turnId: "turn-1", type: "userMessage", text: "hello",
      author: { kind: "agent", roleId: "critic", name: "Critic" },
    };
    expect(item.author?.roleId).toBe("critic");
  });
});
