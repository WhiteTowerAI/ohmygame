import { describe, expect, it } from "vitest";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { canvasHistoryKey, toAssetCanvasNode } from "../src/renderer/asset-canvas-workspace.js";

describe("Asset Canvas node serialization", () => {
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
