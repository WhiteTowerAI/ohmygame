import { usesModel3DPresets } from "../shared/model3d-presets.js";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AGENT_REASONING_LEVELS, CUSTOM_MODEL_APIS, type CustomProviderDetails, type CustomProviderModel, type SaveCustomProviderRequest, type CustomProviderPreset } from "../shared/contracts.js";
import { modelUsageList, modelUsages, MODEL_USAGE_LABELS } from "../shared/custom-models.js";
import { CustomModelUsageFields } from "./custom-model-usage-fields.js";
import { reasoningLabel, supportedReasoningLevels } from "../shared/reasoning.js";
import { discoverCustomProviderModels, saveCustomProvider } from "./api.js";
import { ChevronDown, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, X } from "./icons.js";
import { initialCustomThinkingLevelMap, invalidateCustomModelCapabilities, mergeDiscoveredProviderModels, modelError, type ModelRow } from "./custom-provider-models.js";
import { isLocalModelProvider } from "./local-model-providers.js";

export const PROVIDER_API_LABELS: Record<string, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Generative AI",
  "google-vertex": "Google Vertex AI",
};

const emptyModel = (provider: Pick<SaveCustomProviderRequest, "api" | "preset">): CustomProviderModel => ({
  id: "", name: "", api: provider.api, contextWindow: 128_000, maxTokens: 16_384,
  reasoning: false, supportsImages: false, usages: isLocalModelProvider(provider) ? { language: true } : {},
});

export type CustomProviderField = "name" | "baseUrl" | "api" | "apiKey" | "models";

