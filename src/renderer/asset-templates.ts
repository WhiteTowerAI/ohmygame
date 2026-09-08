import type { AssetTemplateDefinition, Model3DSource, StudioMode } from "../shared/asset-templates.js";
import { BUILT_IN_ASSET_TEMPLATES } from "../shared/built-in-asset-templates.js";
export type { Model3DSource, StudioMode } from "../shared/asset-templates.js";
import general3D from "./assets/asset-templates/general-3d.webp";
import generalImage from "./assets/asset-templates/general.webp";
import generalVideo from "./assets/asset-templates/general-video.webp";

export interface AssetTemplate extends AssetTemplateDefinition {
  id: string;
  previewImage?: string;
  source: "builtIn" | "local" | "catalog";
  hasCover?: boolean;
  releaseId?: string;
  publication?: import("../shared/asset-templates.js").LocalAssetTemplate["publication"];
  author?: import("../shared/publish-v1.js").CommunityAuthor;
  stats?: import("../shared/publish-v1.js").CommunityStats;
}

const PREVIEW_IMAGES: Record<string, string> = {
  "general-image": generalImage,
  "general-video": generalVideo,
  "general-3d": general3D,
};

export const ASSET_TEMPLATES: readonly AssetTemplate[] = BUILT_IN_ASSET_TEMPLATES.map((template) => ({
  ...template,
  previewImage: PREVIEW_IMAGES[template.id],
  source: "builtIn",
}));

export function templatesForMode(mode: StudioMode): readonly AssetTemplate[] {
  return ASSET_TEMPLATES.filter((template) => template.mode === mode);
}

export function defaultTemplateForMode(mode: StudioMode): AssetTemplate {
  const template = templatesForMode(mode)[0];
  if (!template) throw new Error(`No asset template configured for ${mode}`);
  return template;
}
