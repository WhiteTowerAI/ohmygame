import { describe, expect, it } from "vitest";
import type { AssetCanvasNode, ImageModel } from "../src/shared/contracts.js";
import { isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { canvasImagePresetPrompt } from "../src/shared/canvas-image-presets.js";
import { ASSET_CANVAS_TEMPLATES, createAssetCanvasTemplateDocument, createTemplatePresetNode, nextTemplatePresetPosition, templateGuideInfo, templateImagePresets } from "../src/renderer/asset-canvas-templates.js";

const textOnly: ImageModel = {
  provider: "example", id: "text", name: "Text", providerName: "Example", sizes: ["1024x1024"],
  generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }],
  supportsReferenceImage: false, maxOutputs: 1, protocol: "gemini-generate-content",
};
const reference: ImageModel = {
  ...textOnly, id: "reference", supportsReferenceImage: true,
  generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }, { resolution: "1K", aspectRatio: "16:9" }],
};

describe("asset canvas templates", () => {
  it("exposes five independent starts with scoped presets", () => {
    expect(ASSET_CANVAS_TEMPLATES).toEqual(["pixel-art", "character-sheet", "quick-reskin", "free-sequence", "action-set"]);
    expect(templateImagePresets("pixel-art")).toHaveLength(10);
    expect(templateImagePresets("pixel-art")).not.toContain("character-sheet");
    expect(templateImagePresets("character-sheet")).toEqual(["character-sheet"]);
    expect(templateImagePresets("quick-reskin")).toEqual(["quick-reskin"]);
    expect(templateImagePresets("free-sequence")).toEqual(["continuous-sequence", "consistent-sequence"]);
    expect(templateImagePresets("action-set")).toEqual([]);
  });

  it.each(ASSET_CANVAS_TEMPLATES)("%s creates a valid board with a visible guide", (template) => {
    const { document, focusNodeId } = createAssetCanvasTemplateDocument(template, [textOnly, reference]);
    expect(isAssetCanvasDocument(document)).toBe(true);
    expect(document.nodes[0]).toMatchObject({ type: "text", data: { instruction: `asset-canvas-template:${template}` } });
    expect(document.nodes.find((node) => node.id === focusNodeId)).toBeDefined();
    expect(document.nodes.filter((node) => node.type === "text")).toHaveLength(1);
  });

  it("recognizes saved legacy guides without rewriting boards", () => {
    expect(templateGuideInfo("asset-canvas-template:free-image")).toEqual({ template: "pixel-art" });
    expect(templateGuideInfo("asset-canvas-template:free-image:pixel")).toEqual({ template: "pixel-art" });
    expect(templateGuideInfo("asset-canvas-template:free-image:general")).toEqual({ template: "character-sheet" });
    expect(templateGuideInfo("asset-canvas-template:free-sequence")).toEqual({ template: "free-sequence" });
  });

  it("starts a wide character reference sheet with an editable prompt", () => {
    const { document, outputNodeIds } = createAssetCanvasTemplateDocument("character-sheet", [reference], { prompt: "Forest ranger" });
    expect(document.nodes.find((node) => node.id === outputNodeIds[0])).toMatchObject({
      type: "image", data: { presetId: "character-sheet", prompt: "Forest ranger", aspectRatio: "16:9" },
    });
    expect(canvasImagePresetPrompt("character-sheet", "Forest ranger")).toContain("four clearly separated panels");
  });

  it("quick reskin uses a separate source and a reference-capable model", () => {
    const { document, focusNodeId, outputNodeIds } = createAssetCanvasTemplateDocument("quick-reskin", [textOnly, reference]);
    expect(document.nodes.find((node) => node.id === focusNodeId)).toMatchObject({ type: "image", data: { sourceInput: true } });
    expect(document.nodes.find((node) => node.id === outputNodeIds[0])).toMatchObject({
      type: "image", data: { presetId: "quick-reskin", model: { provider: "example", id: "reference" }, images: [{ type: "node", nodeId: focusNodeId }] },
    });
    expect(canvasImagePresetPrompt("quick-reskin", "Red armor")).toContain("same subject, silhouette, pose");
  });

  it.each(["quick-reskin", "free-sequence", "action-set"] as const)("%s shares one source across outputs", (template) => {
    const { document, outputNodeIds } = createAssetCanvasTemplateDocument(template, [reference], { sourceAssetId: "character-1" });
    const source = document.nodes.find((node) => node.type === "asset");
    expect(source?.data.assetId).toBe("character-1");
    expect(outputNodeIds).toHaveLength(template === "action-set" ? 6 : 1);
    for (const id of outputNodeIds) {
      expect(document.nodes.find((node) => node.id === id)).toMatchObject({ type: "image", data: { images: [{ type: "node", nodeId: source?.id }] } });
    }
  });

  it("adds independent results below existing pixel and sequence outputs", () => {
    for (const [template, preset] of [["pixel-art", "scene"], ["free-sequence", "consistent-sequence"]] as const) {
      const { document, outputNodeIds } = createAssetCanvasTemplateDocument(template, [reference]);
      const previous = document.nodes.find((node) => node.id === outputNodeIds[0]) as Extract<AssetCanvasNode, { type: "image" }>;
      previous.data.assetId = "generated-first";
      const sourceId = previous.data.images[0]?.type === "node" ? previous.data.images[0].nodeId : undefined;
      const next = createTemplatePresetNode(template, preset, [reference], nextTemplatePresetPosition(template, document.nodes), sourceId);
      document.nodes.push(next);
      document.editorLayout.nodes[next.id] = next.position;
      expect(isAssetCanvasDocument(document)).toBe(true);
      expect(previous.data.assetId).toBe("generated-first");
      expect(next.data.assetId).toBeUndefined();
      expect(next.position.y).toBeGreaterThan(previous.position.y);
      if (sourceId) expect(next.data.images).toEqual([{ type: "node", nodeId: sourceId }]);
    }
  });
});
