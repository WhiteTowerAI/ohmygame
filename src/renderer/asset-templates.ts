import type { AssetTemplateDefinition, Model3DSource, StudioMode } from "../shared/asset-templates.js";
import { BUILT_IN_ASSET_TEMPLATES } from "../shared/built-in-asset-templates.js";
export type { Model3DSource, StudioMode } from "../shared/asset-templates.js";
import characterModel3D from "./assets/asset-templates/character-model-3d.webp";
import characterSheet from "./assets/asset-templates/character-sheet.webp";
import characterTurnaround from "./assets/asset-templates/character-turnaround.webp";
import cinematicShot from "./assets/asset-templates/cinematic-shot.webp";
import environmentConcept from "./assets/asset-templates/environment-concept.webp";
import gameProp3D from "./assets/asset-templates/game-prop-3d.webp";
import general3D from "./assets/asset-templates/general-3d.webp";
import generalImage from "./assets/asset-templates/general.webp";
import generalVideo from "./assets/asset-templates/general-video.webp";
import propDesign from "./assets/asset-templates/prop-design.webp";
import seamlessLoop from "./assets/asset-templates/seamless-loop.webp";

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
  "character-turnaround": characterTurnaround,
  "environment-concept": environmentConcept,
  "character-sheet": characterSheet,
  "prop-design": propDesign,
  "general-video": generalVideo,
  "cinematic-shot": cinematicShot,
  "seamless-loop": seamlessLoop,
  "general-3d": general3D,
  "game-prop-3d": gameProp3D,
  "character-model-3d": characterModel3D,
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
