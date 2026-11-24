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

export function pixelAssetPresetCatalog(): {
  id: PixelAssetCategory;
  label: string;
  presets: (PixelAssetPreset & { label: string; description: string })[];
}[] {
  return PRESET_CATEGORIES.map((category) => ({
    id: category.id,
    label: t(`assetCanvas.pixelPresets.categories.${category.id}`),
    presets: category.presets.map((id) => {
      const preset = pixelAssetPreset(id);
      return {
        ...preset,
        label: preset.action
          ? t(`assetCanvasTemplates.actions.${preset.action}`)
          : t(`assetCanvas.imagePresets.${preset.imagePreset}`),
        description: preset.action
          ? t(`assetCanvas.pixelPresets.descriptions.actions.${preset.action}`)
          : t(`assetCanvas.pixelPresets.descriptions.${preset.imagePreset}`),
      };
    }),
  }));
}

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

export function pixelAssetWorkflowLabel(id: PixelAssetPresetId): string {
  const preset = pixelAssetPreset(id);
  return `${t(`assetCanvas.pixelPresets.categories.${preset.category}`)} · ${pixelAssetPresetLabel(id)}`;
}

export function pixelAssetPresetNeedsWorkflowGroup(
  id: PixelAssetPresetId,
): boolean {
  return id === "quick-reskin";
}

type PixelAssetWorkflowGroup = Extract<AssetCanvasNode, { type: "group" }> & {
  width: number;
  height: number;
};

