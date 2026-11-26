import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AUDIO_KINDS, type AudioKind, type AudioModelCatalog } from "../shared/audio.js";
import { MEDIA_MODEL_USAGES, type MediaModelCatalog, type MediaModelDefaults, type MediaModelUsage, type ModelRef, type ProjectState } from "../shared/contracts.js";
import { listAudioModelCatalog, listImageModelCatalog, listModel3DCatalog, listVideoModelCatalog, MODELS_CHANGED_EVENT, setDefaultMediaModel, updateProjectMediaModelDefaults } from "./api.js";
import { CanvasChipSelect, type CanvasChipOption } from "./canvas-chip-select.js";
import { Spinner, SlidersHorizontal } from "./icons.js";
import { menuPlacement } from "./popover-placement.js";
import { t } from "./i18n.js";
import { SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";
import { chipMark, ProviderMark } from "./model-selector.js";
import { Select } from "./ui/index.js";

type Catalog = MediaModelCatalog<ModelRef & { name: string; providerName: string }>;
type Catalogs = Partial<Record<MediaModelUsage, Catalog>>;

const isAudioKind = (usage: MediaModelUsage): usage is AudioKind => (AUDIO_KINDS as readonly string[]).includes(usage);
const usageLabel = (usage: MediaModelUsage) => t(`mediaDefaults.usage.${usage}`);

/** One audio catalog as a catalog per kind: the models that make it, in the order the automatic choice takes them, and its default. */
function audioCatalog(audio: AudioModelCatalog, kind: AudioKind): Catalog {
  const models = audio.models.filter((model) => model.capabilities.produces.includes(kind));
  return {
    // Speech prefers a model that reads the text word for word.
    models: kind === "speech" ? [...models.filter((model) => model.capabilities.readsText), ...models.filter((model) => !model.capabilities.readsText)] : models,
    providers: [],
    ...(audio.defaultModels?.[kind] ? { defaultModel: audio.defaultModels[kind] } : {}),
  };
}

function useMediaModelCatalogs(enabled = true) {
  const [catalogs, setCatalogs] = useState<Catalogs>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      setLoading(true);
      void Promise.allSettled([listImageModelCatalog(), listVideoModelCatalog(), listModel3DCatalog(), listAudioModelCatalog()]).then(([image, video, model3D, audio]) => {
        if (!active || current !== revision) return;
        const loaded: Catalogs = {};
        let failure: string | undefined;
        for (const [usage, result] of [["image", image], ["video", video], ["3d", model3D]] as const) {
          if (result.status === "fulfilled") loaded[usage] = result.value;
          else failure ??= errorMessage(result.reason);
        }
        if (audio.status === "fulfilled") for (const kind of AUDIO_KINDS) loaded[kind] = audioCatalog(audio.value, kind);
        else failure ??= errorMessage(audio.reason);
        setCatalogs(loaded);
        setError(failure);
        setLoading(false);
      });
    };
    refresh();
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    return () => { active = false; window.removeEventListener(MODELS_CHANGED_EVENT, refresh); };
  }, [enabled]);
  return { catalogs, loading, error };
}

