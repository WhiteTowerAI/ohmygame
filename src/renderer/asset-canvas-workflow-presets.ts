import type { AssetCanvasNode, ImageModel } from "../shared/contracts.js";
import type { CanvasPresetBoard } from "../shared/canvas-plugin-nodes.js";
import { createAssetGenerationNode } from "../shared/asset-canvas.js";
import {
  createPixelAssetWorkflowNodes,
  PIXEL_ASSET_TEMPLATE_CATEGORIES,
  PIXEL_ASSET_TEMPLATE_NOTE,
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
  // An action sheet becomes an animation in two more steps, written under the
  // generators, then the GIF each action makes, as an example.
  if (category === "animation") {
    guide.title = t("assetCanvas.pixelPresets.animationStep1Title");
    const below = top + rows * ROW + GAP;
    nodes.push(note(t("assetCanvas.pixelPresets.animationStep2Title"), t("assetCanvas.pixelPresets.animationStep2Body"), { x: 0, y: below }, GUIDE_WIDTH));
    nodes.push(note(t("assetCanvas.pixelPresets.animationStep3Title"), t("assetCanvas.pixelPresets.animationStep3Body"), { x: 0, y: below + STEP_HEIGHT + GAP }, GUIDE_WIDTH));
    nodes.push(...gifExamples(presetIds, { x: 0, y: below + 2 * (STEP_HEIGHT + GAP) }));
  }
  return nodes;
}

/** A group of the GIFs the animation generators make, two to a row. */
function gifExamples(presetIds: ReturnType<typeof pixelAssetTemplatePresetIds>, position: { x: number; y: number }): AssetCanvasNode[] {
  const group: AssetCanvasNode = { id: crypto.randomUUID(), type: "group", position, data: { name: `${t("assetCanvas.pixelPresets.categories.animation")} · GIF` } };
  const examples = presetIds.flatMap((presetId) => {
    const exampleImage = pixelPresetGifExampleId(presetId);
    return exampleImage ? [{ presetId, exampleImage }] : [];
  }).map(({ presetId, exampleImage }, index): AssetCanvasNode => ({
    id: crypto.randomUUID(),
    type: "image",
    parentId: group.id,
    title: pixelAssetPresetLabel(presetId),
    position: { x: 16 + (index % 2) * COLUMN, y: 52 + Math.floor(index / 2) * 420 },
    data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [], sourceInput: true, sourceInputLabel: pixelAssetPresetLabel(presetId), exampleImage },
  }));
  const rows = Math.ceil(examples.length / 2);
  return [{ ...group, width: 16 + 2 * COLUMN, height: 52 + rows * 420 }, ...examples];
}

function note(title: string, text: string, position: { x: number; y: number }, width: number): AssetCanvasNode {
  return { id: crypto.randomUUID(), type: "text", title, position, width, data: { instruction: PIXEL_ASSET_TEMPLATE_NOTE, text } };
}
