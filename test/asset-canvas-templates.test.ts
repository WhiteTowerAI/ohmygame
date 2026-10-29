import { describe, expect, it } from "vitest";
import i18next from "i18next";
import type { ImageModel } from "../src/shared/contracts.js";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { canvasImagePresetPrompt, QUICK_RESKIN_DEFAULT_PROMPT } from "../src/shared/canvas-image-presets.js";
import { actionSheetPrompt, characterAssetPrompt } from "../src/shared/canvas-character-tools.js";
import { GLOBAL_PIXEL_ART_STYLE_REQUIREMENTS, withCharacterPixelArtLevel, withGlobalPixelStyle, withPixelArtLevel } from "../src/shared/canvas-pixel-style.js";
import { consistentScenesPrompt } from "../src/shared/canvas-pixel-prompts.js";
import { ASSET_CANVAS_TEMPLATES, templateGuideInfo, templateImagePresets } from "../src/renderer/asset-canvas-templates.js";
import { createPixelAssetPresetContents, createPixelAssetWorkflowNodes, pixelAssetPresetCatalog, pixelAssetTemplateCategories, pixelAssetWorkflowLabel, placePixelPresetOutsideDensityGroups } from "../src/renderer/asset-canvas-pixel-workflows.js";

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
  it("keeps legacy guide markers readable without creating new template boards", () => {
    expect(ASSET_CANVAS_TEMPLATES).toEqual(["pixel-art", "quick-reskin", "free-sequence", "action-set"]);
    expect(templateImagePresets("pixel-art")).toHaveLength(13);
    expect(templateImagePresets("free-sequence")).toEqual(["continuous-sequence", "consistent-sequence"]);
    expect(templateImagePresets("action-set")).toEqual([]);
    expect(templateGuideInfo("asset-canvas-template:pixel-art")).toEqual({ template: "pixel-art" });
    expect(templateGuideInfo("asset-canvas-template:free-image")).toEqual({ template: "pixel-art" });
    expect(templateGuideInfo("asset-canvas-template:free-image:pixel")).toEqual({ template: "pixel-art" });
    expect(templateGuideInfo("asset-canvas-template:free-image:general")).toEqual({ template: "character-sheet" });
    expect(templateGuideInfo("asset-canvas-template:free-sequence")).toEqual({ template: "free-sequence" });
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
    expect(pixelAssetWorkflowLabel("quick-reskin", "classic")).toContain("Outfits");
    expect(pixelAssetWorkflowLabel("quick-reskin", "classic")).toContain("Classic Pixels");
    expect(pixelAssetTemplateCategories().map((category) => category.id)).toEqual([
      "characters", "animation", "terrain", "objects", "creatures", "scenes", "skins",
    ]);
    expect(pixelAssetTemplateCategories().every((category) => category.label && category.description)).toBe(true);
  });

  it("adds one image node per preset and links the three-node skin workflow", () => {
    const catalog = pixelAssetPresetCatalog();
    for (const preset of catalog.flatMap((category) => category.presets)) {
      const workflow = createPixelAssetWorkflowNodes(preset.id, "classic", [reference], "workflow");
      const expectedCount = preset.id === "quick-reskin" ? 3 : 1;
      expect(workflow.nodes).toHaveLength(expectedCount);
      expect(workflow.nodes.every((node) => node.parentId === "workflow")).toBe(true);
      const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId);
      expect(output?.type).toBe("image");
      if (output?.type === "image") {
        expect(output.data.promptExpanded).toBe(true);
        expect(output.data.prompt).toContain("CLASSIC PIXELS");
        expect(output.title).toContain("Classic Pixels");
      }
      if (preset.id === "quick-reskin" && output?.type === "image") {
        const inputs = workflow.nodes.filter((node) => node.type === "image" && node.data.sourceInput);
        expect(inputs).toHaveLength(2);
        expect(output.data.images).toEqual(inputs.map((node) => ({ type: "node", nodeId: node.id })));
        expect(output.data.quickReskinMode).toBe("person-clothing");
      }
    }
  });

  it("adds no workflow group for a single image and one for the reskin flow", () => {
    const placement = { nodePosition: { x: 24, y: 48 }, workflowGroupPosition: { x: 24, y: 48 } };
    const single = createPixelAssetPresetContents("character-sheet", "classic", [], placement);
    const reskin = createPixelAssetPresetContents("quick-reskin", "classic", [], placement);

    expect(single.group).toBeUndefined();
    expect(single.nodes).toHaveLength(1);
    expect(single.nodes[0]?.parentId).toBeUndefined();
    expect(reskin.group).toMatchObject({ type: "group", position: placement.workflowGroupPosition });
    expect(reskin.group?.parentId).toBeUndefined();
    expect(reskin.nodes).toHaveLength(3);
    expect(reskin.nodes.every((node) => (node as typeof node & { parentId?: string }).parentId === reskin.group?.id)).toBe(true);
  });

  it("places toolbar presets outside the permanent pixel-density frames", () => {
    const groups = [
      { position: { x: -880, y: -360 }, width: 560, height: 720 },
      { position: { x: -280, y: -360 }, width: 560, height: 720 },
      { position: { x: 320, y: -360 }, width: 560, height: 720 },
    ];
    const single = placePixelPresetOutsideDensityGroups("character-sheet", { x: 0, y: 0 }, groups);
    const reskin = placePixelPresetOutsideDensityGroups("quick-reskin", { x: 0, y: 0 }, groups);

    expect(single.nodePosition.y).toBeGreaterThanOrEqual(360);
    expect(reskin.workflowGroupPosition.y).toBeGreaterThanOrEqual(360);
  });

  it("persists the pixel level on an outer group and keeps older group data valid", () => {
    const workflow = createPixelAssetWorkflowNodes("quick-reskin", "detailed", [reference], "workflow-skins");
    const document = createAssetCanvasDocument();
    document.nodes = [
      { id: "legacy-group", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300, data: { name: "Old assets" } },
      { id: "pixel-detailed", type: "group", position: { x: 500, y: 0 }, width: 1520, height: 760, data: { name: "Fine pixels", pixelStyle: "detailed" } },
      { id: "workflow-skins", type: "group", parentId: "pixel-detailed", position: { x: 24, y: 48 }, width: 1460, height: 650, data: { name: pixelAssetWorkflowLabel("quick-reskin", "detailed") } },
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
    for (const preset of templateImagePresets("pixel-art")) {
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

  it("uses the density-level character and action prompts in single-node workflows", () => {
    const character = createPixelAssetWorkflowNodes("character-sheet", "coarse", [reference], "characters");
    expect(character.nodes).toHaveLength(1);
    expect(character.nodes[0]).toMatchObject({ type: "image", data: { presetId: "character-sheet", aspectRatio: "16:9" } });
    if (character.nodes[0]?.type === "image") {
      expect(character.nodes[0].data.prompt).toBe(withCharacterPixelArtLevel(characterAssetPrompt("", "coarse"), "coarse"));
      expect(character.nodes[0].data.model).toEqual({ provider: "example", id: "reference" });
    }

    const walk = createPixelAssetWorkflowNodes("action:walk", "classic", [reference], "animation");
    expect(walk.nodes).toHaveLength(1);
    expect(walk.nodes[0]).toMatchObject({ type: "image", data: { aspectRatio: "4:3" } });
    if (walk.nodes[0]?.type === "image") expect(walk.nodes[0].data.prompt).toBe(actionSheetPrompt("walk", "", "classic"));
  });

  it("keeps distinct size, palette, and shading budgets without output-width examples", () => {
    const settings = [
      ["coarse", 32, 8, "1–2"], ["classic", 64, 16, "2–3"], ["detailed", 192, 48, "4–6"],
    ] as const;
    for (const [level, size, colors, tones] of settings) {
      const prompt = withPixelArtLevel("USER REQUEST: wizard", level);
      expect(prompt).toContain(`${size}×${size} logical sprite canvas`);
      expect(prompt).toContain(`Use no more than ${colors} colors`);
      expect(prompt).toContain(`${tones} hard-edged tones per major material`);
      expect(prompt).not.toContain("1536-pixel output width");
      expect(prompt).not.toContain("character head");
      expect(prompt).not.toContain("each eye");
    }
  });

  it("separates whole reference-sheet dimensions from full-body sprite budgets", () => {
    for (const [level, size, width, height] of [
      ["coarse", 32, 128, 72], ["classic", 64, 256, 144], ["detailed", 192, 768, 432],
    ] as const) {
      const prompt = canvasImagePresetPrompt("character-sheet", "blue-haired wizard", "pixel", 1, level);
      expect(prompt).toContain(`entire 16:9 reference sheet on a ${width}×${height} logical pixel canvas`);
      expect(prompt).toContain(`${size}×${size} logical sprite budget`);
      expect(prompt).toContain("same pixel scale and detail budget");
      expect(prompt).toContain("CHARACTER DETAIL BUDGET:");
      expect(prompt).not.toContain("coarse logical pixel grid");
    }
    const coarse = canvasImagePresetPrompt("character-sheet", "wizard", "pixel", 1, "coarse");
    expect(coarse).toContain("each eye as one solid dark mark");
    const detailed = canvasImagePresetPrompt("character-sheet", "wizard", "pixel", 1, "detailed");
    expect(detailed).toContain("4–6 hard-edged tones per major material");
    expect(detailed).toContain("small armor divisions");
    expect(detailed).not.toContain("1–2 hard-edged tones");
    expect(detailed).not.toContain("2–3 hard-edged tones");
  });

  it.each(["coarse", "classic", "detailed"] as const)("applies only the selected %s density across all catalog workflows", (level) => {
    const colors = { coarse: 8, classic: 16, detailed: 48 };
    const tones = { coarse: "1–2", classic: "2–3", detailed: "4–6" };
    for (const category of pixelAssetPresetCatalog()) {
      for (const preset of category.presets) {
        const workflow = createPixelAssetWorkflowNodes(preset.id, level, [reference], "workflow");
        const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId);
        expect(output?.type).toBe("image");
        if (output?.type !== "image") continue;
        const prompt = output.data.prompt;
        expect(output.data.pixelStyle, preset.id).toBe(level);
        expect(prompt, preset.id).toContain("even when the reference is already pixel art");
        expect(prompt, preset.id).toContain("Do not inherit the reference's pixel density");
        expect(prompt, preset.id).toContain("DETAIL BUDGET:");
        expect(prompt, preset.id).toContain(`Use no more than ${colors[level]} colors`);
        expect(prompt, preset.id).toContain(`${tones[level]} hard-edged tones per major material`);
        for (const other of ["coarse", "classic", "detailed"] as const) {
          if (other !== level) expect(prompt, preset.id).not.toContain(`${tones[other]} hard-edged tones`);
        }
        expect(prompt.match(/\*\*PIXEL DENSITY:/g), preset.id).toHaveLength(1);
        expect(prompt, preset.id).not.toContain("1536-pixel output width");
        expect(prompt, preset.id).not.toContain("coarse logical pixel grid");
        if (preset.id !== "continuous-sequence") expect(prompt, preset.id).not.toMatch(/\{[A-Z_]+\}/);
      }
    }
  });

  it.each(["coarse", "classic", "detailed"] as const)("keeps %s density instructions relevant to each asset type", (level) => {
    for (const preset of ["scene", "terrain", "tileset", "building", "prop", "icon", "monster", "animal"] as const) {
      const prompt = canvasImagePresetPrompt(preset, "a silver asset", "pixel", 1, level);
      expect(prompt, preset).not.toContain("character head");
      expect(prompt, preset).not.toContain("each eye");
      expect(prompt, preset).not.toContain("hair locks");
      expect(prompt, preset).not.toContain("iris shading");
    }
    const panels = canvasImagePresetPrompt("consistent-sequence", "a fox in nine settings", "pixel", 1, level);
    expect(panels).toContain("SUBJECT DETAIL BUDGET:");
    expect(panels).not.toContain("CHARACTER DETAIL BUDGET:");
    const portrait = canvasImagePresetPrompt("portrait", "mage", "pixel", 1, level);
    expect(portrait).toContain("CHARACTER DETAIL BUDGET:");
    expect(portrait).not.toContain("Allow greater pixel detail");
    expect(portrait).toContain("A larger portrait does not authorize a finer pixel grid");
    expect(canvasImagePresetPrompt("side-view-character", "mage", "pixel", 1, level)).not.toContain("or visual style reference");
  });

  it.each([
    ["coarse", 32, 96, 16], ["classic", 64, 160, 32], ["detailed", 192, 480, 128],
  ] as const)("computes per-cell and complete-sheet dimensions for %s layouts", (level, sprite, scene, tile) => {
    const actions = actionSheetPrompt("walk", "", level);
    expect(actions).toContain(`per frame: ${sprite}×${sprite} pixels`);
    expect(actions).toContain(`complete sheet is ${sprite * 4}×${sprite * 3} logical pixels`);
    for (const preset of ["monster", "animal"] as const) {
      const prompt = canvasImagePresetPrompt(preset, "fox", "pixel", 1, level);
      expect(prompt).toContain(`per sprite: ${sprite}×${sprite} pixels`);
      expect(prompt).toContain(`complete sheet is ${sprite * 4}×${sprite * 4} logical pixels`);
    }
    const tiles = canvasImagePresetPrompt("tileset", "24×24 tiles in a 3×2 atlas", "pixel", 1, level);
    expect(tiles).toContain(`per tile: ${tile}×${tile} pixels`);
    expect(tiles).toContain(`complete sheet is ${tile * 4}×${tile * 4} logical pixels`);
    expect(tiles).toContain("An explicit user tile size or atlas layout overrides these defaults");
    const panels = canvasImagePresetPrompt("consistent-sequence", "fox", "pixel", 1, level);
    expect(panels).toContain(`per panel: ${scene}×${scene} pixels`);
    expect(panels).toContain(`complete sheet is ${scene * 3}×${scene * 3} logical pixels`);
    const prop = canvasImagePresetPrompt("prop", "sword", "pixel", 1, level);
    expect(prop).toContain(`per view: ${sprite}×${sprite} pixels`);
    expect(prop).toContain(`complete sheet is ${sprite * 4}×${sprite * 3} logical pixels`);
    for (const [preset, ratio] of [["consistent-sequence", "1:1"], ["prop", "4:3"], ["multi-angle", "1:1"]] as const) {
      const workflow = createPixelAssetWorkflowNodes(preset, level, [reference]);
      expect(workflow.nodes[0]).toMatchObject({ data: { aspectRatio: ratio } });
    }
  });

  it("simplifies each classic asset by function without losing animation, tile, or reskin contracts", () => {
    const prompt = (preset: Parameters<typeof canvasImagePresetPrompt>[0]) => canvasImagePresetPrompt(preset, "silver mage $& $'", "pixel", 2, "classic");
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
      expect(canvasImagePresetPrompt(preset, "", "pixel", 1, "classic")).toContain("USER REQUEST: Derive the terrain biome");
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
      const actionPrompt = actionSheetPrompt(action, "", "classic");
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
      const workflow = createPixelAssetWorkflowNodes("quick-reskin", "classic", [reference], "skins");
      const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId);
      expect(output?.type === "image" && output.data.prompt).toBe(withPixelArtLevel(QUICK_RESKIN_DEFAULT_PROMPT, "classic", "sprite", { assetType: "character" }));
      expect(pixelAssetWorkflowLabel("quick-reskin", "classic")).toContain("换装");
      expect(pixelAssetWorkflowLabel("quick-reskin", "classic")).toContain("经典像素");
    } finally {
      await i18next.changeLanguage(previousLanguage);
    }
  });

  it("does not assign an incompatible reference model to the two-image reskin flow", () => {
    const workflow = createPixelAssetWorkflowNodes("quick-reskin", "classic", [textOnly], "skins");
    const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId);
    expect(output?.type === "image" && output.data.model).toBeUndefined();
  });
});
