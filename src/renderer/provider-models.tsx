import { useEffect, useId, useState, type FormEvent } from "react";
import { CUSTOM_MODEL_APIS, type CustomProviderModel, type ProviderModelSettings } from "../shared/contracts.js";
import { addCustomProviderModel, getProviderModels, removeCustomProviderModel, setProviderModelVisibility } from "./api.js";
import { Check, ChevronDown, LoaderCircle, Pencil, Plus, Search, Trash2, X } from "./icons.js";
import { SegmentedControl } from "./segmented-control.js";

const MODEL_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "shown", label: "Shown" },
  { value: "custom", label: "Custom" },
] as const;

export function ProviderModels({ providerId, onEditModels }: { providerId: string; onEditModels?: () => void }) {
  const [settings, setSettings] = useState<ProviderModelSettings>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "shown" | "custom">("all");
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  useEffect(() => {
    let active = true;
    setSettings(undefined);
    setEditing(false);
    setAdding(false);
    setDeleting(undefined);
    setQuery("");
    setFilter("all");
    setError(undefined);
    void getProviderModels(providerId).then((loaded) => { if (active) setSettings(loaded); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [providerId]);

  async function update(operation: () => Promise<ProviderModelSettings>, optimistic?: ProviderModelSettings): Promise<boolean> {
    const previous = settings;
    if (optimistic) setSettings(optimistic);
    setBusy(true);
    setError(undefined);
    try {
      setSettings(await operation());
      return true;
    } catch (cause) {
      if (optimistic) setSettings(previous);
      setError(errorMessage(cause));
      return false;
    } finally { setBusy(false); }
  }

  const search = query.trim().toLowerCase();
  const models = settings?.models.filter((model) => (
    (editing ? filter === "all" || (filter === "shown" ? model.visible : model.custom) : model.visible)
    && (!search || `${model.name} ${model.id}`.toLowerCase().includes(search))
  )) ?? [];
  const shown = settings?.models.filter((model) => model.visible).length ?? 0;
  function toggleEditing(): void {
    setEditing((value) => !value);
    setError(undefined);
    setAdding(false);
    setDeleting(undefined);
    setQuery("");
    setFilter("all");
  }
  function changeVisibility(ids: string[], visible: boolean): void {
    const selected = new Set(ids);
    void update(() => setProviderModelVisibility(providerId, ids, visible), settings ? {
      ...settings,
      models: settings.models.map((model) => selected.has(model.id) ? { ...model, visible } : model),
    } : undefined);
  }
  return <section className={`settings-detail-section provider-models${editing ? " is-editing" : ""}`} aria-label="Language models">
    <div className="provider-models-heading">
      <h4>Language models <small>{settings ? shown : ""}</small></h4>
      {settings ? <div className="provider-models-heading-actions">
        {(editing || !settings.models.length) && settings.canAddCustomModel ? <button className="settings-secondary-button" type="button" disabled={busy || adding} onClick={onEditModels ?? (() => { setAdding(true); setError(undefined); })} aria-expanded={onEditModels ? undefined : adding}>
          <Plus size={13} /><span>Add model</span>
        </button> : null}
        <button className="settings-secondary-button" type="button" disabled={busy} onClick={onEditModels ?? toggleEditing} aria-label={editing ? "Done editing models" : "Edit models"} aria-pressed={onEditModels ? undefined : editing}>
          {editing ? <Check size={13} /> : <Pencil size={13} />}<span>{editing ? "Done" : "Edit"}</span>
        </button>
      </div> : null}
    </div>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    {adding && settings ? <CustomModelForm key={providerId} settings={settings} busy={busy} onCancel={() => { setAdding(false); setError(undefined); }} onAdd={async (model) => {
      if (await update(() => addCustomProviderModel(providerId, model))) { setAdding(false); setQuery(""); setFilter("all"); }
    }} /> : null}
    {settings ? <>
      <div className="provider-models-controls">
        <label className="settings-provider-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models" /></label>
        {editing ? <SegmentedControl className="settings-provider-filters" label="Filter models" options={MODEL_FILTER_OPTIONS} value={filter} onChange={setFilter} /> : null}
      </div>
      {editing ? <div className="provider-models-list-actions">
        <span>{shown} shown <i aria-hidden="true">/</i> {settings.models.length} total</span>
        <button type="button" disabled={busy || !models.some((model) => !model.visible)} onClick={() => changeVisibility(models.map((model) => model.id), true)}>Show all</button>
        <button type="button" disabled={busy || !models.some((model) => model.visible)} onClick={() => changeVisibility(models.map((model) => model.id), false)}>Hide all</button>
      </div> : null}
      <div className="provider-models-list" role="list" aria-label={editing ? "Provider models" : "Shown provider models"} aria-busy={busy}>
        {models.map((model) => {
          const copy = <span className="provider-model-copy"><strong title={model.name}>{model.name}</strong>{model.name !== model.id ? <small title={model.id}>{model.id}</small> : null}</span>;
          return <div className={`provider-model-row${model.visible ? "" : " is-hidden"}`} key={model.id} role="listitem">
            {editing ? <label>
              <input type="checkbox" checked={model.visible} disabled={busy} onChange={(event) => changeVisibility([model.id], event.target.checked)} aria-label={`Show ${model.name}`} />
              {copy}
            </label> : <div className="provider-model-readonly">{copy}</div>}
            {model.custom ? <small className="provider-model-custom">Custom</small> : null}
            {editing && model.custom ? deleting === model.id ? <div className="provider-model-delete-confirm">
              <button type="button" className="settings-danger-button" disabled={busy} onClick={() => void update(() => removeCustomProviderModel(providerId, model.id)).then((removed) => { if (removed) setDeleting(undefined); })}>Delete</button>
              <button type="button" className="icon-button" title="Cancel deletion" aria-label="Cancel deletion" disabled={busy} onClick={() => setDeleting(undefined)}><X size={13} /></button>
            </div> : <button className="icon-button provider-model-delete" type="button" disabled={busy} title={`Delete ${model.name}`} aria-label={`Delete ${model.name}`} onClick={() => setDeleting(model.id)}><Trash2 size={14} /></button> : null}
          </div>;
        })}
        {!models.length ? <p className="settings-empty">{!settings.models.length ? "No language models are available." : !editing && !shown ? "No models shown." : "No models match these filters."}</p> : null}
      </div>
    </> : !error ? <div className="settings-loading"><LoaderCircle className="spin" size={16} />Loading models</div> : null}
  </section>;
}

function CustomModelForm({ settings, busy, onAdd, onCancel }: { settings: ProviderModelSettings; busy: boolean; onAdd: (model: CustomProviderModel) => Promise<void>; onCancel: () => void }) {
  const fieldId = useId();
  const [advanced, setAdvanced] = useState(!settings.defaultBaseUrl);
  const [model, setModel] = useState<CustomProviderModel>({ id: "", name: "", api: settings.defaultApi, baseUrl: "", contextWindow: 128_000, maxTokens: 16_384, reasoning: false, supportsImages: false });
  const apis = [...new Set([settings.defaultApi, ...CUSTOM_MODEL_APIS])];
  const field = <K extends keyof CustomProviderModel>(key: K, value: CustomProviderModel[K]) => setModel((current) => ({ ...current, [key]: value }));
  function submit(event: FormEvent): void {
    event.preventDefault();
    void onAdd({ ...model, id: model.id.trim(), name: model.name.trim() || model.id.trim() });
  }
  return <form className="provider-model-form" aria-label="Add model" onSubmit={submit}>
    <label className="settings-detail-field" htmlFor={`${fieldId}-id`}><span className="settings-search-field-label">Model ID</span><input id={`${fieldId}-id`} className="settings-search-input" value={model.id} onChange={(event) => field("id", event.target.value)} placeholder="Model ID" maxLength={200} required disabled={busy} autoFocus autoComplete="off" spellCheck={false} /></label>
    {advanced ? <div className="provider-model-form-advanced" id={`${fieldId}-advanced`}>
      <div className="provider-model-form-grid">
        <label className="settings-detail-field" htmlFor={`${fieldId}-name`}><span className="settings-search-field-label">Display name</span><input id={`${fieldId}-name`} className="settings-search-input" value={model.name} onChange={(event) => field("name", event.target.value)} placeholder={model.id || "Display name"} maxLength={200} disabled={busy} /></label>
        <label className="settings-detail-field" htmlFor={`${fieldId}-api`}><span className="settings-search-field-label">API</span><select id={`${fieldId}-api`} className="settings-search-input" value={model.api} onChange={(event) => field("api", event.target.value)} disabled={busy}>{apis.map((api) => <option key={api} value={api}>{api}</option>)}</select></label>
        <label className="settings-detail-field provider-model-url-field" htmlFor={`${fieldId}-url`}><span className="settings-search-field-label">Base URL</span><input id={`${fieldId}-url`} className="settings-search-input" type="url" value={model.baseUrl} onChange={(event) => field("baseUrl", event.target.value)} placeholder={settings.defaultBaseUrl ?? "https://api.example.com/v1"} required={!settings.defaultBaseUrl} disabled={busy} /></label>
        <label className="settings-detail-field" htmlFor={`${fieldId}-context`}><span className="settings-search-field-label">Context window</span><input id={`${fieldId}-context`} className="settings-search-input" type="number" min={1} max={100_000_000} step={1} value={model.contextWindow} onChange={(event) => field("contextWindow", Number(event.target.value))} required disabled={busy} /></label>
        <label className="settings-detail-field" htmlFor={`${fieldId}-tokens`}><span className="settings-search-field-label">Max output tokens</span><input id={`${fieldId}-tokens`} className="settings-search-input" type="number" min={1} max={model.contextWindow} step={1} value={model.maxTokens} onChange={(event) => field("maxTokens", Number(event.target.value))} required disabled={busy} /></label>
      </div>
      <div className="provider-model-capabilities">
        <label><input type="checkbox" checked={model.reasoning} onChange={(event) => field("reasoning", event.target.checked)} disabled={busy} />Reasoning</label>
        <label><input type="checkbox" checked={model.supportsImages} onChange={(event) => field("supportsImages", event.target.checked)} disabled={busy} />Image input</label>
      </div>
    </div> : null}
    <div className="provider-model-form-footer">
      <button className="provider-model-advanced-toggle" type="button" aria-expanded={advanced} aria-controls={advanced ? `${fieldId}-advanced` : undefined} disabled={busy} onClick={() => setAdvanced((value) => !value)}><ChevronDown size={12} /><span>Advanced</span></button>
      <div className="provider-model-form-actions">
        <button className="settings-secondary-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="settings-primary-button" type="submit" disabled={busy || !model.id.trim()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}<span>Add</span></button>
      </div>
    </div>
  </form>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
