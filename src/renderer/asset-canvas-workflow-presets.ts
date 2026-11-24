import type { AssetCanvasNode, ImageModel } from "../shared/contracts.js";
import type { CanvasPresetBoard } from "../shared/canvas-plugin-nodes.js";
import { createAssetGenerationNode } from "../shared/asset-canvas.js";
import {
  createPixelAssetWorkflowNodes,
  PIXEL_ASSET_TEMPLATE_CATEGORIES,
  PIXEL_ASSET_TEMPLATE_NOTE,
  PRESET_COLUMN,
  PRESET_NOTE_WIDTH,
  pixelAssetPresetLabel,
  pixelAssetTemplatePresetIds,
  type PixelAssetTemplateCategory,
} from "./asset-canvas-pixel-workflows.js";
import { pixelPresetGifExampleId } from "./asset-canvas-pixel-examples.js";
import { effectLibraryNodes } from "./asset-canvas-effect-library.js";
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

/** The one action the animation workflow makes. */
const ANIMATION_ACTION = "action:walk" as const;

const GUIDE_WIDTH = 760;
/** Rough rendered height of a guide: its paragraphs, then one row per generator. */
const GUIDE_BASE_HEIGHT = 200;
const GUIDE_ROW_HEIGHT = 40;
/** Room for the tallest of the animation steps' notes at their width. */
const ANIMATION_NOTE_HEIGHT = 320;
const GAP = 48;
const COLUMN = PRESET_COLUMN;
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

let coversRequested = false;

/** Starts loading the covers before Asset presets opens, so its cards show them at once. */
export function preloadPixelWorkflowCovers(): void {
  if (coversRequested || typeof Image === "undefined") return;
  coversRequested = true;
  for (const url of Object.values(COVERS)) {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
  }
}

/** A workflow's nodes and links, at positions relative to its top left. */
export function createPixelWorkflowPreset(id: PixelWorkflowPresetId, imageModels: readonly ImageModel[]): CanvasPresetBoard {
  return { nodes: id === "effects" ? effectLibraryNodes(imageModels) : categoryNodes(id, imageModels), edges: [] };
}

function categoryNodes(category: PixelAssetTemplateCategory, imageModels: readonly ImageModel[]): AssetCanvasNode[] {
  if (category === "animation") return animationNodes(imageModels);
  const presetIds = pixelAssetTemplatePresetIds(category);
  const guide: AssetCanvasNode = {
    id: crypto.randomUUID(),
    type: "text",
    title: t("assetCanvas.pixelPresets.introductionTitle", { category: t(`assetCanvas.pixelPresets.categories.${category}`) }),
    position: { x: 0, y: 0 },
    width: GUIDE_WIDTH,
    // The guide is drawn from this marker in the current language; the text is what the agent reads.
    data: { instruction: `pixel-asset-template:${category}`, text: [t(`assetCanvas.pixelPresets.templateDescriptions.${category}`), t("assetCanvas.pixelPresets.introduction"), t("assetCanvas.pixelPresets.modelRecommendation")].join("\n\n") },
  };
  const top = GUIDE_BASE_HEIGHT + presetIds.length * GUIDE_ROW_HEIGHT + GAP;
  // Outfits are their own small workflow: a person, an outfit and the result.
  if (category === "skins") {
    const workflow = createPixelAssetWorkflowNodes(presetIds[0]!, imageModels);
    return [guide, ...workflow.nodes.map((node, index) => ({ ...node, position: { x: index * COLUMN, y: top } }))];
  }
  const rows = Math.ceil(presetIds.length / 2);
  const reference = referenceNode(category, { x: 0, y: top + Math.floor((rows - 1) / 2) * ROW });
  const generators = presetIds.flatMap((presetId, index) =>
    createPixelAssetWorkflowNodes(presetId, imageModels, undefined, reference.id).nodes.map((node) => ({
      ...node,
      position: { x: COLUMN + (index % 2) * COLUMN, y: top + Math.floor(index / 2) * ROW },
    })));
  return [guide, reference, ...generators];
}

function referenceNode(category: PixelAssetTemplateCategory, position: { x: number; y: number }): Extract<AssetCanvasNode, { type: "image" }> {
  const reference = createAssetGenerationNode("image", position, {}) as Extract<AssetCanvasNode, { type: "image" }>;
  reference.title = t("assetCanvas.pixelPresets.referenceImage");
  reference.data.sourceInput = true;
  reference.data.sourceInputLabel = reference.title;
  reference.data.exampleImage = REFERENCE_EXAMPLES[category] ?? "classic/character-sheet";
  return reference;
}

/**
 * Animation makes one action from reference to GIF, read left to right: each
 * step's note stands above what it works on, the reference, the action's
 * sheet, and the GIF that sheet becomes.
 */
function animationNodes(imageModels: readonly ImageModel[]): AssetCanvasNode[] {
  const top = ANIMATION_NOTE_HEIGHT + GAP;
  const reference = referenceNode("animation", { x: 0, y: top });
  const sheet = createPixelAssetWorkflowNodes(ANIMATION_ACTION, imageModels, undefined, reference.id).nodes
    .map((node) => ({ ...node, position: { x: COLUMN, y: top } }));
  const label = pixelAssetPresetLabel(ANIMATION_ACTION);
  const gif: AssetCanvasNode = {
    id: crypto.randomUUID(),
    type: "image",
    title: `${label} · GIF`,
    position: { x: 2 * COLUMN, y: top },
    data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [], sourceInput: true, sourceInputLabel: `${label} · GIF`, exampleImage: pixelPresetGifExampleId(ANIMATION_ACTION)! },
  };
  return [
    note(t("assetCanvas.pixelPresets.animationStep1Title"), t("assetCanvas.pixelPresets.animationStep1Body"), { x: 0, y: 0 }, PRESET_NOTE_WIDTH),
    note(t("assetCanvas.pixelPresets.animationStep2Title"), t("assetCanvas.pixelPresets.animationStep2Body"), { x: COLUMN, y: 0 }, PRESET_NOTE_WIDTH),
    note(t("assetCanvas.pixelPresets.animationStep3Title"), t("assetCanvas.pixelPresets.animationStep3WalkBody"), { x: 2 * COLUMN, y: 0 }, PRESET_NOTE_WIDTH),
    reference,
    ...sheet,
    gif,
  ];
}

function note(title: string, text: string, position: { x: number; y: number }, width: number): AssetCanvasNode {
  return { id: crypto.randomUUID(), type: "text", title, position, width, data: { instruction: PIXEL_ASSET_TEMPLATE_NOTE, text } };
}
