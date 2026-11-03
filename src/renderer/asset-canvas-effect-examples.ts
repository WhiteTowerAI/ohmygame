import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { EffectPresetId } from "./asset-canvas-effect-presets.js";
import coarseFireHit from "./assets/templates/examples/effects/coarse/fire-hit-sheet.webp";
import coarseIceImpact from "./assets/templates/examples/effects/coarse/ice-impact-sheet.webp";
import coarseWaveImpact from "./assets/templates/examples/effects/coarse/wave-impact-sheet.webp";
import coarseWaterSplash from "./assets/templates/examples/effects/coarse/water-splash-sheet.webp";
import coarseElectricOrb from "./assets/templates/examples/effects/coarse/electric-orb-burst-sheet.webp";
import coarseLightningStrike from "./assets/templates/examples/effects/coarse/lightning-strike-sheet.webp";
import coarseIceClaw from "./assets/templates/examples/effects/coarse/ice-claw-slash-sheet.webp";
import coarseElectricTrail from "./assets/templates/examples/effects/coarse/electric-trail-sheet.webp";
import coarseCrescent from "./assets/templates/examples/effects/coarse/blue-white-crescent-slash-sheet.webp";
import coarseSmoke from "./assets/templates/examples/effects/coarse/smoke-dispersal-sheet.webp";
import coarseGreenWave from "./assets/templates/examples/effects/coarse/green-energy-wave-sheet.webp";
import coarseWaterOrb from "./assets/templates/examples/effects/coarse/water-orb-magic-sheet.webp";
import classicFireHit from "./assets/templates/examples/effect-fire-hit-sheet.webp";
import classicIceImpact from "./assets/templates/examples/effect-ice-impact-sheet.webp";
import classicWaveImpact from "./assets/templates/examples/effect-wave-impact-sheet.webp";
import classicWaterSplash from "./assets/templates/examples/effect-water-splash-sheet.webp";
import classicElectricOrb from "./assets/templates/examples/effect-electric-orb-burst-sheet.webp";
import classicLightningStrike from "./assets/templates/examples/effect-lightning-strike-sheet.webp";
import classicIceClaw from "./assets/templates/examples/effect-ice-claw-slash-sheet.webp";
import classicElectricTrail from "./assets/templates/examples/effect-electric-trail-sheet.webp";
import classicCrescent from "./assets/templates/examples/effect-blue-white-crescent-slash-sheet.webp";
import classicSmoke from "./assets/templates/examples/effect-smoke-dispersal-sheet.webp";
import classicGreenWave from "./assets/templates/examples/effect-green-energy-wave-sheet.webp";
import classicWaterOrb from "./assets/templates/examples/effect-water-orb-magic-sheet.webp";
import detailedFireHit from "./assets/templates/examples/effects/detailed/fire-hit-sheet.webp";
import detailedIceImpact from "./assets/templates/examples/effects/detailed/ice-impact-sheet.webp";
import detailedWaveImpact from "./assets/templates/examples/effects/detailed/wave-impact-sheet.webp";
import detailedWaterSplash from "./assets/templates/examples/effects/detailed/water-splash-sheet.webp";
import detailedElectricOrb from "./assets/templates/examples/effects/detailed/electric-orb-burst-sheet.webp";
import detailedLightningStrike from "./assets/templates/examples/effects/detailed/lightning-strike-sheet.webp";
import detailedIceClaw from "./assets/templates/examples/effects/detailed/ice-claw-slash-sheet.webp";
import detailedElectricTrail from "./assets/templates/examples/effects/detailed/electric-trail-sheet.webp";
import detailedCrescent from "./assets/templates/examples/effects/detailed/blue-white-crescent-slash-sheet.webp";
import detailedSmoke from "./assets/templates/examples/effects/detailed/smoke-dispersal-sheet.webp";
import detailedGreenWave from "./assets/templates/examples/effects/detailed/green-energy-wave-sheet.webp";
import detailedWaterOrb from "./assets/templates/examples/effects/detailed/water-orb-magic-sheet.webp";
import coarseFireHitPreview from "./assets/templates/examples/effects/coarse/fire-hit-preview.gif";
import coarseIceImpactPreview from "./assets/templates/examples/effects/coarse/ice-impact-preview.gif";
import coarseWaveImpactPreview from "./assets/templates/examples/effects/coarse/wave-impact-preview.gif";
import coarseWaterSplashPreview from "./assets/templates/examples/effects/coarse/water-splash-preview.gif";
import coarseElectricOrbPreview from "./assets/templates/examples/effects/coarse/electric-orb-burst-preview.gif";
import coarseLightningStrikePreview from "./assets/templates/examples/effects/coarse/lightning-strike-preview.gif";
import coarseIceClawPreview from "./assets/templates/examples/effects/coarse/ice-claw-slash-preview.gif";
import coarseElectricTrailPreview from "./assets/templates/examples/effects/coarse/electric-trail-preview.gif";
import coarseCrescentPreview from "./assets/templates/examples/effects/coarse/blue-white-crescent-slash-preview.gif";
import coarseSmokePreview from "./assets/templates/examples/effects/coarse/smoke-dispersal-preview.gif";
import coarseGreenWavePreview from "./assets/templates/examples/effects/coarse/green-energy-wave-preview.gif";
import coarseWaterOrbPreview from "./assets/templates/examples/effects/coarse/water-orb-magic-preview.gif";
import classicFireHitPreview from "./assets/templates/examples/effect-fire-hit-preview.gif";
import classicIceImpactPreview from "./assets/templates/examples/effect-ice-impact-preview.gif";
import classicWaveImpactPreview from "./assets/templates/examples/effect-wave-impact-preview.gif";
import classicWaterSplashPreview from "./assets/templates/examples/effect-water-splash-preview.gif";
import classicElectricOrbPreview from "./assets/templates/examples/effect-electric-orb-burst-preview.gif";
import classicLightningStrikePreview from "./assets/templates/examples/effect-lightning-strike-preview.gif";
import classicIceClawPreview from "./assets/templates/examples/effect-ice-claw-slash-preview.gif";
import classicElectricTrailPreview from "./assets/templates/examples/effect-electric-trail-preview.gif";
import classicCrescentPreview from "./assets/templates/examples/effect-blue-white-crescent-slash-preview.gif";
import classicSmokePreview from "./assets/templates/examples/effect-smoke-dispersal-preview.gif";
import classicGreenWavePreview from "./assets/templates/examples/effect-green-energy-wave-preview.gif";
import classicWaterOrbPreview from "./assets/templates/examples/effect-water-orb-magic-preview.gif";
import detailedFireHitPreview from "./assets/templates/examples/effects/detailed/fire-hit-preview.gif";
import detailedIceImpactPreview from "./assets/templates/examples/effects/detailed/ice-impact-preview.gif";
import detailedWaveImpactPreview from "./assets/templates/examples/effects/detailed/wave-impact-preview.gif";
import detailedWaterSplashPreview from "./assets/templates/examples/effects/detailed/water-splash-preview.gif";
import detailedElectricOrbPreview from "./assets/templates/examples/effects/detailed/electric-orb-burst-preview.gif";
import detailedLightningStrikePreview from "./assets/templates/examples/effects/detailed/lightning-strike-preview.gif";
import detailedIceClawPreview from "./assets/templates/examples/effects/detailed/ice-claw-slash-preview.gif";
import detailedElectricTrailPreview from "./assets/templates/examples/effects/detailed/electric-trail-preview.gif";
import detailedCrescentPreview from "./assets/templates/examples/effects/detailed/blue-white-crescent-slash-preview.gif";
import detailedSmokePreview from "./assets/templates/examples/effects/detailed/smoke-dispersal-preview.gif";
import detailedGreenWavePreview from "./assets/templates/examples/effects/detailed/green-energy-wave-preview.gif";
import detailedWaterOrbPreview from "./assets/templates/examples/effects/detailed/water-orb-magic-preview.gif";

