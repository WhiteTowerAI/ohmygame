import type {
  AssetCanvasDocument,
  AssetCanvasNode,
  ImageModel,
} from "../shared/contracts.js";
import { withPixelArtLevel, type PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { CANVAS_IMAGE_PRESETS, QUICK_RESKIN_DEFAULT_PROMPT, canvasImagePresetPrompt, type CanvasImagePreset } from "../shared/canvas-image-presets.js";
import { preferredCharacterSheetOption } from "../shared/canvas-character-tools.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
  EFFECT_SPRITE_SHEET_SAFE_MARGIN_PROMPT,
  preferredImageOption,
} from "../shared/asset-canvas.js";
import { createProject, deleteLibraryAsset, deleteProject, getProjectCover, listImageModels, setProjectCover, uploadLibraryAsset } from "./api.js";
import { effectLibraryCoverForLevel } from "./asset-canvas-effect-covers.js";
import effectFireHitSheet from "./assets/templates/examples/effect-fire-hit-sheet.webp";
import effectFireHitPreview from "./assets/templates/examples/effect-fire-hit-preview.gif";
import coarseEffectFireHitSheet from "./assets/templates/examples/effects/coarse/fire-hit-sheet.webp";
import coarseEffectFireHitPreview from "./assets/templates/examples/effects/coarse/fire-hit-preview.gif";
import detailedEffectFireHitSheet from "./assets/templates/examples/effects/detailed/fire-hit-sheet.webp";
import detailedEffectFireHitPreview from "./assets/templates/examples/effects/detailed/fire-hit-preview.gif";
import effectIceImpactSheet from "./assets/templates/examples/effect-ice-impact-sheet.webp";
import effectIceImpactPreview from "./assets/templates/examples/effect-ice-impact-preview.gif";
import coarseEffectIceImpactSheet from "./assets/templates/examples/effects/coarse/ice-impact-sheet.webp";
import coarseEffectIceImpactPreview from "./assets/templates/examples/effects/coarse/ice-impact-preview.gif";
import detailedEffectIceImpactSheet from "./assets/templates/examples/effects/detailed/ice-impact-sheet.webp";
import detailedEffectIceImpactPreview from "./assets/templates/examples/effects/detailed/ice-impact-preview.gif";
import effectWaveImpactSheet from "./assets/templates/examples/effect-wave-impact-sheet.webp";
import effectWaveImpactPreview from "./assets/templates/examples/effect-wave-impact-preview.gif";
import coarseEffectWaveImpactSheet from "./assets/templates/examples/effects/coarse/wave-impact-sheet.webp";
import coarseEffectWaveImpactPreview from "./assets/templates/examples/effects/coarse/wave-impact-preview.gif";
import detailedEffectWaveImpactSheet from "./assets/templates/examples/effects/detailed/wave-impact-sheet.webp";
import detailedEffectWaveImpactPreview from "./assets/templates/examples/effects/detailed/wave-impact-preview.gif";
import effectWaterSplashSheet from "./assets/templates/examples/effect-water-splash-sheet.webp";
import effectWaterSplashPreview from "./assets/templates/examples/effect-water-splash-preview.gif";
import coarseEffectWaterSplashSheet from "./assets/templates/examples/effects/coarse/water-splash-sheet.webp";
import coarseEffectWaterSplashPreview from "./assets/templates/examples/effects/coarse/water-splash-preview.gif";
import detailedEffectWaterSplashSheet from "./assets/templates/examples/effects/detailed/water-splash-sheet.webp";
import detailedEffectWaterSplashPreview from "./assets/templates/examples/effects/detailed/water-splash-preview.gif";
import effectElectricOrbBurstSheet from "./assets/templates/examples/effect-electric-orb-burst-sheet.webp";
import effectElectricOrbBurstPreview from "./assets/templates/examples/effect-electric-orb-burst-preview.gif";
import coarseEffectElectricOrbBurstSheet from "./assets/templates/examples/effects/coarse/electric-orb-burst-sheet.webp";
import coarseEffectElectricOrbBurstPreview from "./assets/templates/examples/effects/coarse/electric-orb-burst-preview.gif";
import detailedEffectElectricOrbBurstSheet from "./assets/templates/examples/effects/detailed/electric-orb-burst-sheet.webp";
import detailedEffectElectricOrbBurstPreview from "./assets/templates/examples/effects/detailed/electric-orb-burst-preview.gif";
import effectLightningStrikeSheet from "./assets/templates/examples/effect-lightning-strike-sheet.webp";
import effectLightningStrikePreview from "./assets/templates/examples/effect-lightning-strike-preview.gif";
import coarseEffectLightningStrikeSheet from "./assets/templates/examples/effects/coarse/lightning-strike-sheet.webp";
import coarseEffectLightningStrikePreview from "./assets/templates/examples/effects/coarse/lightning-strike-preview.gif";
import detailedEffectLightningStrikeSheet from "./assets/templates/examples/effects/detailed/lightning-strike-sheet.webp";
import detailedEffectLightningStrikePreview from "./assets/templates/examples/effects/detailed/lightning-strike-preview.gif";
import effectIceClawSlashSheet from "./assets/templates/examples/effect-ice-claw-slash-sheet.webp";
import effectIceClawSlashPreview from "./assets/templates/examples/effect-ice-claw-slash-preview.gif";
import coarseEffectIceClawSlashSheet from "./assets/templates/examples/effects/coarse/ice-claw-slash-sheet.webp";
import coarseEffectIceClawSlashPreview from "./assets/templates/examples/effects/coarse/ice-claw-slash-preview.gif";
import detailedEffectIceClawSlashSheet from "./assets/templates/examples/effects/detailed/ice-claw-slash-sheet.webp";
import detailedEffectIceClawSlashPreview from "./assets/templates/examples/effects/detailed/ice-claw-slash-preview.gif";
import effectElectricTrailSheet from "./assets/templates/examples/effect-electric-trail-sheet.webp";
import effectElectricTrailPreview from "./assets/templates/examples/effect-electric-trail-preview.gif";
import coarseEffectElectricTrailSheet from "./assets/templates/examples/effects/coarse/electric-trail-sheet.webp";
import coarseEffectElectricTrailPreview from "./assets/templates/examples/effects/coarse/electric-trail-preview.gif";
import detailedEffectElectricTrailSheet from "./assets/templates/examples/effects/detailed/electric-trail-sheet.webp";
import detailedEffectElectricTrailPreview from "./assets/templates/examples/effects/detailed/electric-trail-preview.gif";
import effectBlueWhiteCrescentSlashSheet from "./assets/templates/examples/effect-blue-white-crescent-slash-sheet.webp";
import effectBlueWhiteCrescentSlashPreview from "./assets/templates/examples/effect-blue-white-crescent-slash-preview.gif";
import coarseEffectBlueWhiteCrescentSlashSheet from "./assets/templates/examples/effects/coarse/blue-white-crescent-slash-sheet.webp";
import coarseEffectBlueWhiteCrescentSlashPreview from "./assets/templates/examples/effects/coarse/blue-white-crescent-slash-preview.gif";
import detailedEffectBlueWhiteCrescentSlashSheet from "./assets/templates/examples/effects/detailed/blue-white-crescent-slash-sheet.webp";
import detailedEffectBlueWhiteCrescentSlashPreview from "./assets/templates/examples/effects/detailed/blue-white-crescent-slash-preview.gif";
import effectSmokeDispersalSheet from "./assets/templates/examples/effect-smoke-dispersal-sheet.webp";
import effectSmokeDispersalPreview from "./assets/templates/examples/effect-smoke-dispersal-preview.gif";
import coarseEffectSmokeDispersalSheet from "./assets/templates/examples/effects/coarse/smoke-dispersal-sheet.webp";
import coarseEffectSmokeDispersalPreview from "./assets/templates/examples/effects/coarse/smoke-dispersal-preview.gif";
import detailedEffectSmokeDispersalSheet from "./assets/templates/examples/effects/detailed/smoke-dispersal-sheet.webp";
import detailedEffectSmokeDispersalPreview from "./assets/templates/examples/effects/detailed/smoke-dispersal-preview.gif";
import effectGreenEnergyWaveSheet from "./assets/templates/examples/effect-green-energy-wave-sheet.webp";
import effectGreenEnergyWavePreview from "./assets/templates/examples/effect-green-energy-wave-preview.gif";
import coarseEffectGreenEnergyWaveSheet from "./assets/templates/examples/effects/coarse/green-energy-wave-sheet.webp";
import coarseEffectGreenEnergyWavePreview from "./assets/templates/examples/effects/coarse/green-energy-wave-preview.gif";
import detailedEffectGreenEnergyWaveSheet from "./assets/templates/examples/effects/detailed/green-energy-wave-sheet.webp";
import detailedEffectGreenEnergyWavePreview from "./assets/templates/examples/effects/detailed/green-energy-wave-preview.gif";
import effectWaterOrbMagicSheet from "./assets/templates/examples/effect-water-orb-magic-sheet.webp";
import effectWaterOrbMagicPreview from "./assets/templates/examples/effect-water-orb-magic-preview.gif";
import coarseEffectWaterOrbMagicSheet from "./assets/templates/examples/effects/coarse/water-orb-magic-sheet.webp";
import coarseEffectWaterOrbMagicPreview from "./assets/templates/examples/effects/coarse/water-orb-magic-preview.gif";
import detailedEffectWaterOrbMagicSheet from "./assets/templates/examples/effects/detailed/water-orb-magic-sheet.webp";
import detailedEffectWaterOrbMagicPreview from "./assets/templates/examples/effects/detailed/water-orb-magic-preview.gif";
import { TEMPLATE_SAMPLE_IMAGES, type TemplateSample } from "./asset-canvas-template-samples.js";
import { PIXEL_ASSET_TEMPLATE_NOTE } from "./asset-canvas-pixel-workflows.js";
import {
  changeCanvasBoard,
  createCanvasBoard,
  deleteCanvasBoard,
  getCanvasBoard,
  getCanvasWorkspace,
  saveCanvasBoard,
} from "./canvas-api.js";
import { t } from "./i18n.js";

