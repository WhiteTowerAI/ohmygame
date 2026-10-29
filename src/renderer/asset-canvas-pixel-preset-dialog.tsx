import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Image as ImageIcon, Search, X } from "./icons.js";
import { pixelArtLevelOptions, pixelAssetPresetCatalog, pixelAssetPresetNeedsWorkflowGroup, type PixelAssetCategory, type PixelAssetPresetId } from "./asset-canvas-pixel-workflows.js";
import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { pixelExampleImageUrl, pixelPresetGifExampleId, pixelPresetPreviewUrl } from "./asset-canvas-pixel-examples.js";
import { t } from "./i18n.js";

type AssetCanvasPixelPresetDialogProps = { onClose: () => void; onSelect: (preset: PixelAssetPresetId, level: PixelArtLevel) => void };

export function AssetCanvasPixelPresetDialog(props: AssetCanvasPixelPresetDialogProps) {
  const { onClose } = props;
  const [categoryId, setCategoryId] = useState<PixelAssetCategory>("characters");
  const [level, setLevel] = useState<PixelArtLevel>("classic");
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const categories = pixelAssetPresetCatalog();
  const levels = pixelArtLevelOptions();
  const selectedLevel = levels.find((item) => item.value === level)!;
  const category = categories.find((item) => item.id === categoryId) ?? categories[0]!;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (preset: (typeof category.presets)[number]) => !normalizedQuery || `${preset.label} ${preset.description}`.toLocaleLowerCase().includes(normalizedQuery);
  // A search looks through every category so a preset is found wherever it lives.
  const sections = (normalizedQuery ? categories : [category])
    .map((item) => ({ ...item, presets: item.presets.filter(matches) }))
    .filter((item) => !normalizedQuery || item.presets.length > 0);

  function selectPreset(preset: PixelAssetPresetId): void {
    props.onSelect(preset, level);
  }

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
    const index = categories.findIndex((item) => item.id === category.id);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1
      : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + categories.length) % categories.length;
    const next = categories[nextIndex]!;
    setCategoryId(next.id);
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
          <div role="radiogroup" aria-label={t("assetCanvas.pixelPresets.level")} onKeyDown={(event) => {
            if (!["ArrowRight", "ArrowLeft"].includes(event.key)) return;
            event.preventDefault();
            const index = levels.findIndex((item) => item.value === level);
            const next = levels[(index + (event.key === "ArrowRight" ? 1 : -1) + levels.length) % levels.length]!;
            setLevel(next.value);
            window.document.getElementById(`pixel-preset-level-${next.value}`)?.focus();
          }}>
            {levels.map((item) => <button id={`pixel-preset-level-${item.value}`} key={item.value} type="button" role="radio" title={item.description} tabIndex={level === item.value ? 0 : -1} aria-checked={level === item.value} className={level === item.value ? "is-selected" : undefined} onClick={() => setLevel(item.value)}>{item.label}</button>)}
          </div>
          <small className="pixel-preset-level-description">{selectedLevel.description}</small>
          <label className="pixel-preset-search"><Search size={15} aria-hidden="true" /><input data-pixel-preset-search aria-label={t("assetCanvas.pixelPresets.search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("assetCanvas.pixelPresets.search")} /></label>
        </div>
        <div className="pixel-preset-browser">
          <nav role="tablist" aria-label={t("assetCanvas.pixelPresets.categoriesLabel")} onKeyDown={moveCategory}>
            {categories.map((item) => <button id={`pixel-preset-tab-${item.id}`} key={item.id} type="button" role="tab" tabIndex={category.id === item.id ? 0 : -1} aria-controls="pixel-preset-panel" aria-selected={!normalizedQuery && category.id === item.id} onClick={() => { setCategoryId(item.id); setQuery(""); }}>{item.label}<span>{item.presets.filter(matches).length}</span></button>)}
          </nav>
          <div id="pixel-preset-panel" className="pixel-preset-results" role="tabpanel" tabIndex={0} aria-label={normalizedQuery ? t("assetCanvas.pixelPresets.search") : category.label}>
            {sections.length ? sections.map((section) => <section key={section.id} aria-label={section.label}>
              <h3>{section.label}</h3>
              <div className="pixel-preset-grid">
                {section.presets.map((preset) => {
                  const previewUrl = pixelExampleImageUrl(pixelPresetGifExampleId(preset.id, level)) ?? pixelPresetPreviewUrl(preset.id, level);
                  const nodeCount = pixelAssetPresetNeedsWorkflowGroup(preset.id) ? 3 : 1;
                  return <button key={preset.id} type="button" onClick={() => selectPreset(preset.id)}>
                    <span className={`pixel-preset-card-thumbnail${preset.category === "animation" ? " is-square" : ""}`}>
                      {previewUrl ? <img src={previewUrl} alt="" loading="lazy" /> : <ImageIcon size={22} aria-hidden="true" />}
                    </span>
                    <span className="pixel-preset-card-body">
                      <strong>{preset.label}</strong>
                      <small>{preset.description}</small>
                      {nodeCount > 1 ? <span className="pixel-preset-card-tags"><span>{t("assetCanvas.pixelPresets.nodeCount", { count: nodeCount })}</span></span> : null}
                    </span>
                  </button>;
                })}
              </div>
            </section>) : <p className="pixel-preset-empty">{t("assetCanvas.pixelPresets.noMatches")}</p>}
          </div>
        </div>
        <footer><button type="button" onClick={onClose}>{t("common.cancel")}</button></footer>
      </section>
    </div>,
    window.document.body,
  );
}
