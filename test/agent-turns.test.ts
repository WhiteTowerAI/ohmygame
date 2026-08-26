import { describe, expect, it } from "vitest";
import { projectAgentTurns } from "../src/renderer/agent-turns.js";
import type { ThreadItem } from "../src/shared/contracts.js";

describe("projectAgentTurns", () => {
  it("preserves Pi message and tool order while a turn is active and after it completes", () => {
    const items = [
      item({ id: "user", type: "userMessage", text: "Build it", timestamp: 1_000 }),
      item({ id: "note", type: "agentMessage", text: "I will inspect the project.", status: "completed", timestamp: 2_000 }),
      tool("read", "read", 3_000, { path: "package.json" }),
      tool("write", "write", 4_000, { path: "src/main.ts" }),
      item({ id: "response", type: "agentMessage", text: "Done.", status: "completed", timestamp: 6_000 }),
    ];

    const active = projectAgentTurns(items, "turn-1")[0];
    const complete = projectAgentTurns(items)[0];

    expect(active).toMatchObject({ id: "turn-1", active: true, user: expect.objectContaining({ id: "user" }) });
    expect(complete).toMatchObject({ id: "turn-1", active: false, user: expect.objectContaining({ id: "user" }) });
    expect(active?.items.map(({ id }) => id)).toEqual(["note", "read", "write", "response"]);
    expect(complete?.items.map(({ id }) => id)).toEqual(["note", "read", "write", "response"]);
  });

  it("keeps streaming and empty assistant messages in place", () => {
    const turns = projectAgentTurns([
      item({ id: "user", type: "userMessage", text: "Hello", timestamp: 1_000 }),
      item({ id: "first", type: "agentMessage", text: "", status: "inProgress", timestamp: 2_000 }),
      item({ id: "second", type: "agentMessage", text: "Hi", status: "inProgress", timestamp: 3_000 }),
    ], "turn-1");

    expect(turns[0]?.items.map(({ id }) => id)).toEqual(["first", "second"]);
  });

  it("hides successful compaction but preserves failed compaction", () => {
    const turns = projectAgentTurns([
      item({ id: "user", type: "userMessage", text: "Build", timestamp: 1_000 }),
      item({ id: "complete", type: "contextCompaction", status: "completed", timestamp: 2_000 }),
      item({ id: "error", type: "contextCompaction", status: "failed", error: "Failed", timestamp: 3_000 }),
    ]);

    expect(turns[0]?.items).toEqual([expect.objectContaining({ id: "error" })]);
  });
});

type WithoutTurn<T> = T extends unknown ? Omit<T, "turnId"> : never;
type ItemInput = WithoutTurn<ThreadItem>;

function item(value: ItemInput): ThreadItem {
  return { ...value, turnId: "turn-1" } as ThreadItem;
}

function tool(id: string, tool: string, timestamp: number, args?: unknown): ThreadItem {
  return item({ id, type: "dynamicToolCall", toolCallId: id, tool, status: "completed", timestamp, arguments: args });
}
