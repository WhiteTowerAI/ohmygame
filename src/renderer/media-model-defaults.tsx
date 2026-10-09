import { useEffect, useState } from "react";
import type { MediaModelCatalog, MediaModelDefaults, MediaModelUsage, ModelRef, ProjectState, ProviderCapability } from "../shared/contracts.js";
import { MODEL_USAGE_LABELS } from "../shared/custom-models.js";
import { listImageModelCatalog, listModel3DCatalog, listVideoModelCatalog, MODELS_CHANGED_EVENT, setDefaultMediaModel, updateProjectMediaModelDefaults } from "./api.js";
import { ProjectSettingsDialogFrame } from "./project-settings-dialog.js";
import { LoaderCircle } from "./icons.js";

const USAGES = ["image", "video", "3d"] as const;
type Catalog = MediaModelCatalog<ModelRef & { name: string; providerName: string }>;
type Catalogs = Partial<Record<MediaModelUsage, Catalog>>;

function useMediaModelCatalogs() {
  const [catalogs, setCatalogs] = useState<Catalogs>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
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
  }, []);
  return { catalogs, loading, error };
}

function ModelDefaultField({ usage, catalog, selected, inherit = false, disabled, onChange }: {
  usage: MediaModelUsage; catalog?: Catalog; selected?: ModelRef; inherit?: boolean; disabled: boolean;
  onChange: (model?: ModelRef) => void;
}) {
  const configured = selected && catalog?.models.some((model) => modelKey(model) === modelKey(selected));
  const automatic = inherit ? catalog?.defaultModel ?? catalog?.models[0] : catalog?.models[0];
  const effective = automatic && catalog?.models.find((model) => modelKey(model) === modelKey(automatic));
  const fallbackLabel = effective ? `${effective.providerName} · ${effective.name}` : automatic ? "Selected model unavailable" : "No model available";
  return <label>
    <span>{MODEL_USAGE_LABELS[usage]}</span>
    <select aria-label={`${inherit ? "Project" : "Global default"} ${MODEL_USAGE_LABELS[usage]} model`} disabled={disabled || !catalog}
      value={configured ? modelKey(selected) : selected ? "__unavailable" : ""}
      onChange={(event) => onChange(catalog?.models.find((model) => modelKey(model) === event.target.value))}>
      <option value="">{inherit ? "Inherit global" : "Automatic"} · {fallbackLabel}</option>
      {selected && !configured ? <option value="__unavailable" disabled>Unavailable · {selected.provider} / {selected.id}</option> : null}
      {catalog?.models.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{model.providerName} · {model.name}</option>)}
    </select>
  </label>;
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
  return <section className="settings-generation-defaults" aria-label="Global generation defaults">
    <div className="settings-generation-heading"><h4>Global defaults</h4><p>Used by projects that inherit global settings.</p></div>
    <div className="settings-generation-fields">
      {usages.map((usage) => <ModelDefaultField key={usage} usage={usage} catalog={catalogs[usage]} selected={catalogs[usage]?.defaultModel} disabled={busy || loading} onChange={(model) => void choose(usage, model)} />)}
    </div>
    {error || loadError ? <p role="alert" className="settings-error">{error ?? loadError}</p> : null}
  </section>;
}

export function ProjectMediaModelSettingsDialog({ project, onClose, onSaved }: {
  project: ProjectState; onClose: () => void; onSaved: (project: ProjectState) => void;
}) {
  const { catalogs, loading, error: loadError } = useMediaModelCatalogs();
  const [defaults, setDefaults] = useState<MediaModelDefaults>(() => ({ ...project.mediaModelDefaults }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(undefined);
    try {
      const updated = await updateProjectMediaModelDefaults(project.id, defaults);
      onSaved(updated);
      onClose();
    } catch (cause) { setError(errorMessage(cause)); setSaving(false); }
  }
  return <ProjectSettingsDialogFrame busy={saving} onClose={onClose}>
    <form onSubmit={(event) => void submit(event)}>
      <section className="project-settings-project" aria-label="Project"><span>Project</span><strong title={project.name}>{project.name}</strong></section>
      <fieldset className="project-settings-section">
        <legend>Generation models</legend>
        <p className="project-settings-hint">Defaults for new nodes and generations in this project. Existing nodes keep their selected models.</p>
        {USAGES.map((usage) => <ModelDefaultField key={usage} usage={usage} catalog={catalogs[usage]} selected={defaults[usage]} inherit disabled={saving || loading}
          onChange={(model) => setDefaults((current) => {
            const next = { ...current };
            if (model) next[usage] = { provider: model.provider, id: model.id };
            else delete next[usage];
            return next;
          })} />)}
      </fieldset>
      {error || loadError ? <p className="project-settings-error" role="alert">{error ?? loadError}</p> : null}
      <footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="project-settings-submit" type="submit" disabled={saving || loading}>{saving ? <LoaderCircle className="spin" size={14} /> : null}Save</button></footer>
    </form>
  </ProjectSettingsDialogFrame>;
}

function modelKey(model: ModelRef): string { return JSON.stringify([model.provider, model.id]); }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
