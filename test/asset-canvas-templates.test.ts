import { describe, expect, it } from "vitest";
import i18next from "i18next";
import type { ImageModel } from "../src/shared/contracts.js";
import { createAssetCanvasDocument, effectLibraryPrompt, isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { CANVAS_IMAGE_PRESETS, canvasImagePresetPrompt, QUICK_RESKIN_DEFAULT_PROMPT } from "../src/shared/canvas-image-presets.js";
import { actionSheetPrompt, characterAssetPrompt } from "../src/shared/canvas-character-tools.js";
import { GLOBAL_PIXEL_ART_STYLE_REQUIREMENTS, withCharacterPixelArtStyle, withGlobalPixelStyle, withPixelArtStyle } from "../src/shared/canvas-pixel-style.js";
import { consistentScenesPrompt } from "../src/shared/canvas-pixel-prompts.js";
import { PIXELLAB_PROVIDER, createPixelAssetPresetContents, createPixelAssetWorkflowNodes, createPixelLabPresetNode, pixelAssetPresetCatalog, pixelAssetWorkflowLabel, pixelLabPresetCatalog } from "../src/renderer/asset-canvas-pixel-workflows.js";
import { EFFECT_PRESETS, effectPresetAspectRatio, effectPresetById, effectPresetDescription, effectPresetLabel } from "../src/renderer/asset-canvas-effect-presets.js";
import { effectPresetExampleId, effectPresetPreviewUrl } from "../src/renderer/asset-canvas-effect-examples.js";
import { pixelExampleImageUrl } from "../src/renderer/asset-canvas-pixel-examples.js";

const textOnly: ImageModel = {
  provider: "example", id: "text", name: "Text", providerName: "Example", sizes: ["1024x1024"],
  generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }],
  supportsReferenceImage: false, maxOutputs: 1, protocol: "gemini-generate-content",
};
const reference: ImageModel = {
  ...textOnly, id: "reference", supportsReferenceImage: true,
  generationOptions: [
    { resolution: "1K", aspectRatio: "1:1" },
    { resolution: "1K", aspectRatio: "16:9" },
    { resolution: "1K", aspectRatio: "4:3" },
  ],
};

