import type { CanvasImagePreset } from "../shared/canvas-image-presets.js";
import { templateImagePresets, type AssetCanvasTemplate } from "./asset-canvas-templates.js";
import { TemplateDemo } from "./asset-canvas-template-showcase.js";
import { t } from "./i18n.js";

export function AssetCanvasTemplateGuide({ template }: {
  template: AssetCanvasTemplate;
}) {
  const presets = templateImagePresets(template);
  const showOptions = presets.length > 1;
  const showPreview = template === "action-set";
  const description = (preset?: CanvasImagePreset) => {
    if (preset === "continuous-sequence" || preset === "consistent-sequence") {
      return t(`assetCanvasTemplates.free-sequence.${preset}.output`);
    }
    if (template === "pixel-art" && preset && preset !== "free" && preset !== "character-sheet" && preset !== "quick-reskin") {
      return t(`assetCanvasTemplates.pixel-art.samples.${preset}`);
    }
    if (template === "character-sheet") return t("assetCanvasTemplates.character-sheet.output");
    if (template === "quick-reskin") return t("assetCanvasTemplates.quick-reskin.output");
    if (template === "action-set") return t("assetCanvasTemplates.action-set.output");
  };

  return (
    <div className="asset-template-guide-content nodrag nowheel">
      {showOptions ? <div className={`asset-template-guide-options${presets.length > 2 ? " is-compact" : ""}`} aria-label={t(`assetCanvasTemplates.${template}.title`)}>
        {presets.map((preset) => <div className="asset-template-guide-option" key={preset}>
          <TemplateDemo template={template} preset={preset} />
          <span>{t(`assetCanvas.imagePresets.${preset}`)}</span>
          {description(preset) ? <p>{description(preset)}</p> : null}
        </div>)}
      </div> : null}
      {showPreview ? <div className="asset-template-guide-preview"><TemplateDemo template={template} /></div> : null}
      <p className="asset-template-guide-instruction">{t(`assetCanvasTemplates.${template}.guide`)}</p>
      {!showOptions && description() ? <p className="asset-template-guide-instruction asset-template-guide-description">{description()}</p> : null}
    </div>
  );
}
