import type { AssetTemplateDefinition } from "./asset-templates.js";
import type { CommunityAuthor } from "./publish-v1.js";

export interface BuiltInAssetTemplate extends AssetTemplateDefinition {
  id: string;
  releaseId: string;
  publishedAt: string;
}

export const OPEN_GAME_TEMPLATE_AUTHOR: CommunityAuthor = { id: "opengame", displayName: "OpenGame" };

const PUBLISHED_AT = "2026-09-06T00:00:00.000Z";

export const BUILT_IN_ASSET_TEMPLATES: readonly BuiltInAssetTemplate[] = [
  {
    id: "general-image", releaseId: "general-image-v1", publishedAt: PUBLISHED_AT,
    mode: "image", name: "General Image", description: "A flexible starting point for any visual asset.",
    promptPlaceholder: "A stylized floating island at sunrise, soft volumetric light, game concept art...",
    defaults: { imageResolution: "1K", imageAspectRatio: "1:1", imageOutputs: 1 },
  },
  {
    id: "general-video", releaseId: "general-video-v1", publishedAt: PUBLISHED_AT,
    mode: "video", name: "General Video", description: "A flexible starting point for motion generation.",
    promptPlaceholder: "Describe the scene, motion, and camera movement...",
    defaults: { videoResolution: "720p", videoAspectRatio: "adaptive", videoDuration: 6 },
  },
  {
    id: "general-3d", releaseId: "general-3d-v1", publishedAt: PUBLISHED_AT,
    mode: "3d", name: "General 3D Model", description: "A balanced starting point for a textured model.",
    promptPlaceholder: "A stylized wooden treasure chest with iron bands and a hinged lid...",
    defaults: { model3DModel: "meshy-t2", model3DTargetPolycount: 4_000, model3DPose: "auto", model3DSource: "image" },
  },
];
