import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectCanvasPreset } from "../shared/plugins.js";
import { readProjectPluginCanvasPresetPreview } from "./api.js";
import { Image as ImageIcon, Search, X } from "./icons.js";
import { pixelWorkflowPresets, type PixelWorkflowPresetId } from "./asset-canvas-workflow-presets.js";
import { t } from "./i18n.js";
import { TemplateExampleImage } from "./template-example-cache.js";
import { useModal } from "./ui/index.js";

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
  coverUrl?: string;
  pluginPreviewId?: string;
  square: boolean;
  /** A short fact beside the name, such as how many nodes it adds. */
  meta?: string;
  select: () => void;
};
type PresetPack = {
  id: string;
  label: string;
  cards: PresetCard[];
};

export function AssetCanvasPresetDialog(props: AssetCanvasPresetDialogProps) {
  const { onClose } = props;
  const [packId, setPackId] = useState("pixel");
  const [query, setQuery] = useState("");
  const dialog = useModal(true, onClose);
  const titleId = useId();
  const packs = [pixelPack(props.onSelectWorkflow), ...pluginPacks(props)];
  const pack = packs.find((item) => item.id === packId) ?? packs[0]!;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results = normalizedQuery
    ? packs.map((item) => ({
      ...item,
      cards: item.cards.filter((card) => `${card.label} ${card.description}`.toLocaleLowerCase().includes(normalizedQuery)),
    })).filter((item) => item.cards.length)
    : [pack];

  return createPortal(
    <div className="canvas-preset-backdrop nokey" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="canvas-preset-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialog}>
        <header>
          <h2 id={titleId}>{t("assetCanvas.presets.title")}</h2>
          {/* Packs only need a switch once a plugin adds one beside the app's own. */}
          {packs.length > 1 ? <div className="canvas-preset-packs" role="group" aria-label={t("assetCanvas.presets.packsLabel")}>
            {packs.map((item) => <button key={item.id} type="button" aria-pressed={!normalizedQuery && item.id === pack.id} onClick={() => { setPackId(item.id); setQuery(""); }}>{item.label}</button>)}
          </div> : null}
          <button className="canvas-preset-close" type="button" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}><X size="md" /></button>
        </header>
        <div className="canvas-preset-toolbar">
          <label className="canvas-preset-search"><Search size="sm" aria-hidden="true" /><input data-modal-initial-focus aria-label={t("assetCanvas.presets.search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("assetCanvas.presets.search")} /></label>
        </div>
        <div className="canvas-preset-results" role="region" tabIndex={0} aria-label={normalizedQuery ? t("assetCanvas.presets.search") : pack.label}>
          {results.length ? results.map((item) => (
            <section key={item.id}>
              {normalizedQuery ? <h3>{item.label}</h3> : null}
              <div className="canvas-preset-grid">
                {item.cards.map((card) => <button key={card.id} type="button" title={card.description || undefined} onClick={card.select}>
                  <span className={`canvas-preset-card-thumbnail${card.square ? " is-square" : ""}`}>
                    {card.coverUrl ? <TemplateExampleImage src={card.coverUrl} alt="" />
                      : card.pluginPreviewId ? <PluginPresetPreview key={props.projectId} projectId={props.projectId} presetId={card.pluginPreviewId} />
                        : <ImageIcon size="lg" aria-hidden="true" />}
                  </span>
                  <span className="canvas-preset-card-body">
                    <strong>{card.label}</strong>
                    {card.meta ? <small>{card.meta}</small> : null}
                  </span>
                </button>)}
              </div>
            </section>
          )) : <p className="canvas-preset-empty">{t("assetCanvas.presets.noMatches")}</p>}
        </div>
      </div>
    </div>,
    window.document.body,
  );
}

/** The app's pixel art workflows, each made with the person's own image model. */
function pixelPack(onSelect: AssetCanvasPresetDialogProps["onSelectWorkflow"]): PresetPack {
  return {
    id: "pixel",
    label: t("assetCanvas.presets.packs.pixel"),
    cards: pixelWorkflowPresets().map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      coverUrl: preset.coverUrl,
      square: false,
      meta: t("assetCanvas.pixelPresets.nodeCount", { count: preset.nodeCount }),
      select: () => onSelect(preset.id),
    })),
  };
}

/** One pack for each plugin with presets, its presets in the order it lists them. */
function pluginPacks(props: AssetCanvasPresetDialogProps): PresetPack[] {
  const packs = new Map<string, PresetPack>();
  for (const preset of props.pluginPresets) {
    let pack = packs.get(preset.plugin);
    if (!pack) {
      pack = { id: `plugin:${preset.plugin}`, label: preset.pluginName, cards: [] };
      packs.set(preset.plugin, pack);
    }
    pack.cards.push({
      id: preset.id,
      label: preset.title,
      description: preset.description ?? "",
      ...(preset.preview ? { pluginPreviewId: preset.id } : {}),
      square: true,
      select: () => props.onSelectPlugin(preset),
    });
  }
  return [...packs.values()];
}

function PluginPresetPreview({ projectId, presetId }: { projectId: string; presetId: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void readProjectPluginCanvasPresetPreview(projectId, presetId, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }, () => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, presetId]);
  return url ? <img src={url} alt="" onLoad={pixelateSmall} /> : <ImageIcon size="lg" aria-hidden="true" />;
}

/** Small art shown enlarged keeps its hard pixel edges. */
function pixelateSmall(event: { currentTarget: HTMLImageElement }): void {
  const image = event.currentTarget;
  if (Math.max(image.naturalWidth, image.naturalHeight) <= 160) image.style.imageRendering = "pixelated";
}
