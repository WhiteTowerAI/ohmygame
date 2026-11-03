import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { EFFECT_PRESETS, type EffectPresetId } from "./asset-canvas-effect-presets.js";
import { templateExampleUrl } from "./template-assets.js";

function effectExampleUrl(id: EffectPresetId, level: PixelArtLevel, file: "sheet.webp" | "preview.gif"): string {
  return templateExampleUrl(`pixel/${level}/effects/${id}-${file}`);
}

export function effectPresetExampleId(id: EffectPresetId, level: PixelArtLevel): string {
  return `effects/${level}/${id}`;
}

export function effectPresetExampleUrl(id: EffectPresetId, level: PixelArtLevel): string {
  return effectExampleUrl(id, level, "sheet.webp");
}

export function effectPresetPreviewUrl(id: EffectPresetId, level: PixelArtLevel): string {
  return effectExampleUrl(id, level, "preview.gif");
}

export function effectExampleImageUrl(id?: string): string | undefined {
  const match = id?.match(/^effects\/(coarse|classic|detailed)\/(.+)$/);
  if (!match) return undefined;
  const preset = EFFECT_PRESETS.find((candidate) => candidate.id === match[2]);
  return preset ? effectExampleUrl(preset.id, match[1] as PixelArtLevel, "sheet.webp") : undefined;
}
