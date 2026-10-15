import { describe, expect, it } from "vitest";
import { pinchedViewport, undoShortcut } from "../src/renderer/editor-canvas.js";

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

describe("pinchedViewport", () => {
  const limits = { minZoom: 0.1, maxZoom: 2, mac: true };

  it("zooms around the pointer, keeping the point under it in place", () => {
    const before = { x: 40, y: 20, zoom: 1 };
    const pointer = { x: 300, y: 200 };
    const after = pinchedViewport(before, pointer, { deltaY: -10, deltaMode: 0 }, limits);

    expect(after.zoom).toBeCloseTo(2 ** 0.2);
    expect((pointer.x - after.x) / after.zoom).toBeCloseTo((pointer.x - before.x) / before.zoom);
    expect((pointer.y - after.y) / after.zoom).toBeCloseTo((pointer.y - before.y) / before.zoom);
  });

  it("stays within the canvas zoom limits", () => {
    expect(pinchedViewport({ x: 0, y: 0, zoom: 1.9 }, { x: 0, y: 0 }, { deltaY: -500, deltaMode: 0 }, limits).zoom).toBe(2);
    expect(pinchedViewport({ x: 0, y: 0, zoom: 0.2 }, { x: 0, y: 0 }, { deltaY: 500, deltaMode: 0 }, limits).zoom).toBe(0.1);
  });
});
