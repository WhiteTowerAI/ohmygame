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
