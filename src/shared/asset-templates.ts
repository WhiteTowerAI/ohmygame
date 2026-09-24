import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageOutputCount,
  type ImageResolution,
  type VideoAspectRatio,
  type VideoResolution,
} from "./contracts.js";

export type StudioMode = "image" | "video" | "3d";

export interface AssetTemplateDefaults {
  imageResolution?: ImageResolution;
  imageAspectRatio?: ImageAspectRatio;
  imageOutputs?: ImageOutputCount;
  videoResolution?: VideoResolution;
  videoAspectRatio?: VideoAspectRatio;
  videoDuration?: number;
  model3DTargetPolycount?: number;
}

export interface AssetTemplateDefinition {
  mode: StudioMode;
  name: string;
  description: string;
  promptLabel?: string;
  promptPlaceholder: string;
  previewTemplateId?: string;
  defaultPrompt?: string;
  defaults?: AssetTemplateDefaults;
}

export interface LocalAssetTemplate extends AssetTemplateDefinition {
  id: string;
  source: "local";
  createdAt: string;
  hasCover?: boolean;
}

export interface CreateAssetTemplateRequest extends AssetTemplateDefinition {}

export function isAssetTemplateDefinition(value: unknown): value is AssetTemplateDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const template = value as Partial<AssetTemplateDefinition>;
  if (template.mode !== "image" && template.mode !== "video" && template.mode !== "3d") return false;
  if (!text(template.name, 1, 80) || !text(template.description, 0, 240)) return false;
  if (template.promptLabel !== undefined && !text(template.promptLabel, 1, 80)) return false;
  if (!text(template.promptPlaceholder, 0, 500)) return false;
  if (template.previewTemplateId !== undefined && !text(template.previewTemplateId, 1, 80)) return false;
  if (template.defaultPrompt !== undefined && !text(template.defaultPrompt, 0, 4_000)) return false;
  if (template.defaults !== undefined && !validDefaults(template.defaults)) return false;
  if (!Object.keys(template).every((key) => [
    "mode", "name", "description", "promptLabel", "promptPlaceholder", "previewTemplateId", "defaultPrompt", "defaults",
  ].includes(key))) return false;
  const defaults = template.defaults;
  if (!defaults) return true;
  if (template.mode === "image") {
    return defaults.videoResolution === undefined && defaults.videoAspectRatio === undefined && defaults.videoDuration === undefined
      && defaults.model3DTargetPolycount === undefined;
  }
  if (template.mode === "video") {
    return defaults.imageResolution === undefined && defaults.imageAspectRatio === undefined && defaults.imageOutputs === undefined
      && defaults.model3DTargetPolycount === undefined;
  }
  return defaults.imageResolution === undefined && defaults.imageAspectRatio === undefined && defaults.imageOutputs === undefined
    && defaults.videoResolution === undefined && defaults.videoAspectRatio === undefined && defaults.videoDuration === undefined;
}

function validDefaults(value: unknown): value is AssetTemplateDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const defaults = value as Record<string, unknown>;
  if (!Object.keys(defaults).every((key) => [
    "imageResolution", "imageAspectRatio", "imageOutputs", "videoResolution", "videoAspectRatio",
    "videoDuration", "model3DTargetPolycount",
  ].includes(key))) return false;
  return optionalMember(defaults.imageResolution, IMAGE_RESOLUTIONS)
    && optionalMember(defaults.imageAspectRatio, IMAGE_ASPECT_RATIOS)
    && optionalMember(defaults.imageOutputs, IMAGE_OUTPUT_COUNTS)
    && optionalMember(defaults.videoResolution, VIDEO_RESOLUTIONS)
    && optionalMember(defaults.videoAspectRatio, VIDEO_ASPECT_RATIOS)
    && (defaults.videoDuration === undefined || Number.isInteger(defaults.videoDuration) && Number(defaults.videoDuration) >= 1 && Number(defaults.videoDuration) <= 60)
    && (defaults.model3DTargetPolycount === undefined || Number.isInteger(defaults.model3DTargetPolycount)
      && Number(defaults.model3DTargetPolycount) >= 100 && Number(defaults.model3DTargetPolycount) <= 15_000);
}

function optionalMember<T>(value: unknown, values: readonly T[]): boolean {
  return value === undefined || values.includes(value as T);
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}
