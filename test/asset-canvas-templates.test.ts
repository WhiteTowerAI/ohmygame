import { describe, expect, it } from "vitest";
import { isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { canvasImagePresetPrompt } from "../src/shared/canvas-image-presets.js";
import {
  ASSET_CANVAS_TEMPLATES,
  createAssetCanvasTemplateDocument,
} from "../src/renderer/asset-canvas-templates.js";

describe("asset canvas templates", () => {
  it.each(ASSET_CANVAS_TEMPLATES)(
    "%s creates a valid saved board",
    (template) => {
      const { document, focusNodeId } = createAssetCanvasTemplateDocument(
        template,
        [],
        [],
      );
      expect(isAssetCanvasDocument(document)).toBe(true);
      expect(document.nodes.some((node) => node.id === focusNodeId)).toBe(true);
      expect(document.nodes[0]?.type).toBe("text");
    },
  );

  it.each(["free-sequence", "action-set"] as const)(
    "%s connects every output to the selected character",
    (template) => {
      const { document } = createAssetCanvasTemplateDocument(
        template,
        [],
        [],
        "character-asset",
      );
      expect(isAssetCanvasDocument(document)).toBe(true);
      const source = document.nodes.find((node) => node.type === "asset");
      expect(source?.data.assetId).toBe("character-asset");
      const outputs = document.nodes.filter(
        (node) =>
          node.type === (template === "free-sequence" ? "video" : "image"),
      );
      expect(outputs.length).toBe(template === "free-sequence" ? 1 : 6);
      for (const node of outputs) {
        if (node.type === "video")
          expect(node.data.references).toEqual([
            { type: "node", nodeId: source?.id },
          ]);
        if (node.type === "image")
          expect(node.data.images).toEqual([
            { type: "node", nodeId: source?.id },
          ]);
      }
    },
  );

  it("image presets keep the user's description and expand the selected material", () => {
    expect(canvasImagePresetPrompt("free", "pixel knight")).toBe(
      "pixel knight",
    );
    expect(
      canvasImagePresetPrompt("character-sheet", "pixel knight"),
    ).toContain("four clearly separated panels");
    expect(canvasImagePresetPrompt("monster", "forest guardian")).toContain(
      "forest guardian",
    );
  });
});
