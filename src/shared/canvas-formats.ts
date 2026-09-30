import type { Viewport } from "./contracts.js";

export type { Viewport };

export const CANVAS_FORMAT_PRESETS = [
  {
    id: "landscape",
    label: "Landscape",
    ratio: "16:9",
    viewport: { width: 1280, height: 720 },
  },
  {
    id: "portrait",
    label: "Portrait",
    ratio: "9:16",
    viewport: { width: 720, height: 1280 },
  },
  {
    id: "square",
    label: "Square",
    ratio: "1:1",
    viewport: { width: 1080, height: 1080 },
  },
] as const satisfies readonly {
  id: string;
  label: string;
  ratio: string;
  viewport: Viewport;
}[];

export type CanvasFormatPresetId = (typeof CANVAS_FORMAT_PRESETS)[number]["id"];

export function canvasFormatPreset(id: CanvasFormatPresetId) {
  return CANVAS_FORMAT_PRESETS.find((preset) => preset.id === id)!;
}

export function canvasFormatForViewport(viewport: Viewport) {
  return CANVAS_FORMAT_PRESETS.find(
    (preset) =>
      preset.viewport.width === viewport.width &&
      preset.viewport.height === viewport.height,
  );
}

export function viewportRatio(viewport: Viewport): string {
  const divisor = greatestCommonDivisor(viewport.width, viewport.height);
  return `${viewport.width / divisor}:${viewport.height / divisor}`;
}

export function canvasFormatSummary(viewport: Viewport): string {
  const preset = canvasFormatForViewport(viewport);
  return `${preset?.label ?? "Custom"} ${viewportRatio(viewport)} · ${viewport.width} x ${viewport.height}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.round(Math.abs(left));
  let b = Math.round(Math.abs(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}
