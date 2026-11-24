import type { AssetCanvasNode, ImageModel } from "../shared/contracts.js";
import { PIXEL_RESKIN_CLOTHING_EXAMPLE, pixelPresetExampleId } from "./asset-canvas-pixel-examples.js";
import {
  actionSheetPrompt,
  continuousActionsPrompt,
} from "../shared/canvas-character-tools.js";
import {
  canvasImagePresetPrompt,
  QUICK_RESKIN_DEFAULT_PROMPT,
  type CanvasImagePreset,
} from "../shared/canvas-image-presets.js";
import {
  withPixelArtStyle,
  type PixelArtLevel,
} from "../shared/canvas-pixel-style.js";
import {
  createAssetGenerationNode,
  preferredImageOption,
} from "../shared/asset-canvas.js";
import { t } from "./i18n.js";

export type PixelWorkflowAction =
  "idle" | "walk" | "run" | "attack" | "hurt" | "down";
export type PixelAssetPresetId =
  Exclude<CanvasImagePreset, "free"> | `action:${PixelWorkflowAction}`;
export type PixelAssetCategory =
  | "characters"
  | "creatures"
  | "animation"
  | "scenes"
  | "terrain"
  | "objects"
  | "skins";
export const PIXEL_ASSET_TEMPLATE_CATEGORIES = [
  "characters",
  "animation",
  "terrain",
  "objects",
  "creatures",
  "scenes",
  "skins",
] as const;
export type PixelAssetTemplateCategory =
  (typeof PIXEL_ASSET_TEMPLATE_CATEGORIES)[number];

export type PixelAssetPreset =
  | {
      id: `action:${PixelWorkflowAction}`;
      category: PixelAssetCategory;
      action: PixelWorkflowAction;
      imagePreset?: never;
    }
  | {
      id: Exclude<CanvasImagePreset, "free">;
      category: PixelAssetCategory;
      imagePreset: Exclude<CanvasImagePreset, "free">;
      action?: never;
    };

const PRESET_CATEGORIES: {
  id: PixelAssetCategory;
  presets: PixelAssetPresetId[];
}[] = [
  {
    id: "characters",
    presets: [
      "character-sheet",
      "rpg-character",
      "multi-angle",
      "portrait",
    ],
  },
  {
    id: "animation",
    presets: [
      "action:idle",
      "action:walk",
      "action:run",
      "action:attack",
      "action:hurt",
      "action:down",
      "continuous-sequence",
      "consistent-sequence",
    ],
  },
  { id: "terrain", presets: ["terrain", "tileset", "building"] },
  { id: "objects", presets: ["prop", "icon"] },
  { id: "creatures", presets: ["monster", "animal"] },
  { id: "scenes", presets: ["scene"] },
  { id: "skins", presets: ["quick-reskin"] },
];

export function pixelAssetTemplatePresetIds(
  category: PixelAssetTemplateCategory,
): PixelAssetPresetId[] {
  return [
    ...(PRESET_CATEGORIES.find((candidate) => candidate.id === category)
      ?.presets ?? []),
  ];
}

export function pixelAssetTemplateGuideCategory(
  instruction?: string,
): PixelAssetTemplateCategory | undefined {
  return PIXEL_ASSET_TEMPLATE_CATEGORIES.find(
    (category) => instruction === `pixel-asset-template:${category}`,
  );
}

/** Marks a template's read-only step note, which shows its text instead of a text generator. */
export const PIXEL_ASSET_TEMPLATE_NOTE = "pixel-asset-template-note";

/** Asset presets' columns: about one image node's width, then room for the link between nodes. */
export const PRESET_COLUMN = 560;
/** A step note in a row of steps, about as wide as the image node under it. */
export const PRESET_NOTE_WIDTH = 440;

/**
 * A preset's guide or step: an ordinary text node, written in the language the
 * person uses when they add it, which they can edit like any other. It is as
 * tall as its text needs, so the nodes laid out under it can start below it.
 */
export function presetTextNode(title: string, text: string, position: { x: number; y: number }, width: number, parentId?: string): Extract<AssetCanvasNode, { type: "text" }> {
  return { id: crypto.randomUUID(), type: "text", title, position, width, height: presetTextHeight(text, width), ...(parentId ? { parentId } : {}), data: { text, instruction: "" } };
}

/** Rough height of a text node showing this text at this width: its label, then the text box at 15px. */
function presetTextHeight(text: string, width: number): number {
  const room = width - 42;
  const lines = text.split("\n").reduce((count, paragraph) => {
    // Wide characters, such as Chinese, take about a full em; others about half.
    const span = [...paragraph].reduce((sum, character) => sum + (/[\u2e80-\uffff]/.test(character) ? 15 : 8), 0);
    return count + Math.max(1, Math.ceil(span / room));
  }, 0);
  return Math.ceil(78 + lines * 22.5);
}

export function pixelAssetPresetUsage(id: PixelAssetPresetId): string {
  const preset = pixelAssetPreset(id);
  return preset.action
    ? t(`assetCanvas.pixelPresets.uses.actions.${preset.action}`)
    : t(`assetCanvas.pixelPresets.uses.${preset.imagePreset}`);
}

