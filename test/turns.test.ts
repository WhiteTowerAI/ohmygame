import { describe, expect, it } from "vitest";
import { groupThreadItems } from "../src/shared/turns.js";
import type { ThreadItem } from "../src/shared/contracts.js";

describe("groupThreadItems", () => {
  it("treats an intermediate failed attempt followed by a final answer as completed", () => {
    const items: ThreadItem[] = [
      { id: "user", turnId: "turn-1", type: "userMessage", text: "Build" },
      {
        id: "failed-attempt",
        turnId: "turn-1",
        type: "agentMessage",
        text: "I started checking.",
        status: "failed",
        error: { message: "stream disconnected" },
      },
      {
        id: "final-answer",
        turnId: "turn-1",
        type: "agentMessage",
        text: "Done.",
        status: "completed",
        phase: "final_answer",
      },
    ];

    expect(groupThreadItems("conversation-1", items)[0]?.status).toBe("completed");
  });

  it("treats the final failed assistant attempt as a failed turn", () => {
    const items: ThreadItem[] = [
      { id: "user", turnId: "turn-1", type: "userMessage", text: "Build" },
      {
        id: "failed-attempt",
        turnId: "turn-1",
        type: "agentMessage",
        text: "",
        status: "failed",
        error: { message: "stream disconnected" },
      },
    ];

    expect(groupThreadItems("conversation-1", items)[0]?.status).toBe("failed");
  });

  it("closes orphaned running tools in a non-active restored turn", () => {
    const items: ThreadItem[] = [
      { id: "user", turnId: "turn-1", type: "userMessage", text: "Build" },
      {
        id: "tool",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "tool",
        tool: "bash",
        status: "inProgress",
        arguments: { command: "npm test" },
      },
    ];

    expect(groupThreadItems("conversation-1", items)[0]).toMatchObject({
      status: "completed",
      items: expect.arrayContaining([expect.objectContaining({ id: "tool", status: "failed" })]),
    });
  });
});
