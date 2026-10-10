import { describe, expect, it } from "vitest";
import { editPromptList, promptListLines } from "../src/renderer/prompt-lists.js";

describe("prompt lists", () => {
  it("continues ordered, unordered, nested and task lists with Shift+Enter", () => {
    for (const [value, next] of [["1. First", "\n2. "], ["9) Ninth", "\n10) "], ["- Item", "\n- "], ["  * Item", "\n  * "], ["- [x] Done", "\n- [ ] "]]) {
      expect(editPromptList(value!, value!.length, value!.length, "Enter", true)).toEqual({ value: value + next!, cursor: value!.length + next!.length });
    }
  });

  it("exits an empty item with Shift+Enter", () => {
    expect(editPromptList("1. First\n2. ", 12, 12, "Enter", true)).toEqual({ value: "1. First\n", cursor: 9 });
    expect(editPromptList("  - [ ] ", 8, 8, "Enter", true)).toEqual({ value: "", cursor: 0 });
  });

  it("splits a list item at the caret while keeping the trailing text", () => {
    expect(editPromptList("- First second", 8, 8, "Enter", true)).toEqual({ value: "- First \n- second", cursor: 11 });
  });

  it("leaves Enter available for sending even in populated or empty list items", () => {
    for (const value of ["1. First", "1. First\n2. ", "- Item", "- ", "  * Item", "- [x] Done", "  - [ ] "]) {
      expect(editPromptList(value, value.length, value.length, "Enter")).toBeUndefined();
    }
    expect(editPromptList("- First second", 8, 14, "Enter")).toBeUndefined();
  });

  it("removes a marker with Backspace and indents with Tab", () => {
    expect(editPromptList("- Item", 2, 2, "Backspace")).toEqual({ value: "Item", cursor: 0 });
    expect(editPromptList("- Item", 6, 6, "Tab")).toEqual({ value: "  - Item", cursor: 8 });
    expect(editPromptList("  - Item", 8, 8, "Tab", true)).toEqual({ value: "- Item", cursor: 6 });
  });

  it("leaves prose, horizontal rules and fenced code unchanged", () => {
    for (const value of ["Plain text", "---", "```md\n- code", "~~~~\n1. code"]) expect(editPromptList(value, value.length, value.length, "Enter", true)).toBeUndefined();
    expect(promptListLines("```\n- code\n```\n- Item").map((line) => Boolean(line.list))).toEqual([false, false, false, true]);
  });

  it("does not edit across multiple selected lines or before a marker", () => {
    expect(editPromptList("- Item\nText", 3, 10, "Enter", true)).toBeUndefined();
    expect(editPromptList("\n- Item", 0, 0, "Enter", true)).toBeUndefined();
    expect(editPromptList("- Item", 0, 0, "Enter", true)).toBeUndefined();
  });
});
