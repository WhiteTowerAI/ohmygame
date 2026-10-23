import { useState } from "react";
import type { CanvasImagePreset } from "../shared/canvas-image-presets.js";
import { templateImagePresets, type AssetCanvasTemplate } from "./asset-canvas-templates.js";
import { TemplateDemo } from "./asset-canvas-template-showcase.js";
import { Plus } from "./icons.js";
import { t } from "./i18n.js";

export interface TemplateGuideRuntime {
  onAdd: (preset: CanvasImagePreset) => void;
}

export function AssetCanvasTemplateGuide({ template, runtime }: {
  template: AssetCanvasTemplate;
  runtime?: TemplateGuideRuntime;
}) {
  const presets = templateImagePresets(template);
  const [selection, setSelection] = useState<CanvasImagePreset>();
  const selected = selection && presets.includes(selection) ? selection : presets[0];
  const description = selected === "continuous-sequence" || selected === "consistent-sequence"
    ? t(`assetCanvasTemplates.free-sequence.${selected}.output`)
    : template === "pixel-art" && selected && selected !== "free" && selected !== "character-sheet" && selected !== "quick-reskin"
      ? t(`assetCanvasTemplates.pixel-art.samples.${selected}`)
      : template === "character-sheet" ? t("assetCanvasTemplates.character-sheet.output")
        : template === "quick-reskin" ? t("assetCanvasTemplates.quick-reskin.output")
      : template === "action-set" ? t("assetCanvasTemplates.action-set.output") : undefined;

  return (
    <div className="asset-template-guide-content nodrag nowheel">
      {presets.length > 1 ? <div className={`asset-template-guide-options${presets.length > 2 ? " is-compact" : ""}`} aria-label={t(`assetCanvasTemplates.${template}.title`)}>
        {presets.map((preset) => <button type="button" key={preset} aria-pressed={selected === preset} onClick={() => setSelection(preset)}>
          <TemplateDemo template={template} preset={preset} />
          <span>{t(`assetCanvas.imagePresets.${preset}`)}</span>
        </button>)}
      </div> : null}
      <div className="asset-template-guide-preview"><TemplateDemo template={template} preset={selected} /></div>
      <p className="asset-template-guide-instruction">{t(`assetCanvasTemplates.${template}.guide`)}</p>
      {description ? <p className="asset-template-guide-instruction asset-template-guide-description">{description}</p> : null}
      <small className="asset-template-guide-disclaimer">{t("assetCanvasTemplates.layoutPreview")}</small>
      {runtime && selected ? <button type="button" className="asset-template-guide-add" onClick={() => runtime.onAdd(selected)}><Plus size={14} />{t("assetCanvasTemplates.addToCanvas")}</button> : null}
    </div>
  );
}
