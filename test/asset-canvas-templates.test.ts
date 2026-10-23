import { describe, expect, it } from "vitest";
import i18next from "i18next";
import type { ImageModel } from "../src/shared/contracts.js";
import { isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { canvasImagePresetPrompt } from "../src/shared/canvas-image-presets.js";
import { ASSET_CANVAS_TEMPLATES, createAssetCanvasTemplateDocument, templateGuideInfo, templateImagePresets } from "../src/renderer/asset-canvas-templates.js";

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
      type: "image", data: {
        presetId: "character-sheet",
        promptExpanded: true,
        prompt: expect.stringContaining("Forest ranger"),
        aspectRatio: "16:9",
      },
    });
    const output = document.nodes.find((node) => node.id === outputNodeIds[0]);
    expect(output?.type === "image" && output.data.prompt).toContain("four clearly separated panels");
    expect(output?.type === "image" && output.data.prompt).toContain("Create a production-ready 2D game character reference sheet");
  });

  it("quick reskin uses a separate source and a reference-capable model", () => {
    const { document, focusNodeId, outputNodeIds } = createAssetCanvasTemplateDocument("quick-reskin", [textOnly, reference]);
    expect(document.nodes.find((node) => node.id === focusNodeId)).toMatchObject({ type: "image", data: { sourceInput: true } });
    const output = document.nodes.find((node) => node.id === outputNodeIds[0]);
    expect(output).toMatchObject({
      type: "image",
      data: {
        presetId: "quick-reskin",
        quickReskinMode: "person-clothing",
        model: { provider: "example", id: "reference" },
        prompt: "Put the clothing from the clothing reference image on the person in the person image. Keep the person's pose and composition.",
      },
    });
    const sourceInputs = document.nodes.filter((node) => node.type === "image" && node.data.sourceInput);
    expect(sourceInputs).toHaveLength(2);
    expect(sourceInputs.map((node) => node.title)).toEqual(["Person reference image", "Clothing image"]);
    expect(output).toMatchObject({ type: "image", data: { images: sourceInputs.map((node) => ({ type: "node", nodeId: node.id })) } });
    expect(canvasImagePresetPrompt("quick-reskin", "Transfer this outfit", undefined, 2)).toContain("second reference image as the clothing design");
    expect(canvasImagePresetPrompt("quick-reskin", "Red armor")).toContain("same subject, silhouette, pose");
    const noCompatibleModel = createAssetCanvasTemplateDocument("quick-reskin", [textOnly]).document.nodes.find((node) => node.type === "image" && !node.data.sourceInput);
    expect(noCompatibleModel).toMatchObject({ type: "image", data: { quickReskinMode: "person-clothing" } });
    if (noCompatibleModel?.type === "image") expect(noCompatibleModel.data.model).toBeUndefined();
  });

  it("keeps the default generation prompt in English under the Chinese UI", async () => {
    const previousLanguage = i18next.language;
    try {
      await i18next.changeLanguage("zh-CN");
      const { document, outputNodeIds } = createAssetCanvasTemplateDocument("quick-reskin", [reference]);
      const output = document.nodes.find((node) => node.id === outputNodeIds[0]);
      expect(output?.type === "image" && output.data.prompt).toBe("Put the clothing from the clothing reference image on the person in the person image. Keep the person's pose and composition.");
    } finally {
      await i18next.changeLanguage(previousLanguage);
    }
  });

  it("pixel assets share one reference input and use a reference-capable model", () => {
    const { document, outputNodeIds } = createAssetCanvasTemplateDocument("pixel-art", [textOnly, reference]);
    const source = document.nodes.find((node) => node.type === "image" && node.data.sourceInput);
    expect(source).toBeDefined();
    expect(outputNodeIds).toHaveLength(10);
    for (const id of outputNodeIds) {
      expect(document.nodes.find((node) => node.id === id)).toMatchObject({
        type: "image",
        data: {
          model: { provider: "example", id: "reference" },
          promptExpanded: true,
          prompt: expect.stringContaining("Render in pixel art"),
          images: [{ type: "node", nodeId: source?.id }],
        },
      });
    }
    const fromLibrary = createAssetCanvasTemplateDocument("pixel-art", [reference], { sourceAssetId: "pixel-reference" });
    const librarySource = fromLibrary.document.nodes.find((node) => node.type === "asset");
    expect(librarySource?.data.assetId).toBe("pixel-reference");
    expect(fromLibrary.outputNodeIds.every((id) => fromLibrary.document.nodes.find((node) => node.id === id)?.type === "image")).toBe(true);
    for (const id of fromLibrary.outputNodeIds) {
      expect(fromLibrary.document.nodes.find((node) => node.id === id)).toMatchObject({
        type: "image", data: { images: [{ type: "node", nodeId: librarySource?.id }] },
      });
    }
  });

  it.each(["pixel-art", "quick-reskin", "free-sequence", "action-set"] as const)("%s links its outputs to a replaceable sample reference", (template) => {
    const { document, outputNodeIds, sampleImages } = createAssetCanvasTemplateDocument(template, [reference]);
    expect(isAssetCanvasDocument(document)).toBe(true);
    const source = document.nodes.find((node) => node.type === "image" && node.data.sourceInput);
    expect(source).toBeDefined();
    expect(sampleImages.get(source!.id)).toBe("character-sheet");
    for (const id of outputNodeIds) {
      const output = document.nodes.find((node) => node.id === id);
      expect(output).toMatchObject({ type: "image", data: { images: expect.arrayContaining([{ type: "node", nodeId: source?.id }]) } });
    }
  });

  it.each(["quick-reskin", "free-sequence", "action-set"] as const)("%s shares one source across outputs", (template) => {
    const { document, outputNodeIds } = createAssetCanvasTemplateDocument(template, [reference], { sourceAssetId: "character-1" });
    const source = document.nodes.find((node) => node.type === "asset");
    expect(source?.data.assetId).toBe("character-1");
    expect(outputNodeIds).toHaveLength(template === "action-set" ? 6 : template === "free-sequence" ? 2 : 1);
    for (const id of outputNodeIds) {
      const output = document.nodes.find((node) => node.id === id);
      expect(output).toMatchObject({ type: "image", data: { images: expect.arrayContaining([{ type: "node", nodeId: source?.id }]) } });
      if (template === "quick-reskin" && output?.type === "image") {
        expect(output.data.images).toHaveLength(2);
        expect(output.data.images.every((reference) => reference.type === "node" && document.nodes.some((node) => node.id === reference.nodeId))).toBe(true);
      }
    }
  });

  it("lays out every pixel asset and sequence mode when the board opens", () => {
    const pixel = createAssetCanvasTemplateDocument("pixel-art", [reference]);
    const sequences = createAssetCanvasTemplateDocument("free-sequence", [reference]);
    expect(pixel.outputNodeIds).toHaveLength(10);
    expect(pixel.document.nodes.filter((node) => node.type === "image" && !node.data.sourceInput)).toHaveLength(10);
    expect(sequences.outputNodeIds).toHaveLength(2);
    expect(sequences.document.nodes.filter((node) => node.type === "image" && !node.data.sourceInput)).toHaveLength(2);
    expect(isAssetCanvasDocument(pixel.document)).toBe(true);
    expect(isAssetCanvasDocument(sequences.document)).toBe(true);
    for (const template of [pixel, sequences]) {
      const positions = template.document.nodes.filter((node) => node.type === "image" && !node.data.sourceInput).map((node) => node.position);
      expect(new Set(positions.map(({ x, y }) => `${x},${y}`)).size).toBe(positions.length);
    }
    for (const id of sequences.outputNodeIds) {
      const node = sequences.document.nodes.find((candidate) => candidate.id === id);
      expect(node).toMatchObject({ type: "image", data: { promptExpanded: true } });
      if (node?.type === "image") {
        expect(node.data.prompt).toContain(node.data.presetId === "continuous-sequence" ? "Use the supplied image as the exact character reference" : "Create one 3-row by 3-column image grid");
      }
    }
  });
});
