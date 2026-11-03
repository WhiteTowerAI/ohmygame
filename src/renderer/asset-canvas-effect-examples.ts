import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { EffectPresetId } from "./asset-canvas-effect-presets.js";
import coarseFireHit from "./assets/templates/examples/effects/coarse/fire-hit-sheet.png";
import coarseIceImpact from "./assets/templates/examples/effects/coarse/ice-impact-sheet.png";
import coarseWaveImpact from "./assets/templates/examples/effects/coarse/wave-impact-sheet.png";
import coarseWaterSplash from "./assets/templates/examples/effects/coarse/water-splash-sheet.png";
import coarseElectricOrb from "./assets/templates/examples/effects/coarse/electric-orb-burst-sheet.png";
import coarseLightningStrike from "./assets/templates/examples/effects/coarse/lightning-strike-sheet.png";
import coarseIceClaw from "./assets/templates/examples/effects/coarse/ice-claw-slash-sheet.png";
import coarseElectricTrail from "./assets/templates/examples/effects/coarse/electric-trail-sheet.png";
import coarseCrescent from "./assets/templates/examples/effects/coarse/blue-white-crescent-slash-sheet.png";
import coarseSmoke from "./assets/templates/examples/effects/coarse/smoke-dispersal-sheet.png";
import coarseGreenWave from "./assets/templates/examples/effects/coarse/green-energy-wave-sheet.png";
import coarseWaterOrb from "./assets/templates/examples/effects/coarse/water-orb-magic-sheet.png";
import classicFireHit from "./assets/templates/examples/effect-fire-hit-sheet.png";
import classicIceImpact from "./assets/templates/examples/effect-ice-impact-sheet.png";
import classicWaveImpact from "./assets/templates/examples/effect-wave-impact-sheet.png";
import classicWaterSplash from "./assets/templates/examples/effect-water-splash-sheet.png";
import classicElectricOrb from "./assets/templates/examples/effect-electric-orb-burst-sheet.png";
import classicLightningStrike from "./assets/templates/examples/effect-lightning-strike-sheet.png";
import classicIceClaw from "./assets/templates/examples/effect-ice-claw-slash-sheet.png";
import classicElectricTrail from "./assets/templates/examples/effect-electric-trail-sheet.png";
import classicCrescent from "./assets/templates/examples/effect-blue-white-crescent-slash-sheet.png";
import classicSmoke from "./assets/templates/examples/effect-smoke-dispersal-sheet.png";
import classicGreenWave from "./assets/templates/examples/effect-green-energy-wave-sheet.png";
import classicWaterOrb from "./assets/templates/examples/effect-water-orb-magic-sheet.png";
import detailedFireHit from "./assets/templates/examples/effects/detailed/fire-hit-sheet.png";
import detailedIceImpact from "./assets/templates/examples/effects/detailed/ice-impact-sheet.png";
import detailedWaveImpact from "./assets/templates/examples/effects/detailed/wave-impact-sheet.png";
import detailedWaterSplash from "./assets/templates/examples/effects/detailed/water-splash-sheet.png";
import detailedElectricOrb from "./assets/templates/examples/effects/detailed/electric-orb-burst-sheet.png";
import detailedLightningStrike from "./assets/templates/examples/effects/detailed/lightning-strike-sheet.png";
import detailedIceClaw from "./assets/templates/examples/effects/detailed/ice-claw-slash-sheet.png";
import detailedElectricTrail from "./assets/templates/examples/effects/detailed/electric-trail-sheet.png";
import detailedCrescent from "./assets/templates/examples/effects/detailed/blue-white-crescent-slash-sheet.png";
import detailedSmoke from "./assets/templates/examples/effects/detailed/smoke-dispersal-sheet.png";
import detailedGreenWave from "./assets/templates/examples/effects/detailed/green-energy-wave-sheet.png";
import detailedWaterOrb from "./assets/templates/examples/effects/detailed/water-orb-magic-sheet.png";

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

export function effectPresetExampleId(id: EffectPresetId, level: PixelArtLevel): string {
  return `effects/${level}/${id}`;
}

export function effectPresetExampleUrl(id: EffectPresetId, level: PixelArtLevel): string {
  return EFFECT_SHEET_IMAGES[level][id];
}

export function effectExampleImageUrl(id?: string): string | undefined {
  const match = id?.match(/^effects\/(coarse|classic|detailed)\/(.+)$/);
  if (!match) return undefined;
  const level = match[1] as PixelArtLevel;
  const presetId = match[2] as EffectPresetId;
  return EFFECT_SHEET_IMAGES[level]?.[presetId];
}
