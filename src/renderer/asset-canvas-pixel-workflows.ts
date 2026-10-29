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
  PIXEL_ART_LEVELS,
  withPixelArtLevel,
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

export function pixelAssetTemplateCategories(): {
  id: PixelAssetTemplateCategory;
  label: string;
  description: string;
}[] {
  return PIXEL_ASSET_TEMPLATE_CATEGORIES.map((id) => ({
    id,
    label: t(`assetCanvas.pixelPresets.categories.${id}`),
    description: t(`assetCanvas.pixelPresets.templateDescriptions.${id}`),
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

export function pixelArtLevelLabel(level: PixelArtLevel): string {
  return t(`assetCanvas.pixelPresets.levels.${level}`);
}

export function pixelAssetWorkflowLabel(
  id: PixelAssetPresetId,
  level: PixelArtLevel,
): string {
  const preset = pixelAssetPreset(id);
  return `${t(`assetCanvas.pixelPresets.categories.${preset.category}`)} · ${pixelAssetPresetLabel(id)} · ${pixelArtLevelLabel(level)}`;
}

export function pixelAssetCategoryTemplateLabel(
  category: PixelAssetTemplateCategory,
  level: PixelArtLevel,
): string {
  return `${t(`assetCanvas.pixelPresets.categories.${category}`)} · ${pixelArtLevelLabel(level)}`;
}

export function pixelAssetReferenceNode(
  level: PixelArtLevel,
  parentId: string,
  position: { x: number; y: number },
): Extract<AssetCanvasNode, { type: "image" }> {
  const title = `${t("assetCanvas.pixelPresets.referenceImage")} · ${pixelArtLevelLabel(level)}`;
  const node = createAssetGenerationNode("image", position, {}) as Extract<
    AssetCanvasNode,
    { type: "image" }
  >;
  node.parentId = parentId;
  node.title = title;
  node.data.sourceInput = true;
  node.data.sourceInputLabel = title;
  return node;
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

export interface PixelDensityGroupBounds {
  position: { x: number; y: number };
  width: number;
  height: number;
}

export function placePixelPresetOutsideDensityGroups(
  presetId: PixelAssetPresetId,
  position: { x: number; y: number },
  groups: readonly PixelDensityGroupBounds[],
): {
  nodePosition: { x: number; y: number };
  workflowGroupPosition: { x: number; y: number };
} {
  const isWorkflow = pixelAssetPresetNeedsWorkflowGroup(presetId);
  const candidate = isWorkflow
    ? { x: position.x - 730, y: position.y - 325, width: 1460, height: 650 }
    : { x: position.x, y: position.y, width: 440, height: 400 };
  const overlapsDensityGroup = groups.some(
    (group) =>
      candidate.x < group.position.x + group.width &&
      candidate.x + candidate.width > group.position.x &&
      candidate.y < group.position.y + group.height &&
      candidate.y + candidate.height > group.position.y,
  );
  if (!overlapsDensityGroup) {
    return {
      nodePosition: position,
      workflowGroupPosition: { x: position.x - 730, y: position.y - 325 },
    };
  }

  const nextY =
    Math.max(...groups.map((group) => group.position.y + group.height)) + 48;
  const workflowGroupPosition = isWorkflow
    ? { x: position.x - 730, y: nextY }
    : { x: position.x - 730, y: nextY - 325 };
  return {
    nodePosition: isWorkflow
      ? { x: position.x, y: nextY + 325 }
      : { x: position.x, y: nextY },
    workflowGroupPosition,
  };
}

export function createPixelAssetPresetContents(
  presetId: PixelAssetPresetId,
  level: PixelArtLevel,
  imageModels: readonly ImageModel[],
  placement: {
    nodePosition: { x: number; y: number };
    workflowGroupPosition: { x: number; y: number };
  },
): {
  group?: PixelAssetWorkflowGroup;
  nodes: AssetCanvasNode[];
  outputNodeId: string;
} {
  const needsWorkflowGroup = pixelAssetPresetNeedsWorkflowGroup(presetId);
  const workflowGroupId = needsWorkflowGroup ? crypto.randomUUID() : undefined;
  const generated = createPixelAssetWorkflowNodes(
    presetId,
    level,
    imageModels,
    workflowGroupId,
  );
  const group = needsWorkflowGroup
    ? {
        id: workflowGroupId!,
        type: "group" as const,
        position: placement.workflowGroupPosition,
        width: 1460,
        height: 650,
        data: { name: pixelAssetWorkflowLabel(presetId, level) },
      }
    : undefined;
  const nodes = needsWorkflowGroup
    ? generated.nodes
    : generated.nodes.map((node) => ({
        ...node,
        position: placement.nodePosition,
      }));
  return {
    ...(group ? { group } : {}),
    nodes,
    outputNodeId: generated.outputNodeId,
  };
}

export function pixelArtLevelOptions(): {
  value: PixelArtLevel;
  label: string;
  description: string;
}[] {
  return PIXEL_ART_LEVELS.map((value) => ({
    value,
    label: t(`assetCanvas.pixelPresets.levels.${value}`),
    description: t(`assetCanvas.pixelPresets.levelDescriptions.${value}`),
  }));
}

export function createPixelAssetWorkflowNodes(
  presetId: PixelAssetPresetId,
  level: PixelArtLevel,
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
    node.data.pixelStyle = level;
    if (referenceNodeId)
      node.data.images = [{ type: "node", nodeId: referenceNodeId }];
    if (preset.imagePreset && preset.imagePreset !== "quick-reskin")
      node.data.presetId = preset.imagePreset;
    const exampleImage = pixelPresetExampleId(presetId, level);
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
    person.data.exampleImage = `${level}/character-sheet`;
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
      `${pixelAssetPresetLabel(presetId)} · ${pixelArtLevelLabel(level)}`,
      944,
      withPixelArtLevel(QUICK_RESKIN_DEFAULT_PROMPT, level, "sprite", {
        assetType: "character",
      }),
      [person, clothing],
    );
    return { nodes: [person, clothing, output], outputNodeId: output.id };
  }

  const prompt = preset.action
    ? actionSheetPrompt(preset.action, "", level)
    : preset.imagePreset === "continuous-sequence"
      ? continuousActionsPrompt("", level)
      : canvasImagePresetPrompt(preset.imagePreset, "", "pixel", 1, level);
  const title = `${pixelAssetPresetLabel(presetId)} · ${pixelArtLevelLabel(level)}`;
  const output = makeImage(title, 24, prompt);
  return { nodes: [output], outputNodeId: output.id };
}
