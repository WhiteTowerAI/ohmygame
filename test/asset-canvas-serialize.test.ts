import { describe, expect, it } from "vitest";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { canvasHistoryKey, model3DViewLabels, toAssetCanvasNode } from "../src/renderer/asset-canvas-workspace.js";
import type { Model3DModel } from "../src/shared/contracts.js";
import { model3DModel } from "../src/shared/custom-models.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";

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
