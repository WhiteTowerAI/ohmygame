import { useEffect, useState } from "react";
import type { ProjectCanvasPreset } from "../shared/plugins.js";
import { readProjectPluginCanvasPresetPreview } from "./api.js";
import { Image as ImageIcon } from "./icons.js";
import { pixelWorkflowPresets, type PixelWorkflowPresetId } from "./asset-canvas-workflow-presets.js";
import { t } from "./i18n.js";
import { TemplateExampleImage } from "./template-example-cache.js";
import { Dialog, SearchInput, SegmentedControl } from "./ui/index.js";

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
  const packs = [pixelPack(props.onSelectWorkflow), ...pluginPacks(props)];
  const pack = packs.find((item) => item.id === packId) ?? packs[0]!;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results = normalizedQuery
    ? packs.map((item) => ({
      ...item,
      cards: item.cards.filter((card) => `${card.label} ${card.description}`.toLocaleLowerCase().includes(normalizedQuery)),
    })).filter((item) => item.cards.length)
    : [pack];

  return (
    <Dialog open size="lg" className="canvas-preset-dialog nokey" title={t("assetCanvas.presets.title")} onClose={onClose}>
      <div className="canvas-preset-toolbar">
        {/* Packs only need a switch once a plugin adds one beside the app's own. */}
        {packs.length > 1 ? <SegmentedControl size="sm" label={t("assetCanvas.presets.packsLabel")} value={normalizedQuery ? "" : pack.id}
          options={packs.map((item) => ({ value: item.id, label: item.label }))}
          onChange={(value) => { setPackId(value); setQuery(""); }} /> : null}
        <div className="canvas-preset-search">
          <SearchInput size="sm" initialFocus value={query} onChange={setQuery} label={t("assetCanvas.presets.search")} placeholder={t("assetCanvas.presets.search")} />
        </div>
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
    </Dialog>
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
