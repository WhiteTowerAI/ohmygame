import { describe, expect, it } from "vitest";
import { askToFixPlaytest } from "../src/renderer/playable-playtest.js";
import type { NodeGraph } from "../src/shared/playable-nodes.js";
import type { PlayableDebugRecord } from "../src/shared/playable-debug.js";

const graph = {
  nodes: [
    { id: "menu", title: "Node 1", signals: [{ id: "start", label: "Start" }] },
    { id: "jump", title: "Node 2", signals: [{ id: "success", label: "Made it" }] },
  ],
} as unknown as NodeGraph;

describe("askToFixPlaytest", () => {
  it("tells the AI where the player was, what they did, and what failed", () => {
    const record = {
      currentNode: { id: "jump" },
      recentSignals: [
        { nodeId: "menu", signal: "start", targetNodeId: "jump", followed: true, at: "1" },
        { nodeId: "jump", signal: "success", followed: false, at: "2" },
      ],
    } as unknown as PlayableDebugRecord;

    expect(askToFixPlaytest(graph, record, ["time is not defined"])).toBe([
      "Something broke while I was playtesting. Find the cause and fix it.",
      "I was in Node 2.",
      "",
      "What I did:",
      '- Node 1: "start" → Node 2',
      '- Node 2: "success" → goes nowhere',
      "",
      "Errors:",
      "- time is not defined",
    ].join("\n"));
  });

  it("still names the errors before the game has started", () => {
    expect(askToFixPlaytest(graph, undefined, ["Could not build"])).toBe(
      "Something broke while I was playtesting. Find the cause and fix it.\n\nErrors:\n- Could not build",
    );
  });
});
