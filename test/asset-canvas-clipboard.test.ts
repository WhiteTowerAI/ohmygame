import { describe, expect, it } from "vitest";
import type { AssetCanvasNode } from "../src/shared/contracts.js";
import { createCanvasClipboard, duplicateAssetCanvasNode, duplicateCanvasSelection, parseCanvasClipboard } from "../src/renderer/asset-canvas-clipboard.js";

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

  it("round-trips a selection and remaps its internal links and edges", () => {
    const text: AssetCanvasNode = { id: "prompt", type: "text", position: { x: 0, y: 0 }, data: { text: "A hero", instruction: "" } };
    const image: AssetCanvasNode = { id: "image", type: "image", position: { x: 400, y: 20 }, data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [{ type: "library", assetId: "reference" }, { type: "node", nodeId: "outside" }], promptSource: { type: "node", nodeId: text.id } } };
    const edge = { id: "link", source: text.id, target: image.id };
    const clipboard = createCanvasClipboard("project", [text, image], [edge, { id: "outside-edge", source: "outside", target: image.id }]);
    expect(parseCanvasClipboard(JSON.stringify(clipboard))).toEqual(clipboard);
    let sequence = 0;
    const copy = duplicateCanvasSelection(clipboard.nodes, clipboard.edges, { x: 100, y: 100 }, () => `new-${++sequence}`);
    expect(copy.nodes.map((node) => node.position)).toEqual([{ x: 100, y: 100 }, { x: 500, y: 120 }]);
    expect(copy.nodes[1]!.data).toMatchObject({ promptSource: { type: "node", nodeId: "new-1" }, images: [{ type: "library", assetId: "reference" }] });
    expect(copy.edges).toEqual([{ id: "new-3", source: "new-1", target: "new-2" }]);
    expect(image.data).toMatchObject({ promptSource: { type: "node", nodeId: "prompt" } });
  });

  it("remaps a 3D model's image and animation source within the copied group", () => {
    const image: AssetCanvasNode = { id: "art", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "hero", mediaType: "image" } };
    const model: AssetCanvasNode = { id: "model", type: "model-3d", position: { x: 400, y: 0 }, data: { targetPolycount: 1000, texture: true, pbr: true, images: [{ type: "node", nodeId: image.id }, { type: "node", nodeId: "external" }] } };
    const animation: AssetCanvasNode = { id: "animation", type: "animate-3d", position: { x: 800, y: 0 }, data: { heightMeters: 1.7, actionIds: [0], source: { type: "node", nodeId: model.id } } };
    const copy = duplicateCanvasSelection([image, model, animation], [], { x: 20, y: 20 }, (() => { let i = 0; return () => `copy-${++i}`; })());
    expect(copy.nodes[1]!.data).toMatchObject({ images: [{ type: "node", nodeId: "copy-1" }] });
    expect(copy.nodes[2]!.data).toMatchObject({ source: { type: "node", nodeId: "copy-2" } });
    expect(duplicateAssetCanvasNode(model, { x: 0, y: 0 }).data).toMatchObject({ images: [] });
  });

  it("rejects corrupt clipboard graphs and non-canvas text", () => {
    const node: AssetCanvasNode = { id: "a", type: "text", position: { x: 0, y: 0 }, data: { text: "hello", instruction: "" } };
    const value = createCanvasClipboard("p", [node], []);
    expect(parseCanvasClipboard("ordinary pasted text")).toBeUndefined();
    expect(parseCanvasClipboard(JSON.stringify({ ...value, nodes: [node, node] }))).toBeUndefined();
    expect(parseCanvasClipboard(JSON.stringify({ ...value, edges: [{ id: "e", source: "a", target: "missing" }] }))).toBeUndefined();
    expect(parseCanvasClipboard(JSON.stringify({ ...value, nodes: [{ ...node, position: { x: null, y: 0 } }] }))).toBeUndefined();
  });
});
