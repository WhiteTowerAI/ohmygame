import type { AssetCanvasNode, ImageModel } from "../shared/contracts.js";
import type { CanvasPresetBoard } from "../shared/canvas-plugin-nodes.js";
import { createAssetGenerationNode, effectLibraryPrompt, preferredImageOption } from "../shared/asset-canvas.js";
import {
  createPixelAssetWorkflowNodes,
  PIXEL_ASSET_TEMPLATE_CATEGORIES,
  PIXEL_ASSET_TEMPLATE_NOTE,
  pixelAssetTemplatePresetIds,
  type PixelAssetTemplateCategory,
} from "./asset-canvas-pixel-workflows.js";
import { EFFECT_PRESETS, effectPresetAspectRatio, effectPresetFrames, effectPresetLabel, effectPresetStaticExampleId } from "./asset-canvas-effect-presets.js";
import { templateAssetUrl } from "./template-assets.js";
import { t } from "./i18n.js";

// The app's own Asset presets: each is a workflow, its generators wired to a
// shared reference and laid out with a guide, added to the board in one group.
// A board stores nothing about the preset; the nodes are ordinary ones.

export type PixelWorkflowPresetId = PixelAssetTemplateCategory | "effects";

const COVERS: Record<PixelWorkflowPresetId, string> = {
  characters: templateAssetUrl("examples/characters-cover.webp"),
  creatures: templateAssetUrl("examples/creatures-cover.webp"),
  animation: templateAssetUrl("examples/animation-cover.webp"),
  scenes: templateAssetUrl("examples/scenes-cover.webp"),
  terrain: templateAssetUrl("examples/terrain-cover.webp"),
  objects: templateAssetUrl("examples/objects-cover.webp"),
  skins: templateAssetUrl("examples/skins-cover.webp"),
  effects: templateAssetUrl("examples/effects/covers/classic-cover.webp"),
};

/** The example a category's reference slot shows until the person adds their own. */
const REFERENCE_EXAMPLES: Partial<Record<PixelAssetTemplateCategory, string>> = {
  characters: "reference/character",
  creatures: "reference/creature",
  scenes: "reference/scene",
  terrain: "reference/scene",
  objects: "reference/object",
};

const GUIDE_WIDTH = 760;
/** Rough rendered heights of a guide (its paragraphs, then one row per generator) and of a step note. */
const GUIDE_BASE_HEIGHT = 190;
const GUIDE_ROW_HEIGHT = 50;
const STEP_HEIGHT = 260;
const GAP = 48;
const COLUMN = 460;
const ROW = 480;

/** The pixel workflows in the order Asset presets lists them. */
export function pixelWorkflowPresets(): { id: PixelWorkflowPresetId; label: string; description: string; coverUrl: string }[] {
  return [
    ...PIXEL_ASSET_TEMPLATE_CATEGORIES.map((id) => ({
      id,
      label: t(`assetCanvas.pixelPresets.categories.${id}`),
      description: t(`assetCanvas.pixelPresets.cardDescriptions.${id}`),
      coverUrl: COVERS[id],
    })),
    { id: "effects" as const, label: t("effectLibrary.title"), description: t("effectLibrary.cardDescription"), coverUrl: COVERS.effects },
  ];
}

/** A workflow's nodes and links, at positions relative to its top left. */
export function createPixelWorkflowPreset(id: PixelWorkflowPresetId, imageModels: readonly ImageModel[]): CanvasPresetBoard {
  return { nodes: id === "effects" ? effectNodes(imageModels) : categoryNodes(id, imageModels), edges: [] };
}

