import type { AssetCanvasTemplate } from "./asset-canvas-templates.js";
import characterSheet from "./assets/templates/examples/role-reference-cover.webp";
import pixelGameMaterials from "./assets/templates/examples/pixel-game-materials-cover.webp";
import costumeChange from "./assets/templates/examples/costume-change.webp";
import continuousFootage from "./assets/templates/examples/continuous-footage-cover.webp";
import roleActions from "./assets/templates/examples/role-action-cover.webp";
import animal from "./assets/templates/examples/animal.webp";
import attack from "./assets/templates/examples/attack.webp";
import building from "./assets/templates/examples/building.webp";
import characterSheetSample from "./assets/templates/examples/character-sheet.webp";
import clothing from "./assets/templates/examples/clothing.webp";
import consistentSequence from "./assets/templates/examples/consistent-sequence.webp";
import continuousSequence from "./assets/templates/examples/continuous-sequence.webp";
import down from "./assets/templates/examples/down.webp";
import hurt from "./assets/templates/examples/hurt.webp";
import icon from "./assets/templates/examples/icon.webp";
import idle from "./assets/templates/examples/idle.webp";
import monster from "./assets/templates/examples/monster.webp";
import portrait from "./assets/templates/examples/portrait.webp";
import prop from "./assets/templates/examples/prop.webp";
import quickReskin from "./assets/templates/examples/quick-reskin.webp";
import rpgCharacter from "./assets/templates/examples/rpg-character.webp";
import run from "./assets/templates/examples/run.webp";
import scene from "./assets/templates/examples/scene.webp";
import sideViewCharacter from "./assets/templates/examples/side-view-character.webp";
import terrain from "./assets/templates/examples/terrain.webp";
import walk from "./assets/templates/examples/walk.webp";

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
