import type { AssetCanvasTemplate } from "./asset-canvas-templates.js";
import { templateAssetUrl } from "./template-assets.js";

/** Cover art kept for introduction nodes saved on older boards. */
export const TEMPLATE_COVER_IMAGES: Record<AssetCanvasTemplate, string> = {
  "pixel-art": templateAssetUrl("examples/pixel-game-materials-cover.webp"),
  "character-sheet": templateAssetUrl("examples/role-reference-cover.webp"),
  "quick-reskin": templateAssetUrl("examples/costume-change.webp"),
  "free-sequence": templateAssetUrl("examples/continuous-footage-cover.webp"),
  "action-set": templateAssetUrl("examples/role-action-cover.webp"),
};