describe("pixel asset workflows", () => {
  it("offers every bundled effect as an individual, localized pixel preset", () => {
    expect(EFFECT_PRESETS).toHaveLength(12);
    expect(new Set(EFFECT_PRESETS.map((preset) => preset.id)).size).toBe(EFFECT_PRESETS.length);
    expect(effectPresetAspectRatio("electric-orb-burst")).toBe("3:4");
    expect(effectPresetAspectRatio("lightning-strike")).toBe("21:9");
    for (const preset of EFFECT_PRESETS) {
      expect(effectPresetById(preset.id)).toBe(preset);
      expect(effectPresetLabel(preset.id)).not.toContain("assetCanvas.");
      expect(effectPresetDescription(preset.id)).not.toContain("assetCanvas.");
      expect(effectPresetAspectRatio(preset.id)).toMatch(/^(4:3|3:4|21:9)$/);
      expect(preset.prompt).toContain("sprite sheet");
      expect(effectPresetPreviewUrl(preset.id)).toContain(`/pixel/classic/effects/${preset.id}-preview.gif`);
      expect(pixelExampleImageUrl(effectPresetExampleId(preset.id))).toContain(`/pixel/classic/effects/${preset.id}-sheet.webp`);
      // Canvases from before one pixel style still show their examples.
      for (const level of ["coarse", "detailed"] as const) {
        expect(pixelExampleImageUrl(`effects/${level}/${preset.id}`)).toContain(`/pixel/${level}/effects/`);
      }
    }
  });

  it("applies the one pixel style to effect generation prompts", () => {
    const base = "Create one complete 4-column by 3-row Sprite Sheet (12 frames) for a fire impact.";
    const prompt = effectLibraryPrompt(base, "original", "sample", "");
    expect(prompt).toContain("PIXEL DENSITY: CLASSIC PIXELS");
    expect(prompt).toContain("Default logical size per frame: 64×64 pixels");
    expect(prompt).toContain("Use no more than 16 colors");
    expect(prompt).not.toContain("DETAILED EFFECT PIXEL RULES");
    expect(prompt).not.toContain("COARSE PIXELS");
  });

  it("organizes the pixel catalog by function and provides translated card details", () => {
    const catalog = pixelAssetPresetCatalog();
    expect(catalog.map((category) => category.id)).toEqual([
      "characters", "animation", "terrain", "objects", "creatures", "scenes", "skins",
    ]);
    expect(catalog.flatMap((category) => category.presets)).toHaveLength(21);
    expect(catalog.flatMap((category) => category.presets).every((preset) =>
      preset.label.length > 0 && preset.description.length > 0 && !preset.label.startsWith("assetCanvas."),
    )).toBe(true);
    expect(pixelAssetWorkflowLabel("quick-reskin")).toContain("Outfits");
    expect(pixelAssetWorkflowLabel("quick-reskin")).not.toContain("Pixels");
  });

  it("adds one image node per preset and links the three-node skin workflow", () => {
    const catalog = pixelAssetPresetCatalog();
    for (const preset of catalog.flatMap((category) => category.presets)) {
      const workflow = createPixelAssetWorkflowNodes(preset.id, [reference], "workflow");
      const expectedCount = preset.id === "quick-reskin" ? 3 : 1;
      expect(workflow.nodes).toHaveLength(expectedCount);
      expect(workflow.nodes.every((node) => node.parentId === "workflow")).toBe(true);
      const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId);
      expect(output?.type).toBe("image");
      if (output?.type === "image") {
        expect(output.data.promptExpanded).toBe(true);
        expect(output.data.prompt).toContain("CLASSIC PIXELS");
        expect(output.title).toBe(preset.label);
        expect(output.data).not.toHaveProperty("pixelStyle");
      }
      if (preset.id === "quick-reskin" && output?.type === "image") {
        const inputs = workflow.nodes.filter((node) => node.type === "image" && node.data.sourceInput);
        expect(inputs).toHaveLength(2);
        expect(output.data.images).toEqual(inputs.map((node) => ({ type: "node", nodeId: node.id })));
        expect(output.data.quickReskinMode).toBe("person-clothing");
      }
    }
  });

  it("adds no workflow group for a single image and one centred on the position for the reskin flow", () => {
    const position = { x: 754, y: 373 };
    const single = createPixelAssetPresetContents("character-sheet", [], position);
    const reskin = createPixelAssetPresetContents("quick-reskin", [], position);

    expect(single.group).toBeUndefined();
    expect(single.nodes).toHaveLength(1);
    expect(single.nodes[0]).toMatchObject({ position });
    expect(single.nodes[0]?.parentId).toBeUndefined();
    expect(reskin.group).toMatchObject({ type: "group", position: { x: 24, y: 48 } });
    expect(reskin.group?.parentId).toBeUndefined();
    expect(reskin.nodes).toHaveLength(3);
    expect(reskin.nodes.every((node) => (node as typeof node & { parentId?: string }).parentId === reskin.group?.id)).toBe(true);
  });

  it("offers PixelLab presets by group once the plugin's models are there", () => {
    const pixelLab = (id: string, references: { min?: number; max: number }): ImageModel => ({
      ...textOnly, provider: PIXELLAB_PROVIDER, id, providerName: "PixelLab", protocol: "plugin",
      supportsReferenceImage: references.max > 0, maxReferenceImages: references.max,
      ...(references.min ? { minReferenceImages: references.min } : {}),
    });
    const presets = (models: ImageModel[]) => pixelLabPresetCatalog(models).flatMap((group) => group.presets);

    expect(pixelLabPresetCatalog([]).map((group) => group.group)).toEqual(["characters", "animation", "objects", "maps", "effects", "edits"]);
    expect(presets([])).toHaveLength(16);
    expect(presets([reference]).every((preset) => preset.availability === "missing")).toBe(true);
    // An earlier PixelLab plugin has only some of the models.
    const earlier = presets([pixelLab("frame-animation", { min: 1, max: 1 })]);
    expect(earlier.find((preset) => preset.id === "pixellab:frame-animation")).toMatchObject({ availability: "ready", needsReference: true });
    expect(earlier.find((preset) => preset.id === "pixellab:tileset")?.availability).toBe("outdated");
    for (const preset of earlier) {
      expect(preset.label).not.toContain("assetCanvas.");
      expect(preset.description).not.toContain("assetCanvas.");
    }

    const interpolation = pixelLab("interpolation", { min: 2, max: 2 });
    const node = createPixelLabPresetNode("pixellab:interpolation", [interpolation], { x: 40, y: 80 })!;
    expect(node).toMatchObject({ type: "image", position: { x: 40, y: 80 } });
    expect(node.data.model).toEqual({ provider: PIXELLAB_PROVIDER, id: "interpolation" });
    expect(node.data.prompt).toBe("transforming smoothly");
    expect(node.data.images).toEqual([]);
    expect(createPixelLabPresetNode("pixellab:tileset", [interpolation], { x: 0, y: 0 })).toBeUndefined();
    const document = createAssetCanvasDocument();
    document.nodes = [createPixelLabPresetNode("pixellab:interpolation", [interpolation], { x: 0, y: 0 })!];
    document.editorLayout.nodes = { [document.nodes[0]!.id]: { x: 0, y: 0 } };
    expect(isAssetCanvasDocument(document)).toBe(true);
  });

  it("keeps canvases that saved a pixel density on groups and images valid", () => {
    const workflow = createPixelAssetWorkflowNodes("quick-reskin", [reference], "workflow-skins");
    const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId)!;
    // Earlier versions saved the density on the image too.
    (output.data as Record<string, unknown>).pixelStyle = "detailed";
    const document = createAssetCanvasDocument();
    document.nodes = [
      { id: "legacy-group", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300, data: { name: "Old assets" } },
      { id: "pixel-detailed", type: "group", position: { x: 500, y: 0 }, width: 1520, height: 760, data: { name: "detailed", pixelStyle: "detailed" } },
      { id: "workflow-skins", type: "group", parentId: "pixel-detailed", position: { x: 24, y: 48 }, width: 1460, height: 650, data: { name: pixelAssetWorkflowLabel("quick-reskin") } },
      ...workflow.nodes,
    ];
    document.editorLayout.nodes = Object.fromEntries(document.nodes.map((node) => [node.id, {
      ...node.position,
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
    }]));
    expect(isAssetCanvasDocument(document)).toBe(true);
    expect(document.nodes[0]?.data).not.toHaveProperty("pixelStyle");
    expect(document.nodes[1]?.data).toMatchObject({ pixelStyle: "detailed" });
  });

  it("routes material prompts by asset type and keeps user instructions literal", () => {
    const description = "snow biome, side view, $& $` $'";
    const terrain = canvasImagePresetPrompt("terrain", description);
    const tileset = canvasImagePresetPrompt("tileset", description);
    expect(terrain).toContain("MANDATORY ASSET TYPE: CONTINUOUS MAP TERRAIN");
    expect(tileset).toContain("MANDATORY ASSET TYPE: TERRAIN TILESET");
    expect(tileset).toContain("Default logical size per tile: 32×32 pixels");
    expect(tileset).toContain("With 4 columns and 4 rows, the complete sheet is 128×128 logical pixels");
    for (const preset of CANVAS_IMAGE_PRESETS.filter((candidate) => !["free", "continuous-sequence", "consistent-sequence", "character-sheet", "quick-reskin"].includes(candidate))) {
      const prompt = canvasImagePresetPrompt(preset, description);
      const requestIndex = prompt.indexOf(`${preset === "character-sheet" ? "CHARACTER DESCRIPTION" : "USER REQUEST"}: ${description}`);
      const densityIndex = prompt.indexOf("**PIXEL DENSITY: CLASSIC PIXELS**");
      const style = GLOBAL_PIXEL_ART_STYLE_REQUIREMENTS;
      const styleIndex = prompt.indexOf(style);
      expect(requestIndex).toBe(0);
      expect(densityIndex).toBeGreaterThan(requestIndex);
      expect(styleIndex).toBeGreaterThan(densityIndex);
      expect(withGlobalPixelStyle(prompt, style)).toBe(prompt);
      expect(prompt).not.toContain("{user_prompt}");
      if (preset !== "character-sheet") expect(canvasImagePresetPrompt(preset, description, "general")).not.toMatch(/pixel art/i);
    }
    expect(canvasImagePresetPrompt("monster", "slime")).toContain("Section 4 — Reactions:");
    expect(canvasImagePresetPrompt("animal", "fox")).toContain("four species-appropriate behavior poses");
    expect(canvasImagePresetPrompt("prop", "sword")).toContain("Section 3 — Functional States:");
  });

  it("uses the character and action prompts in single-node workflows", () => {
    const character = createPixelAssetWorkflowNodes("character-sheet", [reference], "characters");
    expect(character.nodes).toHaveLength(1);
    expect(character.nodes[0]).toMatchObject({ type: "image", data: { presetId: "character-sheet", aspectRatio: "16:9" } });
    if (character.nodes[0]?.type === "image") {
      expect(character.nodes[0].data.prompt).toBe(withCharacterPixelArtStyle(characterAssetPrompt("")));
      expect(character.nodes[0].data.model).toEqual({ provider: "example", id: "reference" });
    }

    const walk = createPixelAssetWorkflowNodes("action:walk", [reference], "animation");
    expect(walk.nodes).toHaveLength(1);
    expect(walk.nodes[0]).toMatchObject({ type: "image", data: { aspectRatio: "4:3" } });
    if (walk.nodes[0]?.type === "image") expect(walk.nodes[0].data.prompt).toBe(actionSheetPrompt("walk", ""));
  });

  it("sets one size, palette, and shading budget without output-width examples", () => {
    const prompt = withPixelArtStyle("USER REQUEST: wizard");
    expect(prompt).toContain("64×64 logical sprite canvas");
    expect(prompt).toContain("Use no more than 16 colors");
    expect(prompt).toContain("2–3 hard-edged tones per major material");
    expect(prompt).not.toContain("DENSITY PRIORITY");
    expect(prompt).not.toContain("DETAILED PIXELS");
    expect(prompt).not.toContain("1536-pixel output width");
    expect(prompt).not.toContain("character head");
    expect(prompt).not.toContain("each eye");
  });

  it("separates whole reference-sheet dimensions from full-body sprite budgets", () => {
    const prompt = canvasImagePresetPrompt("character-sheet", "blue-haired wizard", "pixel", 1);
    expect(prompt).toContain("entire 16:9 reference sheet on a 256×144 logical pixel canvas");
    expect(prompt).toContain("64×64 logical sprite budget");
    expect(prompt).toContain("same pixel scale and detail budget");
    expect(prompt).toContain("CHARACTER DETAIL BUDGET:");
    expect(prompt).toContain("2–3 hard-edged tones per major material");
    expect(prompt).not.toContain("coarse logical pixel grid");
    expect(prompt).not.toContain("for coarse pixels");
    expect(prompt).not.toContain("for fine pixels");
  });

  it("applies the one pixel style across all catalog workflows", () => {
    for (const category of pixelAssetPresetCatalog()) {
      for (const preset of category.presets) {
        const workflow = createPixelAssetWorkflowNodes(preset.id, [reference], "workflow");
        const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId);
        expect(output?.type).toBe("image");
        if (output?.type !== "image") continue;
        const prompt = output.data.prompt;
        expect(prompt, preset.id).toContain("even when the reference is already pixel art");
        expect(prompt, preset.id).toContain("Do not inherit the reference's pixel density");
        expect(prompt, preset.id).toContain("DETAIL BUDGET:");
        expect(prompt, preset.id).toContain("Use no more than 16 colors");
        expect(prompt, preset.id).toContain("2–3 hard-edged tones per major material");
        for (const other of ["1–2", "4–6"]) expect(prompt, preset.id).not.toContain(`${other} hard-edged tones`);
        expect(prompt.match(/\*\*PIXEL DENSITY:/g), preset.id).toHaveLength(1);
        expect(prompt, preset.id).not.toContain("1536-pixel output width");
        expect(prompt, preset.id).not.toContain("coarse logical pixel grid");
        if (preset.id !== "continuous-sequence") expect(prompt, preset.id).not.toMatch(/\{[A-Z_]+\}/);
      }
    }
  });

  it("keeps pixel instructions relevant to each asset type", () => {
    for (const preset of ["scene", "terrain", "tileset", "building", "prop", "icon", "monster", "animal"] as const) {
      const prompt = canvasImagePresetPrompt(preset, "a silver asset", "pixel", 1);
      expect(prompt, preset).not.toContain("character head");
      expect(prompt, preset).not.toContain("each eye");
      expect(prompt, preset).not.toContain("hair locks");
      expect(prompt, preset).not.toContain("iris shading");
    }
    const panels = canvasImagePresetPrompt("consistent-sequence", "a fox in nine settings", "pixel", 1);
    expect(panels).toContain("SUBJECT DETAIL BUDGET:");
    expect(panels).not.toContain("CHARACTER DETAIL BUDGET:");
    const portrait = canvasImagePresetPrompt("portrait", "mage", "pixel", 1);
    expect(portrait).toContain("CHARACTER DETAIL BUDGET:");
    expect(portrait).not.toContain("Allow greater pixel detail");
    expect(portrait).toContain("A larger portrait does not authorize a finer pixel grid");
    expect(canvasImagePresetPrompt("side-view-character", "mage", "pixel", 1)).not.toContain("or visual style reference");
  });

  it("computes per-cell and complete-sheet dimensions for each layout", () => {
    const [sprite, scene, tile] = [64, 160, 32];
    const actions = actionSheetPrompt("walk", "");
    expect(actions).toContain(`per frame: ${sprite}×${sprite} pixels`);
    expect(actions).toContain(`complete sheet is ${sprite * 4}×${sprite * 3} logical pixels`);
    for (const preset of ["monster", "animal"] as const) {
      const prompt = canvasImagePresetPrompt(preset, "fox", "pixel", 1);
      expect(prompt).toContain(`per sprite: ${sprite}×${sprite} pixels`);
      expect(prompt).toContain(`complete sheet is ${sprite * 4}×${sprite * 4} logical pixels`);
    }
    const tiles = canvasImagePresetPrompt("tileset", "24×24 tiles in a 3×2 atlas", "pixel", 1);
    expect(tiles).toContain(`per tile: ${tile}×${tile} pixels`);
    expect(tiles).toContain(`complete sheet is ${tile * 4}×${tile * 4} logical pixels`);
    expect(tiles).toContain("An explicit user tile size or atlas layout overrides these defaults");
    const panels = canvasImagePresetPrompt("consistent-sequence", "fox", "pixel", 1);
    expect(panels).toContain(`per panel: ${scene}×${scene} pixels`);
    expect(panels).toContain(`complete sheet is ${scene * 3}×${scene * 3} logical pixels`);
    const prop = canvasImagePresetPrompt("prop", "sword", "pixel", 1);
    expect(prop).toContain(`per view: ${sprite}×${sprite} pixels`);
    expect(prop).toContain(`complete sheet is ${sprite * 4}×${sprite * 3} logical pixels`);
    for (const [preset, ratio] of [["consistent-sequence", "1:1"], ["prop", "4:3"], ["multi-angle", "1:1"]] as const) {
      const workflow = createPixelAssetWorkflowNodes(preset, [reference]);
      expect(workflow.nodes[0]).toMatchObject({ data: { aspectRatio: ratio } });
    }
  });

  it("simplifies each classic asset by function without losing animation, tile, or reskin contracts", () => {
    const prompt = (preset: Parameters<typeof canvasImagePresetPrompt>[0]) => canvasImagePresetPrompt(preset, "silver mage $& $'", "pixel", 2);
    expect(prompt("character-sheet")).toContain("Close-ups must not reintroduce engraving");
    expect(prompt("portrait")).toContain("without separate iris shading or multiple glints");
    for (const preset of ["monster", "animal"] as const) {
      expect(prompt(preset)).toContain("omit individual hairs, repeated scales");
      expect(prompt(preset)).toContain("Preserve species, anatomy, limbs");
    }
    for (const preset of ["scene", "terrain", "tileset", "building"] as const) {
      expect(prompt(preset)).toContain("Omit individual leaves, dense grass blades, tiny bricks");
    }
    for (const preset of ["scene", "building"] as const) {
      expect(prompt(preset)).toContain("Preserve composition, perspective");
    }
    for (const preset of ["terrain", "tileset"] as const) {
      expect(prompt(preset)).not.toContain("Preserve composition");
      expect(prompt(preset)).toContain("TERRAIN DETAIL BUDGET:");
      expect(prompt(preset)).toContain("not a base image to restyle");
      expect(canvasImagePresetPrompt(preset, "", "pixel", 1)).toContain("USER REQUEST: Derive the terrain biome");
    }
    expect(prompt("tileset")).toContain("All cells must have identical square dimensions");
    expect(prompt("multi-angle")).toContain("3-column by 3-row grid");
    expect(prompt("multi-angle")).toContain("top-down overhead view looking straight down");
    expect(prompt("multi-angle")).toContain("front-left three-quarter view, front view facing the viewer, front-right three-quarter view");
    expect(prompt("multi-angle")).toContain("complete sheet is 192×192 logical pixels");
    expect(prompt("multi-angle")).toContain("SUBJECT DETAIL BUDGET:");
    for (const section of ["MAP LAYOUT", "MATERIAL DISTRIBUTION", "ROADS AND PATHS", "WATER", "TERRAIN BOUNDARIES"]) {
      expect(prompt("terrain")).toContain(section);
    }
    expect(prompt("terrain")).toContain("not a scene illustration, story moment");
    for (const preset of ["prop", "icon"] as const) {
      expect(prompt(preset)).toContain("Preserve functional silhouette");
      expect(prompt(preset)).toContain("Merge engraving, gems, reflections");
    }
    for (const action of ["idle", "walk", "run", "attack", "hurt", "down"] as const) {
      const actionPrompt = actionSheetPrompt(action, "");
      expect(actionPrompt).toContain("same detail choices to the supplied subject in every frame");
      expect(actionPrompt).toContain("pelvis horizontal anchor at 50%");
      expect(actionPrompt).toContain("ground baseline at 90%");
    }
    expect(prompt("continuous-sequence")).toContain("ANIMATION DETAIL BUDGET:");
    expect(prompt("consistent-sequence")).toContain("SUBJECT DETAIL BUDGET:");
    expect(prompt("consistent-sequence")).toContain("ENVIRONMENT DETAIL BUDGET:");
    expect(prompt("quick-reskin")).toContain("Keep the same subject, silhouette, pose");
    expect(prompt("quick-reskin")).toContain("second reference image as the clothing design");
  });

  it("keeps scene prompts ordered and separate from animation cycles", () => {
    const description = "A winged fox enters a forest, finds ruins, then lights a torch. $& $'";
    const prompt = canvasImagePresetPrompt("consistent-sequence", description);
    expect(prompt).toContain(`USER REQUEST: ${description}`);
    expect(prompt).toContain("SUBJECT AND DETAILS: Preserve the subject identity");
    expect(prompt).toContain("Arrange exactly nine panels in a clean 3-column by 3-row grid");
    expect(prompt).toContain("per panel: 160×160 pixels");
    expect(prompt).toContain("Do not automatically turn the nine panels into an animation sprite sheet");
    expect(consistentScenesPrompt(description, "Red coat, white tail, two wings")).toContain("SUBJECT AND DETAILS: Red coat, white tail, two wings");
  });

  it("keeps generation prompts in English under the Chinese UI", async () => {
    const previousLanguage = i18next.language;
    try {
      await i18next.changeLanguage("zh-CN");
      const workflow = createPixelAssetWorkflowNodes("quick-reskin", [reference], "skins");
      const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId);
      expect(output?.type === "image" && output.data.prompt).toBe(withPixelArtStyle(QUICK_RESKIN_DEFAULT_PROMPT, "sprite", { assetType: "character" }));
      expect(pixelAssetWorkflowLabel("quick-reskin")).toContain("换装");
      expect(pixelAssetWorkflowLabel("quick-reskin")).not.toContain("经典像素");
    } finally {
      await i18next.changeLanguage(previousLanguage);
    }
  });

  it("does not assign an incompatible reference model to the two-image reskin flow", () => {
    const workflow = createPixelAssetWorkflowNodes("quick-reskin", [textOnly], "skins");
    const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId);
    expect(output?.type === "image" && output.data.model).toBeUndefined();
  });
});
