import { describe, expect, it } from "vitest";
import type { ThreadItem, Turn } from "../src/shared/contracts.js";
import { projectTurnDisplay } from "../src/renderer/turn-display.js";

describe("projectTurnDisplay", () => {
  it("keeps Pi facts separate from the initial activity display", () => {
    const display = projectTurnDisplay(turn([
      thinking("**Planning the build**", "inProgress"),
    ], true));

    expect(display).toMatchObject({
      status: "inProgress",
      working: false,
      work: [],
      messages: [],
      finalMessages: [],
    });
  });

  it("switches the stable activity header to Working after visible text begins", () => {
    const display = projectTurnDisplay(turn([{
      id: "assistant",
      turnId: "turn-1",
      type: "agentMessage",
      text: "I will inspect the workspace.",
      status: "inProgress",
      timestamp: 2,
    }], true), 500);

    expect(display.working).toBe(true);
    expect(display.work).toHaveLength(1);
    expect(display.messages).toHaveLength(0);
  });

  it("does not show an empty Working state for a plan-only turn", () => {
    const display = projectTurnDisplay(turn([{
      id: "turn-1:plan",
      turnId: "turn-1",
      type: "plan",
      plan: { steps: [{ step: "Inspect the workspace", status: "in_progress" }] },
    }], true));

    expect(display.working).toBe(false);
    expect(display.work).toEqual([]);
    expect(display.messages).toEqual([]);
  });

  it("shows Thinking when streamed text stops without completing", () => {
    const display = projectTurnDisplay(turn([{
      id: "assistant",
      turnId: "turn-1",
      type: "agentMessage",
      text: "I will create the project files.",
      status: "inProgress",
      timestamp: 2,
    }], true), 1_002);

    expect(display.working).toBe(true);
    expect(display.work).toHaveLength(2);
    expect(display.work.at(-1)).toMatchObject({ kind: "thinking" });
  });

  it("shows Thinking after stalled streamed commentary during work", () => {
    const display = projectTurnDisplay(turn([
      commentary("I inspected the workspace."),
      tool("completed"),
      {
        id: "assistant",
        turnId: "turn-1",
        type: "agentMessage",
        text: "I will create the project files.",
        status: "inProgress",
        timestamp: 4,
      },
    ], true), 1_004);

    expect(display.working).toBe(true);
    expect(display.work.at(-1)).toMatchObject({ kind: "thinking" });
  });

  it("does not show Thinking while waiting for questionnaire input", () => {
    const display = projectTurnDisplay(turn([
      commentary("I need a decision before continuing."),
    ], true), Date.now(), true);

    expect(display.working).toBe(true);
    expect(display.work).not.toContainEqual(expect.objectContaining({ kind: "thinking" }));
  });

  it("projects a running tool group as current", () => {
    const display = projectTurnDisplay(turn([
      commentary("I will update the file."),
      tool("inProgress"),
    ], true));

    expect(display.working).toBe(true);
    expect(display.work).toHaveLength(2);
    expect(display.work.at(-1)).toMatchObject({ kind: "tool-group", thinking: false, tools: [{ type: "dynamicToolCall", status: "inProgress" }] });
  });

  it("keeps the trailing completed tool group while waiting", () => {
    const display = projectTurnDisplay(turn([
      commentary("I will inspect the file."),
      tool("completed"),
    ], true));

    expect(display.work).toHaveLength(2);
    expect(display.work[0]).toMatchObject({ kind: "item", item: { type: "agentMessage", phase: "commentary" } });
    expect(display.work[1]).toMatchObject({ kind: "tool-group", thinking: true, tools: [{ type: "dynamicToolCall", status: "completed" }] });
  });

  it("separates completed work from the final answer", () => {
    const display = projectTurnDisplay(turn([
      commentary("I inspected the file."),
      tool("completed"),
      answer("Done."),
    ], false));

    expect(display.status).toBe("completed");
    expect(display.work).toHaveLength(2);
    expect(display.messages).toEqual([]);
    expect(display.finalMessages).toHaveLength(1);
    expect(display.finalMessages[0].text).toBe("Done.");
  });

  it("keeps completed work but removes the empty status row from a cancelled turn", () => {
    const display = projectTurnDisplay({
      ...turn([
        tool("completed"),
        { id: "stopped", turnId: "turn-1", type: "agentMessage", text: "", status: "cancelled", timestamp: 5 },
      ], false),
      status: "cancelled",
    });

    expect(display.status).toBe("cancelled");
    expect(display.work).toHaveLength(1);
    expect(display.work[0]).toMatchObject({ kind: "tool-group", tools: [{ status: "completed" }] });
    expect(display.finalMessages).toEqual([]);
    expect(display.durationMs).toBe(4);
  });

  it("keeps non-final agent messages in work even without a phase", () => {
    const display = projectTurnDisplay(turn([{
      id: "assistant-error",
      turnId: "turn-1",
      type: "agentMessage",
      text: "I was checking the project.",
      status: "failed",
      error: { message: "stream disconnected" },
    }], false));

    expect(display.work).toHaveLength(1);
    expect(display.messages).toEqual([]);
  });

  it("keeps completed context compaction as a visible timeline event", () => {
    const compaction: ThreadItem = {
      id: "compaction",
      turnId: "turn-1",
      type: "contextCompaction",
      status: "completed",
    };
    const display = projectTurnDisplay(turn([compaction], false));

    expect(display.work).toEqual([]);
    expect(display.messages).toEqual([compaction]);
  });

  it("projects generated images after work as artifacts", () => {
    const display = projectTurnDisplay(turn([
      tool("completed", { artifact: { type: "image", path: "assets/generated/image.png", mediaType: "image/png" } }),
      answer("Done."),
    ], false));

    expect(display.artifacts).toEqual([{ type: "image", path: "assets/generated/image.png", mediaType: "image/png" }]);
  });

  it("projects generated models after work as artifacts", () => {
    const display = projectTurnDisplay(turn([
      tool("completed", { artifact: { type: "model", path: "assets/generated/model.glb", mediaType: "model/gltf-binary" } }),
      answer("Done."),
    ], false));

    expect(display.artifacts).toEqual([{ type: "model", path: "assets/generated/model.glb", mediaType: "model/gltf-binary" }]);
  });

  it("keeps a final answer in the stable container until the turn ends", () => {
    const display = projectTurnDisplay(turn([answer("Done.")], true));

    expect(display.working).toBe(true);
    expect(display.work).toHaveLength(1);
    expect(display.finalMessages).toEqual([]);
  });
});