export function pixelAssetPreset(id: PixelAssetPresetId): PixelAssetPreset {
  const action = id.startsWith("action:")
    ? (id.slice("action:".length) as PixelWorkflowAction)
    : undefined;
  const category = PRESET_CATEGORIES.find((candidate) =>
    candidate.presets.includes(id),
  )?.id;
  if (!category) throw new Error(`Unknown pixel asset preset: ${id}`);
  return action
    ? { id: id as `action:${PixelWorkflowAction}`, category, action }
    : {
        id: id as Exclude<CanvasImagePreset, "free">,
        category,
        imagePreset: id as Exclude<CanvasImagePreset, "free">,
      };
}

export function pixelAssetPresetAspectRatio(
  id: PixelAssetPresetId,
): "4:3" | "16:9" | "1:1" {
  const preset = pixelAssetPreset(id);
  return preset.action ||
    preset.imagePreset === "continuous-sequence" ||
    preset.imagePreset === "prop"
    ? "4:3"
    : preset.imagePreset === "character-sheet"
      ? "16:9"
      : "1:1";
}

export function pixelAssetPresetLabel(id: PixelAssetPresetId): string {
  const preset = pixelAssetPreset(id);
  return preset.action
    ? t(`assetCanvasTemplates.actions.${preset.action}`)
    : t(`assetCanvas.imagePresets.${preset.imagePreset}`);
}

// compat: since beta.5.11, remove from beta.7 and 2026-12-24. Names the
// density groups that earlier Home templates added to a canvas.
export function pixelArtLevelLabel(level: PixelArtLevel): string {
  return t(`assetCanvas.pixelPresets.levels.${level}`);
}

export function createPixelAssetWorkflowNodes(
  presetId: PixelAssetPresetId,
  imageModels: readonly ImageModel[],
  parentId?: string,
  referenceNodeId?: string,
): { nodes: AssetCanvasNode[]; outputNodeId: string } {
  const preset = pixelAssetPreset(presetId);
  const referenceModel = imageModels.find(
    (model) => model.supportsReferenceImage && model.maxReferenceImages !== 0,
  );
  const reskinModel = imageModels.find(
    (model) =>
      model.supportsReferenceImage && (model.maxReferenceImages ?? 16) >= 2,
  );
  const model =
    preset.imagePreset === "quick-reskin"
      ? reskinModel
      : (referenceModel ?? imageModels[0]);
  const aspectRatio = pixelAssetPresetAspectRatio(presetId);
  const option = preferredImageOption(model, aspectRatio);
  const makeImage = (
    title: string,
    x: number,
    prompt: string,
    images: AssetCanvasNode[] = [],
  ) => {
    const node = createAssetGenerationNode(
      "image",
      { x, y: 72 },
      {
        ...(model
          ? { imageModel: { provider: model.provider, id: model.id } }
          : {}),
        ...(option
          ? {
              imageResolution: option.resolution,
              imageAspectRatio: option.aspectRatio,
            }
          : {}),
      },
    ) as Extract<AssetCanvasNode, { type: "image" }>;
    if (parentId) node.parentId = parentId;
    node.title = title;
    node.data.prompt = prompt;
    node.data.promptExpanded = true;
    if (referenceNodeId)
      node.data.images = [{ type: "node", nodeId: referenceNodeId }];
    if (preset.imagePreset && preset.imagePreset !== "quick-reskin")
      node.data.presetId = preset.imagePreset;
    const exampleImage = pixelPresetExampleId(presetId);
    if (exampleImage) node.data.exampleImage = exampleImage;
    if (preset.imagePreset === "quick-reskin") {
      node.data.presetId = "quick-reskin";
      node.data.quickReskinMode = "person-clothing";
      node.data.images = images.map((source) => ({
        type: "node",
        nodeId: source.id,
      }));
    }
    return node;
  };

  if (preset.imagePreset === "quick-reskin") {
    const person = createAssetGenerationNode(
      "image",
      { x: 24, y: 72 },
      {},
    ) as Extract<AssetCanvasNode, { type: "image" }>;
    if (parentId) person.parentId = parentId;
    person.title = t("assetCanvasTemplates.quickReskinPerson");
    person.data.sourceInput = true;
    person.data.sourceInputLabel = person.title;
    person.data.exampleImage = pixelPresetExampleId("character-sheet")!;
    const clothing = createAssetGenerationNode(
      "image",
      { x: 484, y: 72 },
      {},
    ) as Extract<AssetCanvasNode, { type: "image" }>;
    if (parentId) clothing.parentId = parentId;
    clothing.title = t("assetCanvasTemplates.quickReskinClothing");
    clothing.data.sourceInput = true;
    clothing.data.sourceInputLabel = clothing.title;
    clothing.data.exampleImage = PIXEL_RESKIN_CLOTHING_EXAMPLE;
    const output = makeImage(
      pixelAssetPresetLabel(presetId),
      944,
      withPixelArtStyle(QUICK_RESKIN_DEFAULT_PROMPT, "sprite", {
        assetType: "character",
      }),
      [person, clothing],
    );
    return { nodes: [person, clothing, output], outputNodeId: output.id };
  }

  const prompt = preset.action
    ? actionSheetPrompt(preset.action, "")
    : preset.imagePreset === "continuous-sequence"
      ? continuousActionsPrompt("")
      : canvasImagePresetPrompt(preset.imagePreset, "", "pixel", 1);
  const output = makeImage(pixelAssetPresetLabel(presetId), 24, prompt);
  return { nodes: [output], outputNodeId: output.id };
}
