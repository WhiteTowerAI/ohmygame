import { t } from "./i18n.js";
import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { ImageAspectRatio } from "../shared/contracts.js";
import { effectPresetExampleId } from "./asset-canvas-effect-examples.js";

export const EFFECT_PRESETS = [
  { id: "fire-hit", name: "火焰", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "火焰爆发并化为余烬的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for a compact pixel-art fire impact. Read cells left to right, top to bottom: ignition, expanding flame burst, scattered sparks, fading embers. Use a compact white-hot core, separately articulated narrow yellow and gold inner flame tongues, orange mid-flames, a deep crimson outer rim, small charcoal ember pockets, and tiny square cinders. Preserve dense internal flame striations and stepped pixel contours; never use a smoky, muddy, broad flat red mass. Transparent background, no labels, no borders, fixed center." },
  { id: "ice-impact", name: "冰霜", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "冰晶爆发、碎片飞散并消退的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for a blue ice impact. Read cells left to right, top to bottom: cyan spark, crystal formation, ice burst, shards scatter, frost fades. Transparent background, no labels, no borders, fixed center." },
  { id: "wave-impact", name: "浪花", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "海浪卷起、拍击并回落的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for a powerful pixel-art ocean wave impact. Read cells left to right, top to bottom: wave forms, crest rises, wave crashes, foam and droplets scatter, then retreat. Transparent background, no labels, no borders, fixed center." },
  { id: "water-splash", name: "水花", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "水滴落下、溅起并形成涟漪的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for a pixel-art water droplet splash. Read cells left to right, top to bottom: droplet falls, impact, expanding splash arcs, droplets fall, ripples fade. Transparent background, no labels, no borders, fixed ground point." },
  { id: "electric-orb-burst", name: "雷球", frames: "3 × 4 · 12 帧", grid: { columns: 3, rows: 4 }, description: "雷球蓄能、爆发并分解为电弧的 12 帧特效图集。", prompt: "Create one complete 3-column by 4-row sprite sheet for a spinning pixel-art electric orb that bursts into lightning fragments. Read cells left to right, top to bottom: sparks gather, orb charges, electric burst, fragments scatter, sparks fade. Transparent background, no labels, no borders, fixed center." },
  { id: "lightning-strike", name: "雷点", frames: "5 × 2 · 10 帧", grid: { columns: 5, rows: 2 }, description: "雷电下落、落点爆发并消散的 10 帧特效图集。", prompt: "Create one complete 5-column by 2-row sprite sheet for a pixel-art lightning strike impact. Read cells left to right, top to bottom: charge glow, bolt descends, impact branches, residual sparks fade. Transparent background, no labels, no borders, fixed impact point." },
  { id: "ice-claw-slash", name: "寒冰爪痕", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "三道寒冰爪痕斩击并碎裂的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for a three-claw pixel-art ice slash. Read cells left to right, top to bottom: frost glint, parallel diagonal claw marks form, sharp slash peaks, shards scatter, frost fades. Transparent background, no labels, no borders, fixed center." },
  { id: "electric-trail", name: "电光拖尾", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "电能冲刺形成拖尾并分解的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for an electric dash with a glowing lightning trail. Read cells left to right, top to bottom: spark, charge core, bright horizontal dash trail, branching fragments, sparks fade. Use a hairline white-cyan lightning core, independently articulated thin blue-violet branches, dark navy gaps, stepped micro-pixel bends, cyan rim highlights, segmented afterimage trails, and tiny square charged dust. Keep the energy as precise filaments, never a chunky blob or a broad flat blue slab. Transparent background, no labels, no borders, fixed center." },
  { id: "blue-white-crescent-slash", name: "蓝白弧斩", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "蓝白能量弧沿曲线挥斩的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for a blue-white crescent energy slash. Read cells left to right, top to bottom: small crescent forms, sweeps in a curved arc, reaches a bright peak, then breaks into particles. Build one elegant thin crescent with a razor-sharp white-blue core line, separately articulated cyan and royal-blue energy ribbons, dark navy occlusion gaps, segmented edge highlights, tapered fragments, and tiny square sparks. Keep dense internal striations and finely stepped pixel contours; never use a chunky broad blue swoosh or a flat slab. Transparent background, no labels, no borders, fixed center." },
  { id: "smoke-dispersal", name: "烟团", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "烟团聚集、膨胀并消散的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for a gray pixel-art smoke puff dispersal. Read cells left to right, top to bottom: smoke appears, expands into rounded puffs, separates into wisps, then fades. Transparent background, no labels, no borders, fixed center." },
  { id: "green-energy-wave", name: "绿色聚能波", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "绿色能量汇聚成波并扩散的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for a green energy wave. Read cells left to right, top to bottom: fragments gather, vortex forms, orb compresses, energy ring expands, particles fade. Transparent background, no labels, no borders, fixed center." },
  { id: "water-orb-magic", name: "水球魔法", frames: "4 × 3 · 12 帧", grid: { columns: 4, rows: 3 }, description: "水球凝聚、发射并散开的 12 帧特效图集。", prompt: "Create one complete 4-column by 3-row sprite sheet for a blue water orb magic launch. Read cells left to right, top to bottom: droplets gather, orb forms and charges, launches leftward, splits into droplets, then disperses. Transparent background, no labels, no borders, fixed center." },
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

export function effectPresetAspectRatio(id: EffectPresetId): ImageAspectRatio {
  const { columns, rows } = effectPresetById(id).grid;
  if (columns < rows) return "3:4";
  if (columns / rows >= 2) return "21:9";
  return "4:3";
}

export function effectPresetById(id: EffectPresetId) {
  return EFFECT_PRESETS.find((preset) => preset.id === id)!;
}
