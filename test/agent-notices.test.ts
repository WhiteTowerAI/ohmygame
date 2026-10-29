import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentNoticeLog } from "../src/daemon/agent-notices.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import type { ThreadItem } from "../src/shared/contracts.js";

const scope = { conversationId: "c1", turnId: "t1" };

function setup(options: { planReviewWaitMs?: number } = {}) {
  const events = new RuntimeEventBus();
  const log = new AgentNoticeLog((projectId) => (projectId === "p1" ? "Space Game" : null), { ...options, now: () => 5 });
  events.subscribeAll((event) => log.event(event));
  return { events, log };
}

function approval(status: "inProgress" | "completed"): ThreadItem {
  return {
    id: "t1:approval:r1",
    turnId: "t1",
    type: "approvalRequest",
    requestId: "r1",
    request: { kind: "command", tool: "Bash", command: "npm test" },
    status,
  };
}

describe("agent notices", () => {
  afterEach(() => vi.useRealTimers());

  it("announces finished and failed turns but not stopped ones", () => {
    const { events, log } = setup();
    events.publish("p1", "agent.completed", {}, scope);
    events.publish("p1", "agent.cancelled", {}, { conversationId: "c2", turnId: "t2" });
    events.publish("p2", "agent.error", { error: "boom" }, { conversationId: "c3", turnId: "t3" });

    expect(log.read(0).notices).toEqual([
      { seq: 1, kind: "completed", projectId: "p1", projectName: "Space Game", conversationId: "c1", at: 5 },
      { seq: 2, kind: "failed", projectId: "p2", projectName: null, conversationId: "c3", at: 5 },
    ]);
    expect(log.read(1).notices.map((notice) => notice.seq)).toEqual([2]);
  });

  it("announces a request once and keeps it waiting until it is answered", () => {
    const { events, log } = setup();
    events.publish("p1", "item.started", { item: approval("inProgress") }, scope);
    events.publish("p1", "item.updated", { item: approval("inProgress") }, scope);

    const waiting = log.read(0);
    expect(waiting.notices).toEqual([expect.objectContaining({ kind: "approval", waitingId: "p1:c1:t1:approval:r1" })]);
    expect(waiting.waiting).toEqual([{ id: "p1:c1:t1:approval:r1", kind: "approval", projectId: "p1", conversationId: "c1" }]);

    events.publish("p1", "item.completed", { item: approval("completed") }, scope);
    expect(log.read(0).waiting).toEqual([]);
  });

  it("forgets requests when their turn ends", () => {
    const { events, log } = setup();
    events.publish("p1", "item.started", { item: approval("inProgress") }, scope);
    events.publish("p1", "agent.cancelled", {}, scope);
    expect(log.read(0).waiting).toEqual([]);
  });

  it("announces a planning turn as a plan to review instead of a finished turn", () => {
    const { events, log } = setup();
    events.publish("p1", "plan.mode.changed", { mode: "planning" }, { conversationId: "c1" });
    events.publish("p1", "agent.completed", {}, scope);
    expect(log.read(0).notices).toEqual([]);

    events.publish("p1", "plan.mode.changed", { mode: "awaiting_approval" }, { conversationId: "c1" });
    const page = log.read(0);
    expect(page.notices).toEqual([expect.objectContaining({ kind: "plan", waitingId: "plan:p1:c1" })]);
    expect(page.waiting).toEqual([{ id: "plan:p1:c1", kind: "plan", projectId: "p1", conversationId: "c1" }]);

    events.publish("p1", "plan.mode.changed", { mode: "executing" }, { conversationId: "c1" });
    expect(log.read(0).waiting).toEqual([]);
  });

  it("announces a planning turn that leaves no plan as finished", () => {
    const { events, log } = setup();
    events.publish("p1", "plan.mode.changed", { mode: "planning" }, { conversationId: "c1" });
    events.publish("p1", "agent.completed", {}, scope);
    events.publish("p1", "plan.mode.changed", { mode: "normal" }, { conversationId: "c1" });
    expect(log.read(0).notices).toEqual([expect.objectContaining({ kind: "completed" })]);
  });

  it("announces a planning turn as finished when the plan does not follow in time", () => {
    vi.useFakeTimers();
    const { events, log } = setup({ planReviewWaitMs: 1_000 });
    events.publish("p1", "plan.mode.changed", { mode: "planning" }, { conversationId: "c1" });
    events.publish("p1", "agent.completed", {}, scope);
    vi.advanceTimersByTime(1_000);
    expect(log.read(0).notices).toEqual([expect.objectContaining({ kind: "completed" })]);
  });

  it("keeps a restored plan waiting without announcing it", () => {
    const { events, log } = setup();
    events.publish("p1", "plan.mode.changed", { mode: "awaiting_approval" }, { conversationId: "c1" });
    const page = log.read(0);
    expect(page.notices).toEqual([]);
    expect(page.waiting).toHaveLength(1);
  });

  it("starts a new epoch in every process", () => {
    expect(setup().log.read(0).epoch).not.toBe(setup().log.read(0).epoch);
  });
});
