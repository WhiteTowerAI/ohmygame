import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ImageModel } from "../shared/contracts.js";
import { Image as ImageIcon, Search, X } from "./icons.js";
import { pixelAssetPresetCatalog, pixelAssetPresetNeedsWorkflowGroup, pixelLabPresetCatalog, type PixelAssetPresetId, type PixelLabPresetId } from "./asset-canvas-pixel-workflows.js";
import { pixelExampleImageUrl, pixelPresetGifExampleId, pixelPresetPreviewUrl } from "./asset-canvas-pixel-examples.js";
import { EFFECT_PRESETS, effectPresetDescription, effectPresetLabel, type EffectPresetId } from "./asset-canvas-effect-presets.js";
import { effectPresetPreviewUrl } from "./asset-canvas-effect-examples.js";
import { t } from "./i18n.js";
import { TemplateExampleImage } from "./template-example-cache.js";

type AssetCanvasPixelPresetDialogProps = {
  imageModels: readonly ImageModel[];
  onClose: () => void;
  onSelect: (preset: PixelAssetPresetId) => void;
  onSelectEffect: (preset: EffectPresetId) => void;
  onSelectPixelLab: (preset: PixelLabPresetId) => void;
  /** Opens the PixelLab plugin's page, to add, turn on or update it. */
  onOpenPixelLab: () => void;
};

type PresetCard = {
  id: string;
  label: string;
  description: string;
  previewUrl?: string;
  square: boolean;
  tags: string[];
  disabled: boolean;
  select: () => void;
};
type PresetSection = { id: string; label: string; cards: PresetCard[] };
type PresetTab = { id: string; label: string; sections: PresetSection[] };

