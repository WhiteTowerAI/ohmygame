import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { templateAssetUrl } from "./template-assets.js";

const effectLibraryCover = (level: PixelArtLevel) => templateAssetUrl(`examples/effects/covers/${level}-cover.webp`);

export const EFFECT_LIBRARY_COVERS: Record<PixelArtLevel, string> = {
  coarse: effectLibraryCover("coarse"),
  classic: effectLibraryCover("classic"),
  detailed: effectLibraryCover("detailed"),
};

export function effectLibraryCoverForLevel(level: PixelArtLevel = "classic"): string {
  return EFFECT_LIBRARY_COVERS[level];
}
