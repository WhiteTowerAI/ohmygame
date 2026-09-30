import { describe, expect, it } from "vitest";
import { snapStoryCanvasPosition } from "../src/renderer/story-canvas-clipboard.js";

describe("story canvas clipboard", () => {
  it("snaps pasted nodes to the canvas grid", () => {
    expect(snapStoryCanvasPosition({ x: 104, y: 196 })).toEqual({ x: 100, y: 200 });
  });
});