const byId = (fireHit: string, iceImpact: string, waveImpact: string, waterSplash: string, electricOrb: string, lightningStrike: string, iceClaw: string, electricTrail: string, crescent: string, smoke: string, greenWave: string, waterOrb: string): Record<EffectPresetId, string> => ({
  "fire-hit": fireHit,
  "ice-impact": iceImpact,
  "wave-impact": waveImpact,
  "water-splash": waterSplash,
  "electric-orb-burst": electricOrb,
  "lightning-strike": lightningStrike,
  "ice-claw-slash": iceClaw,
  "electric-trail": electricTrail,
  "blue-white-crescent-slash": crescent,
  "smoke-dispersal": smoke,
  "green-energy-wave": greenWave,
  "water-orb-magic": waterOrb,
});

const EFFECT_SHEET_IMAGES: Record<PixelArtLevel, Record<EffectPresetId, string>> = {
  coarse: byId(coarseFireHit, coarseIceImpact, coarseWaveImpact, coarseWaterSplash, coarseElectricOrb, coarseLightningStrike, coarseIceClaw, coarseElectricTrail, coarseCrescent, coarseSmoke, coarseGreenWave, coarseWaterOrb),
  classic: byId(classicFireHit, classicIceImpact, classicWaveImpact, classicWaterSplash, classicElectricOrb, classicLightningStrike, classicIceClaw, classicElectricTrail, classicCrescent, classicSmoke, classicGreenWave, classicWaterOrb),
  detailed: byId(detailedFireHit, detailedIceImpact, detailedWaveImpact, detailedWaterSplash, detailedElectricOrb, detailedLightningStrike, detailedIceClaw, detailedElectricTrail, detailedCrescent, detailedSmoke, detailedGreenWave, detailedWaterOrb),
};

