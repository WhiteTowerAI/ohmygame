import { describe, expect, it } from "vitest";
import { createAssetCanvasDocument, isAssetCanvasDocument, validateAssetCanvasDocument, withoutContentNodeSizes } from "../src/shared/asset-canvas.js";
import { canvasHistoryKey, model3DViewLabels, toAssetCanvasNode } from "../src/renderer/asset-canvas-workspace.js";
import type { Model3DModel } from "../src/shared/contracts.js";
import { model3DModel } from "../src/shared/custom-models.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { buildModel3DToolRequest } from "../src/shared/generation-config.js";
import { MODEL3D_CONNECTION_ID } from "../src/shared/model3d-operations.js";

describe("Asset Canvas node serialization", () => {
  it("keeps resize history and serialization while rejecting invalid node dimensions", () => {
    const canvas = createAssetCanvasDocument();
    const node = toAssetCanvasNode({ id: "notes", type: "text", position: { x: 0, y: 0 }, width: 600, height: 400, data: { text: "Notes" } });
    canvas.nodes = [node]; canvas.editorLayout.nodes.notes = { x: 0, y: 0, width: 600, height: 400 };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    const resized = structuredClone(canvas); resized.nodes[0]!.width = 800;
    expect(canvasHistoryKey(resized)).not.toBe(canvasHistoryKey(canvas));
    resized.nodes[0]!.width = Infinity; expect(isAssetCanvasDocument(resized)).toBe(false);
  });
  it("rejects fixed sizes on nodes that size to their content", () => {
    const canvas = createAssetCanvasDocument();
    canvas.nodes = [{ id: "boat", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "boat", mediaType: "image" } }];
    canvas.editorLayout.nodes.boat = { x: 0, y: 0 };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    canvas.nodes[0]!.width = 330; canvas.editorLayout.nodes.boat = { x: 0, y: 0, width: 330 };
    expect(isAssetCanvasDocument(canvas)).toBe(false);
    expect(() => validateAssetCanvasDocument(canvas)).toThrow("Node boat: asset nodes size to their content");
    canvas.nodes.push({ id: "notes", type: "text", position: { x: 0, y: 0 }, width: 600, height: 400, data: { text: "", instruction: "" } });
    canvas.editorLayout.nodes.notes = { x: 0, y: 0, width: 600, height: 400 };
    const restored = withoutContentNodeSizes(canvas);
    expect(isAssetCanvasDocument(restored)).toBe(true);
    expect(restored.editorLayout.nodes).toEqual({ boat: { x: 0, y: 0 }, notes: { x: 0, y: 0, width: 600, height: 400 } });
    expect(restored.nodes[1]).toMatchObject({ width: 600, height: 400 });
  });
  it("uses protocol-specific reference labels rather than applying directions to every provider", () => {
    expect(model3DViewLabels(model3DModel("hyper3d", "Hyper3D", MODEL_3D_PRESETS.hyper3d[0]!))).toEqual(["Reference 1", "Reference 2", "Reference 3", "Reference 4", "Reference 5"]);
    expect(model3DViewLabels(model3DModel("tripo", "Tripo", MODEL_3D_PRESETS.tripo[0]!))).toEqual(["Front", "Left", "Back", "Right"]);
    expect(model3DViewLabels(model3DModel("meshy", "Meshy", MODEL_3D_PRESETS.meshy[0]!))).toEqual(["Reference 1"]);
  });
  it("persists the same 3D parameters the current catalog displays", () => {
    const model: Model3DModel = { provider: "custom-studio", providerName: "Studio", id: "props", name: "Props", maxReferenceImages: 1,
      polycount: { min: 200, max: 2_000, default: 800, presets: [800] }, supportsTexture: false, supportsPbr: false };
    const node = toAssetCanvasNode({ id: "3d", type: "model-3d", position: { x: 0, y: 0 }, data: {
      model3DConfig: { model: { provider: model.provider, id: model.id }, targetPolycount: 4_000, texture: true, pbr: true }, images: [],
    } }, [model]);
    expect(node.data).toMatchObject({ model: { provider: model.provider, id: model.id }, targetPolycount: 800, texture: false, pbr: false });
    const unavailable = toAssetCanvasNode({ id: "3d", type: "model-3d", position: { x: 0, y: 0 }, data: {
      model3DConfig: { model: { provider: "disabled-studio", id: "props" }, targetPolycount: 4_000, texture: true, pbr: false }, images: [],
    } }, [model]);
    expect(unavailable.data).toMatchObject({ model: { provider: "disabled-studio", id: "props" }, targetPolycount: 4_000 });
  });
  it("records node changes in history independently of viewport movement and JSON key order", () => {
    const canvas = createAssetCanvasDocument();
    canvas.nodes = [{ id: "rules", type: "text", position: { x: 0, y: 0 }, data: { text: "Rules", instruction: "" } }];
    const movedView = structuredClone(canvas); movedView.editorLayout.viewport = { x: 900, y: 600, zoom: 0.5 };
    expect(canvasHistoryKey(movedView)).toBe(canvasHistoryKey(canvas));
    movedView.nodes[0]!.data = { instruction: "", text: "Rules" };
    expect(canvasHistoryKey(movedView)).toBe(canvasHistoryKey(canvas));
    movedView.nodes[0]!.position.x = 200;
    expect(canvasHistoryKey(movedView)).not.toBe(canvasHistoryKey(canvas));
  });
  it("stores only provider and id for a catalog text model", () => {
    const catalogModel = { provider: "anthropic", id: "claude-3-haiku", name: "Claude 3 Haiku", providerName: "Anthropic", reasoningLevels: [] };
    const node = toAssetCanvasNode({
      id: "text-1",
      type: "text",
      position: { x: 0, y: 0 },
      data: { text: "", instruction: "", textModel: catalogModel, reasoningLevel: "high" },
    } as unknown as Parameters<typeof toAssetCanvasNode>[0]);
    expect(node.data).toMatchObject({ model: { provider: "anthropic", id: "claude-3-haiku" } });
    expect((node.data as { model: object }).model).toEqual({ provider: "anthropic", id: "claude-3-haiku" });
    expect(node.data).toHaveProperty("reasoningLevel", "high");

    const canvas = createAssetCanvasDocument();
    canvas.nodes = [node];
    canvas.editorLayout.nodes = { "text-1": { x: 0, y: 0 } };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    (node.data as { reasoningLevel: string }).reasoningLevel = "turbo";
    expect(isAssetCanvasDocument(canvas)).toBe(false);
  });
  it.each(["text", "image", "video", "model-3d", "animate-3d", "asset", "document"] as const)("preserves %s node metadata without runtime fields", (type) => {
    const node = toAssetCanvasNode({ id: "node", type, position: { x: 0, y: 0 }, title: "Player", description: "Main character", data: { documentId: "rules", assetId: "reference", text: "Rules", nodeDetails: { title: "Runtime name", label: "Runtime label", edit: () => {} } } });
    expect(node).toMatchObject({ title: "Player", description: "Main character" });
    expect(node.data).not.toHaveProperty("nodeDetails");
  });
});

