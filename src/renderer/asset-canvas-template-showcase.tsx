import type { AssetCanvasTemplate } from "./asset-canvas-templates.js";
import type { CanvasImagePreset } from "../shared/canvas-image-presets.js";
import {
  TEMPLATE_SAMPLE_IMAGES,
  type TemplateSample,
} from "./asset-canvas-template-samples.js";

const templateSamples: Record<AssetCanvasTemplate, readonly TemplateSample[]> =
  {
    "pixel-art": [
      "side-view-character",
      "rpg-character",
      "portrait",
      "monster",
      "animal",
      "scene",
      "terrain",
      "building",
      "prop",
      "icon",
    ],
    "character-sheet": ["character-sheet"],
    "quick-reskin": ["quick-reskin"],
    "free-sequence": ["continuous-sequence", "consistent-sequence"],
    "action-set": ["idle", "walk", "run", "attack", "hurt", "down"],
  };

export function TemplateDemo({
  template,
  preset,
}: {
  template: AssetCanvasTemplate;
  preset?: CanvasImagePreset;
}) {
  const samples = templateSamples[template].filter(
    (sample) => !preset || sample === preset,
  );
  return (
    <div
      className={`asset-template-demo${samples.length > 1 ? ` is-collage is-${template}` : ""}`}
      aria-hidden="true"
    >
      {samples.map((sample) => (
        <img
          key={sample}
          src={TEMPLATE_SAMPLE_IMAGES[sample]}
          alt=""
          draggable={false}
        />
      ))}
    </div>
  );
}
