import type { AssetCanvasTemplate } from "./asset-canvas-templates.js";
import characterSheet from "./assets/templates/examples/role-reference-cover.webp";
import pixelGameMaterials from "./assets/templates/examples/pixel-game-materials-cover.webp";
import costumeChange from "./assets/templates/examples/costume-change.webp";
import continuousFootage from "./assets/templates/examples/continuous-footage-cover.webp";
import roleActions from "./assets/templates/examples/role-action-cover.webp";

/** Cover art kept for introduction nodes saved on older boards. */
export const TEMPLATE_COVER_IMAGES: Record<AssetCanvasTemplate, string> = {
  "pixel-art": pixelGameMaterials,
  "character-sheet": characterSheet,
  "quick-reskin": costumeChange,
  "free-sequence": continuousFootage,
  "action-set": roleActions,
};