export const ASSET_CANVAS_TEMPLATES = [
  "pixel-art",
  "character-sheet",
  "quick-reskin",
  "free-sequence",
  "action-set",
] as const;
export type AssetCanvasTemplate = (typeof ASSET_CANVAS_TEMPLATES)[number];

export function templateGuideInfo(instruction?: string): { template: AssetCanvasTemplate } | undefined {
  const legacy = instruction === "asset-canvas-template:free-image" || instruction === "asset-canvas-template:free-image:pixel"
    ? "pixel-art"
    : instruction === "asset-canvas-template:free-image:general" ? "character-sheet" : undefined;
  const template = legacy ?? ASSET_CANVAS_TEMPLATES.find((candidate) => instruction === `asset-canvas-template:${candidate}`);
  return template ? { template } : undefined;
}

const SEQUENCE_PRESETS = ["continuous-sequence", "consistent-sequence"] as const;
const PIXEL_IMAGE_PRESETS = CANVAS_IMAGE_PRESETS.filter((preset) => !["free", "continuous-sequence", "consistent-sequence", "character-sheet", "quick-reskin"].includes(preset));
const PIXEL_CATEGORIES = [
  { key: "characters", presets: ["side-view-character", "rpg-character", "portrait"] },
  { key: "creatures", presets: ["monster", "animal"] },
  { key: "environments", presets: ["scene", "terrain", "building"] },
  { key: "items", presets: ["prop", "icon"] },
] as const;

export function templateImagePresets(template?: AssetCanvasTemplate): readonly CanvasImagePreset[] {
  if (template === "free-sequence") return SEQUENCE_PRESETS;
  if (template === "pixel-art") return PIXEL_IMAGE_PRESETS;
  if (template === "character-sheet") return ["character-sheet"];
  if (template === "quick-reskin") return ["quick-reskin"];
  if (template === "action-set") return [];
  return CANVAS_IMAGE_PRESETS;
}

export function createTemplatePresetNode(
  template: Exclude<AssetCanvasTemplate, "action-set">,
  preset: CanvasImagePreset,
  imageModels: readonly ImageModel[],
  position: { x: number; y: number },
  sourceNodeId?: string,
): Extract<AssetCanvasNode, { type: "image" }> {
  const model = template === "pixel-art" || template === "free-sequence" || template === "quick-reskin"
    ? imageModels.find((candidate) => candidate.supportsReferenceImage && (candidate.maxReferenceImages ?? 16) >= (template === "quick-reskin" || template === "pixel-art" ? 2 : 1))
    : imageModels[0];
  const option = preset === "character-sheet"
    ? preferredCharacterSheetOption(model)
    : preferredImageOption(model, template === "free-sequence" ? "4:3" : "1:1");
  const node = createAssetGenerationNode("image", position, {
    ...(model ? { imageModel: { provider: model.provider, id: model.id } } : {}),
    ...(option ? { imageResolution: option.resolution, imageAspectRatio: option.aspectRatio } : {}),
  }) as Extract<AssetCanvasNode, { type: "image" }>;
  node.title = t(`assetCanvas.imagePresets.${preset}`);
  node.data.presetId = preset;
  if (sourceNodeId) node.data.images = [{ type: "node", nodeId: sourceNodeId }];
  return node;
}

export interface AssetCanvasTemplateInput {
  prompt?: string;
  sourceAssetId?: string;
}

/** The Effect Library creates one image node: its output is a complete sprite sheet, not a GIF. */
export interface EffectSpriteSheetInput {
  name: string;
  prompt: string;
  framePlan: string;
}

const EFFECT_LIBRARY_PRESETS = [
  { category: "fire", name: "火焰命中", frames: "4 × 3 · 12 帧", prompt: "Create one complete 4-column by 3-row sprite sheet for a compact pixel-art fire impact. Read cells left to right, top to bottom: ignition, expanding flame burst, scattered sparks, fading embers. Transparent background, no labels, no borders, fixed center." },
  { category: "fire", name: "火球凝聚发射 V7", frames: "4 × 4 · 16 帧", prompt: "Create one complete 4-column by 4-row sprite sheet for a pixel-art fireball charge and launch. Read cells left to right, top to bottom: sparks gather, fireball forms, projectile flies with a tapered trail, embers dissipate. Transparent background, no labels, no borders, fixed center." },
  { category: "water", name: "双层水纹", frames: "4 × 3 · 12 帧", prompt: "Create one complete 4-column by 3-row sprite sheet for two expanding pixel-art water ripples. Read cells left to right, top to bottom: two rings appear, expand independently, soften, and fade. Transparent background, no labels, no borders, fixed center." },
  { category: "ice", name: "冰块掉落砸击", frames: "4 × 4 · 16 帧", prompt: "Create one complete 4-column by 4-row sprite sheet for a pixel-art ice block falling and shattering. Read cells left to right, top to bottom: ice block enters, falls, impacts, fractures, shards scatter, and frost fades. Transparent background, no labels, no borders, fixed ground point." },
  { category: "ice", name: "冰墙", frames: "4 × 3 · 12 帧", prompt: "Create one complete 4-column by 3-row sprite sheet for a pixel-art ice wall rising from the ground. Read cells left to right, top to bottom: frost gathers, ice spikes rise, wall locks into place, particles settle. Transparent background, no labels, no borders, fixed ground baseline." },
  { category: "lightning", name: "雷电落击", frames: "4 × 3 · 12 帧", prompt: "Create one complete 4-column by 3-row sprite sheet for a pixel-art lightning strike. Read cells left to right, top to bottom: charge glow, bolt descends, impact branches, residual sparks fade. Transparent background, no labels, no borders, fixed impact point." },
  { category: "general", name: "烟团消散", frames: "4 × 3 · 12 帧", prompt: "Create one complete 4-column by 3-row sprite sheet for a pixel-art smoke puff dispersing. Read cells left to right, top to bottom: smoke appears, expands, separates into wisps, then fades away. Transparent background, no labels, no borders, fixed center." },
] as const;

const EFFECT_LIBRARY_EXAMPLE_PROMPT = `Requested action: pixel-art fire impact animation in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: original orange, yellow, red, and dark-brown fire palette

Motion rhythm: balanced buildup, brightest peak, then a clean fade-out

Additional direction:
Create exactly one square sheet with exactly 12 equal-sized cells, read left to right and top to bottom. Every cell must have the same transparent background, identical camera framing, identical scale, and one fixed ground-impact point at the bottom center. Do not add borders, grid lines, labels, text, UI, characters, weapons, scenery, or extra effects. Do not leave any cell empty.

Frame 1: a tiny orange ignition spark on the ground.
Frame 2: a small flame emerges.
Frame 3: the flame grows with a few glowing debris pixels.
Frame 4: a taller flame expands outward.
Frame 5: the first compact fiery burst.
Frame 6: the brightest and largest explosion peak, white-yellow core and orange-red flame.
Frame 7: the burst recedes, with debris moving outward.
Frame 8: a smaller collapsing fire burst with a glowing hot core.
Frame 9: fading flame and scattered ember chunks.
Frame 10: a small diminishing ground flame.
Frame 11: sparse floating embers above a faint glow.
Frame 12: only a few tiny fading embers over the fixed ground point.

Style: crisp 2D fantasy game pixel art, limited orange, yellow, red, and dark-brown palette, hard pixel edges, no blur. Each cell must show one clearly distinct consecutive moment of the same animation. Transparent background.`;

