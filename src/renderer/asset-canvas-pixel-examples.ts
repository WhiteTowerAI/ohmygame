import type { AssetCanvasNode } from "../shared/contracts.js";
import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { PixelAssetPresetId, PixelAssetTemplateCategory } from "./asset-canvas-pixel-workflows.js";

// Coarse
import coarseCharacterSheet from "./assets/templates/examples/coarse/character-sheet.webp";
import coarseRpgCharacter from "./assets/templates/examples/coarse/rpg-character.webp";
import coarsePortrait from "./assets/templates/examples/coarse/portrait.webp";
import coarseMonster from "./assets/templates/examples/coarse/monster.webp";
import coarseMultiAngle from "./assets/templates/examples/coarse/multi-angle.webp";
import coarseAnimal from "./assets/templates/examples/coarse/animal.webp";
import coarseScene from "./assets/templates/examples/coarse/scene.webp";
import coarseProp from "./assets/templates/examples/coarse/prop.webp";
import coarseIcon from "./assets/templates/examples/coarse/icon.webp";
import coarseQuickReskin from "./assets/templates/examples/coarse/quick-reskin.webp";
import coarseContinuousSequence from "./assets/templates/examples/coarse/continuous-sequence.webp";
import coarseConsistentSequence from "./assets/templates/examples/coarse/consistent-sequence.webp";
import coarseIdle from "./assets/templates/examples/coarse/idle.webp";
import coarseWalk from "./assets/templates/examples/coarse/walk.webp";
import coarseRun from "./assets/templates/examples/coarse/run.webp";
import coarseAttack from "./assets/templates/examples/coarse/attack.webp";
import coarseHurt from "./assets/templates/examples/coarse/hurt.webp";
import coarseDown from "./assets/templates/examples/coarse/down.webp";
import coarseTerrain from "./assets/templates/examples/coarse/terrain.webp";
import coarseTileset from "./assets/templates/examples/coarse/tileset.webp";
import coarseBuilding from "./assets/templates/examples/coarse/building.webp";
import coarseIdleGif from "./assets/templates/examples/coarse/idle.gif";
import coarseWalkGif from "./assets/templates/examples/coarse/walk.gif";
import coarseRunGif from "./assets/templates/examples/coarse/run.gif";
import coarseAttackGif from "./assets/templates/examples/coarse/attack.gif";
import coarseHurtGif from "./assets/templates/examples/coarse/hurt.gif";
import coarseDownGif from "./assets/templates/examples/coarse/down.gif";
import coarseContinuousSequenceGif from "./assets/templates/examples/coarse/continuous-sequence.gif";

// Classic
import classicCharacterSheet from "./assets/templates/examples/classic/character-sheet.webp";
import classicRpgCharacter from "./assets/templates/examples/classic/rpg-character.webp";
import classicPortrait from "./assets/templates/examples/classic/portrait.webp";
import classicMonster from "./assets/templates/examples/classic/monster.webp";
import classicMultiAngle from "./assets/templates/examples/classic/multi-angle.webp";
import classicAnimal from "./assets/templates/examples/classic/animal.webp";
import classicScene from "./assets/templates/examples/classic/scene.webp";
import classicProp from "./assets/templates/examples/classic/prop.webp";
import classicIcon from "./assets/templates/examples/classic/icon.webp";
import classicQuickReskin from "./assets/templates/examples/classic/quick-reskin.webp";
import classicContinuousSequence from "./assets/templates/examples/classic/continuous-sequence.webp";
import classicConsistentSequence from "./assets/templates/examples/classic/consistent-sequence.webp";
import classicIdle from "./assets/templates/examples/classic/idle.webp";
import classicWalk from "./assets/templates/examples/classic/walk.webp";
import classicRun from "./assets/templates/examples/classic/run.webp";
import classicAttack from "./assets/templates/examples/classic/attack.webp";
import classicHurt from "./assets/templates/examples/classic/hurt.webp";
import classicDown from "./assets/templates/examples/classic/down.webp";
import classicTerrain from "./assets/templates/examples/classic/terrain.webp";
import classicTileset from "./assets/templates/examples/classic/tileset.webp";
import classicBuilding from "./assets/templates/examples/classic/building.webp";
import classicIdleGif from "./assets/templates/examples/classic/idle.gif";
import classicWalkGif from "./assets/templates/examples/classic/walk.gif";
import classicRunGif from "./assets/templates/examples/classic/run.gif";
import classicAttackGif from "./assets/templates/examples/classic/attack.gif";
import classicHurtGif from "./assets/templates/examples/classic/hurt.gif";
import classicDownGif from "./assets/templates/examples/classic/down.gif";
import classicContinuousSequenceGif from "./assets/templates/examples/classic/continuous-sequence.gif";

