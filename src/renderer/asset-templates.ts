import type { AssetTemplateDefinition, Model3DSource, StudioMode } from "../shared/asset-templates.js";
export type { Model3DSource, StudioMode } from "../shared/asset-templates.js";

export interface AssetTemplate extends AssetTemplateDefinition {
  id: string;
  source: "local" | "catalog";
  hasCover?: boolean;
  releaseId?: string;
  publication?: import("../shared/asset-templates.js").LocalAssetTemplate["publication"];
  author?: import("../shared/publish-v1.js").CommunityAuthor;
  stats?: import("../shared/publish-v1.js").CommunityStats;
}

export const STUDIO_PROMPT_PLACEHOLDERS: Record<StudioMode, string> = {
  image: "A stylized floating island at sunrise, soft volumetric light, game concept art...",
  video: "Describe the scene, motion, and camera movement...",
  "3d": "A stylized wooden treasure chest with iron bands and a hinged lid...",
};
