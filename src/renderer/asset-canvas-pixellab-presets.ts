import type { AssetCanvasNode, ImageModel } from "../shared/contracts.js";
import { createAssetGenerationNode, preferredImageOption } from "../shared/asset-canvas.js";
import { t } from "./i18n.js";
import { templateExampleUrl } from "./template-assets.js";

/** The PixelLab plugin's image provider, as plugin providers are named. */
export const PIXELLAB_PROVIDER = "plugin.ohmygame.pixellab.pixellab";
export const PIXELLAB_PLUGIN = "ohmygame/pixellab";

/**
 * A few PixelLab models, one for each job and each with an example, from the
 * PixelLab plugin. They are named and ordered after PixelLab's own API page
 * rather than grouped; the plugin's other models stay in the model picker. Each makes an
 * ordinary Image node with that model, so a board stores nothing new. The
 * prompt is a starting example in English, as models are sent English.
 * `example` is the file type of the preset's card picture, made with that
 * model and kept at its own pixel size at
 * `template-examples/pixellab/<model>.<example>` on the asset CDN.
 */
const PIXELLAB_PRESETS = [
  { model: "pixflux", prompt: "a knight in silver armor with a blue cape standing in a sunny green meadow", example: "png" },
  { model: "object", prompt: "a wooden treasure chest with iron bands", example: "png" },
  { model: "object-8", prompt: "a stone fountain", example: "gif" },
  { model: "character-4", prompt: "a knight in silver armor with a blue cape", example: "gif" },
  { model: "character-8", prompt: "a young wizard in a purple robe", example: "gif" },
  { model: "character-state", prompt: "wearing a red hooded cloak", example: "gif" },
  { model: "rotations-8", prompt: "", example: "gif" },
  { model: "frame-animation", prompt: "walk in place", example: "gif" },
  { model: "object-animation", prompt: "opening slowly", example: "gif" },
  { model: "vfx", prompt: "a blue magic burst with sparkles", example: "gif" },
  { model: "tileset", prompt: "grass | shallow water | sandy shore", example: "png" },
  { model: "tileset-sidescroller", prompt: "mossy stone bricks | grass", example: "png" },
  { model: "isometric-tile", prompt: "grass on top of dirt", example: "png" },
  { model: "ui", prompt: "a medieval stone button", example: "png" },
  { model: "to-pixel-art-pro-flash", prompt: "", example: "png" },
  { model: "remove-background", prompt: "", example: "png" },
] as const satisfies readonly { model: string; prompt: string; example: "png" | "gif" }[];

export type PixelLabPresetModel = (typeof PIXELLAB_PRESETS)[number]["model"];
export type PixelLabPresetId = `pixellab:${PixelLabPresetModel}`;

export type PixelLabPresetAvailability = "ready" | "missing" | "outdated";

/** The PixelLab presets in order, with whether this project can use each one. */
export function pixelLabPresetCatalog(imageModels: readonly ImageModel[]): {
  id: PixelLabPresetId;
  label: string;
  description: string;
  previewUrl: string;
  availability: PixelLabPresetAvailability;
  needsReference: boolean;
}[] {
  return PIXELLAB_PRESETS.map((preset) => {
    const id = `pixellab:${preset.model}` as const;
    const model = pixelLabModel(id, imageModels);
    return {
      id,
      label: t(`assetCanvas.presets.pixellab.presets.${preset.model}.label`),
      description: t(`assetCanvas.presets.pixellab.presets.${preset.model}.description`),
      previewUrl: templateExampleUrl(`pixellab/${preset.model}.${preset.example}`),
      availability: pixelLabPresetAvailability(id, imageModels),
      needsReference: (model?.minReferenceImages ?? 0) > 0,
    };
  });
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
