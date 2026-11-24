import type { AssetCanvasNode, ImageModel } from "../shared/contracts.js";
import { createAssetGenerationNode, preferredImageOption } from "../shared/asset-canvas.js";
import { t } from "./i18n.js";
import { templateExampleUrl } from "./template-assets.js";

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
 * `example` is the file type of the preset's card picture, made with that
 * model and kept at its own pixel size at
 * `template-examples/pixellab/<model>.<example>` on the asset CDN.
 */
const PIXELLAB_PRESETS = [
  { model: "character-4", group: "characters", prompt: "a knight in silver armor with a blue cape", example: "gif" },
  { model: "character-8", group: "characters", prompt: "a young wizard in a purple robe" },
  { model: "character-state", group: "characters", prompt: "wearing a red hooded cloak" },
  { model: "frame-animation", group: "animation", prompt: "walk in place" },
  { model: "interpolation", group: "animation", prompt: "transforming smoothly" },
  { model: "rotations-8", group: "animation", prompt: "" },
  { model: "object", group: "objects", prompt: "a wooden treasure chest with iron bands", example: "png" },
  { model: "object-8", group: "objects", prompt: "a stone fountain" },
  { model: "object-animation", group: "objects", prompt: "opening slowly" },
  { model: "tileset", group: "maps", prompt: "grass | shallow water | sandy shore", example: "png" },
  { model: "tileset-sidescroller", group: "maps", prompt: "mossy stone bricks | grass" },
  { model: "isometric-tile", group: "maps", prompt: "grass on top of dirt" },
  { model: "vfx", group: "effects", prompt: "a blue magic burst with sparkles", example: "gif" },
  { model: "ui", group: "effects", prompt: "a medieval stone button" },
  { model: "to-pixel-art-pro-flash", group: "edits", prompt: "" },
  { model: "remove-background", group: "edits", prompt: "" },
] as const satisfies readonly { model: string; group: PixelLabPresetGroup; prompt: string; example?: "png" | "gif" }[];

export type PixelLabPresetModel = (typeof PIXELLAB_PRESETS)[number]["model"];
export type PixelLabPresetId = `pixellab:${PixelLabPresetModel}`;
export const PIXELLAB_PRESET_GROUPS: readonly PixelLabPresetGroup[] = ["characters", "animation", "objects", "maps", "effects", "edits"];

export type PixelLabPresetAvailability = "ready" | "missing" | "outdated";

/** The PixelLab presets by group, with whether this project can use each one. */
export function pixelLabPresetCatalog(imageModels: readonly ImageModel[]): {
  group: PixelLabPresetGroup;
  label: string;
  presets: { id: PixelLabPresetId; label: string; description: string; previewUrl?: string; availability: PixelLabPresetAvailability; needsReference: boolean }[];
}[] {
  return PIXELLAB_PRESET_GROUPS.map((group) => ({
    group,
    label: t(`assetCanvas.presets.pixellab.groups.${group}`),
    presets: PIXELLAB_PRESETS.filter((preset) => preset.group === group).map((preset) => {
      const id = `pixellab:${preset.model}` as const;
      const model = pixelLabModel(id, imageModels);
      const example = "example" in preset ? preset.example : undefined;
      return {
        id,
        label: t(`assetCanvas.presets.pixellab.presets.${preset.model}.label`),
        description: t(`assetCanvas.presets.pixellab.presets.${preset.model}.description`),
        ...(example ? { previewUrl: templateExampleUrl(`pixellab/${preset.model}.${example}`) } : {}),
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
  node.title = t(`assetCanvas.presets.pixellab.presets.${preset.model}.label`);
  node.data.prompt = preset.prompt;
  node.data.promptExpanded = true;
  return node;
}