// Detailed
import detailedCharacterSheet from "./assets/templates/examples/detailed/character-sheet.webp";
import detailedRpgCharacter from "./assets/templates/examples/detailed/rpg-character.webp";
import detailedPortrait from "./assets/templates/examples/detailed/portrait.webp";
import detailedMonster from "./assets/templates/examples/detailed/monster.webp";
import detailedMultiAngle from "./assets/templates/examples/detailed/multi-angle.webp";
import detailedAnimal from "./assets/templates/examples/detailed/animal.webp";
import detailedScene from "./assets/templates/examples/detailed/scene.webp";
import detailedProp from "./assets/templates/examples/detailed/prop.webp";
import detailedIcon from "./assets/templates/examples/detailed/icon.webp";
import detailedQuickReskin from "./assets/templates/examples/detailed/quick-reskin.webp";
import detailedContinuousSequence from "./assets/templates/examples/detailed/continuous-sequence.webp";
import detailedConsistentSequence from "./assets/templates/examples/detailed/consistent-sequence.webp";
import detailedIdle from "./assets/templates/examples/detailed/idle.webp";
import detailedWalk from "./assets/templates/examples/detailed/walk.webp";
import detailedRun from "./assets/templates/examples/detailed/run.webp";
import detailedAttack from "./assets/templates/examples/detailed/attack.webp";
import detailedHurt from "./assets/templates/examples/detailed/hurt.webp";
import detailedDown from "./assets/templates/examples/detailed/down.webp";
import detailedTerrain from "./assets/templates/examples/detailed/terrain.webp";
import detailedTileset from "./assets/templates/examples/detailed/tileset.webp";
import detailedBuilding from "./assets/templates/examples/detailed/building.webp";
import detailedIdleGif from "./assets/templates/examples/detailed/idle.gif";
import detailedWalkGif from "./assets/templates/examples/detailed/walk.gif";
import detailedRunGif from "./assets/templates/examples/detailed/run.gif";
import detailedAttackGif from "./assets/templates/examples/detailed/attack.gif";
import detailedHurtGif from "./assets/templates/examples/detailed/hurt.gif";
import detailedDownGif from "./assets/templates/examples/detailed/down.gif";
import detailedContinuousSequenceGif from "./assets/templates/examples/detailed/continuous-sequence.gif";

import referenceCharacter from "./assets/templates/examples/reference/character.webp";
import referenceCreature from "./assets/templates/examples/reference/creature.webp";
import referenceScene from "./assets/templates/examples/reference/scene.webp";
import referenceObject from "./assets/templates/examples/reference/object.webp";
import referenceClothing from "./assets/templates/examples/reference/clothing.webp";

