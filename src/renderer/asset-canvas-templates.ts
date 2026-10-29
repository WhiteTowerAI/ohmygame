import { CANVAS_IMAGE_PRESETS, type CanvasImagePreset } from "../shared/canvas-image-presets.js";

/** Legacy guide IDs remain readable for boards created by earlier versions. */
export const ASSET_CANVAS_TEMPLATES = [
  "pixel-art",
  "quick-reskin",
  "free-sequence",
  "action-set",
] as const;

export type AssetCanvasTemplate = (typeof ASSET_CANVAS_TEMPLATES)[number] | "character-sheet";

export function templateGuideInfo(instruction?: string): { template: AssetCanvasTemplate } | undefined {
  const legacy = instruction === "asset-canvas-template:free-image" || instruction === "asset-canvas-template:free-image:pixel"
    ? "pixel-art"
    : instruction === "asset-canvas-template:free-image:general" ? "character-sheet" : undefined;
  const template = legacy ?? [...ASSET_CANVAS_TEMPLATES, "character-sheet" as const]
    .find((candidate) => instruction === `asset-canvas-template:${candidate}`);
  return template ? { template } : undefined;
}

const SEQUENCE_PRESETS = ["continuous-sequence", "consistent-sequence"] as const;
const PIXEL_IMAGE_PRESETS = CANVAS_IMAGE_PRESETS.filter((preset) =>
  !["free", "continuous-sequence", "consistent-sequence", "quick-reskin"].includes(preset),
);

/** Presets shown in introduction nodes that are already saved on older boards. */
export function templateImagePresets(template?: AssetCanvasTemplate): readonly CanvasImagePreset[] {
  if (template === "free-sequence") return SEQUENCE_PRESETS;
  if (template === "pixel-art") return PIXEL_IMAGE_PRESETS;
  if (template === "character-sheet") return ["character-sheet"];
  if (template === "quick-reskin") return ["quick-reskin"];
  if (template === "action-set") return [];
  return CANVAS_IMAGE_PRESETS;
}
