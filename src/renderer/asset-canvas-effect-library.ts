import type { AssetCanvasNode, ImageModel } from "../shared/contracts.js";
import { withPixelArtStyle } from "../shared/canvas-pixel-style.js";
import { createAssetGenerationNode, preferredImageOption } from "../shared/asset-canvas.js";
import { effectPresetExampleId, effectPresetPreviewExampleId } from "./asset-canvas-effect-examples.js";
import { effectPresetFrames, effectPresetLabel } from "./asset-canvas-effect-presets.js";
import { PIXEL_ASSET_TEMPLATE_NOTE, PRESET_COLUMN, PRESET_NOTE_WIDTH } from "./asset-canvas-pixel-workflows.js";
import { t } from "./i18n.js";

// The Effects workflow of Asset presets: a guide, one finished example (its
// sprite sheet with the prompt that made it beside its GIF), and the steps
// from a sprite sheet to a checked GIF over one generator of the person's own
// with the effect color and rhythm controls.

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


/** The Effects workflow's nodes, laid out as the Effects template's board was, from its top left. */
/** Room for the tallest step note at its width, the second step's in English. */
const NOTE_HEIGHT = 300;
const GAP = 48;
/** Where a group's first node starts, below its name. */
const GROUP_TOP = 52;
const GROUP_PADDING = 28;
/** Rough heights of the guide at its width, an example image and the effect generator. */
const GUIDE_HEIGHT = 140;
const EXAMPLE_HEIGHT = 420;
const GENERATOR_HEIGHT = 420;

/**
 * The Effects workflow's nodes. The guide and one finished example come
 * first; under them, the person's own effect is a row of the four steps, each
 * above where it happens, the generator under the first.
 */
export function effectLibraryNodes(imageModels: readonly ImageModel[]): AssetCanvasNode[] {
  const exampleTop = GUIDE_HEIGHT + GAP;
  const exampleWidth = 2 * GROUP_PADDING + PRESET_COLUMN + PRESET_NOTE_WIDTH;
  const guide: AssetCanvasNode = {
    id: crypto.randomUUID(), type: "text", title: t("effectLibrary.howToTitle"), position: { x: 0, y: 0 }, width: exampleWidth,
    data: { instruction: "effect-library", text: t("effectLibrary.canvasGuide") },
  };
  const exampleGroup: AssetCanvasNode = { id: crypto.randomUUID(), type: "group", position: { x: 0, y: exampleTop }, width: exampleWidth, height: GROUP_TOP + EXAMPLE_HEIGHT + GROUP_PADDING, data: { name: t("effectLibrary.templateExample") } };
  const example = (exampleImage: string, title: string, description: string, x: number, prompt = ""): AssetCanvasNode => ({
    id: crypto.randomUUID(),
    type: "image",
    parentId: exampleGroup.id,
    title,
    description,
    position: { x, y: GROUP_TOP },
    data: { prompt, ...(prompt ? { promptExpanded: true } : {}), images: [], resolution: "1K", aspectRatio: "1:1", exampleImage },
  });
  // The example's prompt is the one that made its sheet, with the pixel style it was drawn in.
  const prompt = withPixelArtStyle(EFFECT_LIBRARY_EXAMPLE_PROMPT, "sprite", { assetType: "effect", grid: { columns: 4, rows: 3, unit: "frame" } });
  const examples = [
    example(effectPresetExampleId("fire-hit"), t("effectLibrary.spriteSheetExample"), effectPresetFrames("fire-hit"), GROUP_PADDING, prompt),
    example(effectPresetPreviewExampleId("fire-hit"), t("effectLibrary.gifPreview"), t("effectLibrary.gifPreviewHint"), GROUP_PADDING + PRESET_COLUMN),
  ];
  const workGroup: AssetCanvasNode = {
    id: crypto.randomUUID(),
    type: "group",
    position: { x: 0, y: exampleTop + (exampleGroup.height ?? 0) + GAP },
    width: 2 * GROUP_PADDING + 3 * PRESET_COLUMN + PRESET_NOTE_WIDTH,
    height: GROUP_TOP + NOTE_HEIGHT + GAP + GENERATOR_HEIGHT + GROUP_PADDING,
    data: { name: t("effectLibrary.myEffects") },
  };
  const steps = ([1, 2, 3, 4] as const).map((index): AssetCanvasNode => ({
    id: crypto.randomUUID(),
    type: "text",
    parentId: workGroup.id,
    title: t(`effectLibrary.step${index}Title`),
    position: { x: GROUP_PADDING + (index - 1) * PRESET_COLUMN, y: GROUP_TOP },
    width: PRESET_NOTE_WIDTH,
    data: { instruction: PIXEL_ASSET_TEMPLATE_NOTE, text: t(`effectLibrary.step${index}Body`) },
  }));
  const model = imageModels[0];
  const option = preferredImageOption(model, "1:1");
  const generator = createAssetGenerationNode("image", { x: GROUP_PADDING, y: GROUP_TOP + NOTE_HEIGHT + GAP }, {
    ...(model ? { imageModel: { provider: model.provider, id: model.id } } : {}),
    ...(option ? { imageResolution: option.resolution, imageAspectRatio: option.aspectRatio } : {}),
  }) as Extract<AssetCanvasNode, { type: "image" }>;
  generator.parentId = workGroup.id;
  generator.title = effectPresetLabel("fire-hit");
  generator.description = effectPresetFrames("fire-hit");
  generator.data.effectBasePrompt = EFFECT_LIBRARY_STARTER_PROMPT;
  generator.data.effectColor = "original";
  generator.data.effectRhythm = "sample";
  generator.data.prompt = "";
  generator.data.promptExpanded = true;
  return [guide, exampleGroup, ...examples, workGroup, ...steps, generator];
}
