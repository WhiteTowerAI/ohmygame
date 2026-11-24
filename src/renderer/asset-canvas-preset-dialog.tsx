import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ImageModel } from "../shared/contracts.js";
import { Image as ImageIcon, Search, X } from "./icons.js";
import { pixelAssetPresetCatalog, pixelAssetPresetNeedsWorkflowGroup, type PixelAssetPresetId } from "./asset-canvas-pixel-workflows.js";
import { pixelLabPresetCatalog, type PixelLabPresetId } from "./asset-canvas-pixellab-presets.js";
import { pixelExampleImageUrl, pixelPresetGifExampleId, pixelPresetPreviewUrl } from "./asset-canvas-pixel-examples.js";
import { EFFECT_PRESETS, effectPresetDescription, effectPresetLabel, type EffectPresetId } from "./asset-canvas-effect-presets.js";
import { effectPresetPreviewUrl } from "./asset-canvas-effect-examples.js";
import { t } from "./i18n.js";
import { TemplateExampleImage } from "./template-example-cache.js";

type AssetCanvasPresetDialogProps = {
  imageModels: readonly ImageModel[];
  onClose: () => void;
  onSelectPixel: (preset: PixelAssetPresetId) => void;
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
  /** Small pixel art shown enlarged, so it keeps hard pixel edges. */
  pixelated?: boolean;
  tags: string[];
  disabled: boolean;
  select: () => void;
};
type PresetCategory = { id: string; label: string; cards: PresetCard[] };
/** A set of presets in one style from one source, with its own categories. */
type PresetPack = {
  id: string;
  label: string;
  categories: PresetCategory[];
  notice?: { message: string; action: string; run: () => void };
};

