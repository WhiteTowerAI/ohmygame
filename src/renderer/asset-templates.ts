import type { AssetTemplateDefinition, Model3DSource, StudioMode } from "../shared/asset-templates.js";
import { BUILT_IN_ASSET_TEMPLATES } from "../shared/built-in-asset-templates.js";
export type { Model3DSource, StudioMode } from "../shared/asset-templates.js";

export interface AssetTemplate extends AssetTemplateDefinition {
  id: string;
  source: "builtIn" | "local" | "catalog";
  hasCover?: boolean;
  releaseId?: string;
  publication?: import("../shared/asset-templates.js").LocalAssetTemplate["publication"];
  author?: import("../shared/publish-v1.js").CommunityAuthor;
  stats?: import("../shared/publish-v1.js").CommunityStats;
}

export const ASSET_TEMPLATES: readonly AssetTemplate[] = BUILT_IN_ASSET_TEMPLATES.map((template) => ({
  ...template,
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
