import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  MODEL_3D_POSES,
  MODEL_3D_QUALITIES,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageOutputCount,
  type ImageResolution,
  type Model3DPose,
  type Model3DQuality,
  type VideoAspectRatio,
  type VideoResolution,
} from "./contracts.js";

export type StudioMode = "image" | "video" | "3d";
export type Model3DSource = "text" | "image";

export interface AssetTemplateDefaults {
  imageResolution?: ImageResolution;
  imageAspectRatio?: ImageAspectRatio;
  imageOutputs?: ImageOutputCount;
  videoResolution?: VideoResolution;
  videoAspectRatio?: VideoAspectRatio;
  videoDuration?: number;
  model3DQuality?: Model3DQuality;
  model3DPose?: Model3DPose;
  model3DSource?: Model3DSource;
}

export interface AssetTemplateDefinition {
  mode: StudioMode;
  name: string;
  description: string;
  promptLabel: string;
  promptPlaceholder: string;
  previewTemplateId?: string;
  defaultPrompt?: string;
  defaults?: AssetTemplateDefaults;
}

export interface LocalAssetTemplate extends AssetTemplateDefinition {
  id: string;
  source: "local";
  createdAt: string;
  publication?: {
    templateId: string;
    releaseId: string;
    publishedAt: string;
  };
}

export interface ExploreAssetTemplate extends AssetTemplateDefinition {
  id: string;
  source: "catalog";
  releaseId: string;
  publishedAt: string;
  author: import("./publish-v1.js").CommunityAuthor;
  stats: import("./publish-v1.js").CommunityStats;
}

export interface CreateAssetTemplateRequest extends AssetTemplateDefinition {}

export function isAssetTemplateDefinition(value: unknown): value is AssetTemplateDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const template = value as Partial<AssetTemplateDefinition>;
  if (template.mode !== "image" && template.mode !== "video" && template.mode !== "3d") return false;
  if (!text(template.name, 1, 80) || !text(template.description, 0, 240)) return false;
  if (!text(template.promptLabel, 1, 80) || !text(template.promptPlaceholder, 0, 500)) return false;
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
      && defaults.model3DQuality === undefined && defaults.model3DPose === undefined && defaults.model3DSource === undefined;
  }
  if (template.mode === "video") {
    return defaults.imageResolution === undefined && defaults.imageAspectRatio === undefined && defaults.imageOutputs === undefined
      && defaults.model3DQuality === undefined && defaults.model3DPose === undefined && defaults.model3DSource === undefined;
  }
  return defaults.imageResolution === undefined && defaults.imageAspectRatio === undefined && defaults.imageOutputs === undefined
    && defaults.videoResolution === undefined && defaults.videoAspectRatio === undefined && defaults.videoDuration === undefined;
}

function validDefaults(value: unknown): value is AssetTemplateDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const defaults = value as Record<string, unknown>;
  if (!Object.keys(defaults).every((key) => [
    "imageResolution", "imageAspectRatio", "imageOutputs", "videoResolution", "videoAspectRatio",
    "videoDuration", "model3DQuality", "model3DPose", "model3DSource",
  ].includes(key))) return false;
  return optionalMember(defaults.imageResolution, IMAGE_RESOLUTIONS)
    && optionalMember(defaults.imageAspectRatio, IMAGE_ASPECT_RATIOS)
    && optionalMember(defaults.imageOutputs, IMAGE_OUTPUT_COUNTS)
    && optionalMember(defaults.videoResolution, VIDEO_RESOLUTIONS)
    && optionalMember(defaults.videoAspectRatio, VIDEO_ASPECT_RATIOS)
    && (defaults.videoDuration === undefined || Number.isInteger(defaults.videoDuration) && Number(defaults.videoDuration) >= 1 && Number(defaults.videoDuration) <= 60)
    && optionalMember(defaults.model3DQuality, MODEL_3D_QUALITIES)
    && optionalMember(defaults.model3DPose, MODEL_3D_POSES)
    && optionalMember(defaults.model3DSource, ["text", "image"] as const);
}

function optionalMember<T>(value: unknown, values: readonly T[]): boolean {
  return value === undefined || values.includes(value as T);
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}
