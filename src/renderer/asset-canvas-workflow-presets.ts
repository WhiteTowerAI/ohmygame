import type { AssetCanvasNode, ImageModel } from "../shared/contracts.js";
import type { CanvasPresetBoard } from "../shared/canvas-plugin-nodes.js";
import { createAssetGenerationNode } from "../shared/asset-canvas.js";
import {
  createPixelAssetWorkflowNodes,
  PIXEL_ASSET_TEMPLATE_CATEGORIES,
  PRESET_COLUMN,
  PRESET_NOTE_WIDTH,
  pixelAssetPresetLabel,
  pixelAssetPresetUsage,
  presetTextNode,
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

/** The action the animation workflow's prompt makes until the person changes it. */
const ANIMATION_ACTION = "action:walk" as const;

const GUIDE_WIDTH = 760;
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
  // The guide lists what each generator's result is for in a game.
  const uses = presetIds.map((id) => t("assetCanvas.pixelPresets.useLine", { label: pixelAssetPresetLabel(id), use: pixelAssetPresetUsage(id) })).join("\n");
  const guide = presetTextNode(
    t("assetCanvas.pixelPresets.introductionTitle", { category: t(`assetCanvas.pixelPresets.categories.${category}`) }),
    [t(`assetCanvas.pixelPresets.templateDescriptions.${category}`), t("assetCanvas.pixelPresets.introduction"), uses, t("assetCanvas.pixelPresets.modelRecommendation")].join("\n\n"),
    { x: 0, y: 0 },
    GUIDE_WIDTH,
  );
  const top = (guide.height ?? 0) + GAP;
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
  const steps = [
    presetTextNode(t("assetCanvas.pixelPresets.animationStep1Title"), t("assetCanvas.pixelPresets.animationStep1Body"), { x: 0, y: 0 }, PRESET_NOTE_WIDTH),
    presetTextNode(t("assetCanvas.pixelPresets.animationStep2Title"), t("assetCanvas.pixelPresets.animationStep2Body"), { x: COLUMN, y: 0 }, PRESET_NOTE_WIDTH),
    presetTextNode(t("assetCanvas.pixelPresets.animationStep3Title"), t("assetCanvas.pixelPresets.animationStep3ExampleBody"), { x: 2 * COLUMN, y: 0 }, PRESET_NOTE_WIDTH),
  ];
  const top = Math.max(...steps.map((step) => step.height ?? 0)) + GAP;
  const reference = referenceNode("animation", { x: 0, y: top });
  // Titled for any action: the prompt makes a walk until the person names another.
  const sheet = createPixelAssetWorkflowNodes(ANIMATION_ACTION, imageModels, undefined, reference.id).nodes
    .map((node) => ({ ...node, title: t("assetCanvas.pixelPresets.animationSheet"), position: { x: COLUMN, y: top } }));
  const gifTitle = t("assetCanvas.pixelPresets.animationGifExample");
  const gif: AssetCanvasNode = {
    id: crypto.randomUUID(),
    type: "image",
    title: gifTitle,
    position: { x: 2 * COLUMN, y: top },
    data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [], sourceInput: true, sourceInputLabel: gifTitle, exampleImage: pixelPresetGifExampleId(ANIMATION_ACTION)! },
  };
  return [
    ...steps,
    reference,
    ...sheet,
    gif,
  ];
}
