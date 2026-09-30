import { describe, expect, it } from "vitest";
import type { AssetCanvasNode } from "../src/shared/contracts.js";
import { duplicateAssetCanvasNode, snapCanvasPosition } from "../src/renderer/asset-canvas-clipboard.js";

describe("Asset Canvas clipboard", () => {
  it("snaps pasted nodes to the canvas grid", () => {
    expect(snapCanvasPosition({ x: 104, y: 196 })).toEqual({ x: 100, y: 200 });
  });

  it("duplicates canonical node data with a new identity and position", () => {
    const source: AssetCanvasNode = {
      id: "text",
      type: "text",
      position: { x: 100, y: 200 },
      data: { text: "Opening", instruction: "Write a title" },
    };
    const duplicate = duplicateAssetCanvasNode(source, { x: 123, y: 238 }, "copy");

    expect(duplicate).toEqual({ ...source, id: "copy", position: { x: 120, y: 240 } });
    expect(duplicate.data).not.toBe(source.data);
  });

  it("does not reproduce graph connections", () => {
    const source: AssetCanvasNode = {
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

    const duplicate = duplicateAssetCanvasNode(source, { x: 20, y: 20 }, "copy");

    expect(duplicate.type === "image" && duplicate.data.promptSource).toBeUndefined();
    expect(duplicate.type === "image" && duplicate.data.images).toEqual([{ type: "library", assetId: "library" }]);
  });
});
