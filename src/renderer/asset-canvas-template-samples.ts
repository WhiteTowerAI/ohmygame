import characterSheet from "./assets/templates/examples/character-sheet.webp";
import sideViewCharacter from "./assets/templates/examples/side-view-character.webp";
import rpgCharacter from "./assets/templates/examples/rpg-character.webp";
import portrait from "./assets/templates/examples/portrait.webp";
import monster from "./assets/templates/examples/monster.webp";
import animal from "./assets/templates/examples/animal.webp";
import scene from "./assets/templates/examples/scene.webp";
import terrain from "./assets/templates/examples/terrain.webp";
import building from "./assets/templates/examples/building.webp";
import prop from "./assets/templates/examples/prop.webp";
import icon from "./assets/templates/examples/icon.webp";
import clothing from "./assets/templates/examples/clothing.webp";
import quickReskin from "./assets/templates/examples/quick-reskin.webp";
import continuousSequence from "./assets/templates/examples/continuous-sequence.webp";
import consistentSequence from "./assets/templates/examples/consistent-sequence.webp";
import idle from "./assets/templates/examples/idle.webp";
import walk from "./assets/templates/examples/walk.webp";
import run from "./assets/templates/examples/run.webp";
import attack from "./assets/templates/examples/attack.webp";
import hurt from "./assets/templates/examples/hurt.webp";
import down from "./assets/templates/examples/down.webp";

/** Shared by template covers, guides, and the images saved into new boards. */
export const TEMPLATE_SAMPLE_IMAGES = {
  "character-sheet": characterSheet,
  "side-view-character": sideViewCharacter,
  "rpg-character": rpgCharacter,
  portrait,
  monster,
  animal,
  scene,
  terrain,
  building,
  prop,
  icon,
  clothing,
  "quick-reskin": quickReskin,
  "continuous-sequence": continuousSequence,
  "consistent-sequence": consistentSequence,
  idle,
  walk,
  run,
  attack,
  hurt,
  down,
} as const;

export type TemplateSample = keyof typeof TEMPLATE_SAMPLE_IMAGES;
