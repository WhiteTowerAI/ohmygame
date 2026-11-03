import type { AssetCanvasNode } from "../shared/contracts.js";
import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { PixelAssetPresetId, PixelAssetTemplateCategory } from "./asset-canvas-pixel-workflows.js";
import { effectExampleImageUrl } from "./asset-canvas-effect-examples.js";
import { templateExampleUrl } from "./template-assets.js";

const PIXEL_ART_LEVELS: readonly PixelArtLevel[] = ["coarse", "classic", "detailed"];
const STILL_EXAMPLES = [
  "character-sheet", "rpg-character", "portrait", "monster", "multi-angle", "animal", "scene", "prop", "icon",
  "quick-reskin", "continuous-sequence", "consistent-sequence", "idle", "walk", "run", "attack", "hurt", "down",
  "terrain", "tileset", "building",
];
const ANIMATED_EXAMPLES = ["idle", "walk", "run", "attack", "hurt", "down", "continuous-sequence"];
const REFERENCE_EXAMPLES = ["character", "creature", "scene", "object", "clothing"];

/** Example images, keyed by a stable id that canvas boards persist instead of build-specific URLs. */
const EXAMPLE_IMAGES: Record<string, string> = Object.fromEntries([
  ...PIXEL_ART_LEVELS.flatMap((level) => [
    ...STILL_EXAMPLES.map((name) => [`${level}/${name}`, templateExampleUrl(`pixel/${level}/${name}.webp`)]),
    ...ANIMATED_EXAMPLES.map((name) => [`${level}/${name}.gif`, templateExampleUrl(`pixel/${level}/${name}.gif`)]),
  ]),
  ...REFERENCE_EXAMPLES.map((name) => [`reference/${name}`, templateExampleUrl(`pixel/reference/${name}.webp`)]),
]);

const PRESET_EXAMPLES: Partial<Record<PixelAssetPresetId, string>> = {
  "character-sheet": "character-sheet",
  "rpg-character": "rpg-character",
  portrait: "portrait",
  monster: "monster",
  "multi-angle": "multi-angle",
  animal: "animal",
  scene: "scene",
  prop: "prop",
  icon: "icon",
  "quick-reskin": "quick-reskin",
  "continuous-sequence": "continuous-sequence",
  "consistent-sequence": "consistent-sequence",
  "action:idle": "idle",
  "action:walk": "walk",
  "action:run": "run",
  "action:attack": "attack",
  "action:hurt": "hurt",
  "action:down": "down",
  terrain: "terrain",
  tileset: "tileset",
  building: "building",
};

const TEMPLATE_REFERENCES: Partial<Record<PixelAssetTemplateCategory, string>> = {
  characters: "reference/character",
  creatures: "reference/creature",
  scenes: "reference/scene",
  terrain: "reference/scene",
  objects: "reference/object",
};

export const PIXEL_RESKIN_CLOTHING_EXAMPLE = "reference/clothing";

export function pixelExampleImageUrl(id?: string): string | undefined {
  return id ? EXAMPLE_IMAGES[id] ?? effectExampleImageUrl(id) : undefined;
}

/** Template boards start with bundled examples only; the last generator example stands in as the cover until real media exists. */
export function pixelExampleCoverUrl(nodes: readonly AssetCanvasNode[]): string | undefined {
  const examples = nodes.filter((node): node is Extract<AssetCanvasNode, { type: "image" }> => node.type === "image" && Boolean(pixelExampleImageUrl(node.data.exampleImage)));
  const generators = examples.filter((node) => !node.data.sourceInput);
  return pixelExampleImageUrl((generators.length ? generators : examples).at(-1)?.data.exampleImage);
}

export function pixelPresetExampleId(presetId: PixelAssetPresetId, level: PixelArtLevel): string | undefined {
  const name = PRESET_EXAMPLES[presetId];
  return name ? `${level}/${name}` : undefined;
}

export function pixelPresetPreviewUrl(presetId: PixelAssetPresetId, level: PixelArtLevel): string | undefined {
  return pixelExampleImageUrl(pixelPresetExampleId(presetId, level));
}

export function pixelPresetGifExampleId(presetId: PixelAssetPresetId, level: PixelArtLevel): string | undefined {
  const id = `${level}/${PRESET_EXAMPLES[presetId]}.gif`;
  return EXAMPLE_IMAGES[id] ? id : undefined;
}

/** Falls back to the level's character sheet when a category has no dedicated reference image. */
export function pixelTemplateReferenceExampleId(category: PixelAssetTemplateCategory, level: PixelArtLevel): string {
  return TEMPLATE_REFERENCES[category] ?? `${level}/character-sheet`;
}
