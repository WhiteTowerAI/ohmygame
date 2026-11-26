import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { EFFECT_PRESETS, type EffectPresetId } from "./asset-canvas-effect-presets.js";
import { templateExampleUrl } from "./template-assets.js";

/** New effect nodes use the examples drawn on the classic grid, the one pixel style presets use. */
const EXAMPLE_LEVEL: PixelArtLevel = "classic";

function effectExampleUrl(id: EffectPresetId, level: PixelArtLevel, file: "sheet.webp" | "preview.gif"): string {
  return templateExampleUrl(`pixel/${level}/effects/${id}-${file}`);
}

export function effectPresetExampleId(id: EffectPresetId): string {
  return `effects/${EXAMPLE_LEVEL}/${id}`;
}

/** An effect's example GIF, made from its sprite sheet. */
export function effectPresetPreviewExampleId(id: EffectPresetId): string {
  return `effects/${EXAMPLE_LEVEL}/${id}.gif`;
}

// compat: since beta.5.11, remove from beta.7 and 2026-12-24. Canvases from
// before then also show coarse and detailed effect examples.
export function effectExampleImageUrl(id?: string): string | undefined {
  const match = id?.match(/^effects\/(coarse|classic|detailed)\/(.+)$/);
  if (!match) return undefined;
  const preview = match[2]!.endsWith(".gif");
  const presetId = preview ? match[2]!.slice(0, -".gif".length) : match[2];
  const preset = EFFECT_PRESETS.find((candidate) => candidate.id === presetId);
  return preset ? effectExampleUrl(preset.id, match[1] as PixelArtLevel, preview ? "preview.gif" : "sheet.webp") : undefined;
}
