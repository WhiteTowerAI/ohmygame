import { describe, expect, it } from "vitest";
import type { AssetCanvasNode } from "../src/shared/contracts.js";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "../src/shared/asset-canvas.js";

describe("Asset Canvas document", () => {
  it("creates an empty valid canvas", () => {
    const canvas = createAssetCanvasDocument();
    expect(canvas).toMatchObject({ nodes: [], edges: [] });
    expect(isAssetCanvasDocument(canvas)).toBe(true);
  });

  it("accepts 3D generation and model Asset nodes", () => {
    const canvas = createAssetCanvasDocument();
    canvas.nodes = [
      { id: "model-generator", type: "model-3d", position: { x: 80, y: 120 }, data: { model: { provider: "meshy", id: "meshy-t2" }, targetPolycount: 4_000, texture: true, pbr: true, images: [] } },
      { id: "model-asset", type: "asset", position: { x: 560, y: 120 }, data: { assetId: "library-model", mediaType: "model" } },
    ];
    canvas.editorLayout.nodes = { "model-generator": { x: 80, y: 120 }, "model-asset": { x: 560, y: 120 } };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
  });

  it("accepts Animate 3D nodes fed by a model and rejects other sources", () => {
    const canvas = createAssetCanvasDocument();
    const animate: AssetCanvasNode = {
      id: "animate",
      type: "animate-3d",
      position: { x: 560, y: 120 },
      data: { source: { type: "node", nodeId: "model-generator" }, heightMeters: 1.7, actionIds: [0, 30] },
    };
    canvas.nodes = [
      { id: "model-generator", type: "model-3d", position: { x: 80, y: 120 }, data: { targetPolycount: 4_000, texture: true, pbr: false, images: [] } },
      animate,
    ];
    canvas.editorLayout.nodes = { "model-generator": { x: 80, y: 120 }, animate: { x: 560, y: 120 } };
    expect(isAssetCanvasDocument(canvas)).toBe(true);

    canvas.nodes[0] = { id: "model-generator", type: "text", position: { x: 80, y: 120 }, data: { text: "", instruction: "" } };
    expect(isAssetCanvasDocument(canvas)).toBe(false);
    canvas.nodes = [{ ...animate, data: { heightMeters: 1.7, actionIds: Array.from({ length: 11 }, (_, index) => index) } }];
    canvas.editorLayout.nodes = { animate: { x: 560, y: 120 } };
    expect(isAssetCanvasDocument(canvas)).toBe(false);
  });

  it("rejects invalid 3D generation settings", () => {
    const canvas = createAssetCanvasDocument();
    const node: AssetCanvasNode = {
      id: "model-generator",
      type: "model-3d",
      position: { x: 80, y: 120 },
      data: { targetPolycount: 4_000, texture: true, pbr: false, images: [] },
    };
    Reflect.deleteProperty(node.data, "targetPolycount");
    canvas.nodes = [node];
    canvas.editorLayout.nodes = { "model-generator": { x: 80, y: 120 } };
    expect(isAssetCanvasDocument(canvas)).toBe(false);
  });
});
