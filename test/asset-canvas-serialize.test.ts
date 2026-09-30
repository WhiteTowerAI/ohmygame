import { describe, expect, it } from "vitest";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { toAssetCanvasNode } from "../src/renderer/asset-canvas-workspace.js";

describe("Asset Canvas node serialization", () => {
  it("stores only provider and id for a catalog text model", () => {
    const catalogModel = { provider: "anthropic", id: "claude-3-haiku", name: "Claude 3 Haiku", providerName: "Anthropic", reasoningLevels: [] };
    const node = toAssetCanvasNode({
      id: "text-1",
      type: "text",
      position: { x: 0, y: 0 },
      data: { text: "", instruction: "", textModel: catalogModel },
    } as unknown as Parameters<typeof toAssetCanvasNode>[0]);
    expect(node.data).toMatchObject({ model: { provider: "anthropic", id: "claude-3-haiku" } });
    expect((node.data as { model: object }).model).toEqual({ provider: "anthropic", id: "claude-3-haiku" });

    const canvas = createAssetCanvasDocument();
    canvas.nodes = [node];
    canvas.editorLayout.nodes = { "text-1": { x: 0, y: 0 } };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
  });
});