const EFFECT_PREVIEW_IMAGES: Record<PixelArtLevel, Record<EffectPresetId, string>> = {
  coarse: byId(coarseFireHitPreview, coarseIceImpactPreview, coarseWaveImpactPreview, coarseWaterSplashPreview, coarseElectricOrbPreview, coarseLightningStrikePreview, coarseIceClawPreview, coarseElectricTrailPreview, coarseCrescentPreview, coarseSmokePreview, coarseGreenWavePreview, coarseWaterOrbPreview),
  classic: byId(classicFireHitPreview, classicIceImpactPreview, classicWaveImpactPreview, classicWaterSplashPreview, classicElectricOrbPreview, classicLightningStrikePreview, classicIceClawPreview, classicElectricTrailPreview, classicCrescentPreview, classicSmokePreview, classicGreenWavePreview, classicWaterOrbPreview),
  detailed: byId(detailedFireHitPreview, detailedIceImpactPreview, detailedWaveImpactPreview, detailedWaterSplashPreview, detailedElectricOrbPreview, detailedLightningStrikePreview, detailedIceClawPreview, detailedElectricTrailPreview, detailedCrescentPreview, detailedSmokePreview, detailedGreenWavePreview, detailedWaterOrbPreview),
};

export function effectPresetExampleId(id: EffectPresetId, level: PixelArtLevel): string {
  return `effects/${level}/${id}`;
}

export function effectPresetExampleUrl(id: EffectPresetId, level: PixelArtLevel): string {
  return EFFECT_SHEET_IMAGES[level][id];
}

export function effectPresetPreviewUrl(id: EffectPresetId, level: PixelArtLevel): string {
  return EFFECT_PREVIEW_IMAGES[level][id];
}

export function effectExampleImageUrl(id?: string): string | undefined {
  const match = id?.match(/^effects\/(coarse|classic|detailed)\/(.+)$/);
  if (!match) return undefined;
  const level = match[1] as PixelArtLevel;
  const presetId = match[2] as EffectPresetId;
  return EFFECT_SHEET_IMAGES[level]?.[presetId];
}
