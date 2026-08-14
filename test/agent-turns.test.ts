import { describe, expect, it } from "vitest";
import { projectAgentTurns } from "../src/renderer/agent-turns.js";
import type { AgentItem } from "../src/shared/contracts.js";

describe("projectAgentTurns", () => {
  it("separates work from the final assistant response", () => {
    const turns = projectAgentTurns([
      item({ id: "user", kind: "user", text: "Build it", timestamp: 1_000 }),
      item({ id: "note", kind: "assistant", text: "I will inspect the project.", status: "complete", timestamp: 2_000 }),
      tool("read", "read", 3_000, { path: "package.json" }),
      tool("write", "write", 4_000, { path: "src/main.ts" }),
      item({ id: "response", kind: "assistant", text: "Done.", status: "complete", timestamp: 6_000 }),
    ]);

    expect(turns).toEqual([expect.objectContaining({
      id: "turn-1",
      active: false,
      status: "complete",
      startedAt: 1_000,
      completedAt: 6_000,
      work: expect.arrayContaining([expect.objectContaining({ id: "note" }), expect.objectContaining({ id: "read" })]),
      response: expect.objectContaining({ id: "response", text: "Done." }),
    })]);
  });

  it("keeps the streaming assistant message inside active work", () => {
    const turns = projectAgentTurns([
      item({ id: "user", kind: "user", text: "Hello", timestamp: 1_000 }),
      item({ id: "assistant", kind: "assistant", text: "Hi", status: "streaming", timestamp: 2_000 }),
    ], "turn-1");

    expect(turns[0]).toMatchObject({ active: true, status: "running", response: undefined });
    expect(turns[0]?.work).toEqual([expect.objectContaining({ id: "assistant" })]);
  });

  it("does not treat an empty streaming assistant as visible work", () => {
    const turns = projectAgentTurns([
      item({ id: "user", kind: "user", text: "Hello", timestamp: 1_000 }),
      item({ id: "assistant", kind: "assistant", text: "", status: "streaming", timestamp: 2_000 }),
    ], "turn-1");

    expect(turns[0]).toMatchObject({ active: true, work: [], response: undefined });
  });

  it("keeps earlier assistant text inside active work once a tool starts", () => {
    const turns = projectAgentTurns([
      item({ id: "user", kind: "user", text: "Build", timestamp: 1_000 }),
      item({ id: "assistant", kind: "assistant", text: "I will inspect it.", status: "complete", timestamp: 2_000 }),
      tool("read", "read", 3_000, { path: "package.json" }),
    ], "turn-1");

    expect(turns[0]).toMatchObject({ active: true, response: undefined });
    expect(turns[0]?.work).toEqual([
      expect.objectContaining({ id: "assistant" }),
      expect.objectContaining({ id: "read" }),
    ]);
  });

  it("does not present intermediate text as the final response when work follows it", () => {
    const turns = projectAgentTurns([
      item({ id: "user", kind: "user", text: "Build", timestamp: 1_000 }),
      item({ id: "assistant", kind: "assistant", text: "I will inspect it.", status: "complete", timestamp: 2_000 }),
      tool("read", "read", 3_000, { path: "package.json" }),
    ]);

    expect(turns[0]).toMatchObject({ response: undefined });
    expect(turns[0]?.work).toEqual([
      expect.objectContaining({ id: "assistant" }),
      expect.objectContaining({ id: "read" }),
    ]);
  });

  it("hides successful compaction and preserves failed terminal status", () => {
    const turns = projectAgentTurns([
      item({ id: "user", kind: "user", text: "Build", timestamp: 1_000 }),
      item({ id: "compact", kind: "compaction", status: "complete", timestamp: 2_000 }),
      item({ id: "error", kind: "assistant", text: "", status: "error", error: "Failed", timestamp: 3_000 }),
    ]);

    expect(turns[0]).toMatchObject({ status: "error", work: [], response: expect.objectContaining({ id: "error" }) });
  });
});

type WithoutTurn<T> = T extends unknown ? Omit<T, "turnId"> : never;
type ItemInput = WithoutTurn<AgentItem>;

function item(value: ItemInput): AgentItem {
  return { ...value, turnId: "turn-1" } as AgentItem;
}

function tool(id: string, toolName: string, timestamp: number, args?: unknown): AgentItem {
  return item({ id, kind: "tool", toolCallId: id, toolName, status: "complete", timestamp, args });
}
