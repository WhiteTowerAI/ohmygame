import { describe, expect, it } from "vitest";
import { editPromptList, promptListLines } from "../src/renderer/prompt-lists.js";

describe("prompt lists", () => {
  it("continues ordered, unordered, nested and task lists", () => {
    for (const [value, next] of [["1. First", "\n2. "], ["9) Ninth", "\n10) "], ["- Item", "\n- "], ["  * Item", "\n  * "], ["- [x] Done", "\n- [ ] "]]) {
      expect(editPromptList(value!, value!.length, value!.length, "Enter")).toEqual({ value: value + next!, cursor: value!.length + next!.length });
    }
  });

  it("exits an empty item without sending the prompt", () => {
    expect(editPromptList("1. First\n2. ", 12, 12, "Enter")).toEqual({ value: "1. First\n", cursor: 9 });
    expect(editPromptList("  - [ ] ", 8, 8, "Enter")).toEqual({ value: "", cursor: 0 });
  });

  it("splits a list item at the caret while keeping the trailing text", () => {
    expect(editPromptList("- First second", 8, 8, "Enter")).toEqual({ value: "- First \n- second", cursor: 11 });
  });

  it("leaves Shift+Enter available for a plain line break", () => {
    expect(editPromptList("- Item", 6, 6, "Enter", true)).toBeUndefined();
    expect(editPromptList("- ", 2, 2, "Enter", true)).toBeUndefined();
  });

  it("removes a marker with Backspace and indents with Tab", () => {
    expect(editPromptList("- Item", 2, 2, "Backspace")).toEqual({ value: "Item", cursor: 0 });
    expect(editPromptList("- Item", 6, 6, "Tab")).toEqual({ value: "  - Item", cursor: 8 });
    expect(editPromptList("  - Item", 8, 8, "Tab", true)).toEqual({ value: "- Item", cursor: 6 });
  });

  it("leaves prose, horizontal rules and fenced code unchanged", () => {
    for (const value of ["Plain text", "---", "```md\n- code", "~~~~\n1. code"]) expect(editPromptList(value, value.length, value.length, "Enter")).toBeUndefined();
    expect(promptListLines("```\n- code\n```\n- Item").map((line) => Boolean(line.list))).toEqual([false, false, false, true]);
  });

  it("does not edit across multiple selected lines or before a marker", () => {
    expect(editPromptList("- Item\nText", 3, 10, "Enter")).toBeUndefined();
    expect(editPromptList("\n- Item", 0, 0, "Enter")).toBeUndefined();
    expect(editPromptList("- Item", 0, 0, "Enter")).toBeUndefined();
  });
});
