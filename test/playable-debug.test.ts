import { describe, expect, it } from "vitest";
import { diffPlayableState, formatStateValue, playableDebugRecord, PlayableStateHistory } from "../src/shared/playable-debug.js";
import type { NodeRuntimeSnapshot } from "../src/shared/playable-runtime.js";
import { createNodeGraphFixture } from "./playable-fixture.js";

function snapshot(overrides: Partial<NodeRuntimeSnapshot> = {}): NodeRuntimeSnapshot {
  return {
    status: "running",
    policy: "follow",
    currentNodeId: "menu",
    backStack: [],
    state: {},
    recentSignals: [],
    reports: [],
    stateAccess: {},
    errors: [],
    save: { present: false },
    ...overrides,
  } as NodeRuntimeSnapshot;
}

describe("Playable debug record", () => {
  it("diffs changed, added, and removed State keys in key order", () => {
    expect(diffPlayableState(
      { score: 1, removed: true, same: [1] },
      { score: 2, added: "x", same: [1] },
      "lobby",
      "t",
    )).toEqual([
      { key: "added", after: "x", nodeId: "lobby", at: "t" },
      { key: "removed", before: true, nodeId: "lobby", at: "t" },
      { key: "score", before: 1, after: 2, nodeId: "lobby", at: "t" },
    ]);
  });

  it("records changes between successive snapshots and resets", () => {
    const history = new PlayableStateHistory();
    expect(history.record(snapshot({ state: { hasKey: false } }), "1")).toBe(false);
    expect(history.record(snapshot({ state: { hasKey: false } }), "2")).toBe(false);
    expect(history.record(snapshot({ currentNodeId: "lobby", state: { hasKey: true } }), "3")).toBe(true);
    expect(history.changes).toEqual([{ key: "hasKey", before: false, after: true, nodeId: "lobby", at: "3" }]);

    history.reset();
    expect(history.changes).toEqual([]);
    expect(history.record(snapshot({ state: { hasKey: false } }), "4")).toBe(false);
  });

  it("keeps only the most recent changes", () => {
    const history = new PlayableStateHistory();
    for (let index = 0; index <= 40; index += 1) history.record(snapshot({ state: { count: index } }), String(index));
    expect(history.changes).toHaveLength(30);
    expect(history.changes.at(-1)).toMatchObject({ after: 40 });
  });

  it("names Nodes and marks Signals without an edge as not followed", () => {
    const record = playableDebugRecord(snapshot({
      currentNodeId: "archive",
      backStack: ["menu"],
      recentSignals: [
        { nodeId: "menu", signal: "inspect", edgeId: "inspect-archive", targetNodeId: "archive", at: "1" },
        { nodeId: "archive", signal: "missing", at: "2" },
      ] as NodeRuntimeSnapshot["recentSignals"],
    }), createNodeGraphFixture(), []);

    expect(record.currentNode).toEqual({ id: "archive", title: "Archive" });
    expect(record.backStack).toEqual([{ id: "menu", title: "Main menu" }]);
    expect(record.recentSignals.map((signal) => signal.followed)).toEqual([true, false]);
  });

  it("formats absent values as a dash", () => {
    expect(formatStateValue(undefined)).toBe("—");
    expect(formatStateValue({ a: [1] })).toBe('{"a":[1]}');
  });
});
