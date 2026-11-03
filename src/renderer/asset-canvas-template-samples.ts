import type { AssetCanvasTemplate } from "./asset-canvas-templates.js";
import { templateAssetUrl, templateExampleUrl } from "./template-assets.js";

export type TemplateSample =
  | "animal" | "attack" | "building" | "character-sheet" | "clothing" | "consistent-sequence"
  | "continuous-sequence" | "down" | "hurt" | "icon" | "idle" | "monster" | "portrait" | "prop"
  | "quick-reskin" | "rpg-character" | "run" | "scene" | "side-view-character" | "terrain" | "walk";

const classicExample = (name: string) => templateExampleUrl(`pixel/classic/${name}.webp`);

/**
 * Reference images used to seed new template boards. Legacy boards still refer
 * to these sample keys, so they point at the canonical classic examples.
 */
export const TEMPLATE_SAMPLE_IMAGES: Record<TemplateSample, string> = {
  animal: classicExample("animal"),
  attack: classicExample("attack"),
  building: classicExample("building"),
  "character-sheet": classicExample("character-sheet"),
  clothing: templateExampleUrl("pixel/reference/clothing.webp"),
  "consistent-sequence": classicExample("consistent-sequence"),
  "continuous-sequence": classicExample("continuous-sequence"),
  down: classicExample("down"),
  hurt: classicExample("hurt"),
  icon: classicExample("icon"),
  idle: classicExample("idle"),
  monster: classicExample("monster"),
  portrait: classicExample("portrait"),
  prop: classicExample("prop"),
  "quick-reskin": classicExample("quick-reskin"),
  "rpg-character": classicExample("rpg-character"),
  run: classicExample("run"),
  scene: classicExample("scene"),
  "side-view-character": templateExampleUrl("pixel/reference/character.webp"),
  terrain: classicExample("terrain"),
  walk: classicExample("walk"),
};

/** Cover art kept for introduction nodes saved on older boards. */
export const TEMPLATE_COVER_IMAGES: Record<AssetCanvasTemplate, string> = {
  "pixel-art": templateAssetUrl("examples/pixel-game-materials-cover.webp"),
  "character-sheet": templateAssetUrl("examples/role-reference-cover.webp"),
  "quick-reskin": templateAssetUrl("examples/costume-change.webp"),
  "free-sequence": templateAssetUrl("examples/continuous-footage-cover.webp"),
  "action-set": templateAssetUrl("examples/role-action-cover.webp"),
};
