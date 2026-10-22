import { characterAssetPrompt, continuousActionsPrompt } from "./canvas-character-tools.js";

export const CANVAS_IMAGE_PRESETS = [
  "free",
  "character-sheet",
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

const instructions: Record<
  Exclude<CanvasImagePreset, "free" | "character-sheet" | "continuous-sequence">,
  string
> = {
  "consistent-sequence":
    "Create one 3-row by 3-column image grid of nine related scenes from the supplied reference. Follow the requested scenes in reading order. Keep the same character identity, face, outfit, colors, proportions, and art style across every scene. Vary only the requested action, composition, or setting. Use equal-sized panels and no text or labels.",
  "side-view-character":
    "Create a full-body side-view pixel-art game character on a plain background, with a readable silhouette and consistent pixel scale.",
  "rpg-character":
    "Create a top-down RPG pixel-art character sprite with a complete body, clear equipment, and a plain background.",
  portrait:
    "Create a detailed pixel-art character portrait with a clear face, expression, costume, and plain background.",
  monster:
    "Create a complete pixel-art game monster sprite with a readable silhouette and plain background.",
  animal:
    "Create a complete pixel-art game animal sprite with a readable silhouette and plain background.",
  scene:
    "Create a pixel-art game environment with coherent perspective, lighting, and readable foreground and background layers.",
  terrain:
    "Create a pixel-art terrain tile sample with clean edges, consistent scale, and repeatable materials.",
  building:
    "Create a complete pixel-art game building asset with a readable silhouette, consistent perspective, and plain background.",
  prop: "Create a single pixel-art game prop or equipment asset, centered on a plain background with a clear silhouette.",
  icon: "Create a single pixel-art game UI icon, centered in a square frame with a clear silhouette and no text.",
};

export function canvasImagePresetPrompt(
  preset: CanvasImagePreset | undefined,
  description: string,
): string {
  const subject = description.trim();
  if (!preset || preset === "free") return subject;
  if (preset === "character-sheet") return characterAssetPrompt(subject);
  if (preset === "continuous-sequence") return continuousActionsPrompt(subject);
  return `${instructions[preset]}\n\nSubject and details: ${subject}`;
}
