import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { EFFECT_PRESETS, type EffectPresetId } from "./asset-canvas-effect-presets.js";
import { templateExampleUrl } from "./template-assets.js";

function effectExampleUrl(id: EffectPresetId, level: PixelArtLevel, file: "sheet.webp" | "preview.gif"): string {
  return templateExampleUrl(`pixel/${level}/effects/${id}-${file}`);
}

export function effectPresetExampleId(id: EffectPresetId, level: PixelArtLevel): string {
  return `effects/${level}/${id}`;
}

export function effectPresetPreviewExampleId(id: EffectPresetId, level: PixelArtLevel): string {
  return `effects/${level}/${id}.gif`;
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
  const preview = match[2]!.endsWith(".gif");
  const presetId = preview ? match[2]!.slice(0, -".gif".length) : match[2];
  const preset = EFFECT_PRESETS.find((candidate) => candidate.id === presetId);
  return preset ? effectExampleUrl(preset.id, match[1] as PixelArtLevel, preview ? "preview.gif" : "sheet.webp") : undefined;
}