const EFFECT_LIBRARY_ICE_EXAMPLE_PROMPT = `Requested action: blue ice impact animation in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: icy cyan, bright blue, and white highlights

Motion rhythm: quick and forceful

Additional direction:
Frame 1: tiny cyan spark.
Frame 2: small ice crystal appears.
Frame 3: more crystals form.
Frame 4: ice burst expands upward.
Frame 5: sharp ice shards erupt outward.
Frame 6: largest bright blue-white ice explosion.
Frame 7: burst collapses.
Frame 8: shards fall.
Frame 9: glow fades.
Frame 10: small remaining crystal.
Frame 11: sparse frost particles.
Frame 12: faint glow and tiny particles.

Transparent background. Hard pixel edges. No blur. Keep every frame fully inside its own cell with at least 10% transparent padding.`;

const EFFECT_LIBRARY_WAVE_EXAMPLE_PROMPT = `Requested action: a powerful ocean wave impact animation in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: deep ocean blue, turquoise, cyan, and bright white foam highlights

Motion rhythm: fast and forceful wave movement, explosive impact, followed by a smooth retreat

Additional direction:
Frame 1: a small blue wave begins forming from the left side.
Frame 2: the wave grows taller with a curved crest.
Frame 3: the wave moves forward and gathers energy.
Frame 4: the crest rises and curls inward.
Frame 5: the wave surges toward the center with bright foam.
Frame 6: the main wave crashes forward in a powerful impact.
Frame 7: the largest splash expands outward with multiple foam arcs.
Frame 8: water droplets and foam scatter around the impact point.
Frame 9: the wave begins collapsing and flowing back.
Frame 10: the splash becomes smaller with several falling droplets.
Frame 11: only a low wave, foam fragments, and small droplets remain.
Frame 12: faint foam and a few tiny water particles fade out.

Transparent background. Hard pixel edges. No blur. Keep every frame fully inside its own cell with at least 10% transparent padding.`;

const EFFECT_LIBRARY_WATER_SPLASH_EXAMPLE_PROMPT = `Requested action: a water droplet splash impact animation in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: bright cyan, electric blue, deep blue, and white water highlights

Motion rhythm: quick impact, energetic splash expansion, then a smooth collapse and fade-out

Additional direction:
Frame 1: a tiny glowing blue water droplet falls from above.
Frame 2: the droplet moves downward toward the fixed impact point.
Frame 3: the droplet hits and creates a tiny circular splash.
Frame 4: a small water ring expands outward.
Frame 5: several short water arcs rise from the impact point.
Frame 6: the splash grows upward with bright cyan highlights.
Frame 7: the largest splash bursts outward with multiple droplets.
Frame 8: the splash reaches its widest shape with scattered droplets.
Frame 9: the outer arcs begin falling back toward the center.
Frame 10: the water collapses into a smaller circular splash.
Frame 11: only a few droplets and ripples remain.
Frame 12: tiny fading droplets disappear above a faint blue ripple.

Transparent background. Hard pixel edges. No blur. Keep every frame fully inside its own cell with at least 10% transparent padding.`;

const EFFECT_LIBRARY_ELECTRIC_ORB_EXAMPLE_PROMPT = `Requested action: a spinning electric orb that bursts into lightning fragments in a 3-column by 4-row Sprite Sheet (12 frames)

Main color: bright cyan, electric blue, deep indigo, and white energy highlights

Motion rhythm: gradual charge-up, sudden burst, then a smooth electric fade-out

Additional direction:
Frame 1: a tiny glowing blue spark appears at the center.
Frame 2: two small electric particles begin orbiting the center.
Frame 3: a small cyan energy core forms.
Frame 4: the orb grows with a thin rotating electric ring.
Frame 5: the orb becomes brighter and several lightning arcs appear.
Frame 6: the orb reaches maximum charge with a white-blue core.
Frame 7: the orb violently bursts into branching lightning bolts.
Frame 8: electric fragments scatter outward from the center.
Frame 9: the fragments begin slowing down while small arcs remain.
Frame 10: the central glow collapses into a smaller blue spark.
Frame 11: only a few cyan particles and short electric arcs remain.
Frame 12: faint blue sparks fade out completely.

Transparent background. Hard pixel edges. No blur. Keep every frame fully inside its own cell with at least 10% transparent padding.`;

const EFFECT_LIBRARY_LIGHTNING_STRIKE_EXAMPLE_PROMPT = `Requested action: a lightning strike impact animation in a 5-column by 2-row Sprite Sheet (10 frames)

Main color: electric blue, violet, cyan, and white-hot highlights

Motion rhythm: extremely fast buildup, explosive impact, then rapid dissipation

Additional direction:
Frame 1: a tiny blue electrical spark appears above the fixed ground point.
Frame 2: thin electric branches begin forming downward.
Frame 3: several small lightning arcs gather around the impact point.
Frame 4: a bright lightning bolt starts descending from above.
Frame 5: the main lightning bolt strikes the ground with a white-blue flash.
Frame 6: the largest electric explosion expands outward with branching arcs.
Frame 7: the impact contracts while sparks scatter in every direction.
Frame 8: smaller electric arcs flicker around the fading impact point.
Frame 9: only a few floating blue sparks remain.
Frame 10: tiny fading particles disappear above the ground point.

Transparent background. Hard pixel edges. No blur. Keep every frame fully inside its own cell with at least 10% transparent padding.`;

const EFFECT_LIBRARY_ICE_CLAW_EXAMPLE_PROMPT = `Requested action: a three-claw ice slash animation with each slash oriented diagonally from the upper-right toward the lower-left in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: icy cyan, bright blue, deep navy, and white frozen highlights

Motion rhythm: fast wind-up, sharp three-claw slash, brief hold, then a crystalline fade-out

Important composition rule: the upper-right to lower-left direction describes only the diagonal orientation of the three claw marks. The complete effect must remain centered and stationary inside every individual cell. Do not move the effect from one corner of a cell to another. Do not create a slash path that crosses a cell boundary.

Additional direction:
Frame 1: a tiny centered icy glint.
Frame 2: three tiny diagonal frost marks begin forming.
Frame 3: three short parallel claw marks appear, oriented upper-right to lower-left.
Frame 4: the three claws extend slightly while remaining centered.
Frame 5: three sharp parallel ice slashes appear at medium size.
Frame 6: the complete three-claw strike reaches its largest size, fully inside the cell.
Frame 7: ice shards scatter around the centered claw marks.
Frame 8: the slash trails begin slowing while frozen fragments remain.
Frame 9: the three marks crack and begin fading.
Frame 10: only shorter glowing claw traces remain.
Frame 11: sparse ice particles and tiny blue fragments drift away.
Frame 12: faint diagonal frost lines disappear completely.

Transparent background. Hard pixel edges. No blur. No characters, weapons, scenery, text, borders, grid lines, or UI. Keep exactly three clearly separated claw marks. Keep every frame fully inside its own cell with at least 15% transparent padding on all four sides. Keep the effect within the central 70% of each cell. No claw, particle, glow, or ice fragment may touch, cross, or be clipped by a cell boundary. Keep identical camera framing, scale, center point, and diagonal orientation in every frame.`;

const EFFECT_LIBRARY_ELECTRIC_TRAIL_EXAMPLE_PROMPT = `Requested action: an electric dash with a glowing lightning trail animation in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: electric blue, cyan, violet, and white-hot highlights

Motion rhythm: extremely fast acceleration, sharp forward dash, stretched trail, then rapid dissipation

Important composition rule: the left-to-right direction describes the orientation of the dash and its trail, not movement across the entire cell. The complete effect must remain centered inside every individual cell. Do not move the effect from the left edge to the right edge of a cell. Do not let the bolt or trail cross any cell boundary.

Additional direction:
Frame 1: a tiny centered electric spark.
Frame 2: a compact blue energy core forms at the center.
Frame 3: short lightning arcs gather behind the core.
Frame 4: a small horizontal electric trail appears behind the centered core.
Frame 5: the core brightens and the trail becomes longer toward the left.
Frame 6: the centered energy bolt reaches maximum brightness with a white core.
Frame 7: a wide cyan-blue lightning trail extends toward the left while the bolt remains inside the center area.
Frame 8: the trail breaks into branching electric fragments around the centered bolt.
Frame 9: the main bolt fades while several short horizontal arcs remain.
Frame 10: scattered sparks remain along a short leftward trail.
Frame 11: only a few tiny blue particles remain near the center.
Frame 12: the final electric sparks fade out completely.

Transparent background. Hard pixel edges. No blur. No characters, weapons, scenery, text, borders, grid lines, or UI. Keep every frame fully inside its own cell with at least 15% transparent padding on all four sides. Keep the effect within the central 70% of each cell. No lightning branch, particle, glow, or trail may touch, cross, or be clipped by a cell boundary. Keep identical camera framing, scale, center point, and motion direction in every frame.`;

