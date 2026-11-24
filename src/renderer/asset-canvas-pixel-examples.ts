import type { AssetCanvasNode } from "../shared/contracts.js";
import { PIXEL_ART_LEVELS, type PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { PixelAssetPresetId } from "./asset-canvas-pixel-workflows.js";
import { effectExampleImageUrl } from "./asset-canvas-effect-examples.js";
import { templateExampleUrl } from "./template-assets.js";

/** New nodes use the examples drawn on the classic grid, the one pixel style presets use. */
const EXAMPLE_LEVEL: PixelArtLevel = "classic";
const STILL_EXAMPLES = [
  "character-sheet", "rpg-character", "portrait", "monster", "multi-angle", "animal", "scene", "prop", "icon",
  "quick-reskin", "continuous-sequence", "consistent-sequence", "idle", "walk", "run", "attack", "hurt", "down",
  "terrain", "tileset", "building",
];
const ANIMATED_EXAMPLES = ["idle", "walk", "run", "attack", "hurt", "down", "continuous-sequence"];
const REFERENCE_EXAMPLES = ["character", "creature", "scene", "object", "clothing"];

/** Example images, keyed by a stable id that canvas boards persist instead of build-specific URLs. */
// compat: since beta.5.11, remove from beta.7 and 2026-12-24. Canvases from
// before then also show coarse and detailed examples; new nodes use classic.
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

export function pixelPresetExampleId(presetId: PixelAssetPresetId): string | undefined {
  const name = PRESET_EXAMPLES[presetId];
  return name ? `${EXAMPLE_LEVEL}/${name}` : undefined;
}

export function pixelPresetPreviewUrl(presetId: PixelAssetPresetId): string | undefined {
  return pixelExampleImageUrl(pixelPresetExampleId(presetId));
}

export function pixelPresetGifExampleId(presetId: PixelAssetPresetId): string | undefined {
  const id = `${EXAMPLE_LEVEL}/${PRESET_EXAMPLES[presetId]}.gif`;
  return EXAMPLE_IMAGES[id] ? id : undefined;
}

