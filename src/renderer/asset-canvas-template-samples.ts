import type { AssetCanvasTemplate } from "./asset-canvas-templates.js";
import characterSheet from "./assets/templates/examples/role-reference-cover.webp";
import pixelGameMaterials from "./assets/templates/examples/pixel-game-materials-cover.webp";
import costumeChange from "./assets/templates/examples/costume-change.webp";
import continuousFootage from "./assets/templates/examples/continuous-footage-cover.webp";
import roleActions from "./assets/templates/examples/role-action-cover.webp";
// Legacy boards still refer to these sample keys. Keep the imports pointed at
// the canonical examples introduced with the density-based template layout.
import animal from "./assets/templates/examples/classic/animal.webp";
import attack from "./assets/templates/examples/classic/attack.webp";
import building from "./assets/templates/examples/classic/building.webp";
import characterSheetSample from "./assets/templates/examples/classic/character-sheet.webp";
import clothing from "./assets/templates/examples/reference/clothing.webp";
import consistentSequence from "./assets/templates/examples/classic/consistent-sequence.webp";
import continuousSequence from "./assets/templates/examples/classic/continuous-sequence.webp";
import down from "./assets/templates/examples/classic/down.webp";
import hurt from "./assets/templates/examples/classic/hurt.webp";
import icon from "./assets/templates/examples/classic/icon.webp";
import idle from "./assets/templates/examples/classic/idle.webp";
import monster from "./assets/templates/examples/classic/monster.webp";
import portrait from "./assets/templates/examples/classic/portrait.webp";
import prop from "./assets/templates/examples/classic/prop.webp";
import quickReskin from "./assets/templates/examples/classic/quick-reskin.webp";
import rpgCharacter from "./assets/templates/examples/classic/rpg-character.webp";
import run from "./assets/templates/examples/classic/run.webp";
import scene from "./assets/templates/examples/classic/scene.webp";
import sideViewCharacter from "./assets/templates/examples/reference/character.webp";
import terrain from "./assets/templates/examples/classic/terrain.webp";
import walk from "./assets/templates/examples/classic/walk.webp";

export type TemplateSample =
  | "animal" | "attack" | "building" | "character-sheet" | "clothing" | "consistent-sequence"
  | "continuous-sequence" | "down" | "hurt" | "icon" | "idle" | "monster" | "portrait" | "prop"
  | "quick-reskin" | "rpg-character" | "run" | "scene" | "side-view-character" | "terrain" | "walk";

/** Reference images used to seed new template boards. */
export const TEMPLATE_SAMPLE_IMAGES: Record<TemplateSample, string> = {
  animal, attack, building, "character-sheet": characterSheetSample, clothing,
  "consistent-sequence": consistentSequence, "continuous-sequence": continuousSequence,
  down, hurt, icon, idle, monster, portrait, prop, "quick-reskin": quickReskin,
  "rpg-character": rpgCharacter, run, scene, "side-view-character": sideViewCharacter, terrain, walk,
};

/** Cover art kept for introduction nodes saved on older boards. */
export const TEMPLATE_COVER_IMAGES: Record<AssetCanvasTemplate, string> = {
  "pixel-art": pixelGameMaterials,
  "character-sheet": characterSheet,
  "quick-reskin": costumeChange,
  "free-sequence": continuousFootage,
  "action-set": roleActions,
};
