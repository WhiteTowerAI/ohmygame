import { describe, expect, it } from "vitest";
import { formatChatPrompt } from "../src/renderer/chat-reference.js";

describe("chat reference", () => {
  it("adds selected text before the user's prompt", () => {
    expect(formatChatPrompt({ text: " selected answer " }, " explain this ")).toBe(
      "[Selected text]\nselected answer\n\n[User prompt]\nexplain this",
    );
  });
});