/** A preset's nodes at a canvas position; a workflow preset is centred there inside its own group. */
export function createPixelAssetPresetContents(
  presetId: PixelAssetPresetId,
  imageModels: readonly ImageModel[],
  position: { x: number; y: number },
): {
  group?: PixelAssetWorkflowGroup;
  nodes: AssetCanvasNode[];
  outputNodeId: string;
} {
  const needsWorkflowGroup = pixelAssetPresetNeedsWorkflowGroup(presetId);
  const workflowGroupId = needsWorkflowGroup ? crypto.randomUUID() : undefined;
  const generated = createPixelAssetWorkflowNodes(
    presetId,
    imageModels,
    workflowGroupId,
  );
  const group = needsWorkflowGroup
    ? {
        id: workflowGroupId!,
        type: "group" as const,
        position: { x: position.x - 730, y: position.y - 325 },
        width: 1460,
        height: 650,
        data: { name: pixelAssetWorkflowLabel(presetId) },
      }
    : undefined;
  const nodes = needsWorkflowGroup
    ? generated.nodes
    : generated.nodes.map((node) => ({
        ...node,
        position,
      }));
  return {
    ...(group ? { group } : {}),
    nodes,
    outputNodeId: generated.outputNodeId,
  };
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

/** The PixelLab plugin's image provider, as plugin providers are named. */
export const PIXELLAB_PROVIDER = "plugin.ohmygame.pixellab.pixellab";
export const PIXELLAB_PLUGIN = "ohmygame/pixellab";

export type PixelLabPresetGroup =
  | "characters"
  | "animation"
  | "objects"
  | "maps"
  | "effects"
  | "edits";

/**
 * Presets that are one PixelLab model, from the PixelLab plugin. Each makes
 * an ordinary Image node with that model, so a board stores nothing new. The
 * prompt is a starting example in English, as models are sent English.
 */
const PIXELLAB_PRESETS = [
  { model: "character-4", group: "characters", prompt: "a knight in silver armor with a blue cape" },
  { model: "character-8", group: "characters", prompt: "a young wizard in a purple robe" },
  { model: "character-state", group: "characters", prompt: "wearing a red hooded cloak" },
  { model: "frame-animation", group: "animation", prompt: "walk in place" },
  { model: "interpolation", group: "animation", prompt: "transforming smoothly" },
  { model: "rotations-8", group: "animation", prompt: "" },
  { model: "object", group: "objects", prompt: "a wooden treasure chest with iron bands" },
  { model: "object-8", group: "objects", prompt: "a stone fountain" },
  { model: "object-animation", group: "objects", prompt: "opening slowly" },
  { model: "tileset", group: "maps", prompt: "grass | shallow water | sandy shore" },
  { model: "tileset-sidescroller", group: "maps", prompt: "mossy stone bricks | grass" },
  { model: "isometric-tile", group: "maps", prompt: "grass on top of dirt" },
  { model: "vfx", group: "effects", prompt: "a blue magic burst with sparkles" },
  { model: "ui", group: "effects", prompt: "a medieval stone button" },
  { model: "to-pixel-art-pro-flash", group: "edits", prompt: "" },
  { model: "remove-background", group: "edits", prompt: "" },
] as const satisfies readonly { model: string; group: PixelLabPresetGroup; prompt: string }[];

export type PixelLabPresetModel = (typeof PIXELLAB_PRESETS)[number]["model"];
export type PixelLabPresetId = `pixellab:${PixelLabPresetModel}`;
export const PIXELLAB_PRESET_GROUPS: readonly PixelLabPresetGroup[] = ["characters", "animation", "objects", "maps", "effects", "edits"];

export type PixelLabPresetAvailability = "ready" | "missing" | "outdated";

/** The PixelLab presets by group, with whether this project can use each one. */
export function pixelLabPresetCatalog(imageModels: readonly ImageModel[]): {
  group: PixelLabPresetGroup;
  label: string;
  presets: { id: PixelLabPresetId; label: string; description: string; availability: PixelLabPresetAvailability; needsReference: boolean }[];
}[] {
  return PIXELLAB_PRESET_GROUPS.map((group) => ({
    group,
    label: t(`assetCanvas.pixelPresets.pixellab.groups.${group}`),
    presets: PIXELLAB_PRESETS.filter((preset) => preset.group === group).map((preset) => {
      const id = `pixellab:${preset.model}` as const;
      const model = pixelLabModel(id, imageModels);
      return {
        id,
        label: t(`assetCanvas.pixelPresets.pixellab.presets.${preset.model}.label`),
        description: t(`assetCanvas.pixelPresets.pixellab.presets.${preset.model}.description`),
        availability: pixelLabPresetAvailability(id, imageModels),
        needsReference: (model?.minReferenceImages ?? 0) > 0,
      };
    }),
  }));
}

export function pixelLabPresetAvailability(id: PixelLabPresetId, imageModels: readonly ImageModel[]): PixelLabPresetAvailability {
  if (pixelLabModel(id, imageModels)) return "ready";
  return imageModels.some((model) => model.provider === PIXELLAB_PROVIDER) ? "outdated" : "missing";
}

function pixelLabModel(id: PixelLabPresetId, imageModels: readonly ImageModel[]): ImageModel | undefined {
  const modelId = id.slice("pixellab:".length);
  return imageModels.find((model) => model.provider === PIXELLAB_PROVIDER && model.id === modelId);
}

/** A PixelLab preset's Image node at `position`. */
export function createPixelLabPresetNode(
  id: PixelLabPresetId,
  imageModels: readonly ImageModel[],
  position: { x: number; y: number },
): Extract<AssetCanvasNode, { type: "image" }> | undefined {
  const model = pixelLabModel(id, imageModels);
  const preset = PIXELLAB_PRESETS.find((candidate) => `pixellab:${candidate.model}` === id);
  if (!model || !preset) return undefined;
  const option = preferredImageOption(model, "1:1");
  const node = createAssetGenerationNode("image", position, {
    imageModel: { provider: model.provider, id: model.id },
    ...(option ? { imageResolution: option.resolution, imageAspectRatio: option.aspectRatio } : {}),
  }) as Extract<AssetCanvasNode, { type: "image" }>;
  node.title = t(`assetCanvas.pixelPresets.pixellab.presets.${preset.model}.label`);
  node.data.prompt = preset.prompt;
  node.data.promptExpanded = true;
  return node;
}
