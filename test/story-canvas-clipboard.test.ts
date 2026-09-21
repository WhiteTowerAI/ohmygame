import { describe, expect, it } from "vitest";
import type { StoryNode } from "../src/shared/contracts.js";
import { duplicateStoryNode, snapStoryCanvasPosition } from "../src/renderer/story-canvas-clipboard.js";
import { DEFAULT_SCENE_SURFACE_FILES } from "../src/shared/story.js";

describe("story canvas clipboard", () => {
  it("snaps pasted nodes to the canvas grid", () => {
    expect(snapStoryCanvasPosition({ x: 104, y: 196 })).toEqual({ x: 100, y: 200 });
  });

  it("duplicates canonical node data with a new identity and position", () => {
    const source: StoryNode = {
      id: "scene",
      type: "scene",
      position: { x: 100, y: 200 },
      data: {
        title: "Opening",
        durationMs: 3_000,
        presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } },
      },
    };
    const duplicate = duplicateStoryNode(source, { x: 123, y: 238 }, "copy");

    expect(duplicate).toEqual({ ...source, id: "copy", position: { x: 120, y: 240 } });
    expect(duplicate.data).not.toBe(source.data);
  });

  it("does not reproduce graph connections", () => {
    const source: StoryNode = {
      id: "image",
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        prompt: "",
        promptSource: { type: "node", nodeId: "prompt" },
        resolution: "1K",
        aspectRatio: "1:1",
        images: [{ type: "node", nodeId: "reference" }, { type: "library", assetId: "library" }],
      },
    };

    const duplicate = duplicateStoryNode(source, { x: 20, y: 20 }, "copy");

    expect(duplicate.type === "image" && duplicate.data.promptSource).toBeUndefined();
    expect(duplicate.type === "image" && duplicate.data.images).toEqual([{ type: "library", assetId: "library" }]);
  });
});
