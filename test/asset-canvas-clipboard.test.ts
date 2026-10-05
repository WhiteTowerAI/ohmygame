import { describe, expect, it } from "vitest";
import type { AssetCanvasNode } from "../src/shared/contracts.js";
import { duplicateAssetCanvasNode } from "../src/renderer/asset-canvas-clipboard.js";

describe("Asset Canvas clipboard", () => {
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

  it("keeps an Animate node's Library model but not its connected node", () => {
    const connected: AssetCanvasNode = { id: "animate", type: "animate-3d", position: { x: 0, y: 0 }, data: { source: { type: "node", nodeId: "model" }, heightMeters: 1.7, actionIds: [0] } };
    const library: AssetCanvasNode = { ...connected, data: { ...connected.data, source: { type: "library", assetId: "hero" } } };

    expect(duplicateAssetCanvasNode(connected, { x: 0, y: 0 }, "copy").data).toEqual({ heightMeters: 1.7, actionIds: [0] });
    expect(duplicateAssetCanvasNode(library, { x: 0, y: 0 }, "copy").data).toEqual(library.data);
  });
});
