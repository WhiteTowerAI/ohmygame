import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CUSTOM_MODEL_APIS, type CustomProviderModel, type ProviderModelSettings, type ModelRef } from "../shared/contracts.js";
import { addCustomProviderModel, getCloudQuotas, getProviderModels, notifyAgentModelsChanged, removeCustomProviderModel, resetProviderModel3D, setProviderModelVisibility, updateProviderModel3D } from "./api.js";
import { ProviderModel3DForm } from "./provider-model3d-form.js";
import { Check, ChevronDown, ExternalLink, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, X } from "./icons.js";
import { SegmentedControl } from "./segmented-control.js";
import { MODEL_USAGE_LABELS } from "../shared/custom-models.js";
import { hyper3DCredits } from "../shared/cloud-models.js";

const MODEL_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "shown", label: "Shown" },
  { value: "custom", label: "Custom" },
] as const;

export function ProviderModels({ providerId, additionalProviderId, sourceLabels, onEditModels }: { providerId: string; additionalProviderId?: string; sourceLabels?: Record<string, string>; onEditModels?: () => void }) {
  const [settings, setSettings] = useState<ProviderModelSettings>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "shown" | "custom">("all");
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<ModelRef>();
  const [editingModel, setEditingModel] = useState<ModelRef>();
  const providerRef = useRef(providerId);
  const reloadRef = useRef<(force?: boolean) => void>(() => {});
  providerRef.current = providerId;
  useEffect(() => {
    let active = true, sequence = 0;
    setSettings(undefined);
    setEditing(false);
    setAdding(false);
    setDeleting(undefined);
    setEditingModel(undefined);
    setBusy(false);
    setQuery("");
    setFilter("all");
    setError(undefined);
    const load = async (force = false) => {
      const revision = ++sequence;
      setBusy(true);
      try {
        if (force && additionalProviderId?.startsWith("cloud-")) { await getCloudQuotas(); notifyAgentModelsChanged(); }
        const results = await Promise.allSettled([providerId, ...(additionalProviderId ? [additionalProviderId] : [])].map(getProviderModels));
        if (!active || revision !== sequence) return;
        const loaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const failure = results.find((result) => result.status === "rejected");
        if (loaded.length) setSettings({ ...loaded[0]!, models: loaded.slice().reverse().flatMap((item) => item.models) });
        setError(failure?.status === "rejected" ? errorMessage(failure.reason) : undefined);
      } catch (cause) { if (active && revision === sequence) setError(errorMessage(cause)); }
      finally { if (active && revision === sequence) setBusy(false); }
    };
    reloadRef.current = (force) => { void load(force); };
    void load();
    return () => { active = false; };
  }, [providerId, additionalProviderId]);

  async function update(operation: () => Promise<ProviderModelSettings>, owner: string | null = providerId): Promise<boolean> {
    const id = providerId;
    setBusy(true);
    setError(undefined);
    try {
      const loaded = await operation();
      if (providerRef.current !== id) return false;
      setSettings((current) => owner && additionalProviderId && current ? { ...current,
        models: owner === providerId ? [...current.models.filter((model) => model.provider !== owner), ...loaded.models]
          : [...loaded.models, ...current.models.filter((model) => model.provider !== owner)],
      } : loaded);
      return true;
    } catch (cause) {
      if (providerRef.current !== id) return false;
      setError(errorMessage(cause));
      return false;
    } finally { if (providerRef.current === id) setBusy(false); }
  }

  const search = query.trim().toLowerCase();
  const models = settings?.models.filter((model) => (
    (onEditModels ? true : editing ? filter === "all" || (filter === "shown" ? model.visible : model.custom) : model.visible)
    && (!search || `${model.name} ${model.id} ${sourceLabels?.[model.provider] ?? ""}`.toLowerCase().includes(search))
  )) ?? [];
  const shown = settings?.models.filter((model) => model.visible).length ?? 0;
  function toggleEditing(): void {
    setEditing((value) => !value);
    setError(undefined);
    setAdding(false);
    setDeleting(undefined);
    setEditingModel(undefined);
    setQuery("");
    setFilter("all");
  }
  function changeVisibility(models: ProviderModelSettings["models"], visible: boolean): void {
    const owners = [...new Set(models.map((model) => model.provider))];
    if (owners.length === 1) {
      const owner = owners[0]!;
      void update(() => setProviderModelVisibility(owner, models.map((model) => model.id), visible), owner);
      return;
    }
    void update(async () => {
      const changes = await Promise.allSettled(owners.map((owner) => setProviderModelVisibility(owner, models.filter((model) => model.provider === owner).map((model) => model.id), visible)));
      // Reload both sources even after a partial failure, so the displayed switches stay accurate.
      const loaded = await Promise.all([providerId, ...(additionalProviderId ? [additionalProviderId] : [])].map(getProviderModels));
      const failure = changes.find((change) => change.status === "rejected");
      if (failure?.status === "rejected") setError(errorMessage(failure.reason));
      return { ...loaded[0]!, models: loaded.slice().reverse().flatMap((item) => item.models) };
    }, null);
  }
  return <section className={`settings-detail-section provider-models${editing ? " is-editing" : ""}`} aria-label="Models">
    <div className="provider-models-heading">
      <h4>Models <small>{settings ? shown : ""}</small></h4>
      {settings ? <div className="provider-models-heading-actions">
        {settings.model3DProtocol ? <button className="settings-secondary-button" type="button" disabled={busy || adding || Boolean(editingModel)} onClick={() => reloadRef.current(true)} title="Reload the bundled official presets and account catalog" aria-label="Reload model catalog"><RefreshCw size={13} className={busy ? "spin" : undefined} /><span>Reload</span></button> : null}
        {(editing || !settings.models.length) && settings.canAddCustomModel ? <button className="settings-secondary-button" type="button" disabled={busy || adding} onClick={onEditModels ?? (() => { setAdding(true); setEditingModel(undefined); setError(undefined); })} aria-expanded={onEditModels ? undefined : adding}>
          <Plus size={13} /><span>Add model</span>
        </button> : null}
        <button className="settings-secondary-button" type="button" disabled={busy} onClick={onEditModels ?? toggleEditing} aria-label={editing ? "Done editing models" : "Edit models"} aria-pressed={onEditModels ? undefined : editing}>
          {editing ? <Check size={13} /> : <Pencil size={13} />}<span>{editing ? "Done" : "Edit"}</span>
        </button>
      </div> : null}
    </div>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    {settings?.catalogNotice ? <details className="settings-detail-hint provider-catalog-info"><summary>Model catalog info</summary><p>{settings.catalogNotice}</p>{settings.catalogDocsUrl ? <a href={settings.catalogDocsUrl} target="_blank" rel="noreferrer">Official model versions <ExternalLink size={11} /></a> : null}</details> : null}
    {adding && settings?.model3DProtocol ? <ProviderModel3DForm key={`${providerId}-new`} protocol={settings.model3DProtocol} busy={busy} onCancel={() => { setAdding(false); setError(undefined); }} onSave={async (model) => {
      if (await update(() => addCustomProviderModel(providerId, model))) { setAdding(false); setQuery(""); setFilter("all"); }
    }} /> : adding && settings ? <CustomModelForm key={providerId} settings={settings} busy={busy} onCancel={() => { setAdding(false); setError(undefined); }} onAdd={async (model) => {
      if (await update(() => addCustomProviderModel(providerId, model))) { setAdding(false); setQuery(""); setFilter("all"); }
    }} /> : null}
    {editingModel && settings?.model3DProtocol ? <ProviderModel3DForm key={`${editingModel.provider}-${editingModel.id}`} protocol={settings.model3DProtocol} initial={settings.models.find((model) => model.provider === editingModel.provider && model.id === editingModel.id)?.model3d} busy={busy} onCancel={() => { setEditingModel(undefined); setError(undefined); }} onSave={async (model) => {
      if (await update(() => updateProviderModel3D(editingModel.provider, model), editingModel.provider)) setEditingModel(undefined);
    }} onReset={() => void update(() => resetProviderModel3D(editingModel.provider, editingModel.id), editingModel.provider).then((saved) => { if (saved) setEditingModel(undefined); })} /> : null}
    {settings ? <>
      <div className="provider-models-controls">
        <label className="settings-provider-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models" /></label>
        {editing ? <SegmentedControl className="settings-provider-filters" label="Filter models" options={MODEL_FILTER_OPTIONS} value={filter} onChange={setFilter} /> : null}
      </div>
      {editing ? <div className="provider-models-list-actions">
        <span>{shown} shown <i aria-hidden="true">/</i> {settings.models.length} total</span>
        <button type="button" disabled={busy || !models.some((model) => !model.visible)} onClick={() => changeVisibility(models, true)}>Show all</button>
        <button type="button" disabled={busy || !models.some((model) => model.visible)} onClick={() => changeVisibility(models, false)}>Hide all</button>
      </div> : null}
      <div className="provider-models-list" role="list" aria-label={editing ? "Provider models" : "Shown provider models"} aria-busy={busy}>
        {models.map((model) => {
          const credits = model.model3d?.settings.protocol === "hyper3d" ? hyper3DCredits(model.id) : undefined;
          const description = model.model3d ? `${model.id}${credits !== undefined ? ` · ${credits} credits / generation` : ""} · up to ${model.model3d.settings.maxReferenceImages} ${model.model3d.settings.maxReferenceImages === 1 ? "reference" : "references"} · ${model.model3d.settings.polycount.min.toLocaleString()}–${model.model3d.settings.polycount.max.toLocaleString()} faces` : model.description ? `${model.id} · ${model.description}` : model.name !== model.id ? model.id : undefined;
          const copy = <span className="provider-model-copy"><strong title={model.name}>{model.name}</strong>{description ? <small title={description}>{description}</small> : null}</span>;
          const selected = (ref?: ModelRef) => ref?.provider === model.provider && ref.id === model.id;
          return <div className={`provider-model-row${model.visible ? "" : " is-hidden"}`} key={`${model.provider}/${model.id}`} role="listitem">
            {editing || onEditModels ? <label>
              <input type="checkbox" checked={model.visible} disabled={busy || model.capabilities?.length === 0} onChange={(event) => changeVisibility([model], event.target.checked)} aria-label={`Enable ${model.name}`} />
              {copy}
            </label> : <div className="provider-model-readonly">{copy}</div>}
            {model.capabilities ? <span className="custom-model-usage-badges">{model.capabilities.length ? model.capabilities.map((usage) => <small key={usage}>{MODEL_USAGE_LABELS[usage]}</small>) : <small>Unassigned</small>}</span> : model.custom ? <small className="provider-model-custom">Custom</small> : null}
            {sourceLabels?.[model.provider] || model.source ? <small className="provider-model-custom">{sourceLabels?.[model.provider] ?? (model.source === "preset" ? "Official" : model.source === "cloud" ? "Cloud" : "Custom")}</small> : null}
            {editing && model.model3d ? <button className="icon-button" type="button" disabled={busy || adding} aria-label={`Edit ${model.name}`} title={`Edit ${model.name}`} aria-expanded={selected(editingModel)} onClick={() => { setEditingModel((ref) => selected(ref) ? undefined : model); setError(undefined); setDeleting(undefined); }}><Pencil size={14} /></button> : null}
            {editing && model.custom ? selected(deleting) ? <div className="provider-model-delete-confirm">
              <button type="button" className="settings-danger-button" disabled={busy} onClick={() => void update(() => removeCustomProviderModel(model.provider, model.id), model.provider).then((removed) => { if (removed) setDeleting(undefined); })}>Delete</button>
              <button type="button" className="icon-button" title="Cancel deletion" aria-label="Cancel deletion" disabled={busy} onClick={() => setDeleting(undefined)}><X size={13} /></button>
            </div> : <button className="icon-button provider-model-delete" type="button" disabled={busy} title={`Delete ${model.name}`} aria-label={`Delete ${model.name}`} onClick={() => setDeleting(model)}><Trash2 size={14} /></button> : null}
          </div>;
        })}
        {!models.length ? <p className="settings-empty">{!settings.models.length ? "No models are available." : !editing && !shown ? "No models shown." : "No models match these filters."}</p> : null}
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