export function CustomProviderDialog({ settings, initialProvider, initialFocus = "name", onClose, onSaved }: {
  settings?: CustomProviderDetails;
  initialProvider?: Pick<SaveCustomProviderRequest, "name" | "baseUrl" | "api" | "authentication" | "preset">;
  initialFocus?: CustomProviderField;
  onClose: () => void;
  onSaved: (settings: CustomProviderDetails) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const endpointInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const apiInput = useRef<HTMLSelectElement>(null);
  const authenticationInput = useRef<HTMLSelectElement>(null);
  const modelSearch = useRef<HTMLInputElement>(null);
  const fetchButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const savingRef = useRef(false);
  const discovery = useRef<AbortController | undefined>(undefined);
  const [form, setForm] = useState<SaveCustomProviderRequest>(settings ? { name: settings.name, baseUrl: settings.baseUrl, api: settings.api, authentication: settings.authentication, preset: settings.preset } : initialProvider ?? { name: "", baseUrl: "", api: "openai-completions", authentication: "api_key" });
  const [rows, setRows] = useState<ModelRow[]>(() => {
    const hidden = new Set(settings?.hiddenModelIds);
    return settings?.models.map((model) => ({ model, enabled: !hidden.has(model.id) })) ?? [];
  });
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string>();
  const [fetching, setFetching] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string>();
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [fetchedCount, setFetchedCount] = useState<number>();
  const [discoverySource, setDiscoverySource] = useState<"provider" | "presets">("provider");
  const usesPresets = usesModel3DPresets(form.baseUrl, form.preset);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState<CustomProviderModel>(() => emptyModel(form));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  closeRef.current = onClose;
  savingRef.current = saving;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const initialInput = initialFocus === "baseUrl" ? endpointInput.current
      : initialFocus === "api" ? apiInput.current
      : initialFocus === "apiKey" ? keyInput.current ?? authenticationInput.current
      : initialFocus === "models" ? modelSearch.current ?? fetchButton.current
      : nameInput.current;
    initialInput?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!savingRef.current) closeRef.current();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const elements = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex='0']")].filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (!dialog.current.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => { discovery.current?.abort(); window.removeEventListener("keydown", keyboard, true); previousFocus?.focus(); };
  }, []);

  function cancelDiscovery(): void {
    discovery.current?.abort();
    setFetching(false);
  }

  function field<K extends keyof SaveCustomProviderRequest>(key: K, value: SaveCustomProviderRequest[K]): void {
    if (key !== "name") { cancelDiscovery(); setDiscoveryError(undefined); setDiscoveryWarnings([]); setFetchedCount(undefined); setTruncated(false); }
    if (key === "api" || key === "baseUrl") {
      setRows((current) => current.map((row) => ({ ...row, model: invalidateCustomModelCapabilities(row.model, key === "api" && row.model.api === form.api ? String(value) : row.model.api) })));
      setManual((current) => invalidateCustomModelCapabilities(current, key === "api" ? String(value) : current.api));
    }
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function fetchModels(): Promise<void> {
    if (!endpointInput.current?.reportValidity() || (keyInput.current && !keyInput.current.reportValidity())) return;
    cancelDiscovery();
    const controller = new AbortController();
    discovery.current = controller;
    setFetching(true);
    setDiscoveryError(undefined);
    setDiscoveryWarnings([]);
    try {
      const loaded = await discoverCustomProviderModels({ providerId: settings?.id, baseUrl: form.baseUrl, api: form.api, authentication: form.authentication, apiKey: form.authentication === "api_key" ? form.apiKey : undefined, preset: form.preset }, controller.signal);
      if (controller.signal.aborted) return;
      setRows((current) => mergeDiscoveredProviderModels(current, loaded.models));
      setDiscoverySource(loaded.source ?? "provider");
      setFetchedCount(loaded.models.length);
      setTruncated(loaded.truncated === true);
      setDiscoveryWarnings(loaded.warnings ?? []);
    } catch (cause) {
      if (!controller.signal.aborted) setDiscoveryError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (!controller.signal.aborted) setFetching(false); }
  }

  function updateModel(id: string, model: CustomProviderModel): void {
    setRows((current) => current.map((row) => row.model.id === id ? { ...row, model } : row));
    setError(undefined);
  }

  function toggleModels(ids: string[], enabled: boolean): void {
    const matching = new Set(ids);
    setRows((current) => current.map((row) => matching.has(row.model.id) ? { ...row, enabled } : row));
  }

  function addManualModel(): void {
    const model = { ...manual, id: manual.id.trim(), name: manual.name.trim() || manual.id.trim() };
    const invalid = modelError(model, true);
    if (invalid || rows.some((row) => row.model.id === model.id)) {
      setError(invalid ?? "A model with this ID is already in the list.");
      setManualOpen(true);
      return;
    }
    setRows((current) => [...current, { model, enabled: true }]);
    setManual(emptyModel(form));
    setManualOpen(false);
    setQuery("");
    setError(undefined);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (savingRef.current) return;
    if (!nameInput.current?.reportValidity() || !endpointInput.current?.reportValidity() || (keyInput.current && !keyInput.current.reportValidity())) return;
    for (const row of rows) {
      const invalid = modelError(row.model, row.enabled);
      if (invalid) { setError(invalid); setQuery(""); setEditing(row.model.id); return; }
    }
    const models = rows.map((row) => ({ ...row.model, name: row.model.name.trim() || row.model.id }));
    cancelDiscovery();
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const saved = await saveCustomProvider({
        ...form,
        modelConfigurationVersion: 2,
        apiKey: form.authentication === "api_key" ? form.apiKey : undefined,
        models, hiddenModelIds: rows.filter((row) => !row.enabled).map((row) => row.model.id),
      }, settings?.id);
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      savingRef.current = false;
      setSaving(false);
    }
  }

  const search = query.trim().toLowerCase();
  const visibleModels = rows.filter((row) => !search || `${row.model.id} ${row.model.name}`.toLowerCase().includes(search));
  const enabledCount = rows.filter((row) => row.enabled && modelUsageList(row.model).length).length;
  const configuredModels = visibleModels.filter((row) => modelUsageList(row.model).length);
  const allVisibleEnabled = configuredModels.length > 0 && configuredModels.every((row) => row.enabled);

  return createPortal(<div className="project-settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingRef.current) onClose(); }}>
    <section ref={dialog} className="project-settings-dialog custom-provider-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><h2 id={titleId}>{settings ? "Edit provider" : initialProvider ? `Connect ${initialProvider.name}` : "Add provider"}</h2><button type="button" disabled={saving} aria-label="Close" onClick={onClose}><X size={16} /></button></header>
      <form noValidate onSubmit={(event) => void submit(event)}>
        <div className="custom-provider-dialog-body">
          <fieldset className="project-settings-section" disabled={saving}>
            <label><span>Display name</span><input ref={nameInput} value={form.name} onChange={(event) => field("name", event.target.value)} placeholder="My provider" maxLength={100} required autoComplete="off" /></label>
            <label><span>Base URL</span><input ref={endpointInput} type="url" value={form.baseUrl} onChange={(event) => field("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" required autoComplete="off" spellCheck={false} /><small>Use the API endpoint, including /v1 when your service requires it.</small></label>
            <div className="project-settings-field-row">
              <label><span>Default language protocol</span><select ref={apiInput} value={form.api} onChange={(event) => field("api", event.target.value)}>{CUSTOM_MODEL_APIS.map((api) => <option key={api} value={api}>{PROVIDER_API_LABELS[api]}</option>)}</select></label>
              <label><span>Authentication</span><select ref={authenticationInput} value={form.authentication} onChange={(event) => field("authentication", event.target.value as SaveCustomProviderRequest["authentication"])}><option value="api_key">API key</option><option value="none">No API key</option></select></label>
            </div>
            {form.authentication === "api_key" ? <label><span>API key</span><input ref={keyInput} type="password" value={form.apiKey ?? ""} onChange={(event) => field("apiKey", event.target.value)} required={!settings || settings.authentication !== "api_key"} placeholder={settings?.authentication === "api_key" ? "Leave blank to keep the current key" : "Paste your API key"} autoComplete="new-password" spellCheck={false} /></label> : null}
          </fieldset>
          <section className="custom-provider-model-picker" aria-label="Model settings">
            <div className="custom-provider-model-heading">
              <h3>Models <small>{enabledCount} enabled</small></h3>
              <button ref={fetchButton} className="settings-secondary-button" type="button" disabled={saving || fetching} onClick={() => void fetchModels()}>{fetching ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{fetching ? usesPresets ? "Loading…" : "Fetching…" : usesPresets ? "Load presets" : "Fetch"}</button>
            </div>
            {discoveryWarnings.map((warning) => <p className="custom-provider-hint" role="status" key={warning}>{warning}</p>)}
            {discoveryError ? <p className="project-settings-error" role="alert">{discoveryError}</p> : null}
            {fetchedCount !== undefined ? <p className="custom-provider-hint" role="status">{truncated ? `Fetched the first ${fetchedCount} models. Other model IDs can be added manually.` : `${discoverySource === "presets" ? "Loaded" : "Fetched"} ${fetchedCount} ${discoverySource === "presets" ? "official presets" : "models"}.`}</p> : null}
            {rows.length ? <>
              <label className="custom-provider-model-search"><Search size={14} /><input ref={modelSearch} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models" disabled={saving} /></label>
              {visibleModels.length ? <>
                <label className="custom-provider-select-all"><input type="checkbox" checked={allVisibleEnabled} onChange={(event) => toggleModels(configuredModels.map((row) => row.model.id), event.target.checked)} disabled={saving || !configuredModels.length} />{search ? "Enable matching configured models" : "Enable all configured models"}</label>
                <div className={`custom-provider-model-results${visibleModels.some((row) => row.model.id === editing) ? " is-editing" : ""}`} role="group" aria-label="Available models">
                  {visibleModels.map((row) => <div className="custom-provider-model-item" key={row.model.id}>
                    <div className="custom-provider-model-row">
                      <label className="custom-provider-model-choice"><input type="checkbox" aria-label={`Enable ${row.model.name || row.model.id}`} checked={row.enabled} onChange={(event) => { toggleModels([row.model.id], event.target.checked); if (event.target.checked && !modelUsageList(row.model).length) setEditing(row.model.id); }} disabled={saving} /><span><strong>{row.model.name || row.model.id}</strong><small>{row.model.id}</small><span className="custom-model-usage-badges">{modelUsageList(row.model).length ? modelUsageList(row.model).map((usage) => <small key={usage}>{MODEL_USAGE_LABELS[usage]}</small>) : <small>Unassigned</small>}</span></span></label>
                      <button className="icon-button" type="button" aria-label={`Edit ${row.model.name || row.model.id}`} data-tooltip={`Edit ${row.model.name || row.model.id}`} aria-expanded={editing === row.model.id} disabled={saving} onClick={() => setEditing((current) => current === row.model.id ? undefined : row.model.id)}><Pencil size={14} /></button>
                      <button className="icon-button" type="button" aria-label={`Remove ${row.model.name || row.model.id}`} data-tooltip={`Remove ${row.model.name || row.model.id}`} disabled={saving} onClick={() => { setRows((current) => current.filter((item) => item.model.id !== row.model.id)); if (editing === row.model.id) setEditing(undefined); }}><Trash2 size={14} /></button>
                    </div>
                    {editing === row.model.id ? <div className="custom-provider-model-editor" role="group" aria-label={`Edit model ${row.model.id}`}><ModelFields model={row.model} preset={form.preset} onChange={(model) => updateModel(row.model.id, model)} disabled={saving} /></div> : null}
                  </div>)}
                </div>
              </> : <p className="custom-provider-hint">No models match your search.</p>}
            </> : !manualOpen ? <p className="custom-provider-model-empty">No models added yet.</p> : null}
            <details className="custom-provider-manual" open={manualOpen} onToggle={(event) => setManualOpen(event.currentTarget.open)}>
              <summary><Plus size={14} aria-hidden="true" /><span>Add a model manually</span><ChevronDown size={14} aria-hidden="true" /></summary>
              <div className="custom-provider-manual-fields">
                <label><span>Model ID</span><input value={manual.id} onChange={(event) => setManual((current) => ({ ...current, id: event.target.value }))} placeholder={form.preset === "ollama" ? "qwen3:8b" : "Model ID from your provider"} maxLength={200} disabled={saving} autoComplete="off" spellCheck={false} /></label>
                <ModelFields model={manual} preset={form.preset} onChange={setManual} disabled={saving || !manual.id.trim()} />
                <button className="settings-secondary-button custom-provider-manual-add" type="button" disabled={saving || !manual.id.trim()} onClick={addManualModel}><Plus size={13} />Add model</button>
              </div>
            </details>
          </section>
          {error ? <p className="project-settings-error" role="alert">{error}</p> : null}
        </div>
        <footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="project-settings-submit" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={14} /> : null}{saving ? "Saving…" : settings ? "Save changes" : initialProvider ? "Connect" : "Add provider"}</button></footer>
      </form>
    </section>
  </div>, document.body);
}

function ModelFields({ model, preset, onChange, disabled }: { model: CustomProviderModel; preset?: CustomProviderPreset; onChange: (model: CustomProviderModel) => void; disabled: boolean }) {
  const usages = modelUsages(model);
  return <fieldset className="project-settings-section" disabled={disabled}>
    <label><span>Model display name</span><input value={model.name} onChange={(event) => onChange({ ...model, name: event.target.value })} placeholder={model.id || "Same as model ID"} maxLength={200} /></label>
    <CustomModelUsageFields usages={usages} preset={preset} onChange={(usages) => onChange({ ...model, usages })} />
    {usages.language ? <details className="custom-provider-advanced"><summary>Language settings</summary><LanguageModelFields model={model} onChange={onChange} disabled={disabled} /></details> : null}
  </fieldset>;
}

function LanguageModelFields({ model, onChange, disabled }: { model: CustomProviderModel; onChange: (model: CustomProviderModel) => void; disabled: boolean }) {
  const field = <K extends keyof CustomProviderModel>(key: K, value: CustomProviderModel[K]) => onChange({ ...model, [key]: value });
  const automaticMap = model.reasoningCapabilities?.thinkingLevelMap;
  const automaticLevels = supportedReasoningLevels({ reasoning: true, thinkingLevelMap: automaticMap });
  const effectiveMap = { ...automaticMap, ...model.thinkingLevelMap };
  const levels = supportedReasoningLevels({ reasoning: true, thinkingLevelMap: effectiveMap });
  return <fieldset className="project-settings-section" disabled={disabled}>
    <label><span>Language protocol</span><select value={model.api} onChange={(event) => onChange(invalidateCustomModelCapabilities(model, event.target.value))}>{CUSTOM_MODEL_APIS.map((api) => <option key={api} value={api}>{PROVIDER_API_LABELS[api]}</option>)}</select></label>
    <label><span>Language Base URL override</span><input type="url" value={model.baseUrl ?? ""} onChange={(event) => field("baseUrl", event.target.value || undefined)} placeholder="Use the provider's Base URL" /></label>
    <div className="project-settings-field-row">
      <label><span>Context window</span><input type="number" min={1} max={100_000_000} step={1} value={model.contextWindow} onChange={(event) => field("contextWindow", Number(event.target.value))} required /></label>
      <label><span>Max output tokens</span><input type="number" min={1} max={model.contextWindow} step={1} value={model.maxTokens} onChange={(event) => field("maxTokens", Number(event.target.value))} required /></label>
    </div>
    <div className="custom-provider-capabilities"><label><input type="checkbox" checked={model.reasoning} onChange={(event) => field("reasoning", event.target.checked)} />Reasoning</label><label><input type="checkbox" checked={model.supportsImages} onChange={(event) => field("supportsImages", event.target.checked)} />Image input</label></div>
    {model.reasoning ? <details className="custom-provider-advanced"><summary>Reasoning settings</summary>
      <label><span>Reasoning levels</span><select value={model.thinkingLevelMap ? "custom" : "automatic"} onChange={(event) => field("thinkingLevelMap", event.target.value === "automatic" ? undefined : initialCustomThinkingLevelMap(model))}><option value="automatic">Automatic</option><option value="custom">Custom</option></select></label>
      {model.thinkingLevelMap ? <>
        <p className="custom-provider-hint">Enable the supported levels and set the parameter sent to your provider.</p>
        <div className="custom-provider-reasoning-levels">
          {AGENT_REASONING_LEVELS.map((level) => <div className="custom-provider-reasoning-row" key={level}>
            <label><input type="checkbox" checked={levels.includes(level)} onChange={(event) => field("thinkingLevelMap", { ...model.thinkingLevelMap, [level]: event.target.checked ? automaticMap?.[level] ?? (level === "off" ? "none" : level) : null })} />{reasoningLabel(level)}</label>
            <input aria-label={`${reasoningLabel(level)} parameter`} value={levels.includes(level) ? effectiveMap[level] ?? (level === "off" ? "none" : level) : ""} disabled={!levels.includes(level)} maxLength={100} spellCheck={false} autoComplete="off" placeholder={level === "off" ? "none" : level} onChange={(event) => field("thinkingLevelMap", { ...model.thinkingLevelMap, [level]: event.target.value })} />
          </div>)}
        </div>
      </> : <p className="custom-provider-hint">{automaticLevels.map(reasoningLabel).join(" · ")}{model.reasoningCapabilities?.source === "provider" ? " — reported by your provider" : model.reasoningCapabilities?.source === "catalog" ? " — from the model catalog" : " — default levels; customize if needed"}</p>}
    </details> : null}
  </fieldset>;
}
