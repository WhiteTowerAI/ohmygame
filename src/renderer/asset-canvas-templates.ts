import type {
  AssetCanvasNode,
  ImageModel,
} from "../shared/contracts.js";
import { withPixelArtLevel, type PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { CANVAS_IMAGE_PRESETS, type CanvasImagePreset } from "../shared/canvas-image-presets.js";
import { preferredCharacterSheetOption } from "../shared/canvas-character-tools.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
  preferredImageOption,
} from "../shared/asset-canvas.js";
import { createProject, deleteProject, listImageModels, setProjectCover } from "./api.js";
import { effectLibraryCoverForLevel } from "./asset-canvas-effect-covers.js";
import { effectPresetExampleId, effectPresetPreviewExampleId } from "./asset-canvas-effect-examples.js";
import { effectPresetFrames, effectPresetLabel, type EffectPresetId } from "./asset-canvas-effect-presets.js";
import { PIXEL_ASSET_TEMPLATE_NOTE } from "./asset-canvas-pixel-workflows.js";
import {
  changeCanvasBoard,
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

/** The starting prompt of the Effects template's own generator. */
const EFFECT_LIBRARY_STARTER_PROMPT = "Create one complete 4-column by 3-row sprite sheet for a compact pixel-art fire impact. Read cells left to right, top to bottom: ignition, expanding flame burst, scattered sparks, fading embers. Transparent background, no labels, no borders, fixed center.";

const EFFECT_LIBRARY_EXAMPLE_PROMPT = `Requested action: pixel-art fire impact animation in a 4-column by 3-row Sprite Sheet (12 frames)

Main color: original orange, yellow, red, and dark-brown fire palette

Motion rhythm: balanced buildup, brightest peak, then a clean fade-out

Fine-detail direction: use a compact white-hot core, separately articulated narrow yellow and gold inner flame tongues, orange mid-flames, a deep crimson outer rim, small charcoal ember pockets, and tiny square cinders. Preserve dense internal flame striations and stepped pixel contours; never use a smoky, muddy, broad flat red mass.

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
Fine-detail direction: use a hairline white-cyan lightning core, independently articulated thin blue-violet branches, dark navy gaps, stepped micro-pixel bends, cyan rim highlights, segmented afterimage trails, and tiny square charged dust. Keep the energy as precise filaments, never a chunky blob or a broad flat blue slab.

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

Fine-detail direction: build one elegant thin crescent with a razor-sharp white-blue core line, separately articulated cyan and royal-blue energy ribbons, dark navy occlusion gaps, segmented edge highlights, tapered fragments, and tiny square sparks. Keep dense internal striations and finely stepped pixel contours; never use a chunky broad blue swoosh or a flat slab.

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

async function applyEffectLibraryCover(projectId: string, level: PixelArtLevel = "classic"): Promise<void> {
  const response = await fetch(effectLibraryCoverForLevel(level));
  if (!response.ok) throw new Error("Could not load the Effect Library cover");
  await setProjectCover(projectId, await response.blob());
}

/** Creates the Effect Library as a normal Asset Canvas template, matching the pixel-art template layout. */
export async function createEffectLibraryProject(level: PixelArtLevel = "classic"): Promise<{ projectId: string; boardId: string; nodeId: string }> {
  const [imageModels, project] = await Promise.all([
    listImageModels().catch(() => []),
    createProject({ type: "asset-canvas", name: `${t("effectLibrary.title")} · ${t(`assetCanvas.pixelPresets.levels.${level}`)}` }),
  ]);
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
    const exampleGroup: AssetCanvasNode = { id: crypto.randomUUID(), type: "group", position: { x: 40, y: 700 }, width: 2080, height: 2680, data: { name: t("effectLibrary.templateExample"), pixelStyle: level } };
    const effectExamples: ReadonlyArray<{ id: EffectPresetId; prompt: string; x: number; y: number }> = [
      { id: "fire-hit", prompt: EFFECT_LIBRARY_EXAMPLE_PROMPT, x: 28, y: 54 },
      { id: "ice-impact", prompt: EFFECT_LIBRARY_ICE_EXAMPLE_PROMPT, x: 1050, y: 54 },
      { id: "ice-claw-slash", prompt: EFFECT_LIBRARY_ICE_CLAW_EXAMPLE_PROMPT, x: 28, y: 490 },
      { id: "wave-impact", prompt: EFFECT_LIBRARY_WAVE_EXAMPLE_PROMPT, x: 1050, y: 490 },
      { id: "water-splash", prompt: EFFECT_LIBRARY_WATER_SPLASH_EXAMPLE_PROMPT, x: 28, y: 926 },
      { id: "electric-orb-burst", prompt: EFFECT_LIBRARY_ELECTRIC_ORB_EXAMPLE_PROMPT, x: 1050, y: 926 },
      { id: "lightning-strike", prompt: EFFECT_LIBRARY_LIGHTNING_STRIKE_EXAMPLE_PROMPT, x: 28, y: 1362 },
      { id: "electric-trail", prompt: EFFECT_LIBRARY_ELECTRIC_TRAIL_EXAMPLE_PROMPT, x: 1050, y: 1362 },
      { id: "blue-white-crescent-slash", prompt: EFFECT_LIBRARY_BLUE_WHITE_CRESCENT_EXAMPLE_PROMPT, x: 28, y: 1798 },
      { id: "smoke-dispersal", prompt: EFFECT_LIBRARY_SMOKE_EXAMPLE_PROMPT, x: 1050, y: 1798 },
      { id: "water-orb-magic", prompt: EFFECT_LIBRARY_WATER_ORB_MAGIC_EXAMPLE_PROMPT, x: 28, y: 2234 },
      { id: "green-energy-wave", prompt: EFFECT_LIBRARY_GREEN_ENERGY_WAVE_EXAMPLE_PROMPT, x: 1050, y: 2234 },
    ];
    const effectExamplePrompt = (prompt: string): string => {
      const gridMatch = prompt.match(/(\d+)-column by (\d+)-row Sprite Sheet/i);
      const columns = Number(gridMatch?.[1] ?? 4);
      const rows = Number(gridMatch?.[2] ?? 3);
      return withPixelArtLevel(prompt, level, "sprite", { assetType: "effect", grid: { columns, rows, unit: "frame" } });
    };
    const effectExampleImageNode = (exampleImage: string, title: string, description: string, position: { x: number; y: number }, prompt = ""): AssetCanvasNode => ({
      id: crypto.randomUUID(),
      type: "image",
      parentId: exampleGroup.id,
      title,
      description,
      position,
      data: {
        prompt,
        ...(prompt ? { promptExpanded: true } : {}),
        images: [],
        resolution: "1K",
        aspectRatio: "1:1",
        pixelStyle: level,
        exampleImage,
      },
    });
    const exampleNodes = effectExamples.flatMap(({ id, prompt, x, y }) => {
      const label = effectPresetLabel(id);
      const isFirstExample = id === "fire-hit";
      return [
        effectExampleImageNode(
          effectPresetExampleId(id, level),
          isFirstExample ? t("effectLibrary.spriteSheetExample") : `${t("effectLibrary.spriteSheetExample")} · ${label}`,
          effectPresetFrames(id),
          { x, y },
          effectExamplePrompt(prompt),
        ),
        effectExampleImageNode(
          effectPresetPreviewExampleId(id, level),
          isFirstExample ? t("effectLibrary.gifPreview") : `${t("effectLibrary.gifPreview")} · ${label}`,
          t("effectLibrary.gifPreviewHint"),
          { x: x + 502, y },
        ),
      ];
    });
    const workGroup: AssetCanvasNode = { id: crypto.randomUUID(), type: "group", position: { x: 40, y: 4380 }, width: 2080, height: 460, data: { name: t("effectLibrary.myEffects") } };
    const imageOption = preferredImageOption(imageModels[0], "1:1");
    const image = createAssetGenerationNode("image", { x: 28, y: 52 }, {
      ...(imageModels[0] ? { imageModel: { provider: imageModels[0].provider, id: imageModels[0].id } } : {}),
      ...(imageOption ? { imageResolution: imageOption.resolution, imageAspectRatio: imageOption.aspectRatio } : {}),
    }) as Extract<AssetCanvasNode, { type: "image" }>;
    image.parentId = workGroup.id;
    image.title = effectPresetLabel("fire-hit");
    image.description = effectPresetFrames("fire-hit");
    image.data.effectBasePrompt = EFFECT_LIBRARY_STARTER_PROMPT;
    image.data.effectColor = "original";
    image.data.effectRhythm = "sample";
    image.data.prompt = "";
    image.data.pixelStyle = level;
    image.data.promptExpanded = true;
    const nodes: AssetCanvasNode[] = [guide, introductionStep, exampleGroup, splitStep, gifStep, checkStep, ...exampleNodes, workGroup, image];
    document.nodes = nodes;
    document.editorLayout.nodes = Object.fromEntries(nodes.map((node) => [node.id, { ...node.position, ...(node.width ? { width: node.width } : {}), ...(node.height ? { height: node.height } : {}) }]));
    const workspace = await getCanvasWorkspace(project.id);
    const current = await getCanvasBoard(project.id, workspace.boards[0]!.id);
    await saveCanvasBoard(project.id, { board: { ...document, id: current.board.id }, revision: current.revision });
    await changeCanvasBoard(project.id, current.board.id, { name: `${t("effectLibrary.title")} · ${t(`assetCanvas.pixelPresets.levels.${level}`)}` });
    void applyEffectLibraryCover(project.id, level).catch(() => undefined);
    return { projectId: project.id, boardId: current.board.id, nodeId: image.id };
  } catch (cause) {
    await deleteProject(project.id).catch(() => undefined);
    throw cause;
  }
}
