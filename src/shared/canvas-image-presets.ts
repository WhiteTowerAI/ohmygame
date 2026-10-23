import {
  characterAssetPrompt,
  continuousActionsPrompt,
} from "./canvas-character-tools.js";

export const CANVAS_IMAGE_PRESETS = [
  "free",
  "character-sheet",
  "quick-reskin",
  "continuous-sequence",
  "consistent-sequence",
  "side-view-character",
  "rpg-character",
  "portrait",
  "monster",
  "animal",
  "scene",
  "terrain",
  "building",
  "prop",
  "icon",
] as const;

export type CanvasImagePreset = (typeof CANVAS_IMAGE_PRESETS)[number];

export const CANVAS_MATERIAL_STYLES = ["pixel", "general"] as const;
export type CanvasMaterialStyle = (typeof CANVAS_MATERIAL_STYLES)[number];

/** Preserve the pixel prompts used by saved material nodes without a style. */
export function canvasMaterialStyle(preset?: CanvasImagePreset, style?: CanvasMaterialStyle): CanvasMaterialStyle {
  return style ?? (preset && !["free", "character-sheet", "quick-reskin", "continuous-sequence", "consistent-sequence"].includes(preset) ? "pixel" : "general");
}

const instructions: Record<
  Exclude<
    CanvasImagePreset,
    "free" | "character-sheet" | "quick-reskin" | "continuous-sequence"
  >,
  string
> = {
  "consistent-sequence":
    "Create one 3-row by 3-column image grid of nine related scenes from the supplied reference. Follow the requested scenes in reading order. Keep the same character identity, face, outfit, colors, proportions, and art style across every scene. Vary only the requested action, composition, or setting. Use equal-sized panels and no text or labels.",
  "side-view-character":
    "Create a full-body side-view game character on a plain background, with a readable silhouette and consistent proportions.",
  "rpg-character":
    "Create a top-down RPG character sprite with a complete body, clear equipment, and a plain background.",
  portrait:
    "Create a detailed character portrait with a clear face, expression, costume, and plain background.",
  monster:
    "Create a complete game monster sprite with a readable silhouette and plain background.",
  animal:
    "Create a complete game animal sprite with a readable silhouette and plain background.",
  scene:
    "Create a game environment with coherent perspective, lighting, and readable foreground and background layers.",
  terrain:
    "Create a terrain tile sample with clean edges, consistent scale, and repeatable materials.",
  building:
    "Create a complete game building asset with a readable silhouette, consistent perspective, and plain background.",
  prop: "Create a single game prop or equipment asset, centered on a plain background with a clear silhouette.",
  icon: "Create a single game UI icon, centered in a square frame with a clear silhouette and no text.",
};

export function canvasImagePresetPrompt(
  preset: CanvasImagePreset | undefined,
  description: string,
  style?: CanvasMaterialStyle,
): string {
  const subject = description.trim();
  if (!preset || preset === "free") return subject;
  if (preset === "continuous-sequence") return continuousActionsPrompt(subject);
  if (preset === "quick-reskin") return `Use the supplied reference image as the source for one reskinned game asset. Keep the same subject, silhouette, pose, proportions, camera angle, framing, composition, and visual style. Change only the requested appearance, such as costume, colors, surface materials, or small accessories. Preserve all other details and the original background or transparency. Output one finished image, not a comparison, sprite sheet, animation, or labeled diagram.\n\nRequested appearance changes: ${subject}`;
  const prompt = preset === "character-sheet" ? characterAssetPrompt(subject)
    : `${instructions[preset]}\n\nSubject and details: ${subject}`;
  if (preset === "consistent-sequence") return prompt;
  return `${prompt}\n\n${canvasMaterialStyle(preset, style) === "pixel"
    ? "Render in pixel art with crisp pixel edges, a limited palette, and consistent pixel scale."
    : "Follow the art style requested in the description or shown in the supplied reference images. If no style is specified, use a clean game-asset illustration style."}`;
}