function ModelDefaultField({ usage, catalog, selected, inherit = false, loading, disabled, menuContainer, onChange }: {
  usage: MediaModelUsage; catalog?: Catalog; selected?: ModelRef; inherit?: boolean; disabled: boolean;
  loading: boolean;
  menuContainer?: HTMLElement | null;
  onChange: (model?: ModelRef) => void;
}) {
  const selectedModel = selected && catalog?.models.find((model) => modelKey(model) === modelKey(selected));
  const automatic = inherit ? catalog?.defaultModel ?? catalog?.models[0] : catalog?.models[0];
  const effective = automatic && catalog?.models.find((model) => modelKey(model) === modelKey(automatic));
  const effectiveLabel = !catalog ? loading ? t("mediaDefaults.loading") : t("mediaDefaults.unavailable") : effective?.name ?? (automatic ? t("mediaDefaults.modelUnavailable", { id: automatic.id }) : t("mediaDefaults.noModel"));
  const automaticLabel = catalog ? inherit ? t("mediaDefaults.useGlobal", { label: effectiveLabel }) : t("mediaDefaults.automatic", { label: effectiveLabel }) : effectiveLabel;
  const options: CanvasChipOption<string>[] = [
    { value: "", label: automaticLabel, shortLabel: effectiveLabel, ...(effective ? { mark: chipMark(effective) } : {}) },
    ...(selected && !selectedModel ? [{ value: modelKey(selected), label: t("mediaDefaults.modelUnavailable", { id: selected.id }), group: selected.provider }] : []),
    ...(catalog?.models.map((model) => ({ value: modelKey(model), label: model.name, group: model.providerName, mark: chipMark(model) })) ?? []),
  ];
  return <div className="media-default-field">
    <span>{usageLabel(usage)}</span>
    <CanvasChipSelect label={inherit ? t("mediaDefaults.projectModel", { usage: usageLabel(usage) }) : t("mediaDefaults.globalModel", { usage: usageLabel(usage) })}
      value={selected ? modelKey(selected) : ""} options={options} menuContainer={menuContainer}
      disabled={disabled || !catalog || (!catalog.models.length && !selected)}
      onChange={(value) => onChange(catalog?.models.find((model) => modelKey(model) === value))} />
  </div>;
}

/** One kind of generation in Providers: the kit select, each model with its provider's logo. */
function GlobalModelDefaultRow({ usage, catalog, loading, disabled, onChange }: {
  usage: MediaModelUsage; catalog?: Catalog; loading: boolean; disabled: boolean; onChange: (model?: ModelRef) => void;
}) {
  const label = usageLabel(usage);
  const selected = catalog?.defaultModel;
  const selectedModel = selected && catalog?.models.find((model) => modelKey(model) === modelKey(selected));
  const first = catalog?.models[0];
  const options = [
    ...(first ? [{ value: "", label: t("mediaDefaults.automatic", { label: first.name }), icon: <ProviderMark provider={first.provider} name={first.providerName} /> }] : []),
    ...(selected && !selectedModel ? [{ value: modelKey(selected), label: t("mediaDefaults.modelUnavailable", { id: selected.id }) }] : []),
    ...(catalog?.models.map((model) => ({ value: modelKey(model), label: model.name, description: model.providerName, icon: <ProviderMark provider={model.provider} name={model.providerName} /> })) ?? []),
  ];
  return <SettingsRow className="is-compact" title={label}>
    {!catalog ? <span className="settings-muted">{loading ? t("mediaDefaults.loading") : t("mediaDefaults.unavailable")}</span>
      : !options.length ? <span className="settings-muted">{t("mediaDefaults.connectFirst")}</span>
      : <span className={disabled ? "settings-select-busy" : undefined}>
        <Select size="sm" label={t("mediaDefaults.globalModel", { usage: label })} value={selected ? modelKey(selected) : ""} options={options}
          onChange={(value) => { if (!disabled) onChange(catalog.models.find((model) => modelKey(model) === value)); }} />
      </span>}
  </SettingsRow>;
}

/** A kind has a choice once a connected provider makes it, or a default is saved for it. */
function hasChoice(catalog: Catalog | undefined): boolean {
  return Boolean(catalog && (catalog.models.length || catalog.defaultModel));
}

/**
 * The default model per kind, one line each, for the kinds a connection makes.
 * The others stay out of the list until a provider makes them.
 * `leading` rows come first, such as the chat model, which Agents sets.
 */