/** Bundled example images, keyed by a stable id that canvas boards persist instead of build-specific URLs. */
const EXAMPLE_IMAGES: Record<string, string> = {
  "coarse/character-sheet": coarseCharacterSheet,
  "coarse/rpg-character": coarseRpgCharacter,
  "coarse/portrait": coarsePortrait,
  "coarse/monster": coarseMonster,
  "coarse/multi-angle": coarseMultiAngle,
  "coarse/animal": coarseAnimal,
  "coarse/scene": coarseScene,
  "coarse/prop": coarseProp,
  "coarse/icon": coarseIcon,
  "coarse/quick-reskin": coarseQuickReskin,
  "coarse/continuous-sequence": coarseContinuousSequence,
  "coarse/consistent-sequence": coarseConsistentSequence,
  "coarse/idle": coarseIdle,
  "coarse/walk": coarseWalk,
  "coarse/run": coarseRun,
  "coarse/attack": coarseAttack,
  "coarse/hurt": coarseHurt,
  "coarse/down": coarseDown,
  "coarse/terrain": coarseTerrain,
  "coarse/tileset": coarseTileset,
  "coarse/building": coarseBuilding,
  "coarse/idle.gif": coarseIdleGif,
  "coarse/walk.gif": coarseWalkGif,
  "coarse/run.gif": coarseRunGif,
  "coarse/attack.gif": coarseAttackGif,
  "coarse/hurt.gif": coarseHurtGif,
  "coarse/down.gif": coarseDownGif,
  "coarse/continuous-sequence.gif": coarseContinuousSequenceGif,
  "classic/character-sheet": classicCharacterSheet,
  "classic/rpg-character": classicRpgCharacter,
  "classic/portrait": classicPortrait,
  "classic/monster": classicMonster,
  "classic/multi-angle": classicMultiAngle,
  "classic/animal": classicAnimal,
  "classic/scene": classicScene,
  "classic/prop": classicProp,
  "classic/icon": classicIcon,
  "classic/quick-reskin": classicQuickReskin,
  "classic/continuous-sequence": classicContinuousSequence,
  "classic/consistent-sequence": classicConsistentSequence,
  "classic/idle": classicIdle,
  "classic/walk": classicWalk,
  "classic/run": classicRun,
  "classic/attack": classicAttack,
  "classic/hurt": classicHurt,
  "classic/down": classicDown,
  "classic/terrain": classicTerrain,
  "classic/tileset": classicTileset,
  "classic/building": classicBuilding,
  "classic/idle.gif": classicIdleGif,
  "classic/walk.gif": classicWalkGif,
  "classic/run.gif": classicRunGif,
  "classic/attack.gif": classicAttackGif,
  "classic/hurt.gif": classicHurtGif,
  "classic/down.gif": classicDownGif,
  "classic/continuous-sequence.gif": classicContinuousSequenceGif,
  "detailed/character-sheet": detailedCharacterSheet,
  "detailed/rpg-character": detailedRpgCharacter,
  "detailed/portrait": detailedPortrait,
  "detailed/monster": detailedMonster,
  "detailed/multi-angle": detailedMultiAngle,
  "detailed/animal": detailedAnimal,
  "detailed/scene": detailedScene,
  "detailed/prop": detailedProp,
  "detailed/icon": detailedIcon,
  "detailed/quick-reskin": detailedQuickReskin,
  "detailed/continuous-sequence": detailedContinuousSequence,
  "detailed/consistent-sequence": detailedConsistentSequence,
  "detailed/idle": detailedIdle,
  "detailed/walk": detailedWalk,
  "detailed/run": detailedRun,
  "detailed/attack": detailedAttack,
  "detailed/hurt": detailedHurt,
  "detailed/down": detailedDown,
  "detailed/terrain": detailedTerrain,
  "detailed/tileset": detailedTileset,
  "detailed/building": detailedBuilding,
  "detailed/idle.gif": detailedIdleGif,
  "detailed/walk.gif": detailedWalkGif,
  "detailed/run.gif": detailedRunGif,
  "detailed/attack.gif": detailedAttackGif,
  "detailed/hurt.gif": detailedHurtGif,
  "detailed/down.gif": detailedDownGif,
  "detailed/continuous-sequence.gif": detailedContinuousSequenceGif,
  "reference/character": referenceCharacter,
  "reference/creature": referenceCreature,
  "reference/scene": referenceScene,
  "reference/object": referenceObject,
  "reference/clothing": referenceClothing,
};

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
  return id ? EXAMPLE_IMAGES[id] : undefined;
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