function turn(items: ThreadItem[], active: boolean): Turn {
  return {
    id: "turn-1",
    conversationId: "conversation-1",
    status: active ? "inProgress" : "completed",
    items: [{ id: "user", turnId: "turn-1", type: "userMessage", text: "Build", timestamp: 1 }, ...items],
  };
}

function thinking(text: string, status: "inProgress" | "completed"): ThreadItem {
  return { id: "thinking", turnId: "turn-1", type: "reasoning", text, status, timestamp: 2 };
}

function commentary(text: string): ThreadItem {
  return { id: `commentary:${text}`, turnId: "turn-1", type: "agentMessage", text, status: "completed", phase: "commentary", timestamp: 2 };
}

function answer(text: string): ThreadItem {
  return { id: "answer", turnId: "turn-1", type: "agentMessage", text, status: "completed", phase: "final_answer", timestamp: 4 };
}

function tool(status: "inProgress" | "completed", extra: Partial<Extract<ThreadItem, { type: "dynamicToolCall" }>> = {}): ThreadItem {
  return {
    id: "tool",
    turnId: "turn-1",
    type: "dynamicToolCall",
    toolCallId: "tool",
    tool: "read",
    status,
    arguments: { path: "package.json" },
    timestamp: 3,
    ...extra,
  };
}
