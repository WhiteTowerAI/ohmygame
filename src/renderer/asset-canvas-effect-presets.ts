import { t } from "./i18n.js";

/**
 * The effects the app has example sheets and GIFs for, with each sheet's grid.
 * The Effects preset shows fire-hit; canvases from before it show any of them.
 */
export const EFFECT_PRESETS = [
  { id: "fire-hit", grid: { columns: 4, rows: 3 } },
  { id: "ice-impact", grid: { columns: 4, rows: 3 } },
  { id: "wave-impact", grid: { columns: 4, rows: 3 } },
  { id: "water-splash", grid: { columns: 4, rows: 3 } },
  { id: "electric-orb-burst", grid: { columns: 3, rows: 4 } },
  { id: "lightning-strike", grid: { columns: 5, rows: 2 } },
  { id: "ice-claw-slash", grid: { columns: 4, rows: 3 } },
  { id: "electric-trail", grid: { columns: 4, rows: 3 } },
  { id: "blue-white-crescent-slash", grid: { columns: 4, rows: 3 } },
  { id: "smoke-dispersal", grid: { columns: 4, rows: 3 } },
  { id: "green-energy-wave", grid: { columns: 4, rows: 3 } },
  { id: "water-orb-magic", grid: { columns: 4, rows: 3 } },
] as const;

export type EffectPresetId = (typeof EFFECT_PRESETS)[number]["id"];

/** The sheet's grid and frame count, such as "4 × 3 · 12 frames". */
export function effectPresetFrames(id: EffectPresetId): string {
  const { columns, rows } = EFFECT_PRESETS.find((preset) => preset.id === id)!.grid;
  return t("effectLibrary.frameGrid", { columns, rows, count: columns * rows });
}