describe("3D processing node serialization", () => {
  it.each(["meshy", "tripo"])("uses %s remesh limits for a native connection saved without runtime catalog data", (provider) => {
    const node = toAssetCanvasNode({ id: "remesh", type: "model-3d", position: { x: 0, y: 0 }, data: {
      model3DOperation: "remesh", model3DSource: { type: "library", assetId: "source" }, images: [],
      model3DConfig: { model: { provider, id: MODEL3D_CONNECTION_ID }, targetPolycount: 500_000, texture: true, pbr: false },
    } });
    if (node.type !== "model-3d") throw new Error("Expected model node");
    expect(node.data.targetPolycount).toBe(provider === "meshy" ? 30_000 : 500_000);
    expect(buildModel3DToolRequest(node.data, [], node.data.operation).targetPolycount).toBe(node.data.targetPolycount);
  });
  it("keeps remesh face counts above the geometry model's generation limit in saved requests", () => {
    const node = toAssetCanvasNode({ id: "remesh", type: "model-3d", position: { x: 0, y: 0 }, data: {
      model3DOperation: "remesh", model3DSource: { type: "library", assetId: "source" }, images: [],
      model3DConfig: { model: { provider: "tripo", id: "P1-20260311" }, targetPolycount: 300_000, texture: true, pbr: false },
    } });
    if (node.type !== "model-3d") throw new Error("Expected model node");
    const saved = JSON.parse(JSON.stringify(node.data));
    expect(saved.targetPolycount).toBe(300_000);
    expect(buildModel3DToolRequest(saved, [], saved.operation).targetPolycount).toBe(300_000);
  });
  it("keeps source, prompt links and operation versions in history and clipboard", async () => {
    const { createCanvasClipboard, duplicateCanvasSelection, parseCanvasClipboard } = await import("../src/renderer/asset-canvas-clipboard.js");
    const source = toAssetCanvasNode({ id: "source", type: "model-3d", position: { x: 0, y: 0 }, data: { images: [] } });
    const text = toAssetCanvasNode({ id: "style", type: "text", position: { x: 0, y: 200 }, data: { text: "Gold" } });
    const node = toAssetCanvasNode({ id: "texture", type: "model-3d", position: { x: 300, y: 0 }, data: {
      model3DConfig: { model: { provider: "tripo", id: "P1-20260311" }, targetPolycount: 4000, texture: true, pbr: true },
      model3DOperation: "retexture", model3DSource: { type: "node", nodeId: "source" }, prompt: "Worn metal", promptSource: { type: "node", nodeId: "style" },
      model3DOptions: { textureModel: "v3.5-20260815", textureQuality: "detailed" }, images: [],
    } });
    expect(node.data).toMatchObject({ operation: "retexture", source: { nodeId: "source" }, promptSource: { nodeId: "style" }, options: { textureModel: "v3.5-20260815" } });
    const value = createCanvasClipboard("project", [source, text, node], []);
    expect(parseCanvasClipboard(JSON.stringify(value))).toBeDefined();
    let next = 0;
    const copy = duplicateCanvasSelection(value.nodes, [], { x: 500, y: 0 }, () => `copy-${++next}`);
    expect(copy.nodes[2]!.data).toMatchObject({ source: { nodeId: "copy-1" }, promptSource: { nodeId: "copy-2" }, operation: "retexture" });
  });
  it("keeps Tripo string IDs and provider/rig options without changing legacy Meshy nodes", () => {
    const node = toAssetCanvasNode({ id: "animation", type: "animate-3d", position: { x: 0, y: 0 }, data: {
      images: [{ type: "library", assetId: "character" }], animationModel: { provider: "tripo", id: "P1-20260311" },
      actionIds: ["preset:quadruped:walk"], model3DOptions: { rigModel: "v2.5-20260210", rigType: "quadruped", animateInPlace: true },
    } });
    const canvas = createAssetCanvasDocument(); canvas.nodes = [node]; canvas.editorLayout.nodes = { animation: node.position };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    expect(node.data).toMatchObject({ model: { provider: "tripo" }, actionIds: ["preset:quadruped:walk"], options: { rigModel: "v2.5-20260210" } });
    const legacy = toAssetCanvasNode({ id: "legacy", type: "animate-3d", position: { x: 0, y: 0 }, data: { actionIds: [0, 30] } });
    expect(legacy.data).not.toHaveProperty("model"); expect(legacy.data).toMatchObject({ actionIds: [0, 30] });
  });
  it("removes processing model connections when the source node is deleted", async () => {
    const { removeNodesAndReferences } = await import("../src/renderer/asset-canvas-workspace.js");
    const result = removeNodesAndReferences([{ id: "texture", type: "model-3d", position: { x: 0, y: 0 }, data: { model3DSource: { type: "node", nodeId: "source" }, model3DOperation: "retexture" } }], new Set(["source"]));
    expect(result[0]!.data.model3DSource).toBeUndefined();
  });
});
