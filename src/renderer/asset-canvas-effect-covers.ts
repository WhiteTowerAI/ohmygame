import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import classicEffectLibraryCover from "./assets/templates/examples/effects/covers/classic-cover.webp";
import coarseEffectLibraryCover from "./assets/templates/examples/effects/covers/coarse-cover.webp";
import detailedEffectLibraryCover from "./assets/templates/examples/effects/covers/detailed-cover.webp";

export const EFFECT_LIBRARY_COVERS: Record<PixelArtLevel, string> = {
  coarse: coarseEffectLibraryCover,
  classic: classicEffectLibraryCover,
  detailed: detailedEffectLibraryCover,
};

export function effectLibraryCoverForLevel(level: PixelArtLevel = "classic"): string {
  return EFFECT_LIBRARY_COVERS[level];
}
