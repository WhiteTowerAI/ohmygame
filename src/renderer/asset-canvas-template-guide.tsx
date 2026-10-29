import type { CanvasImagePreset } from "../shared/canvas-image-presets.js";
import { templateImagePresets, type AssetCanvasTemplate } from "./asset-canvas-templates.js";
import { TemplateDemo } from "./asset-canvas-template-showcase.js";
import { t } from "./i18n.js";
import { pixelAssetPresetLabel, pixelAssetPresetUsage, pixelAssetTemplatePresetIds, type PixelAssetTemplateCategory } from "./asset-canvas-pixel-workflows.js";

export function PixelAssetTemplateGuide({ category }: { category: PixelAssetTemplateCategory }) {
  return <div className="asset-template-guide-content pixel-template-guide-content nodrag nowheel">
    <p className="asset-template-guide-instruction">{t(`assetCanvas.pixelPresets.templateDescriptions.${category}`)}</p>
    <p className="asset-template-guide-instruction">{t("assetCanvas.pixelPresets.introduction")}</p>
    <dl className="pixel-template-guide-uses">
      {pixelAssetTemplatePresetIds(category).map((id) => <div key={id}>
        <dt>{pixelAssetPresetLabel(id)}</dt>
        <dd>{pixelAssetPresetUsage(id)}</dd>
      </div>)}
    </dl>
  </div>;
}

export function AssetCanvasTemplateGuide({ template }: {
  template: AssetCanvasTemplate;
}) {
  const presets = templateImagePresets(template);
  const showOptions = presets.length > 1;
  const showPreview = template !== "character-sheet";
  const description = (preset?: CanvasImagePreset) => {
    if (preset === "character-sheet") return t("assetCanvasTemplates.character-sheet.output");
    if (preset === "continuous-sequence" || preset === "consistent-sequence") {
      return t(`assetCanvasTemplates.free-sequence.${preset}.output`);
    }
    if (template === "pixel-art" && preset && preset !== "free" && preset !== "quick-reskin") {
      return t(`assetCanvasTemplates.pixel-art.samples.${preset}`);
    }
    if (template === "character-sheet") return t("assetCanvasTemplates.character-sheet.output");
    if (template === "quick-reskin") return t("assetCanvasTemplates.quick-reskin.output");
    if (template === "action-set") return t("assetCanvasTemplates.action-set.output");
  };

  return (
    <div className="asset-template-guide-content nodrag nowheel">
      {showPreview ? <div className="asset-template-guide-preview"><TemplateDemo template={template} /></div> : null}
      {showOptions ? <div className={`asset-template-guide-options${presets.length > 2 ? " is-compact" : ""}`} aria-label={t(`assetCanvasTemplates.${template}.title`)}>
        {presets.map((preset) => <div className="asset-template-guide-option" key={preset}>
          <span>{t(`assetCanvas.imagePresets.${preset}`)}</span>
          {description(preset) ? <p>{description(preset)}</p> : null}
        </div>)}
      </div> : null}
      <p className="asset-template-guide-instruction">{t(`assetCanvasTemplates.${template}.guide`)}</p>
      {!showOptions && description() ? <p className="asset-template-guide-instruction asset-template-guide-description">{description()}</p> : null}
    </div>
  );
}
