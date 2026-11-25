import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ProjectCanvasPreset } from "../shared/plugins.js";
import { readProjectPluginCanvasPresetPreview } from "./api.js";
import { Image as ImageIcon, Search, X } from "./icons.js";
import { createPixelWorkflowPreset, pixelWorkflowPresets, type PixelWorkflowPresetId } from "./asset-canvas-workflow-presets.js";
import { t } from "./i18n.js";
import { TemplateExampleImage } from "./template-example-cache.js";

type AssetCanvasPresetDialogProps = {
  projectId: string;
  /** What the project's active plugins offer, in the order they list them. */
  pluginPresets: readonly ProjectCanvasPreset[];
  onClose: () => void;
  onSelectWorkflow: (preset: PixelWorkflowPresetId) => void;
  onSelectPlugin: (preset: ProjectCanvasPreset) => void;
};

type PresetCard = {
  id: string;
  label: string;
  description: string;
  previewUrl?: string;
  /** The preview is a plugin's file, already read, rather than an example the app caches. */
  previewLoaded?: boolean;
  square: boolean;
  /** A short fact beside the name, such as how many nodes it adds. */
  meta?: string;
  select: () => void;
};
type PresetCategory = { id: string; label: string; cards: PresetCard[] };
/** A set of presets in one style from one source, with its own categories. */
type PresetPack = {
  id: string;
  label: string;
  categories: PresetCategory[];
};

export function AssetCanvasPresetDialog(props: AssetCanvasPresetDialogProps) {
  const { onClose } = props;
  const [packId, setPackId] = useState("pixel");
  const [categoryId, setCategoryId] = useState<string>();
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const previews = usePluginPresetPreviews(props.projectId, props.pluginPresets);
  const packs = [pixelPack(props), ...pluginPacks(props, previews)];
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
          {/* Packs only need a switch once a plugin adds one beside the app's own. */}
          {packs.length > 1 ? <div className="canvas-preset-packs" role="group" aria-label={t("assetCanvas.presets.packsLabel")}>
            {packs.map((item) => <button key={item.id} type="button" aria-pressed={!normalizedQuery && item.id === pack.id} onClick={() => choosePack(item.id)}>{item.label}</button>)}
          </div> : null}
          <button className="canvas-preset-close" type="button" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}><X size={17} /></button>
        </header>
        <div className="canvas-preset-toolbar">
          <label className="canvas-preset-search"><Search size={15} aria-hidden="true" /><input data-canvas-preset-search aria-label={t("assetCanvas.presets.search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("assetCanvas.presets.search")} /></label>
        </div>
        <div className={`canvas-preset-browser${flat ? " is-flat" : ""}`}>
          {flat ? null : <nav role="tablist" aria-label={t("assetCanvas.presets.categoriesLabel", { pack: pack.label })} onKeyDown={moveCategory}>
            {pack.categories.map((item) => <button id={`canvas-preset-tab-${item.id}`} key={item.id} type="button" role="tab" tabIndex={category.id === item.id ? 0 : -1} aria-controls="canvas-preset-panel" aria-selected={!normalizedQuery && category.id === item.id} onClick={() => { setCategoryId(item.id); setQuery(""); }}>{item.label}<span>{item.cards.filter(matches).length}</span></button>)}
          </nav>}
          <div id="canvas-preset-panel" className="canvas-preset-results" role={flat ? "region" : "tabpanel"} tabIndex={0} aria-label={normalizedQuery ? t("assetCanvas.presets.search") : category.label}>
            {sections.length ? sections.map((section) => <section key={section.id} aria-label={section.label}>
              {flat && !normalizedQuery ? null : <h3>{section.label}</h3>}
              <div className="canvas-preset-grid">
                {section.cards.map((card) => <button key={card.id} type="button" title={card.description || undefined} onClick={card.select}>
                  <span className={`canvas-preset-card-thumbnail${card.square ? " is-square" : ""}`}>
                    {card.previewUrl ? card.previewLoaded
                      ? <img src={card.previewUrl} alt="" onLoad={pixelateSmall} />
                      : <TemplateExampleImage src={card.previewUrl} alt="" />
                      : <ImageIcon size={22} aria-hidden="true" />}
                  </span>
                  <span className="canvas-preset-card-body">
                    <strong>{card.label}</strong>
                    {card.meta ? <small>{card.meta}</small> : null}
                  </span>
                </button>)}
              </div>
            </section>) : <p className="canvas-preset-empty">{t("assetCanvas.presets.noMatches")}</p>}
          </div>
        </div>
      </section>
    </div>,
    window.document.body,
  );
}

/** The app's pixel art workflows, each made with the person's own image model. */
function pixelPack(props: AssetCanvasPresetDialogProps): PresetPack {
  return {
    id: "pixel",
    label: t("assetCanvas.presets.packs.pixel"),
    categories: [{
      id: "pixel",
      label: t("assetCanvas.presets.packs.pixel"),
      cards: pixelWorkflowPresets().map((preset): PresetCard => ({
        id: preset.id,
        label: preset.label,
        description: preset.description,
        previewUrl: preset.coverUrl,
        square: false,
        meta: t("assetCanvas.pixelPresets.nodeCount", { count: createPixelWorkflowPreset(preset.id, []).nodes.length }),
        select: () => props.onSelectWorkflow(preset.id),
      })),
    }],
  };
}

/** One pack for each plugin with presets, its presets in the order it lists them. */
function pluginPacks(props: AssetCanvasPresetDialogProps, previews: ReadonlyMap<string, string>): PresetPack[] {
  const plugins = [...new Set(props.pluginPresets.map((preset) => preset.plugin))];
  return plugins.map((plugin): PresetPack => {
    const presets = props.pluginPresets.filter((preset) => preset.plugin === plugin);
    const label = presets[0]!.pluginName;
    return {
      id: `plugin:${plugin}`,
      label,
      categories: [{
        id: `plugin:${plugin}`,
        label,
        cards: presets.map((preset): PresetCard => {
          const previewUrl = previews.get(preset.id);
          return {
            id: preset.id,
            label: preset.title,
            description: preset.description ?? "",
            ...(previewUrl ? { previewUrl, previewLoaded: true } : {}),
            square: true,
            select: () => props.onSelectPlugin(preset),
          };
        }),
      }],
    };
  });
}

/** Reads the previews plugins give for their presets, while the dialog is open. */
function usePluginPresetPreviews(projectId: string, presets: readonly ProjectCanvasPreset[]): ReadonlyMap<string, string> {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const wanted = presets.filter((preset) => preset.preview).map((preset) => preset.id).join("\n");
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    const made: string[] = [];
    for (const id of wanted.split("\n"))
      readProjectPluginCanvasPresetPreview(projectId, id, controller.signal).then((blob) => {
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        made.push(url);
        setUrls((current) => new Map(current).set(id, url));
      }, () => undefined);
    return () => {
      controller.abort();
      for (const url of made) URL.revokeObjectURL(url);
      setUrls(new Map());
    };
  }, [projectId, wanted]);
  return urls;
}

/** Small art shown enlarged keeps its hard pixel edges. */
function pixelateSmall(event: { currentTarget: HTMLImageElement }): void {
  const image = event.currentTarget;
  if (Math.max(image.naturalWidth, image.naturalHeight) <= 160) image.style.imageRendering = "pixelated";
}
