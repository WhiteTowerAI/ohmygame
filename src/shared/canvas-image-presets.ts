import {
  characterAssetPrompt,
  continuousActionsPrompt,
} from "./canvas-character-tools.js";
import { consistentScenesPrompt, PIXEL_MATERIAL_PROMPTS } from "./canvas-pixel-prompts.js";
import { pixelPromptWithRequest, withCharacterPixelArtLevel, withGlobalPixelStyle, withPixelArtLevel, type PixelArtLevel } from "./canvas-pixel-style.js";

export const CANVAS_IMAGE_PRESETS = [
  "free",
  "character-sheet",
  "quick-reskin",
  "continuous-sequence",
  "consistent-sequence",
  "side-view-character",
  "rpg-character",
  "multi-angle",
  "portrait",
  "monster",
  "animal",
  "scene",
  "terrain",
  "tileset",
  "building",
  "prop",
  "icon",
] as const;

export type CanvasImagePreset = (typeof CANVAS_IMAGE_PRESETS)[number];

export const CANVAS_MATERIAL_STYLES = ["pixel", "general"] as const;
export type CanvasMaterialStyle = (typeof CANVAS_MATERIAL_STYLES)[number];

export const QUICK_RESKIN_DEFAULT_PROMPT = withGlobalPixelStyle("Put the clothing from the clothing reference image on the person in the person image. Preserve the person's identity, proportions, pose, and composition. Adapt both references to the same selected pixel density and palette.");

/** Preserve the pixel prompts used by saved material nodes without a style. */
export function canvasMaterialStyle(preset?: CanvasImagePreset, style?: CanvasMaterialStyle): CanvasMaterialStyle {
  return style ?? (preset && !["free", "character-sheet", "quick-reskin", "continuous-sequence", "consistent-sequence"].includes(preset) ? "pixel" : "general");
}

const instructions: Record<
  Exclude<
    CanvasImagePreset,
    "free" | "character-sheet" | "quick-reskin" | "continuous-sequence" | "consistent-sequence"
  >,
  string
> = {
  "side-view-character":
    "Create a full-body side-view game character on a plain background, with a readable silhouette and consistent proportions.",
  "rpg-character":
    "Create a top-down RPG character sprite with a complete body, clear equipment, and a plain background.",
  "multi-angle":
    "Create a 3 × 3 sheet of nine views of one subject: back-left, back, and back-right on the top row; left side, top-down overhead, and right side in the middle; front-left, front, and front-right on the bottom row. Keep the same design, pose, and scale in every view on a plain background.",
  portrait:
    "Create a detailed character portrait with a clear face, expression, costume, and plain background.",
  monster:
    "Create a complete game monster sprite with a menacing silhouette, exaggerated threatening features such as claws, fangs, or spikes, a dark palette with vivid danger accents, and a plain background.",
  animal:
    "Create a complete game animal sprite that looks naturalistic and recognizable, with accurate species anatomy, proportions, and colors on a plain background.",
  scene:
    "Create a game environment with coherent perspective, lighting, and readable foreground and background layers.",
  terrain:
    "Create one continuous terrain area with coherent materials, consistent scale, and no tile atlas grid.",
  tileset:
    "Create a grid-aligned terrain tileset with equally sized square cells, compatible edges, corners, and transitions.",
  building:
    "Create a complete game building asset with a readable silhouette, consistent perspective, and plain background.",
  prop: "Create a single game prop or equipment asset, centered on a plain background with a clear silhouette.",
  icon: "Create a single game UI icon, centered in a square frame with a clear silhouette and no text.",
};

export function canvasImagePresetPrompt(
  preset: CanvasImagePreset | undefined,
  description: string,
  style?: CanvasMaterialStyle,
  referenceCount = 1,
  pixelLevel: PixelArtLevel = "classic",
): string {
  const subject = description.trim();
  if (!preset || preset === "free") return subject;
  if (preset === "character-sheet") return withCharacterPixelArtLevel(characterAssetPrompt(subject, pixelLevel), pixelLevel);
  if (preset === "continuous-sequence") return continuousActionsPrompt(subject, pixelLevel);
  if (preset === "consistent-sequence") return consistentScenesPrompt(subject, undefined, pixelLevel);
  if (preset === "quick-reskin") {
    const sourceInstructions = referenceCount >= 2
      ? "Use the first reference image as the person and the second reference image as the clothing design. Transfer the clothing from the second image onto the person in the first image."
      : "Use the supplied reference image as the source for one reskinned game asset.";
    return withPixelArtLevel(pixelPromptWithRequest("Requested appearance changes", subject, `${sourceInstructions} Keep the same subject, silhouette, pose, proportions, camera angle, framing, and composition. Change only the requested appearance, such as costume, colors, surface materials, or small accessories. Preserve the original background or transparency. Output one finished image, not a comparison, sprite sheet, animation, or labeled diagram.`), pixelLevel, "sprite", { assetType: "subject" });
  }
  if (preset in PIXEL_MATERIAL_PROMPTS && canvasMaterialStyle(preset, style) === "pixel") {
    const template = PIXEL_MATERIAL_PROMPTS[preset as keyof typeof PIXEL_MATERIAL_PROMPTS];
    const kind = preset === "scene" || preset === "terrain" ? "scene" : preset === "tileset" ? "tile" : "sprite";
    const assetType = preset === "monster" || preset === "animal" ? "creature"
      : preset === "terrain" || preset === "tileset" ? "terrain"
      : preset === "scene" || preset === "building" ? "environment"
      : preset === "prop" || preset === "icon" ? "object"
      : preset === "multi-angle" ? "subject" : "character";
    const grid = preset === "monster" || preset === "animal"
      ? { columns: 4, rows: 4, unit: "sprite" as const }
      : preset === "prop" ? { columns: 4, rows: 3, unit: "view" as const }
        : preset === "multi-angle" ? { columns: 3, rows: 3, unit: "view" as const }
        : preset === "tileset" ? { columns: 4, rows: 4, unit: "tile" as const } : undefined;
    const fallback = preset === "terrain" || preset === "tileset"
      ? "Derive the terrain biome, materials, and palette from the supplied reference, then build a new asset that follows the requirements below."
      : undefined;
    return withPixelArtLevel(pixelPromptWithRequest("USER REQUEST", subject, template.replace("\n\nUSER REQUEST: {user_prompt}", ""), fallback), pixelLevel, kind, { assetType, grid });
  }
  const prompt = `${instructions[preset]}\n\nSubject and details: ${subject}`;
  return `${prompt}\n\n${canvasMaterialStyle(preset, style) === "pixel"
    ? "Render in pixel art with crisp pixel edges, a limited palette, and consistent pixel scale."
    : "Follow the art style requested in the description or shown in the supplied reference images. If no style is specified, use a clean game-asset illustration style."}`;
}
