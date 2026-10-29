import type { AssetCanvasTemplate } from "./asset-canvas-templates.js";
import { TEMPLATE_COVER_IMAGES } from "./asset-canvas-template-samples.js";

export function TemplateDemo({ template }: { template: AssetCanvasTemplate }) {
  return (
    <div className="asset-template-demo" aria-hidden="true">
      <img src={TEMPLATE_COVER_IMAGES[template]} alt="" draggable={false} />
    </div>
  );
}
