import { describe, expect, it } from "vitest";
import type { ThreadItem, Turn } from "../src/shared/contracts.js";
import { mergeCompletedCompactionTurns, projectTurnDisplay } from "../src/renderer/turn-display.js";

describe("mergeCompletedCompactionTurns", () => {
  const compaction: Turn = {
    id: "compact-1", conversationId: "conversation-1", status: "completed",
    items: [{ id: "compact-item", turnId: "compact-1", type: "contextCompaction", status: "completed", timestamp: 10_000 }],
  };

  it("preserves merged historical references when a later turn changes", () => {
    const original = turn([tool("completed"), answer("Done")], false);
    const active = { ...turn([], true), id: "active" };
    const first = mergeCompletedCompactionTurns([original, compaction, active]);
    const second = mergeCompletedCompactionTurns([original, compaction, { ...active, items: [...active.items, answer("Streaming")] }]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
  });

  it("merges independent completed compaction into preceding work without changing runtime turns", () => {
    const original = turn([tool("completed"), answer("Done.")], false);
    const turns = [original, compaction, { ...compaction, id: "compact-2", items: [{ ...compaction.items[0], id: "compact-item-2", turnId: "compact-2" }] }];
    const merged = mergeCompletedCompactionTurns(turns);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(original.id);
    expect(merged[0].items.slice(-2).map((item) => item.turnId)).toEqual([original.id, original.id]);
    expect(projectTurnDisplay(merged[0]).durationMs).toBe(3);
    expect(original.items).toHaveLength(3);
    expect(compaction.items[0].turnId).toBe("compact-1");
  });

  it("retains model changes while folding compaction into the latest conversation work", () => {
    const first = { ...turn([], false), id: "earlier" };
    const latest = turn([answer("Done.")], false);
    const modelChange: Turn = {
      id: "model-change", conversationId: "conversation-1", status: "completed",
      items: [{ id: "model-change", turnId: "model-change", type: "modelChange", model: { provider: "openai", id: "next" } }],
    };
    const merged = mergeCompletedCompactionTurns([first, latest, modelChange, compaction]);

    expect(merged.map((item) => item.id)).toEqual([first.id, latest.id, modelChange.id]);
    expect(merged[0]).toBe(first);
    expect(merged[1].items.at(-1)).toMatchObject({ type: "contextCompaction", turnId: latest.id });
    expect(merged[2]).toBe(modelChange);
  });

  it("preserves running and failed compaction as independent activity", () => {
    for (const status of ["inProgress", "failed", "cancelled"] as const) {
      const separate = { ...compaction, status, items: [{ ...compaction.items[0], status }] } as Turn;
      const turns = [turn([answer("Done.")], false), separate];
      expect(mergeCompletedCompactionTurns(turns)).toEqual(turns);
    }
  });

  it("does not attach orphan compaction to another conversation or pending steering", () => {
    const unrelated = { ...turn([], false), conversationId: "other-conversation" };
    const steering = { ...turn([], false), steering: true };
    expect(mergeCompletedCompactionTurns([unrelated, steering, compaction])).toEqual([unrelated, steering, compaction]);
  });

  it("keeps stopped work duration when compaction completes afterward", () => {
    const stopped: Turn = {
      ...turn([tool("completed"), { ...answer(""), status: "cancelled", phase: undefined, timestamp: 5 }], false),
      status: "cancelled",
    };
    const [merged] = mergeCompletedCompactionTurns([stopped, compaction]);
    expect(merged.status).toBe("cancelled");
    expect(projectTurnDisplay(merged).durationMs).toBe(4);
  });
});

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

  it("folds completed context compaction into work before the final answer", () => {
    const compaction: ThreadItem = {
      id: "compaction",
      turnId: "turn-1",
      type: "contextCompaction",
      status: "completed",
    };
    const display = projectTurnDisplay(turn([answer("Done."), compaction], false));

    expect(display.work).toEqual([{ kind: "item", item: compaction }]);
    expect(display.messages).toEqual([]);
    expect(display.finalMessages).toEqual([answer("Done.")]);
  });

  it("does not extend work duration for compaction after the final answer", () => {
    const display = projectTurnDisplay(turn([
      { ...answer("Done."), timestamp: 5 },
      { id: "compaction", turnId: "turn-1", type: "contextCompaction", status: "completed", timestamp: 10_000 },
    ], false));

    expect(display.durationMs).toBe(4);
  });

  it("keeps failed compaction visible outside the completed work fold", () => {
    const compaction: ThreadItem = { id: "failed", turnId: "turn-1", type: "contextCompaction", status: "failed" };
    const display = projectTurnDisplay(turn([answer("Done."), compaction], false));

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

function answer(text: string): Extract<ThreadItem, { type: "agentMessage" }> {
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