const EFFECT_LIBRARY_BLUE_WHITE_CRESCENT_EXAMPLE_PROMPT = `Requested action: a blue-white crescent energy slash sweeping along a curved path from the upper-right area toward the lower-right area of each cell in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: bright cyan, electric blue, deep navy, and white-hot highlights

Motion rhythm: fast initiation, smooth curved downward sweep, strong mid-swing peak, then rapid dissipation

Important motion rule: this is one single crescent-shaped slash, not a straight projectile and not a stationary effect. The crescent starts near the upper-right area, travels downward along the right side in a curved arc, and ends near the lower-right area. The motion path must stay inside the same cell and must never cross a cell boundary.

Additional direction:
Frame 1: a tiny blue-white crescent appears near the upper-right area.
Frame 2: the crescent grows slightly and begins sliding downward.
Frame 3: the curved blade moves diagonally downward along the right side.
Frame 4: the crescent becomes larger while continuing its downward arc.
Frame 5: the blade reaches the right-center area with a bright cyan inner edge.
Frame 6: the slash reaches maximum size and brightness during the middle of the curved sweep.
Frame 7: the crescent continues sliding toward the lower-right area.
Frame 8: the arc begins shrinking while maintaining the same curved path.
Frame 9: the blade becomes thinner and leaves blue-white particles behind.
Frame 10: a smaller crescent remains near the lower-right area.
Frame 11: only a short curved fragment and scattered blue particles remain.
Frame 12: the final particles fade out near the lower-right area.

Transparent background. Hard pixel edges. No blur. No characters, weapons, scenery, text, borders, grid lines, or UI. Use exactly one crescent-shaped slash. Keep the full effect at least 15% away from all cell boundaries. No blade, glow, trail, or particle may touch, cross, or be clipped by a cell boundary. Keep identical camera framing, scale, and cell layout in every frame.`;

const EFFECT_LIBRARY_SMOKE_EXAMPLE_PROMPT = `Requested action: a gray smoke puff dispersal animation in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: soft gray, dark gray, light gray, and subtle white-gray highlights

Motion rhythm: quick appearance, gradual expansion, brief dense peak, then loose outward dispersal and fade-out

Additional direction:
Frame 1: a single tiny gray smoke particle appears at the center.
Frame 2: a small three-lobed gray smoke puff forms.
Frame 3: the smoke puff grows slightly with several rounded smoke blobs.
Frame 4: more gray smoke blobs gather into a compact cluster.
Frame 5: the smoke becomes larger and denser with overlapping rounded puffs.
Frame 6: the smoke cluster reaches its maximum size and density.
Frame 7: the outer smoke blobs begin separating from the main cluster.
Frame 8: several gray smoke chunks drift outward in different directions.
Frame 9: the smoke breaks into smaller scattered fragments.
Frame 10: only a few small gray smoke particles remain.
Frame 11: sparse tiny particles fade around the center.
Frame 12: the final smoke particles disappear completely.

Transparent background. Crisp 2D fantasy game pixel art. Hard pixel edges. Softly rounded pixel clusters. No blur, scenery, characters, text, borders, grid lines, or UI. Keep the smoke centered inside each cell. Do not move the entire effect across the cell. Keep every frame fully inside its own cell with at least 15% transparent padding on all four sides. Keep the smoke within the central 70% of each cell. No smoke blob or particle may touch, cross, or be clipped by a cell boundary. Keep identical camera framing, scale, and center point in every frame.`;

const EFFECT_LIBRARY_GREEN_ENERGY_WAVE_EXAMPLE_PROMPT = `Requested action: a green energy wave charging, expanding, and dissipating animation in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: neon green, emerald green, deep green, lime green, and pale yellow-green highlights

Motion rhythm: scattered energy fragments gather inward, form a rotating vortex, compress into a bright orb, expand into a circular wave ring, then break apart and fade

Additional direction:
Frame 1: scattered green particles and short curved energy fragments float around the center.
Frame 2: more green fragments begin spiraling inward toward the center.
Frame 3: several curved green energy strokes gather into a loose clockwise vortex.
Frame 4: the vortex tightens into a dense rotating green spiral with a bright center.
Frame 5: the spiral compresses into a compact glowing green energy orb.
Frame 6: the orb grows larger with a pale yellow-green core and a dark emerald rim.
Frame 7: the orb reaches maximum brightness and size, with layered circular energy bands.
Frame 8: the orb opens into a bright circular energy ring with a transparent center.
Frame 9: the ring expands slightly and begins breaking into uneven green arc segments.
Frame 10: the ring becomes incomplete, with separated glowing fragments around the perimeter.
Frame 11: only sparse green particles and small curved fragments remain.
Frame 12: the final green sparks fade out completely.

Transparent background. Crisp 2D fantasy game pixel art. Hard pixel edges. No blur, no characters, no weapons, no scenery, no text, no borders, no grid lines, and no UI. Keep the effect centered in every cell. Keep every frame fully inside its own cell with at least 15% transparent padding on all four sides. Keep the effect within the central 70% of each cell. No particle, arc, ring, or orb may touch, cross, or be clipped by a cell boundary. Keep identical camera framing, scale, and center point in every frame.`;

const EFFECT_LIBRARY_WATER_ORB_MAGIC_EXAMPLE_PROMPT = `Requested action: a blue water orb magic launch and dispersal animation in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: aqua blue, bright cyan, deep ocean blue, navy blue, and white watery highlights

Motion rhythm: tiny droplets gather, form a rotating water orb, charge briefly, launch toward the left, split into droplets, then disperse and fade

Additional direction:
Frame 1: a tiny blue water droplet appears at the center.
Frame 2: several small blue droplets gather around the center and begin moving inward.
Frame 3: the droplets condense into a small rounded water cluster with a bright core.
Frame 4: the cluster becomes a compact blue water orb with a dark-blue outer rim.
Frame 5: the orb becomes smooth and spherical with a bright cyan highlight and internal swirl.
Frame 6: the orb rotates and pulses while maintaining a stable circular shape.
Frame 7: the orb reaches maximum charge with stronger white-blue highlights and a dense inner spiral.
Frame 8: the orb launches from right to left, stretching into a comet-like water shape.
Frame 9: the water projectile elongates leftward and begins breaking into curved droplets.
Frame 10: the main water mass separates into multiple blue droplets and splash fragments.
Frame 11: scattered droplets drift outward along the former launch path.
Frame 12: the final tiny droplets fade out completely.

Transparent background. Crisp 2D fantasy game pixel art. Hard pixel edges. Clean rounded water shapes. No blur, no characters, no weapons, no scenery, no text, no borders, no grid lines, and no UI. Keep the effect centered before launch, then keep the leftward motion fully inside each cell. Keep every frame fully inside its own cell with at least 15% transparent padding on all four sides. Keep the effect within the central 70% of each cell. No orb, droplet, splash, or particle may touch, cross, or be clipped by a cell boundary. Keep identical scale and camera framing in every frame. The launch direction must remain consistently from right to left.`;

const EFFECT_LIBRARY_CATEGORIES = ["fire", "water", "ice", "lightning", "general"] as const;

async function uploadTemplateSample(sample: TemplateSample): Promise<string> {
  const response = await fetch(TEMPLATE_SAMPLE_IMAGES[sample]);
  if (!response.ok) throw new Error(`Could not load the template example: ${sample}`);
  const file = new File([await response.blob()], `${sample}.webp`, { type: "image/webp" });
  return (await uploadLibraryAsset(file, "image/webp", undefined, "reference")).id;
}