export function GlobalMediaModelDefaults({ leading }: { leading?: ReactNode }) {
  const { catalogs, loading, error: loadError } = useMediaModelCatalogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = !loading || MEDIA_MODEL_USAGES.some((usage) => catalogs[usage]);
  const usable = MEDIA_MODEL_USAGES.filter((usage) => hasChoice(catalogs[usage]));
  async function choose(usage: MediaModelUsage, model?: ModelRef) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await setDefaultMediaModel(usage, model ? { provider: model.provider, id: model.id } : undefined); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <SettingsGroup className="settings-generation-defaults" label={t("mediaDefaults.globalDefaults")} title={t("mediaDefaults.title")}>
    {leading}
    {usable.map((usage) => <GlobalModelDefaultRow key={usage} usage={usage} catalog={catalogs[usage]} loading={loading} disabled={busy || loading} onChange={(model) => void choose(usage, model)} />)}
    {!ready ? <div className="settings-defaults-waiting"><Spinner size="sm" />{t("mediaDefaults.loading")}</div> : null}
    {error || loadError ? <div className="settings-pad"><SettingsNote tone="danger">{error ?? loadError}</SettingsNote></div> : null}
  </SettingsGroup>;
}

export function ProjectMediaModelSettings({ project, onSaved }: {
  project: ProjectState; onSaved: (project: ProjectState) => void;
}) {
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const { catalogs, loading, error: loadError } = useMediaModelCatalogs(open);
  const [defaults, setDefaults] = useState<MediaModelDefaults>(() => ({ ...project.mediaModelDefaults }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setDefaults({ ...project.mediaModelDefaults }); }, [project.mediaModelDefaults]);
  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return; }
    const anchor = trigger.current?.getBoundingClientRect();
    const bounds = popup?.getBoundingClientRect();
    if (anchor && bounds) setPosition(menuPlacement(anchor, bounds, { width: window.innerWidth, height: window.innerHeight }));
  }, [open, popup, loading, error, loadError]);
  useLayoutEffect(() => {
    if (open && position && document.activeElement === trigger.current) popup?.querySelector<HTMLButtonElement>(".canvas-chip")?.focus();
  }, [open, position, popup]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!popup?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
    };
  }, [open, popup]);

  async function choose(usage: MediaModelUsage, model?: ModelRef) {
    if (saving) return;
    setSaving(true); setError(undefined);
    const next = { ...defaults };
    if (model) next[usage] = { provider: model.provider, id: model.id };
    else delete next[usage];
    try {
      const updated = await updateProjectMediaModelDefaults(project.id, next);
      setDefaults({ ...updated.mediaModelDefaults });
      onSaved(updated);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  return <>
    <button ref={trigger} className="icon-button pane-header-action" type="button" title={t("mediaDefaults.title")} aria-label={t("mediaDefaults.title")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((next) => !next)}><SlidersHorizontal size="sm" /></button>
    {open ? createPortal(<div ref={setPopup} className="canvas-chip-menu project-media-defaults" role="dialog" aria-labelledby={titleId}
      style={position ?? { top: 0, left: 0, visibility: "hidden" }}>
      <div className="canvas-chip-menu-heading" id={titleId}>{t("mediaDefaults.title")}{saving ? <Spinner size="xs" aria-label={t("mediaDefaults.saving")} /> : null}</div>
      {MEDIA_MODEL_USAGES.filter((usage) => !isAudioKind(usage)).map((usage) => <ModelDefaultField key={usage} usage={usage} catalog={catalogs[usage]} selected={defaults[usage]} inherit loading={loading} disabled={saving || loading} menuContainer={popup} onChange={(model) => void choose(usage, model)} />)}
      <div role="group" aria-label={t("assetCanvas.node.audio")} className="media-default-audio-group">
        <div className="media-default-audio-label">{t("assetCanvas.node.audio")}</div>
        {AUDIO_KINDS.map((usage) => <ModelDefaultField key={usage} usage={usage} catalog={catalogs[usage]} selected={defaults[usage]} inherit loading={loading} disabled={saving || loading} menuContainer={popup} onChange={(model) => void choose(usage, model)} />)}
      </div>
      {error || loadError ? <p className="settings-error" role="alert">{error ?? loadError}</p> : null}
    </div>, document.body) : null}
  </>;
}

function modelKey(model: ModelRef): string { return JSON.stringify([model.provider, model.id]); }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
