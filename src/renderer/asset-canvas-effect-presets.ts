import { t } from "./i18n.js";
import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { ImageAspectRatio } from "../shared/contracts.js";
import { effectPresetExampleId } from "./asset-canvas-effect-examples.js";

export const EFFECT_PRESETS = [
  { id: "fire-hit",  grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for a compact pixel-art fire impact. Read cells left to right, top to bottom: ignition, expanding flame burst, scattered sparks, fading embers. Use a compact white-hot core, separately articulated narrow yellow and gold inner flame tongues, orange mid-flames, a deep crimson outer rim, small charcoal ember pockets, and tiny square cinders. Preserve dense internal flame striations and stepped pixel contours; never use a smoky, muddy, broad flat red mass. Transparent background, no labels, no borders, fixed center." },  { id: "ice-impact", grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for a blue ice impact. Read cells left to right, top to bottom: cyan spark, crystal formation, ice burst, shards scatter, frost fades. Transparent background, no labels, no borders, fixed center." },
  { id: "wave-impact", grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for a powerful pixel-art ocean wave impact. Read cells left to right, top to bottom: wave forms, crest rises, wave crashes, foam and droplets scatter, then retreat. Transparent background, no labels, no borders, fixed center." },
  { id: "water-splash", grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for a pixel-art water droplet splash. Read cells left to right, top to bottom: droplet falls, impact, expanding splash arcs, droplets fall, ripples fade. Transparent background, no labels, no borders, fixed ground point." },
  { id: "electric-orb-burst", grid: { columns: 3, rows: 4 }, prompt: "Create one complete 3-column by 4-row sprite sheet for a spinning pixel-art electric orb that bursts into lightning fragments. Read cells left to right, top to bottom: sparks gather, orb charges, electric burst, fragments scatter, sparks fade. Transparent background, no labels, no borders, fixed center." },
  { id: "lightning-strike", grid: { columns: 5, rows: 2 }, prompt: "Create one complete 5-column by 2-row sprite sheet for a pixel-art lightning strike impact. Read cells left to right, top to bottom: charge glow, bolt descends, impact branches, residual sparks fade. Transparent background, no labels, no borders, fixed impact point." },
  { id: "ice-claw-slash", grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for a three-claw pixel-art ice slash. Read cells left to right, top to bottom: frost glint, parallel diagonal claw marks form, sharp slash peaks, shards scatter, frost fades. Transparent background, no labels, no borders, fixed center." },
  { id: "electric-trail", grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for an electric dash with a glowing lightning trail. Read cells left to right, top to bottom: spark, charge core, bright horizontal dash trail, branching fragments, sparks fade. Transparent background, no labels, no borders, fixed center." },
  { id: "blue-white-crescent-slash", grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for a blue-white crescent energy slash. Read cells left to right, top to bottom: small crescent forms, sweeps in a curved arc, reaches a bright peak, then breaks into particles. Transparent background, no labels, no borders, fixed center." },
  { id: "smoke-dispersal", grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for a gray pixel-art smoke puff dispersal. Read cells left to right, top to bottom: smoke appears, expands into rounded puffs, separates into wisps, then fades. Transparent background, no labels, no borders, fixed center." },
  { id: "green-energy-wave", grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for a green energy wave. Read cells left to right, top to bottom: fragments gather, vortex forms, orb compresses, energy ring expands, particles fade. Transparent background, no labels, no borders, fixed center." },
  { id: "water-orb-magic", grid: { columns: 4, rows: 3 }, prompt: "Create one complete 4-column by 3-row sprite sheet for a blue water orb magic launch. Read cells left to right, top to bottom: droplets gather, orb forms and charges, launches leftward, splits into droplets, then disperses. Transparent background, no labels, no borders, fixed center." },
] as const;

export type EffectPresetId = (typeof EFFECT_PRESETS)[number]["id"];

export function effectPresetLabel(id: EffectPresetId): string {
  return t(`assetCanvas.pixelPresets.effectPresets.${id}.label` as never);
}

export function effectPresetDescription(id: EffectPresetId): string {
  return t(`assetCanvas.pixelPresets.effectPresets.${id}.description` as never);
}

export function effectPresetStaticExampleId(id: EffectPresetId, level: PixelArtLevel): string {
  return effectPresetExampleId(id, level);
}

/** The sheet's grid and frame count, such as "4 × 3 · 12 frames". */
export function effectPresetFrames(id: EffectPresetId): string {
  const { columns, rows } = effectPresetById(id).grid;
  return t("effectLibrary.frameGrid", { columns, rows, count: columns * rows });
}

export function effectPresetAspectRatio(id: EffectPresetId): ImageAspectRatio {
  const { columns, rows } = effectPresetById(id).grid;
  if (columns < rows) return "3:4";
  if (columns / rows >= 2) return "21:9";
  return "4:3";
}

export function effectPresetById(id: EffectPresetId) {
  return EFFECT_PRESETS.find((preset) => preset.id === id)!;
}
