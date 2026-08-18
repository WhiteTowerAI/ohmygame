import { describe, expect, it } from "vitest";
import type { AgentItem } from "../src/shared/contracts.js";
import type { AgentTurn } from "../src/renderer/agent-turns.js";
import { projectTurnDisplay } from "../src/renderer/turn-display.js";

describe("projectTurnDisplay", () => {
  it("keeps Pi facts separate from the initial activity display", () => {
    const display = projectTurnDisplay(turn([
      thinking("**Planning the build**", "streaming"),
    ], true));

    expect(display).toMatchObject({
      active: true,
      working: false,
      waiting: false,
      thinkingText: "**Planning the build**",
      work: [],
      messages: [],
      finalMessages: [],
    });
  });

  it("switches the stable activity header to Working after visible text begins", () => {
    const display = projectTurnDisplay(turn([{
      id: "assistant",
      turnId: "turn-1",
      kind: "assistant",
      text: "I will inspect the workspace.",
      status: "streaming",
      timestamp: 2,
    }], true), 500);

    expect(display.working).toBe(true);
    expect(display.work).toHaveLength(1);
    expect(display.messages).toHaveLength(0);
  });

  it("shows Thinking when streamed text stops without completing", () => {
    const display = projectTurnDisplay(turn([{
      id: "assistant",
      turnId: "turn-1",
      kind: "assistant",
      text: "I will create the project files.",
      status: "streaming",
      timestamp: 2,
    }], true), 1_002);

    expect(display.working).toBe(true);
    expect(display.waiting).toBe(true);
    expect(display.work).toHaveLength(1);
  });

  it("shows Thinking after stalled streamed commentary during work", () => {
    const display = projectTurnDisplay(turn([
      commentary("I inspected the workspace."),
      tool("complete"),
      {
        id: "assistant",
        turnId: "turn-1",
        kind: "assistant",
        text: "I will create the project files.",
        status: "streaming",
        timestamp: 4,
      },
    ], true), 1_004);

    expect(display.working).toBe(true);
    expect(display.waiting).toBe(true);
  });

  it("projects a running tool as the current activity", () => {
    const display = projectTurnDisplay(turn([
      commentary("I will update the file."),
      tool("running"),
    ], true));

    expect(display.working).toBe(true);
    expect(display.waiting).toBe(false);
    expect(display.work).toHaveLength(2);
    expect(display.work.at(-1)).toMatchObject({ kind: "tool-group", active: { kind: "tool", status: "running" } });
  });

  it("temporarily replaces the trailing completed tool group while waiting", () => {
    const display = projectTurnDisplay(turn([
      commentary("I will inspect the file."),
      tool("complete"),
    ], true));

    expect(display.waiting).toBe(true);
    expect(display.work).toHaveLength(1);
    expect(display.work[0]).toMatchObject({ kind: "item", item: { kind: "assistant", phase: "commentary" } });
  });

  it("separates completed work from the final answer", () => {
    const display = projectTurnDisplay(turn([
      commentary("I inspected the file."),
      tool("complete"),
      answer("Done."),
    ], false));

    expect(display.active).toBe(false);
    expect(display.work).toHaveLength(2);
    expect(display.messages).toEqual([]);
    expect(display.finalMessages).toHaveLength(1);
    expect(display.finalMessages[0].text).toBe("Done.");
  });

  it("keeps a final answer in the stable container until the turn ends", () => {
    const display = projectTurnDisplay(turn([answer("Done.")], true));

    expect(display.working).toBe(true);
    expect(display.waiting).toBe(false);
    expect(display.work).toHaveLength(1);
    expect(display.finalMessages).toEqual([]);
  });
});

function turn(items: AgentItem[], active: boolean): AgentTurn {
  return {
    id: "turn-1",
    user: { id: "user", turnId: "turn-1", kind: "user", text: "Build", timestamp: 1 },
    items,
    active,
  };
}

function thinking(text: string, status: "streaming" | "complete"): AgentItem {
  return { id: "thinking", turnId: "turn-1", kind: "thinking", text, status, timestamp: 2 };
}

function commentary(text: string): AgentItem {
  return { id: `commentary:${text}`, turnId: "turn-1", kind: "assistant", text, status: "complete", phase: "commentary", timestamp: 2 };
}

function answer(text: string): AgentItem {
  return { id: "answer", turnId: "turn-1", kind: "assistant", text, status: "complete", phase: "final_answer", timestamp: 4 };
}

function tool(status: "running" | "complete"): AgentItem {
  return {
    id: "tool",
    turnId: "turn-1",
    kind: "tool",
    toolCallId: "tool",
    toolName: "read",
    status,
    args: { path: "package.json" },
    timestamp: 3,
  };
}
