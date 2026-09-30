import { describe, expect, it } from "vitest";
import { undoShortcut } from "../src/renderer/editor-canvas.js";

const key = (value: string, modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

describe("undoShortcut", () => {
  it("reads undo and redo on macOS and other systems", () => {
    expect(undoShortcut(key("z", { metaKey: true }))).toBe("undo");
    expect(undoShortcut(key("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(undoShortcut(key("z", { ctrlKey: true }))).toBe("undo");
    expect(undoShortcut(key("y", { ctrlKey: true }))).toBe("redo");
  });

  it("ignores other keys and modifiers", () => {
    expect(undoShortcut(key("z"))).toBeUndefined();
    expect(undoShortcut(key("z", { metaKey: true, altKey: true }))).toBeUndefined();
    expect(undoShortcut(key("y", { metaKey: true }))).toBeUndefined();
    expect(undoShortcut(key("c", { metaKey: true }))).toBeUndefined();
  });
});