async function uploadEffectExample(source: string, name: string, contentType: "image/webp" | "image/gif"): Promise<string> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Could not load the Effect Library example: ${name}`);
  return (await uploadLibraryAsset(new File([await response.blob()], name, { type: contentType }), contentType, undefined, "reference")).id;
}

async function applyEffectLibraryCover(projectId: string, level: PixelArtLevel = "classic"): Promise<void> {
  const response = await fetch(effectLibraryCoverForLevel(level));
  if (!response.ok) throw new Error("Could not load the Effect Library cover");
  await setProjectCover(projectId, await response.blob());
}

/** Adds the template cover to Effect Library projects created before covers were introduced. */
export async function backfillEffectLibraryCover(projectId: string): Promise<void> {
  if (await getProjectCover(projectId)) return;
  await applyEffectLibraryCover(projectId);
}

const ACTIONS = [
  { key: "idle", label: "idle", loop: true },
  { key: "walk", label: "walking", loop: true },
  { key: "run", label: "running", loop: true },
  { key: "attack", label: "attacking", loop: false },
  { key: "hurt", label: "taking damage", loop: false },
  { key: "down", label: "falling down", loop: false },
] as const;

export function createAssetCanvasTemplateDocument(
  template: AssetCanvasTemplate,
  imageModels: readonly ImageModel[],
  input: AssetCanvasTemplateInput = {},
): { document: AssetCanvasDocument; focusNodeId: string; outputNodeIds: string[]; sampleImages: Map<string, TemplateSample> } {
  const document = createAssetCanvasDocument();
  const sampleImages = new Map<string, TemplateSample>();
  document.editorLayout.viewport = { x: 24, y: 100, zoom: 0.75 };
  const guide: AssetCanvasNode = {
    id: crypto.randomUUID(),
    type: "text",
    title: t(`assetCanvasTemplates.${template}.title`),
    position: { x: 40, y: 80 },
    width: template === "action-set" ? 400 : 480,
    data: {
      text: t(`assetCanvasTemplates.${template}.guide`),
      instruction: `asset-canvas-template:${template}`,
    },
  };
  const nodes: AssetCanvasNode[] = [guide];
  const outputNodeIds: string[] = [];
  const prompt = input.prompt?.trim() ?? "";
  const imageModel =
    (template === "character-sheet" && !input.sourceAssetId
      ? imageModels[0]
      : imageModels.find(
          (model) =>
            model.supportsReferenceImage && model.maxReferenceImages !== 0,
        ));
  const imageOption = template === "character-sheet"
    ? preferredCharacterSheetOption(imageModel)
    : preferredImageOption(imageModel, template === "pixel-art" || template === "quick-reskin" ? "1:1" : "4:3");

  function imageNode(
    x: number,
    y: number,
  ): Extract<AssetCanvasNode, { type: "image" }> {
    return createAssetGenerationNode(
      "image",
      { x, y },
      {
        ...(imageModel
          ? { imageModel: { provider: imageModel.provider, id: imageModel.id } }
          : {}),
        ...(imageOption
          ? {
              imageResolution: imageOption.resolution,
              imageAspectRatio: imageOption.aspectRatio,
            }
          : {}),
      },
    ) as Extract<AssetCanvasNode, { type: "image" }>;
  }

  function finish(focusNodeId: string) {
    const examples = nodes.filter((node) => node.id !== guide.id);
    const roots = examples.filter((node) => !node.parentId);
    const left = Math.min(...roots.map((node) => node.position.x)) - 28;
    const top = Math.min(...roots.map((node) => node.position.y)) - 54;
    // Leave room for the largest media preview and its label; cards size to content.
    const right = Math.max(...roots.map((node) => node.position.x + (node.width ?? 440))) + 28;
    const bottom = Math.max(...roots.map((node) => node.position.y + (node.height ?? 400))) + 28;
    const group: AssetCanvasNode = {
      id: crypto.randomUUID(),
      type: "group",
      position: { x: left, y: top },
      width: Math.max(500, right - left),
      height: Math.max(400, bottom - top),
      data: { name: t("assetCanvasTemplates.examplesGroup") },
    };
    document.nodes = [guide, group, ...examples.map((node) => ({
      ...node,
      parentId: node.parentId ?? group.id,
      position: node.parentId ? node.position : { x: node.position.x - left, y: node.position.y - top },
    }))];
    document.editorLayout.nodes = Object.fromEntries(document.nodes.map((node) => [
      node.id,
      { ...node.position, ...(node.width ? { width: node.width } : {}), ...(node.height ? { height: node.height } : {}) },
    ]));
    return { document, focusNodeId, outputNodeIds, sampleImages };
  }

  function referenceNode(): AssetCanvasNode {
    const title = t(template === "quick-reskin" ? "assetCanvasTemplates.quickReskinSource" : "assetCanvasTemplates.reference");
    if (input.sourceAssetId) return {
      id: crypto.randomUUID(),
      type: "asset",
      title,
      position: { x: 560, y: 80 },
      data: { assetId: input.sourceAssetId, mediaType: "image" },
    };
    const node = imageNode(560, 80);
    node.title = title;
    node.data.sourceInput = true;
    if (template === "quick-reskin") node.data.sourceInputLabel = t("assetCanvasTemplates.quickReskinPerson");
    sampleImages.set(node.id, "character-sheet");
    return node;
  }

  if (template === "pixel-art") {
    const source = referenceNode();
    const style = imageNode(1080, 80);
    style.title = t("assetCanvasTemplates.styleReference");
    style.data.sourceInput = true;
    style.data.sourceInputLabel = style.title;
    sampleImages.set(style.id, "rpg-character");
    nodes.push(source, style);
    for (const [row, category] of PIXEL_CATEGORIES.entries()) {
      const group: AssetCanvasNode = {
        id: crypto.randomUUID(), type: "group",
        position: { x: 560, y: 700 + row * 700 },
        width: 1536, height: 640,
        data: { name: t(`assetCanvasTemplates.pixel-art.categories.${category.key}`) },
      };
      nodes.push(group);
      for (const [column, preset] of category.presets.entries()) {
        const image = createTemplatePresetNode(template, preset, imageModels, { x: 28 + column * 520, y: 54 }, source.id);
        image.parentId = group.id;
        image.data.images = [{ type: "node", nodeId: source.id }, { type: "node", nodeId: style.id }];
        image.data.prompt = `${canvasImagePresetPrompt(preset, prompt, "pixel", 2)}\n\nUse the first reference for character identity or subject details where relevant. Use the second reference only for palette, pixel scale, shading, and visual style; do not copy its subject into unrelated assets.`;
        image.data.promptExpanded = true;
        sampleImages.set(image.id, preset);
        nodes.push(image);
        outputNodeIds.push(image.id);
      }
    }
    return finish(outputNodeIds[0]!);
  }

  if (template === "character-sheet") {
    const image = createTemplatePresetNode(template, "character-sheet", imageModels, { x: 560, y: 80 });
    image.data.prompt = canvasImagePresetPrompt("character-sheet", prompt, undefined, 0);
    image.data.promptExpanded = true;
    sampleImages.set(image.id, "character-sheet");
    nodes.push(image);
    outputNodeIds.push(image.id);
    return finish(outputNodeIds[0]!);
  }

  const source = referenceNode();
  nodes.push(source);

  if (template === "quick-reskin") {
    const image = createTemplatePresetNode(template, "quick-reskin", imageModels, { x: 1100, y: 80 }, source.id);
    image.data.quickReskinMode = "person-clothing";
    image.data.prompt = prompt || QUICK_RESKIN_DEFAULT_PROMPT;
    const clothingSource = imageNode(560, 700);
    clothingSource.title = t("assetCanvasTemplates.quickReskinClothing");
    clothingSource.data.sourceInput = true;
    clothingSource.data.sourceInputLabel = t("assetCanvasTemplates.quickReskinClothing");
    sampleImages.set(clothingSource.id, "clothing");
    sampleImages.set(image.id, "quick-reskin");
    nodes.push(clothingSource);
    image.data.images = [
      { type: "node", nodeId: source.id },
      { type: "node", nodeId: clothingSource.id },
    ];
    nodes.push(image);
    outputNodeIds.push(image.id);
  } else if (template === "free-sequence") {
    for (const [index, preset] of SEQUENCE_PRESETS.entries()) {
      const sequence = createTemplatePresetNode("free-sequence", preset, imageModels, { x: 1100 + (index % 2) * 520, y: 80 + Math.floor(index / 2) * 640 }, source.id);
      sequence.data.prompt = canvasImagePresetPrompt(preset, prompt, undefined, 1);
      sequence.data.promptExpanded = true;
      sampleImages.set(sequence.id, preset);
      nodes.push(sequence);
      outputNodeIds.push(sequence.id);
    }
  } else {
    for (const [index, action] of ACTIONS.entries()) {
      const image = imageNode(
        1100 + (index % 3) * 520,
        80 + Math.floor(index / 3) * 640,
      );
      image.title = t(`assetCanvasTemplates.actions.${action.key}`);
      sampleImages.set(image.id, action.key);
      image.data.images = [{ type: "node", nodeId: source.id }];
      image.data.prompt = `Use the supplied image as the exact character reference. Create one sprite sheet showing 12 successive frames of the character ${action.label}, arranged in a 3-row by 4-column grid, read left to right. Keep the same face, outfit, colors, proportions, scale, and camera angle in every frame. Use equal-sized cells, consistent baselines, a plain background, and no labels or extra characters. ${action.loop ? "Make the last frame transition smoothly to the first." : "Show a complete action progression from start to finish; do not loop the last frame to the first."}${prompt ? ` Additional direction: ${prompt}` : ""}`;
      nodes.push(image);
      outputNodeIds.push(image.id);
    }
  }

  return finish(source.id);
}

export async function createAssetCanvasTemplateProject(
  template: AssetCanvasTemplate,
  input: AssetCanvasTemplateInput = {},
): Promise<{ projectId: string; boardId: string; nodeId: string; outputNodeIds: string[] }> {
  const imageModels = await listImageModels().catch(() => []);
  const project = await createProject({
    type: "asset-canvas",
    name: t(`assetCanvasTemplates.${template}.title`),
  });
  const sampleAssetIds = new Map<TemplateSample, string>();
  try {
    const { document, focusNodeId, outputNodeIds, sampleImages } = createAssetCanvasTemplateDocument(
      template,
      imageModels,
      input,
    );
    const workspace = await getCanvasWorkspace(project.id);
    const current = await getCanvasBoard(project.id, workspace.boards[0]!.id);
    if (!input.sourceAssetId && !input.prompt?.trim()) {
      for (const node of document.nodes) {
        const sample = sampleImages.get(node.id);
        if (node.type !== "image" || !sample) continue;
        let assetId = sampleAssetIds.get(sample);
        if (!assetId) {
          assetId = await uploadTemplateSample(sample);
          sampleAssetIds.set(sample, assetId);
        }
        node.data.assetId = assetId;
      }
    }
    await saveCanvasBoard(project.id, {
      board: { ...document, id: current.board.id },
      revision: current.revision,
    });
    await changeCanvasBoard(project.id, current.board.id, { name: t(`assetCanvasTemplates.${template}.title`) });
    return { projectId: project.id, boardId: current.board.id, nodeId: focusNodeId, outputNodeIds };
  } catch (cause) {
    await deleteProject(project.id).catch(() => undefined);
    for (const assetId of sampleAssetIds.values()) await deleteLibraryAsset(assetId).catch(() => undefined);
    throw cause;
  }
}

export async function createEffectSpriteSheetProject(
  input: EffectSpriteSheetInput,
): Promise<{ projectId: string; boardId: string; nodeId: string }> {
  const imageModels = await listImageModels().catch(() => []);
  const project = await createProject({ type: "asset-canvas", name: input.name });
  try {
    const document = createAssetCanvasDocument();
    document.editorLayout.viewport = { x: 24, y: 100, zoom: 0.85 };
    const imageModel = imageModels[0];
    const imageOption = preferredImageOption(imageModel, "1:1");
    const guide: AssetCanvasNode = {
      id: crypto.randomUUID(),
      type: "text",
      title: t("effectLibrary.framePlan"),
      position: { x: 48, y: 92 },
      width: 440,
      data: { text: input.framePlan, instruction: "effect-library:frame-plan" },
    };
    const spriteSheet = createAssetGenerationNode("image", { x: 560, y: 80 }, {
      ...(imageModel ? { imageModel: { provider: imageModel.provider, id: imageModel.id } } : {}),
      ...(imageOption ? { imageResolution: imageOption.resolution, imageAspectRatio: imageOption.aspectRatio } : {}),
    }) as Extract<AssetCanvasNode, { type: "image" }>;
    spriteSheet.title = input.name;
    spriteSheet.data.prompt = input.prompt;
    spriteSheet.data.promptExpanded = true;
    document.nodes = [guide, spriteSheet];
    document.editorLayout.nodes = Object.fromEntries(document.nodes.map((node) => [node.id, { ...node.position, ...(node.width ? { width: node.width } : {}) }]));
    const workspace = await getCanvasWorkspace(project.id);
    const current = await getCanvasBoard(project.id, workspace.boards[0]!.id);
    await saveCanvasBoard(project.id, { board: { ...document, id: current.board.id }, revision: current.revision });
    await changeCanvasBoard(project.id, current.board.id, { name: input.name });
    return { projectId: project.id, boardId: current.board.id, nodeId: spriteSheet.id };
  } catch (cause) {
    await deleteProject(project.id).catch(() => undefined);
    throw cause;
  }
}

/** Creates the Effect Library as a normal Asset Canvas template, matching the pixel-art template layout. */
export async function createEffectLibraryProject(level: PixelArtLevel = "classic"): Promise<{ projectId: string; boardId: string; nodeId: string }> {
  const imageModels = await listImageModels().catch(() => []);
  const project = await createProject({ type: "asset-canvas", name: `${t("effectLibrary.title")} · ${t(`assetCanvas.pixelPresets.levels.${level}`)}` });
  try {
    const document = createAssetCanvasDocument();
    document.editorLayout.viewport = { x: 24, y: 100, zoom: 0.72 };
    const guide: AssetCanvasNode = {
      id: crypto.randomUUID(), type: "text", title: t("effectLibrary.howToTitle"), position: { x: 40, y: 80 }, width: 440,
      data: { instruction: "effect-library", text: t("effectLibrary.canvasGuide") },
    };
    const tutorialStep = (index: 1 | 2 | 3 | 4, y: number): AssetCanvasNode => ({
      id: crypto.randomUUID(),
      type: "text",
      title: t(`effectLibrary.step${index}Title`),
      position: { x: 40, y },
      width: 440,
      data: { instruction: PIXEL_ASSET_TEMPLATE_NOTE, text: t(`effectLibrary.step${index}Body`) },
    });
    const introductionStep = tutorialStep(1, 390);
    const splitStep = tutorialStep(2, 3470);
    const gifStep = tutorialStep(3, 3790);
    const checkStep = tutorialStep(4, 4110);
    const fireHitSheet = level === "coarse" ? coarseEffectFireHitSheet : level === "detailed" ? detailedEffectFireHitSheet : effectFireHitSheet;
    const fireHitPreview = level === "coarse" ? coarseEffectFireHitPreview : level === "detailed" ? detailedEffectFireHitPreview : effectFireHitPreview;
    const iceImpactSheet = level === "coarse" ? coarseEffectIceImpactSheet : level === "detailed" ? detailedEffectIceImpactSheet : effectIceImpactSheet;
    const iceImpactPreview = level === "coarse" ? coarseEffectIceImpactPreview : level === "detailed" ? detailedEffectIceImpactPreview : effectIceImpactPreview;
    const iceClawSlashSheet = level === "coarse" ? coarseEffectIceClawSlashSheet : level === "detailed" ? detailedEffectIceClawSlashSheet : effectIceClawSlashSheet;
    const iceClawSlashPreview = level === "coarse" ? coarseEffectIceClawSlashPreview : level === "detailed" ? detailedEffectIceClawSlashPreview : effectIceClawSlashPreview;
    const waveImpactSheet = level === "coarse" ? coarseEffectWaveImpactSheet : level === "detailed" ? detailedEffectWaveImpactSheet : effectWaveImpactSheet;
    const waveImpactPreview = level === "coarse" ? coarseEffectWaveImpactPreview : level === "detailed" ? detailedEffectWaveImpactPreview : effectWaveImpactPreview;
    const waterSplashSheetSource = level === "coarse" ? coarseEffectWaterSplashSheet : level === "detailed" ? detailedEffectWaterSplashSheet : effectWaterSplashSheet;
    const waterSplashPreviewSource = level === "coarse" ? coarseEffectWaterSplashPreview : level === "detailed" ? detailedEffectWaterSplashPreview : effectWaterSplashPreview;
    const electricOrbBurstSheetSource = level === "coarse" ? coarseEffectElectricOrbBurstSheet : level === "detailed" ? detailedEffectElectricOrbBurstSheet : effectElectricOrbBurstSheet;
    const electricOrbBurstPreviewSource = level === "coarse" ? coarseEffectElectricOrbBurstPreview : level === "detailed" ? detailedEffectElectricOrbBurstPreview : effectElectricOrbBurstPreview;
    const lightningStrikeSheetSource = level === "coarse" ? coarseEffectLightningStrikeSheet : level === "detailed" ? detailedEffectLightningStrikeSheet : effectLightningStrikeSheet;
    const lightningStrikePreviewSource = level === "coarse" ? coarseEffectLightningStrikePreview : level === "detailed" ? detailedEffectLightningStrikePreview : effectLightningStrikePreview;
    const electricTrailSheetSource = level === "coarse" ? coarseEffectElectricTrailSheet : level === "detailed" ? detailedEffectElectricTrailSheet : effectElectricTrailSheet;
    const electricTrailPreviewSource = level === "coarse" ? coarseEffectElectricTrailPreview : level === "detailed" ? detailedEffectElectricTrailPreview : effectElectricTrailPreview;
    const blueWhiteCrescentSheetSource = level === "coarse" ? coarseEffectBlueWhiteCrescentSlashSheet : level === "detailed" ? detailedEffectBlueWhiteCrescentSlashSheet : effectBlueWhiteCrescentSlashSheet;
    const blueWhiteCrescentPreviewSource = level === "coarse" ? coarseEffectBlueWhiteCrescentSlashPreview : level === "detailed" ? detailedEffectBlueWhiteCrescentSlashPreview : effectBlueWhiteCrescentSlashPreview;
    const smokeSheetSource = level === "coarse" ? coarseEffectSmokeDispersalSheet : level === "detailed" ? detailedEffectSmokeDispersalSheet : effectSmokeDispersalSheet;
    const smokePreviewSource = level === "coarse" ? coarseEffectSmokeDispersalPreview : level === "detailed" ? detailedEffectSmokeDispersalPreview : effectSmokeDispersalPreview;
    const waterOrbMagicSheetSource = level === "coarse" ? coarseEffectWaterOrbMagicSheet : level === "detailed" ? detailedEffectWaterOrbMagicSheet : effectWaterOrbMagicSheet;
    const waterOrbMagicPreviewSource = level === "coarse" ? coarseEffectWaterOrbMagicPreview : level === "detailed" ? detailedEffectWaterOrbMagicPreview : effectWaterOrbMagicPreview;
    const greenEnergyWaveSheetSource = level === "coarse" ? coarseEffectGreenEnergyWaveSheet : level === "detailed" ? detailedEffectGreenEnergyWaveSheet : effectGreenEnergyWaveSheet;
    const greenEnergyWavePreviewSource = level === "coarse" ? coarseEffectGreenEnergyWavePreview : level === "detailed" ? detailedEffectGreenEnergyWavePreview : effectGreenEnergyWavePreview;
    const [sheetAssetId, gifAssetId, iceSheetAssetId, iceGifAssetId, waveSheetAssetId, waveGifAssetId, waterSplashSheetAssetId, waterSplashGifAssetId, electricOrbSheetAssetId, electricOrbGifAssetId, lightningStrikeSheetAssetId, lightningStrikeGifAssetId, iceClawSheetAssetId, iceClawGifAssetId, electricTrailSheetAssetId, electricTrailGifAssetId, blueWhiteCrescentSheetAssetId, blueWhiteCrescentGifAssetId, smokeSheetAssetId, smokeGifAssetId, greenEnergyWaveSheetAssetId, greenEnergyWaveGifAssetId, waterOrbMagicSheetAssetId, waterOrbMagicGifAssetId] = await Promise.all([
      uploadEffectExample(fireHitSheet, "火焰命中-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(fireHitPreview, "火焰命中-preview.gif", "image/gif"),
      uploadEffectExample(iceImpactSheet, "冰霜冲击-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(iceImpactPreview, "冰霜冲击-preview.gif", "image/gif"),
      uploadEffectExample(waveImpactSheet, "海浪冲击-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(waveImpactPreview, "海浪冲击-preview.gif", "image/gif"),
      uploadEffectExample(waterSplashSheetSource, "水花命中-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(waterSplashPreviewSource, "水花命中-preview.gif", "image/gif"),
      uploadEffectExample(electricOrbBurstSheetSource, "雷球爆裂-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(electricOrbBurstPreviewSource, "雷球爆裂-preview.gif", "image/gif"),
      uploadEffectExample(lightningStrikeSheetSource, "雷点落击-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(lightningStrikePreviewSource, "雷点落击-preview.gif", "image/gif"),
      uploadEffectExample(iceClawSlashSheet, "三道寒冰爪痕-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(iceClawSlashPreview, "三道寒冰爪痕-preview.gif", "image/gif"),
      uploadEffectExample(electricTrailSheetSource, "电光拖尾-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(electricTrailPreviewSource, "电光拖尾-preview.gif", "image/gif"),
      uploadEffectExample(blueWhiteCrescentSheetSource, "蓝白弧形斩击-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(blueWhiteCrescentPreviewSource, "蓝白弧形斩击-preview.gif", "image/gif"),
      uploadEffectExample(smokeSheetSource, "烟团消散-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(smokePreviewSource, "烟团消散-preview.gif", "image/gif"),
      uploadEffectExample(greenEnergyWaveSheetSource, "绿色聚能波-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(greenEnergyWavePreviewSource, "绿色聚能波-preview.gif", "image/gif"),
      uploadEffectExample(waterOrbMagicSheetSource, "水球魔法-sprite-sheet.webp", "image/webp"),
      uploadEffectExample(waterOrbMagicPreviewSource, "水球魔法-preview.gif", "image/gif"),
    ]);
    const exampleGroup: AssetCanvasNode = { id: crypto.randomUUID(), type: "group", position: { x: 40, y: 700 }, width: 2080, height: 2680, data: { name: t("effectLibrary.templateExample"), pixelStyle: level } };
    const sheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 28, y: 54 }, title: t("effectLibrary.spriteSheetExample"), description: "4 × 3 · 12 帧", data: { assetId: sheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_EXAMPLE_PROMPT } };
    const preview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 530, y: 54 }, title: t("effectLibrary.gifPreview"), description: t("effectLibrary.gifPreviewHint"), data: { assetId: gifAssetId, mediaType: "image" } };
    const iceSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1050, y: 54 }, title: `${t("effectLibrary.spriteSheetExample")} · 冰霜`, description: "4 × 3 · 12 帧", data: { assetId: iceSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_ICE_EXAMPLE_PROMPT } };
    const icePreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1552, y: 54 }, title: `${t("effectLibrary.gifPreview")} · 冰霜`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: iceGifAssetId, mediaType: "image" } };
    const iceClawSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 28, y: 490 }, title: `${t("effectLibrary.spriteSheetExample")} · 寒冰爪痕`, description: "4 × 3 · 12 帧", data: { assetId: iceClawSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_ICE_CLAW_EXAMPLE_PROMPT } };
    const iceClawPreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 530, y: 490 }, title: `${t("effectLibrary.gifPreview")} · 寒冰爪痕`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: iceClawGifAssetId, mediaType: "image" } };
    const waveSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1050, y: 490 }, title: `${t("effectLibrary.spriteSheetExample")} · 海浪`, description: "4 × 3 · 12 帧", data: { assetId: waveSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_WAVE_EXAMPLE_PROMPT } };
    const wavePreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1552, y: 490 }, title: `${t("effectLibrary.gifPreview")} · 海浪`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: waveGifAssetId, mediaType: "image" } };
    const waterSplashSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 28, y: 926 }, title: `${t("effectLibrary.spriteSheetExample")} · 水花`, description: "4 × 3 · 12 帧", data: { assetId: waterSplashSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_WATER_SPLASH_EXAMPLE_PROMPT } };
    const waterSplashPreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 530, y: 926 }, title: `${t("effectLibrary.gifPreview")} · 水花`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: waterSplashGifAssetId, mediaType: "image" } };
    const electricOrbSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1050, y: 926 }, title: `${t("effectLibrary.spriteSheetExample")} · 雷球`, description: "3 × 4 · 12 帧", data: { assetId: electricOrbSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_ELECTRIC_ORB_EXAMPLE_PROMPT } };
    const electricOrbPreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1552, y: 926 }, title: `${t("effectLibrary.gifPreview")} · 雷球`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: electricOrbGifAssetId, mediaType: "image" } };
    const lightningStrikeSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 28, y: 1362 }, title: `${t("effectLibrary.spriteSheetExample")} · 雷点`, description: "5 × 2 · 10 帧", data: { assetId: lightningStrikeSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_LIGHTNING_STRIKE_EXAMPLE_PROMPT } };
    const lightningStrikePreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 530, y: 1362 }, title: `${t("effectLibrary.gifPreview")} · 雷点`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: lightningStrikeGifAssetId, mediaType: "image" } };
    const electricTrailSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1050, y: 1362 }, title: `${t("effectLibrary.spriteSheetExample")} · 电光拖尾`, description: "4 × 3 · 12 帧", data: { assetId: electricTrailSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_ELECTRIC_TRAIL_EXAMPLE_PROMPT } };
    const electricTrailPreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1552, y: 1362 }, title: `${t("effectLibrary.gifPreview")} · 电光拖尾`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: electricTrailGifAssetId, mediaType: "image" } };
    const blueWhiteCrescentSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 28, y: 1798 }, title: `${t("effectLibrary.spriteSheetExample")} · 蓝白弧斩`, description: "4 × 3 · 12 帧", data: { assetId: blueWhiteCrescentSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_BLUE_WHITE_CRESCENT_EXAMPLE_PROMPT } };
    const blueWhiteCrescentPreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 530, y: 1798 }, title: `${t("effectLibrary.gifPreview")} · 蓝白弧斩`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: blueWhiteCrescentGifAssetId, mediaType: "image" } };
    const smokeSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1050, y: 1798 }, title: `${t("effectLibrary.spriteSheetExample")} · 烟团`, description: "4 × 3 · 12 帧", data: { assetId: smokeSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_SMOKE_EXAMPLE_PROMPT } };
    const smokePreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1552, y: 1798 }, title: `${t("effectLibrary.gifPreview")} · 烟团`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: smokeGifAssetId, mediaType: "image" } };
    const greenEnergyWaveSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1050, y: 2234 }, title: `${t("effectLibrary.spriteSheetExample")} · 绿色聚能波`, description: "4 × 3 · 12 帧", data: { assetId: greenEnergyWaveSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_GREEN_ENERGY_WAVE_EXAMPLE_PROMPT } };
    const greenEnergyWavePreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 1552, y: 2234 }, title: `${t("effectLibrary.gifPreview")} · 绿色聚能波`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: greenEnergyWaveGifAssetId, mediaType: "image" } };
    const waterOrbMagicSheet: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 28, y: 2234 }, title: `${t("effectLibrary.spriteSheetExample")} · 水球魔法`, description: "4 × 3 · 12 帧", data: { assetId: waterOrbMagicSheetAssetId, mediaType: "image", examplePrompt: EFFECT_LIBRARY_WATER_ORB_MAGIC_EXAMPLE_PROMPT } };
    const waterOrbMagicPreview: AssetCanvasNode = { id: crypto.randomUUID(), type: "asset", parentId: exampleGroup.id, position: { x: 530, y: 2234 }, title: `${t("effectLibrary.gifPreview")} · 水球魔法`, description: t("effectLibrary.gifPreviewHint"), data: { assetId: waterOrbMagicGifAssetId, mediaType: "image" } };
    const effectExamplePrompt = (prompt: string): string => {
      const gridMatch = prompt.match(/(\d+)-column by (\d+)-row Sprite Sheet/i);
      const columns = Number(gridMatch?.[1] ?? 4);
      const rows = Number(gridMatch?.[2] ?? 3);
      return withPixelArtLevel(prompt, level, "sprite", { assetType: "animation", grid: { columns, rows, unit: "frame" } });
    };
    const exampleImageNode = (node: AssetCanvasNode, prompt: string): AssetCanvasNode => {
      const assetId = "assetId" in node.data ? node.data.assetId : undefined;
      return {
        ...node,
        type: "image",
        data: {
          prompt,
          promptExpanded: true,
          images: [],
          resolution: "1K",
          aspectRatio: "1:1",
          pixelStyle: level,
          ...(assetId ? { assetId } : {}),
        },
      };
    };
    const workGroup: AssetCanvasNode = { id: crypto.randomUUID(), type: "group", position: { x: 40, y: 4380 }, width: 2080, height: 460, data: { name: t("effectLibrary.myEffects") } };
    const imageOption = preferredImageOption(imageModels[0], "1:1");
    const image = createAssetGenerationNode("image", { x: 28, y: 52 }, {
      ...(imageModels[0] ? { imageModel: { provider: imageModels[0].provider, id: imageModels[0].id } } : {}),
      ...(imageOption ? { imageResolution: imageOption.resolution, imageAspectRatio: imageOption.aspectRatio } : {}),
    }) as Extract<AssetCanvasNode, { type: "image" }>;
    image.parentId = workGroup.id;
    image.title = EFFECT_LIBRARY_PRESETS[0].name;
    image.description = EFFECT_LIBRARY_PRESETS[0].frames;
    image.data.effectBasePrompt = EFFECT_LIBRARY_PRESETS[0].prompt;
    image.data.effectColor = "original";
    image.data.effectRhythm = "sample";
    image.data.prompt = "";
    image.data.pixelStyle = level;
    image.data.promptExpanded = true;
    const nodes: AssetCanvasNode[] = [guide, introductionStep, exampleGroup, splitStep, gifStep, checkStep,
      exampleImageNode(sheet, effectExamplePrompt(EFFECT_LIBRARY_EXAMPLE_PROMPT)), preview,
      exampleImageNode(iceSheet, effectExamplePrompt(EFFECT_LIBRARY_ICE_EXAMPLE_PROMPT)), icePreview,
      exampleImageNode(waveSheet, effectExamplePrompt(EFFECT_LIBRARY_WAVE_EXAMPLE_PROMPT)), wavePreview,
      exampleImageNode(waterSplashSheet, effectExamplePrompt(EFFECT_LIBRARY_WATER_SPLASH_EXAMPLE_PROMPT)), waterSplashPreview,
      exampleImageNode(electricOrbSheet, effectExamplePrompt(EFFECT_LIBRARY_ELECTRIC_ORB_EXAMPLE_PROMPT)), electricOrbPreview,
      exampleImageNode(lightningStrikeSheet, effectExamplePrompt(EFFECT_LIBRARY_LIGHTNING_STRIKE_EXAMPLE_PROMPT)), lightningStrikePreview,
      exampleImageNode(iceClawSheet, effectExamplePrompt(EFFECT_LIBRARY_ICE_CLAW_EXAMPLE_PROMPT)), iceClawPreview,
      exampleImageNode(electricTrailSheet, effectExamplePrompt(EFFECT_LIBRARY_ELECTRIC_TRAIL_EXAMPLE_PROMPT)), electricTrailPreview,
      exampleImageNode(blueWhiteCrescentSheet, effectExamplePrompt(EFFECT_LIBRARY_BLUE_WHITE_CRESCENT_EXAMPLE_PROMPT)), blueWhiteCrescentPreview,
      exampleImageNode(smokeSheet, effectExamplePrompt(EFFECT_LIBRARY_SMOKE_EXAMPLE_PROMPT)), smokePreview,
      exampleImageNode(waterOrbMagicSheet, effectExamplePrompt(EFFECT_LIBRARY_WATER_ORB_MAGIC_EXAMPLE_PROMPT)), waterOrbMagicPreview,
      exampleImageNode(greenEnergyWaveSheet, effectExamplePrompt(EFFECT_LIBRARY_GREEN_ENERGY_WAVE_EXAMPLE_PROMPT)), greenEnergyWavePreview,
      workGroup, image];
    document.nodes = nodes;
    document.editorLayout.nodes = Object.fromEntries(nodes.map((node) => [node.id, { ...node.position, ...(node.width ? { width: node.width } : {}), ...(node.height ? { height: node.height } : {}) }]));
    const workspace = await getCanvasWorkspace(project.id);
    const current = await getCanvasBoard(project.id, workspace.boards[0]!.id);
    await saveCanvasBoard(project.id, { board: { ...document, id: current.board.id }, revision: current.revision });
    await changeCanvasBoard(project.id, current.board.id, { name: `${t("effectLibrary.title")} · ${t(`assetCanvas.pixelPresets.levels.${level}`)}` });
    await applyEffectLibraryCover(project.id, level);
    return { projectId: project.id, boardId: current.board.id, nodeId: image.id };
  } catch (cause) {
    await deleteProject(project.id).catch(() => undefined);
    throw cause;
  }
}

export async function createAssetCanvasTemplateBoard(
  projectId: string,
  template: AssetCanvasTemplate,
  sourceAssetId: string,
): Promise<{ boardId: string; nodeId: string }> {
  const imageModels = await listImageModels().catch(() => []);
  const { document, focusNodeId } = createAssetCanvasTemplateDocument(
    template,
    imageModels,
    { sourceAssetId },
  );
  const workspace = await createCanvasBoard(
    projectId,
    t(`assetCanvasTemplates.${template}.title`),
  );
  const boardId = workspace.boards.at(-1)!.id;
  try {
    const current = await getCanvasBoard(projectId, boardId);
    await saveCanvasBoard(projectId, {
      board: { ...document, id: boardId },
      revision: current.revision,
    });
    return { boardId, nodeId: focusNodeId };
  } catch (cause) {
    await deleteCanvasBoard(projectId, boardId).catch(() => undefined);
    throw cause;
  }
}
