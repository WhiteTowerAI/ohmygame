import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MediaModelCatalog, MediaModelDefaults, MediaModelUsage, ModelRef, ProjectState, ProviderCapability } from "../shared/contracts.js";
import { MODEL_USAGE_LABELS } from "../shared/custom-models.js";
import { listImageModelCatalog, listModel3DCatalog, listVideoModelCatalog, MODELS_CHANGED_EVENT, setDefaultMediaModel, updateProjectMediaModelDefaults } from "./api.js";
import { CanvasChipSelect, type CanvasChipOption } from "./canvas-chip-select.js";
import { LoaderCircle, Settings } from "./icons.js";
import { menuPlacement } from "./popover-placement.js";

const USAGES = ["image", "video", "3d"] as const;
type Catalog = MediaModelCatalog<ModelRef & { name: string; providerName: string }>;
type Catalogs = Partial<Record<MediaModelUsage, Catalog>>;

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
      void Promise.allSettled([listImageModelCatalog(), listVideoModelCatalog(), listModel3DCatalog()]).then((results) => {
        if (!active || current !== revision) return;
        const loaded: Catalogs = {};
        let failure: string | undefined;
        results.forEach((result, index) => {
          if (result.status === "fulfilled") loaded[USAGES[index]!] = result.value;
          else failure ??= errorMessage(result.reason);
        });
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
  const effectiveLabel = !catalog ? loading ? "Loading models…" : "Models unavailable" : effective?.name ?? (automatic ? `${automatic.id} · Unavailable` : "No model available");
  const automaticLabel = catalog ? `${inherit ? "Use global" : "Automatic"} · ${effectiveLabel}` : effectiveLabel;
  const options: CanvasChipOption<string>[] = [
    { value: "", label: automaticLabel, shortLabel: effectiveLabel },
    ...(selected && !selectedModel ? [{ value: modelKey(selected), label: `${selected.id} · Unavailable`, group: selected.provider }] : []),
    ...(catalog?.models.map((model) => ({ value: modelKey(model), label: model.name, group: model.providerName })) ?? []),
  ];
  return <div className="media-default-field">
    <span>{MODEL_USAGE_LABELS[usage]}</span>
    <CanvasChipSelect label={`${inherit ? "Project" : "Global default"} ${MODEL_USAGE_LABELS[usage]} model`}
      value={selected ? modelKey(selected) : ""} options={options} menuContainer={menuContainer}
      disabled={disabled || !catalog || (!catalog.models.length && !selected)}
      onChange={(value) => onChange(catalog?.models.find((model) => modelKey(model) === value))} />
  </div>;
}

export function GlobalMediaModelDefaults({ capability }: { capability: "all" | ProviderCapability }) {
  const { catalogs, loading, error: loadError } = useMediaModelCatalogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const usages = USAGES.filter((usage) => capability === "all" || usage === capability);
  if (!usages.length) return null;
  async function choose(usage: MediaModelUsage, model?: ModelRef) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await setDefaultMediaModel(usage, model ? { provider: model.provider, id: model.id } : undefined); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <section className={`settings-generation-defaults settings-provider-group${capability === "all" ? " is-all" : ""}`} aria-label="Global generation defaults">
    <h4>Default models</h4>
    <div className="settings-generation-fields">
      {usages.map((usage) => <ModelDefaultField key={usage} usage={usage} catalog={catalogs[usage]} selected={catalogs[usage]?.defaultModel} loading={loading} disabled={busy || loading} onChange={(model) => void choose(usage, model)} />)}
    </div>
    {error || loadError ? <p role="alert" className="settings-error">{error ?? loadError}</p> : null}
  </section>;
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
    <button ref={trigger} className="icon-button pane-header-action" type="button" title="Project settings" aria-label="Project settings" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((next) => !next)}><Settings size={14} /></button>
    {open ? createPortal(<div ref={setPopup} className="canvas-chip-menu project-media-defaults" role="dialog" aria-labelledby={titleId}
      style={position ?? { top: 0, left: 0, visibility: "hidden" }}>
      <div className="canvas-chip-menu-heading" id={titleId}>Default models{saving ? <LoaderCircle className="spin" size={12} aria-label="Saving" /> : null}</div>
      {USAGES.map((usage) => <ModelDefaultField key={usage} usage={usage} catalog={catalogs[usage]} selected={defaults[usage]} inherit loading={loading} disabled={saving || loading} menuContainer={popup} onChange={(model) => void choose(usage, model)} />)}
      {error || loadError ? <p className="settings-error" role="alert">{error ?? loadError}</p> : null}
    </div>, document.body) : null}
  </>;
}

function modelKey(model: ModelRef): string { return JSON.stringify([model.provider, model.id]); }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