export function AssetCanvasPixelPresetDialog(props: AssetCanvasPixelPresetDialogProps) {
  const { onClose } = props;
  const [tabId, setTabId] = useState("characters");
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const pixelLab = pixelLabPresetCatalog(props.imageModels);
  const pixelLabMissing = pixelLab.every((group) => group.presets.every((preset) => preset.availability === "missing"));
  const pixelLabOutdated = pixelLab.some((group) => group.presets.some((preset) => preset.availability === "outdated"));
  const tabs: PresetTab[] = [
    ...pixelAssetPresetCatalog().map((category) => ({
      id: category.id,
      label: category.label,
      sections: [{
        id: category.id,
        label: category.label,
        cards: category.presets.map((preset): PresetCard => {
          const nodeCount = pixelAssetPresetNeedsWorkflowGroup(preset.id) ? 3 : 1;
          const previewUrl = pixelExampleImageUrl(pixelPresetGifExampleId(preset.id)) ?? pixelPresetPreviewUrl(preset.id);
          return {
            id: preset.id,
            label: preset.label,
            description: preset.description,
            ...(previewUrl ? { previewUrl } : {}),
            square: preset.category === "animation",
            tags: nodeCount > 1 ? [t("assetCanvas.pixelPresets.nodeCount", { count: nodeCount })] : [],
            disabled: false,
            select: () => props.onSelect(preset.id),
          };
        }),
      }],
    })),
    {
      id: "effects",
      label: t("assetCanvas.pixelPresets.categories.effects"),
      sections: [{
        id: "effects",
        label: t("assetCanvas.pixelPresets.categories.effects"),
        cards: EFFECT_PRESETS.map((preset): PresetCard => {
          const previewUrl = effectPresetPreviewUrl(preset.id);
          return {
            id: preset.id,
            label: effectPresetLabel(preset.id),
            description: effectPresetDescription(preset.id),
            ...(previewUrl ? { previewUrl } : {}),
            square: true,
            tags: [],
            disabled: false,
            select: () => props.onSelectEffect(preset.id),
          };
        }),
      }],
    },
    {
      id: "pixellab",
      label: t("assetCanvas.pixelPresets.categories.pixellab"),
      sections: pixelLabMissing ? [] : pixelLab.map((group) => ({
        id: `pixellab-${group.group}`,
        label: `PixelLab · ${group.label}`,
        cards: group.presets.map((preset): PresetCard => ({
          id: preset.id,
          label: preset.label,
          description: preset.description,
          square: false,
          tags: [t("assetCanvas.pixelPresets.pixellab.paid"), ...(preset.needsReference ? [t("assetCanvas.pixelPresets.pixellab.needsReference")] : [])],
          disabled: preset.availability !== "ready",
          select: () => props.onSelectPixelLab(preset.id),
        })),
      })),
    },
  ];
  const tab = tabs.find((item) => item.id === tabId) ?? tabs[0]!;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (card: PresetCard) => !normalizedQuery || `${card.label} ${card.description}`.toLocaleLowerCase().includes(normalizedQuery);
  const count = (item: PresetTab) => item.sections.reduce((total, section) => total + section.cards.filter(matches).length, 0);
  // A search looks through every category so a preset is found wherever it lives.
  const sections = (normalizedQuery ? tabs.flatMap((item) => item.sections) : tab.sections)
    .map((section) => ({ ...section, cards: section.cards.filter(matches) }))
    .filter((section) => !normalizedQuery || section.cards.length > 0);
  const pixelLabNotice = !normalizedQuery && tab.id === "pixellab" && (pixelLabMissing || pixelLabOutdated);

  useEffect(() => {
    const previousFocus = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : undefined;
    dialog.current?.querySelector<HTMLInputElement>("[data-pixel-preset-search]")?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  function moveCategory(event: ReactKeyboardEvent<HTMLElement>): void {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((item) => item.id === tab.id);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex]!;
    setTabId(next.id);
    window.document.getElementById(`pixel-preset-tab-${next.id}`)?.focus();
  }

  function containFocus(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && window.document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && window.document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return createPortal(
    <div className="pixel-preset-backdrop nokey" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="pixel-preset-dialog" role="dialog" aria-modal="true" aria-labelledby="pixel-preset-title" tabIndex={-1} ref={dialog} onKeyDown={containFocus}>
        <header>
          <h2 id="pixel-preset-title">{t("assetCanvas.pixelPresets.title")}</h2>
          <button type="button" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}><X size={17} /></button>
        </header>
        <div className="pixel-preset-toolbar">
          <label className="pixel-preset-search"><Search size={15} aria-hidden="true" /><input data-pixel-preset-search aria-label={t("assetCanvas.pixelPresets.search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("assetCanvas.pixelPresets.search")} /></label>
        </div>
        <div className="pixel-preset-browser">
          <nav role="tablist" aria-label={t("assetCanvas.pixelPresets.categoriesLabel")} onKeyDown={moveCategory}>
            {tabs.map((item) => <button id={`pixel-preset-tab-${item.id}`} key={item.id} type="button" role="tab" tabIndex={tab.id === item.id ? 0 : -1} aria-controls="pixel-preset-panel" aria-selected={!normalizedQuery && tab.id === item.id} onClick={() => { setTabId(item.id); setQuery(""); }}>{item.label}<span>{count(item)}</span></button>)}
          </nav>
          <div id="pixel-preset-panel" className="pixel-preset-results" role="tabpanel" tabIndex={0} aria-label={normalizedQuery ? t("assetCanvas.pixelPresets.search") : tab.label}>
            {pixelLabNotice ? <div className="pixel-preset-notice">
              <p>{pixelLabMissing ? t("assetCanvas.pixelPresets.pixellab.missing") : t("assetCanvas.pixelPresets.pixellab.outdated")}</p>
              <button type="button" onClick={props.onOpenPixelLab}>{pixelLabMissing ? t("assetCanvas.pixelPresets.pixellab.install") : t("assetCanvas.pixelPresets.pixellab.update")}</button>
            </div> : null}
            {sections.length ? sections.map((section) => <section key={section.id} aria-label={section.label}>
              <h3>{section.label}</h3>
              <div className="pixel-preset-grid">
                {section.cards.map((card) => <button key={card.id} type="button" disabled={card.disabled} onClick={card.select}>
                  <span className={`pixel-preset-card-thumbnail${card.square ? " is-square" : ""}`}>
                    {card.previewUrl ? <TemplateExampleImage src={card.previewUrl} alt="" loading="lazy" /> : <ImageIcon size={22} aria-hidden="true" />}
                  </span>
                  <span className="pixel-preset-card-body">
                    <strong>{card.label}</strong>
                    <small>{card.description}</small>
                    {card.tags.length ? <span className="pixel-preset-card-tags">{card.tags.map((tag) => <span key={tag}>{tag}</span>)}</span> : null}
                  </span>
                </button>)}
              </div>
            </section>) : pixelLabNotice ? null : <p className="pixel-preset-empty">{t("assetCanvas.pixelPresets.noMatches")}</p>}
          </div>
        </div>
        <footer><button type="button" onClick={onClose}>{t("common.cancel")}</button></footer>
      </section>
    </div>,
    window.document.body,
  );
}