function categoryNodes(category: PixelAssetTemplateCategory, imageModels: readonly ImageModel[]): AssetCanvasNode[] {
  const presetIds = pixelAssetTemplatePresetIds(category);
  const guide: AssetCanvasNode = {
    id: crypto.randomUUID(),
    type: "text",
    title: t("assetCanvas.pixelPresets.introductionTitle", { category: t(`assetCanvas.pixelPresets.categories.${category}`) }),
    position: { x: 0, y: 0 },
    width: GUIDE_WIDTH,
    // The guide is drawn from this marker in the current language; the text is what the agent reads.
    data: { instruction: `pixel-asset-template:${category}`, text: [t(`assetCanvas.pixelPresets.templateDescriptions.${category}`), t("assetCanvas.pixelPresets.introduction")].join("\n\n") },
  };
  const top = GUIDE_BASE_HEIGHT + presetIds.length * GUIDE_ROW_HEIGHT + GAP;
  // Outfits are their own small workflow: a person, an outfit and the result.
  if (category === "skins") {
    const workflow = createPixelAssetWorkflowNodes(presetIds[0]!, imageModels);
    return [guide, ...workflow.nodes.map((node) => ({ ...node, position: { x: node.position.x - 24, y: top } }))];
  }
  const rows = Math.ceil(presetIds.length / 2);
  const reference = createAssetGenerationNode("image", { x: 0, y: top + Math.floor((rows - 1) / 2) * ROW }, {}) as Extract<AssetCanvasNode, { type: "image" }>;
  reference.title = t("assetCanvas.pixelPresets.referenceImage");
  reference.data.sourceInput = true;
  reference.data.sourceInputLabel = reference.title;
  reference.data.exampleImage = REFERENCE_EXAMPLES[category] ?? "classic/character-sheet";
  const generators = presetIds.flatMap((presetId, index) =>
    createPixelAssetWorkflowNodes(presetId, imageModels, undefined, reference.id).nodes.map((node) => ({
      ...node,
      position: { x: COLUMN + (index % 2) * COLUMN, y: top + Math.floor(index / 2) * ROW },
    })));
  const nodes: AssetCanvasNode[] = [guide, reference, ...generators];
  // An action sheet becomes an animation in two more steps, written under the generators.
  if (category === "animation") {
    guide.title = t("assetCanvas.pixelPresets.animationStep1Title");
    const below = top + rows * ROW + GAP;
    nodes.push(note(t("assetCanvas.pixelPresets.animationStep2Title"), t("assetCanvas.pixelPresets.animationStep2Body"), { x: 0, y: below }, GUIDE_WIDTH));
    nodes.push(note(t("assetCanvas.pixelPresets.animationStep3Title"), t("assetCanvas.pixelPresets.animationStep3Body"), { x: 0, y: below + STEP_HEIGHT + GAP }, GUIDE_WIDTH));
  }
  return nodes;
}

/** The four steps from a sprite sheet to a checked GIF, beside one generator for each effect. */
function effectNodes(imageModels: readonly ImageModel[]): AssetCanvasNode[] {
  const steps = ([1, 2, 3, 4] as const).map((index) =>
    note(t(`effectLibrary.step${index}Title`), t(`effectLibrary.step${index}Body`), { x: 0, y: (index - 1) * (STEP_HEIGHT + GAP) }, 440));
  const model = imageModels.find((candidate) => candidate.supportsReferenceImage && candidate.maxReferenceImages !== 0) ?? imageModels[0];
  const generators = EFFECT_PRESETS.map((preset, index): AssetCanvasNode => {
    const option = preferredImageOption(model, effectPresetAspectRatio(preset.id));
    const node = createAssetGenerationNode("image", { x: 500 + (index % 3) * COLUMN, y: Math.floor(index / 3) * ROW }, {
      ...(model ? { imageModel: { provider: model.provider, id: model.id } } : {}),
      ...(option ? { imageResolution: option.resolution, imageAspectRatio: option.aspectRatio } : {}),
    }) as Extract<AssetCanvasNode, { type: "image" }>;
    node.title = effectPresetLabel(preset.id);
    node.description = effectPresetFrames(preset.id);
    node.data.prompt = effectLibraryPrompt(preset.prompt, "original", "sample", "");
    node.data.promptExpanded = true;
    node.data.exampleImage = effectPresetStaticExampleId(preset.id);
    return node;
  });
  return [...steps, ...generators];
}

function note(title: string, text: string, position: { x: number; y: number }, width: number): AssetCanvasNode {
  return { id: crypto.randomUUID(), type: "text", title, position, width, data: { instruction: PIXEL_ASSET_TEMPLATE_NOTE, text } };
}
