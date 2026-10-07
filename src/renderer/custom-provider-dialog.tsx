import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CUSTOM_MODEL_APIS, type CustomProviderDetails, type CustomProviderModel, type SaveCustomProviderRequest } from "../shared/contracts.js";
import { discoverCustomProviderModels, saveCustomProvider } from "./api.js";
import { LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, X } from "./icons.js";

const PRESETS = {
  gateway: { name: "", baseUrl: "", api: "openai-completions", authentication: "api_key" },
  ollama: { name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", authentication: "none" },
  lmstudio: { name: "LM Studio", baseUrl: "http://localhost:1234/v1", api: "openai-completions", authentication: "none" },
} as const;

const PROVIDER_API_LABELS: Record<string, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Generative AI",
  "google-vertex": "Google Vertex AI",
};

type ModelRow = { model: CustomProviderModel; enabled: boolean; saved: boolean };
const emptyModel = (): CustomProviderModel => ({ id: "", name: "", api: "openai-completions", contextWindow: 128_000, maxTokens: 16_384, reasoning: false, supportsImages: false });

export function CustomProviderDialog({ settings, onClose, onSaved }: {
  settings?: CustomProviderDetails;
  onClose: () => void;
  onSaved: (settings: CustomProviderDetails) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const endpointInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  const savingRef = useRef(false);
  const discovery = useRef<AbortController | undefined>(undefined);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("gateway");
  const [form, setForm] = useState<SaveCustomProviderRequest>(settings ? { name: settings.name, baseUrl: settings.baseUrl, api: settings.api, authentication: settings.authentication } : PRESETS.gateway);
  const [rows, setRows] = useState<ModelRow[]>(() => {
    const hidden = new Set(settings?.hiddenModelIds);
    return settings?.models.map((model) => ({ model, enabled: !hidden.has(model.id), saved: true })) ?? [];
  });
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string>();
  const [fetching, setFetching] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [fetchedCount, setFetchedCount] = useState<number>();
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState<CustomProviderModel>(emptyModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  closeRef.current = onClose;
  savingRef.current = saving;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    nameInput.current?.focus();
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
    if (key !== "name") { cancelDiscovery(); setDiscoveryError(undefined); setFetchedCount(undefined); setTruncated(false); }
    if (key === "api") setRows((current) => current.map((row) => row.model.api === form.api ? { ...row, model: { ...row.model, api: String(value) } } : row));
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function fetchModels(): Promise<void> {
    if (!endpointInput.current?.reportValidity() || (keyInput.current && !keyInput.current.reportValidity())) return;
    cancelDiscovery();
    const controller = new AbortController();
    discovery.current = controller;
    setFetching(true);
    setDiscoveryError(undefined);
    try {
      const loaded = await discoverCustomProviderModels({ providerId: settings?.id, baseUrl: form.baseUrl, api: form.api, authentication: form.authentication, apiKey: form.authentication === "api_key" ? form.apiKey : undefined }, controller.signal);
      if (controller.signal.aborted) return;
      setRows((current) => {
        const merged = new Map(current.map((row) => [row.model.id, row]));
        for (const model of loaded.models) if (!merged.has(model.id)) merged.set(model.id, { model, enabled: false, saved: false });
        return [...merged.values()].sort((a, b) => a.model.name.localeCompare(b.model.name));
      });
      setFetchedCount(loaded.models.length);
      setTruncated(loaded.truncated === true);
    } catch (cause) {
      if (!controller.signal.aborted) setDiscoveryError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (!controller.signal.aborted) setFetching(false); }
  }

  function updateModel(id: string, model: CustomProviderModel): void {
    setRows((current) => current.map((row) => row.model.id === id ? { ...row, model } : row));
  }

  function toggleModels(ids: string[], enabled: boolean): void {
    const matching = new Set(ids);
    setRows((current) => current.map((row) => matching.has(row.model.id) ? { ...row, enabled } : row));
  }

  function addManualModel(): void {
    const model = { ...manual, id: manual.id.trim(), name: manual.name.trim() || manual.id.trim(), api: form.api };
    const invalid = modelError(model);
    if (invalid || rows.some((row) => row.model.id === model.id)) {
      setError(invalid ?? "A model with this ID is already in the list.");
      setManualOpen(true);
      return;
    }
    setRows((current) => [...current, { model, enabled: true, saved: false }]);
    setManual(emptyModel());
    setManualOpen(false);
    setQuery("");
    setError(undefined);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (savingRef.current) return;
    if (!nameInput.current?.reportValidity() || !endpointInput.current?.reportValidity() || (keyInput.current && !keyInput.current.reportValidity())) return;
    const included = rows.filter((row) => row.saved || row.enabled);
    for (const row of included) {
      const invalid = modelError(row.model);
      if (invalid) { setError(invalid); setQuery(""); setEditing(row.model.id); return; }
    }
    const models = included.map((row) => ({ ...row.model, name: row.model.name.trim() || row.model.id }));
    cancelDiscovery();
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const saved = await saveCustomProvider({
        ...form,
        apiKey: form.authentication === "api_key" ? form.apiKey : undefined,
        models, hiddenModelIds: included.filter((row) => !row.enabled).map((row) => row.model.id),
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
  const enabledCount = rows.filter((row) => row.enabled).length;
  const allVisibleEnabled = visibleModels.length > 0 && visibleModels.every((row) => row.enabled);

  return createPortal(<div className="project-settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingRef.current) onClose(); }}>
    <section ref={dialog} className="project-settings-dialog custom-provider-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><h2 id={titleId}>{settings ? "Edit custom provider" : "Add provider"}</h2><button type="button" disabled={saving} aria-label="Close" onClick={onClose}><X size={16} /></button></header>
      <form noValidate onSubmit={(event) => void submit(event)}>
        <div className="custom-provider-dialog-body">
          <p className="custom-provider-intro">Connect a gateway or a local model service with its own endpoint and models.</p>
          <fieldset className="project-settings-section" disabled={saving}>
            <div className={!settings ? "project-settings-field-row" : undefined}>
              {!settings ? <label><span>Preset</span><select value={preset} onChange={(event) => { const next = event.target.value as keyof typeof PRESETS; cancelDiscovery(); setPreset(next); setForm({ ...PRESETS[next] }); setDiscoveryError(undefined); setFetchedCount(undefined); setTruncated(false); }}>
                <option value="gateway">Custom gateway</option><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option>
              </select></label> : null}
              <label><span>Display name</span><input ref={nameInput} value={form.name} onChange={(event) => field("name", event.target.value)} placeholder="My provider" maxLength={100} required autoComplete="off" /></label>
            </div>
            <label><span>Base URL</span><input ref={endpointInput} type="url" value={form.baseUrl} onChange={(event) => field("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" required autoComplete="off" spellCheck={false} /><small>Use the API endpoint, including /v1 when your service requires it.</small></label>
            <div className="project-settings-field-row">
              <label><span>API protocol</span><select value={form.api} onChange={(event) => field("api", event.target.value)}>{CUSTOM_MODEL_APIS.map((api) => <option key={api} value={api}>{PROVIDER_API_LABELS[api]}</option>)}</select></label>
              <label><span>Authentication</span><select value={form.authentication} onChange={(event) => field("authentication", event.target.value as SaveCustomProviderRequest["authentication"])}><option value="api_key">API key</option><option value="none">No API key</option></select></label>
            </div>
            {form.authentication === "api_key" ? <label><span>API key</span><input ref={keyInput} type="password" value={form.apiKey ?? ""} onChange={(event) => field("apiKey", event.target.value)} required={!settings || settings.authentication !== "api_key"} placeholder={settings?.authentication === "api_key" ? "Leave blank to keep the current key" : "Paste your API key"} autoComplete="new-password" spellCheck={false} /></label> : <p className="custom-provider-hint">For local services that do not require an API key.</p>}
          </fieldset>
          <section className="custom-provider-model-picker" aria-label="Model settings">
            <div className="custom-provider-model-heading">
              <h3>Models <small>{enabledCount} enabled</small></h3>
              <button className="settings-secondary-button" type="button" disabled={saving || fetching} onClick={() => void fetchModels()}>{fetching ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{fetching ? "Fetching…" : "Fetch"}</button>
            </div>
            <p className="custom-provider-hint">Fetch models or add them manually. You can save this provider without any models.</p>
            {discoveryError ? <p className="project-settings-error" role="alert">{discoveryError}</p> : null}
            {fetchedCount !== undefined ? <p className="custom-provider-hint" role="status">{truncated ? `Fetched the first ${fetchedCount} models. Other model IDs can be added manually.` : `Fetched ${fetchedCount} models.`}</p> : null}
            {rows.length ? <>
              <label className="custom-provider-model-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models" disabled={saving} /></label>
              {visibleModels.length ? <>
                <label className="custom-provider-select-all"><input type="checkbox" checked={allVisibleEnabled} onChange={(event) => toggleModels(visibleModels.map((row) => row.model.id), event.target.checked)} disabled={saving} />{search ? "Enable matching models" : "Enable all models"}</label>
                <div className="custom-provider-model-results" role="group" aria-label="Available models">
                  {visibleModels.map((row) => <div className="custom-provider-model-item" key={row.model.id}>
                    <div className="custom-provider-model-row">
                      <label className="custom-provider-model-choice"><input type="checkbox" aria-label={`Enable ${row.model.name || row.model.id}`} checked={row.enabled} onChange={(event) => toggleModels([row.model.id], event.target.checked)} disabled={saving} /><span><strong>{row.model.name || row.model.id}</strong><small>{row.model.id}</small></span></label>
                      <button className="icon-button" type="button" aria-label={`Edit ${row.model.name || row.model.id}`} data-tooltip={`Edit ${row.model.name || row.model.id}`} aria-expanded={editing === row.model.id} disabled={saving} onClick={() => setEditing((current) => current === row.model.id ? undefined : row.model.id)}><Pencil size={14} /></button>
                      <button className="icon-button" type="button" aria-label={`Remove ${row.model.name || row.model.id}`} data-tooltip={`Remove ${row.model.name || row.model.id}`} disabled={saving} onClick={() => { setRows((current) => current.filter((item) => item.model.id !== row.model.id)); if (editing === row.model.id) setEditing(undefined); }}><Trash2 size={14} /></button>
                    </div>
                    {editing === row.model.id ? <div className="custom-provider-model-editor" role="group" aria-label={`Edit model ${row.model.id}`}><ModelFields model={row.model} onChange={(model) => updateModel(row.model.id, model)} disabled={saving} /></div> : null}
                  </div>)}
                </div>
              </> : <p className="custom-provider-hint">No models match your search.</p>}
            </> : <p className="custom-provider-model-empty">No models added yet.</p>}
            <details className="custom-provider-manual" open={manualOpen} onToggle={(event) => setManualOpen(event.currentTarget.open)}>
              <summary>Add a model manually</summary>
              <label><span>Model ID</span><input value={manual.id} onChange={(event) => setManual((current) => ({ ...current, id: event.target.value }))} placeholder={preset === "ollama" ? "qwen3:8b" : "Model ID from your provider"} maxLength={200} disabled={saving} autoComplete="off" spellCheck={false} /></label>
              <details className="custom-provider-advanced"><summary>Advanced model settings</summary><ModelFields model={manual} onChange={setManual} disabled={saving || !manual.id.trim()} /></details>
              <button className="settings-secondary-button custom-provider-manual-add" type="button" disabled={saving || !manual.id.trim()} onClick={addManualModel}><Plus size={13} />Add model</button>
            </details>
          </section>
          {error ? <p className="project-settings-error" role="alert">{error}</p> : null}
        </div>
        <footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="project-settings-submit" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={14} /> : null}{saving ? "Saving…" : settings ? "Save changes" : "Add provider"}</button></footer>
      </form>
    </section>
  </div>, document.body);
}

function ModelFields({ model, onChange, disabled }: { model: CustomProviderModel; onChange: (model: CustomProviderModel) => void; disabled: boolean }) {
  const field = <K extends keyof CustomProviderModel>(key: K, value: CustomProviderModel[K]) => onChange({ ...model, [key]: value });
  return <fieldset className="project-settings-section" disabled={disabled}>
    <label><span>Model display name</span><input value={model.name} onChange={(event) => field("name", event.target.value)} placeholder={model.id || "Same as model ID"} maxLength={200} /></label>
    <div className="project-settings-field-row">
      <label><span>Context window</span><input type="number" min={1} max={100_000_000} step={1} value={model.contextWindow} onChange={(event) => field("contextWindow", Number(event.target.value))} required /></label>
      <label><span>Max output tokens</span><input type="number" min={1} max={model.contextWindow} step={1} value={model.maxTokens} onChange={(event) => field("maxTokens", Number(event.target.value))} required /></label>
    </div>
    <div className="custom-provider-capabilities"><label><input type="checkbox" checked={model.reasoning} onChange={(event) => field("reasoning", event.target.checked)} />Reasoning</label><label><input type="checkbox" checked={model.supportsImages} onChange={(event) => field("supportsImages", event.target.checked)} />Image input</label></div>
  </fieldset>;
}

function modelError(model: CustomProviderModel): string | undefined {
  if (!model.id.trim() || /[\s\x00-\x1f]/.test(model.id) || model.id.length > 200) return "Enter a model ID without spaces (up to 200 characters).";
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || model.contextWindow > 100_000_000 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow) return `Check the token limits for ${model.name || model.id}. Output tokens must not exceed the context window.`;
}
