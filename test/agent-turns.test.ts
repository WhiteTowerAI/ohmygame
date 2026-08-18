import { describe, expect, it } from "vitest";
import { projectAgentTurns } from "../src/renderer/agent-turns.js";
import type { AgentItem } from "../src/shared/contracts.js";

describe("projectAgentTurns", () => {
  it("preserves Pi message and tool order while a turn is active and after it completes", () => {
    const items = [
      item({ id: "user", kind: "user", text: "Build it", timestamp: 1_000 }),
      item({ id: "note", kind: "assistant", text: "I will inspect the project.", status: "complete", timestamp: 2_000 }),
      tool("read", "read", 3_000, { path: "package.json" }),
      tool("write", "write", 4_000, { path: "src/main.ts" }),
      item({ id: "response", kind: "assistant", text: "Done.", status: "complete", timestamp: 6_000 }),
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
      item({ id: "user", kind: "user", text: "Hello", timestamp: 1_000 }),
      item({ id: "first", kind: "assistant", text: "", status: "streaming", timestamp: 2_000 }),
      item({ id: "second", kind: "assistant", text: "Hi", status: "streaming", timestamp: 3_000 }),
    ], "turn-1");

    expect(turns[0]?.items.map(({ id }) => id)).toEqual(["first", "second"]);
  });

  it("hides successful compaction but preserves failed compaction", () => {
    const turns = projectAgentTurns([
      item({ id: "user", kind: "user", text: "Build", timestamp: 1_000 }),
      item({ id: "complete", kind: "compaction", status: "complete", timestamp: 2_000 }),
      item({ id: "error", kind: "compaction", status: "error", error: "Failed", timestamp: 3_000 }),
    ]);

    expect(turns[0]?.items).toEqual([expect.objectContaining({ id: "error" })]);
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
