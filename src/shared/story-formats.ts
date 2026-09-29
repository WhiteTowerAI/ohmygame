export interface StoryViewport {
  width: number;
  height: number;
}

export const STORY_FORMAT_PRESETS = [
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
  viewport: StoryViewport;
}[];

export type StoryFormatPresetId = (typeof STORY_FORMAT_PRESETS)[number]["id"];

export function storyFormatPreset(id: StoryFormatPresetId) {
  return STORY_FORMAT_PRESETS.find((preset) => preset.id === id)!;
}

export function storyFormatForViewport(viewport: StoryViewport) {
  return STORY_FORMAT_PRESETS.find(
    (preset) =>
      preset.viewport.width === viewport.width &&
      preset.viewport.height === viewport.height,
  );
}

export function storyViewportRatio(viewport: StoryViewport): string {
  const divisor = greatestCommonDivisor(viewport.width, viewport.height);
  return `${viewport.width / divisor}:${viewport.height / divisor}`;
}

export function storyFormatSummary(viewport: StoryViewport): string {
  const preset = storyFormatForViewport(viewport);
  return `${preset?.label ?? "Custom"} ${storyViewportRatio(viewport)} · ${viewport.width} x ${viewport.height}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.round(Math.abs(left));
  let b = Math.round(Math.abs(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}
