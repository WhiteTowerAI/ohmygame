import type { LocalAssetTemplate, Model3DSource, StudioMode } from "../shared/asset-templates.js";
export type { Model3DSource, StudioMode } from "../shared/asset-templates.js";

export type AssetTemplate = LocalAssetTemplate;

export const STUDIO_PROMPT_PLACEHOLDERS: Record<StudioMode, string> = {
  image: "A stylized floating island at sunrise, soft volumetric light, game concept art...",
  video: "Describe the scene, motion, and camera movement...",
  "3d": "A stylized wooden treasure chest with iron bands and a hinged lid...",
};