export function AssetCanvasPresetDialog(props: AssetCanvasPresetDialogProps) {
  const { onClose } = props;
  const [packId, setPackId] = useState("pixel");
  const [categoryId, setCategoryId] = useState<string>();
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const packs = [pixelPack(props), pixelLabPack(props)];
  const pack = packs.find((item) => item.id === packId) ?? packs[0]!;
  const category = pack.categories.find((item) => item.id === categoryId) ?? pack.categories[0]!;
  // A pack with one category lists its cards without a category column.
  const flat = pack.categories.length === 1;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (card: PresetCard) => !normalizedQuery || `${card.label} ${card.description}`.toLocaleLowerCase().includes(normalizedQuery);
  // A search looks through every pack and category so a preset is found wherever it lives.
  const sections = (normalizedQuery
    ? packs.flatMap((item) => item.categories.map((candidate) => ({ ...candidate, id: `${item.id}-${candidate.id}`, label: item.categories.length === 1 ? item.label : `${item.label} · ${candidate.label}` })))
    : [category])
    .map((section) => ({ ...section, cards: section.cards.filter(matches) }))
    .filter((section) => !normalizedQuery || section.cards.length > 0);
  const notice = normalizedQuery ? undefined : pack.notice;

  useEffect(() => {
    const previousFocus = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : undefined;
    dialog.current?.querySelector<HTMLInputElement>("[data-canvas-preset-search]")?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  function choosePack(id: string): void {
    setPackId(id);
    setCategoryId(undefined);
    setQuery("");
  }

  function moveCategory(event: ReactKeyboardEvent<HTMLElement>): void {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const categories = pack.categories;
    const index = categories.findIndex((item) => item.id === category.id);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1
      : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + categories.length) % categories.length;
    const next = categories[nextIndex]!;
    setCategoryId(next.id);
    window.document.getElementById(`canvas-preset-tab-${next.id}`)?.focus();
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
    <div className="canvas-preset-backdrop nokey" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="canvas-preset-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-preset-title" tabIndex={-1} ref={dialog} onKeyDown={containFocus}>
        <header>
          <h2 id="canvas-preset-title">{t("assetCanvas.presets.title")}</h2>
          <button type="button" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}><X size={17} /></button>
        </header>
        <div className="canvas-preset-toolbar">
          <div className="canvas-preset-packs" role="group" aria-label={t("assetCanvas.presets.packsLabel")}>
            {packs.map((item) => <button key={item.id} type="button" aria-pressed={!normalizedQuery && item.id === pack.id} onClick={() => choosePack(item.id)}>{item.label}</button>)}
          </div>
          <label className="canvas-preset-search"><Search size={15} aria-hidden="true" /><input data-canvas-preset-search aria-label={t("assetCanvas.presets.search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("assetCanvas.presets.search")} /></label>
        </div>
        <div className={`canvas-preset-browser${flat ? " is-flat" : ""}`}>
          {flat ? null : <nav role="tablist" aria-label={t("assetCanvas.presets.categoriesLabel", { pack: pack.label })} onKeyDown={moveCategory}>
            {pack.categories.map((item) => <button id={`canvas-preset-tab-${item.id}`} key={item.id} type="button" role="tab" tabIndex={category.id === item.id ? 0 : -1} aria-controls="canvas-preset-panel" aria-selected={!normalizedQuery && category.id === item.id} onClick={() => { setCategoryId(item.id); setQuery(""); }}>{item.label}<span>{item.cards.filter(matches).length}</span></button>)}
          </nav>}
          <div id="canvas-preset-panel" className="canvas-preset-results" role={flat ? "region" : "tabpanel"} tabIndex={0} aria-label={normalizedQuery ? t("assetCanvas.presets.search") : category.label}>
            {notice ? <div className="canvas-preset-notice">
              <p>{notice.message}</p>
              <button type="button" onClick={notice.run}>{notice.action}</button>
            </div> : null}
            {sections.length ? sections.map((section) => <section key={section.id} aria-label={section.label}>
              {flat && !normalizedQuery ? null : <h3>{section.label}</h3>}
              <div className="canvas-preset-grid">
                {section.cards.map((card) => <button key={card.id} type="button" disabled={card.disabled} onClick={card.select}>
                  <span className={`canvas-preset-card-thumbnail${card.square ? " is-square" : ""}${card.pixelated ? " is-pixelated" : ""}`}>
                    {card.previewUrl ? <TemplateExampleImage src={card.previewUrl} alt="" loading="lazy" /> : <ImageIcon size={22} aria-hidden="true" />}
                  </span>
                  <span className="canvas-preset-card-body">
                    <strong>{card.label}</strong>
                    <small>{card.description}</small>
                    {card.tags.length ? <span className="canvas-preset-card-tags">{card.tags.map((tag) => <span key={tag}>{tag}</span>)}</span> : null}
                  </span>
                </button>)}
              </div>
            </section>) : <p className="canvas-preset-empty">{t("assetCanvas.presets.noMatches")}</p>}
          </div>
        </div>
        <footer><button type="button" onClick={onClose}>{t("common.cancel")}</button></footer>
      </section>
    </div>,
    window.document.body,
  );
}

/** Pixel art from the person's own image model, with a pixel style in each prompt. */
function pixelPack(props: AssetCanvasPresetDialogProps): PresetPack {
  return {
    id: "pixel",
    label: t("assetCanvas.presets.packs.pixel"),
    categories: [
      ...pixelAssetPresetCatalog().map((category) => ({
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
            select: () => props.onSelectPixel(preset.id),
          };
        }),
      })),
      {
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
      },
    ],
  };
}

/** One PixelLab plugin model each; shown, but not usable, until the plugin has them. */
function pixelLabPack(props: AssetCanvasPresetDialogProps): PresetPack {
  const presets = pixelLabPresetCatalog(props.imageModels);
  const missing = presets.every((preset) => preset.availability === "missing");
  const outdated = !missing && presets.some((preset) => preset.availability !== "ready");
  return {
    id: "pixellab",
    label: "PixelLab",
    // One list, in the order PixelLab's API page names its tools.
    categories: [{
      id: "pixellab",
      label: "PixelLab",
      cards: presets.map((preset): PresetCard => ({
        id: preset.id,
        label: preset.label,
        description: preset.description,
        ...(preset.previewUrl ? { previewUrl: preset.previewUrl } : {}),
        square: true,
        pixelated: true,
        tags: [t("assetCanvas.presets.pixellab.paid"), ...(preset.needsReference ? [t("assetCanvas.presets.pixellab.needsReference")] : [])],
        disabled: preset.availability !== "ready",
        select: () => props.onSelectPixelLab(preset.id),
      })),
    }],
    ...(missing || outdated ? {
      notice: {
        message: missing ? t("assetCanvas.presets.pixellab.missing") : t("assetCanvas.presets.pixellab.outdated"),
        action: missing ? t("assetCanvas.presets.pixellab.install") : t("assetCanvas.presets.pixellab.update"),
        run: props.onOpenPixelLab,
      },
    } : {}),
  };
}
