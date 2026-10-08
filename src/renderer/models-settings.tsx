import { ArrowLeft, ChevronDown, ChevronRight, Code2, ExternalLink, LoaderCircle, Pencil, Search, Server, Plus, Plug, RefreshCw, Settings, Trash2, UserRound } from "./icons.js";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  CustomProviderDetails,
  ModelAuthEvent,
  ModelAuthMethod,
  ModelAuthNotification,
  ModelAuthPrompt,
  ImageModel,
  ImageModelRef,
  ModelProviderSummary,
  ProviderCapability,
  ProviderSummary,
  VideoModel,
} from "../shared/contracts.js";
import { CUSTOM_IMAGE_MODEL_APIS } from "../shared/contracts.js";
import {
  getCustomProvider,
  removeCustomProvider,
  setProviderEnabled,
  cancelModelAuth,
  getOpenAIEndpointSettings,
  listProviders,
  listImageModelCatalog,
  setDefaultImageModel,
  notifyAgentModelsChanged,
  respondToModelAuth,
  startModelProviderLogin,
  subscribeToModelAuth,
  updateOpenAIEndpointSettings,
  updateMeshyApiKey,
  updateSeedanceApiKey,
  listVideoModelCatalog,
} from "./api.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import { CustomProviderDialog, PROVIDER_API_LABELS, type CustomProviderField } from "./custom-provider-dialog.js";
import { ProviderModels } from "./provider-models.js";
import { SegmentedControl } from "./segmented-control.js";

export type ModelsView = { page: "providers" } | { page: "provider"; provider: ProviderSummary };

const POPULAR_PROVIDER_IDS = ["openrouter", "openai", "anthropic"];
const SEEDANCE_PROVIDER_IDS = new Set(["volcengine-ark", "byteplus-modelark"]);
const PROVIDER_CAPABILITY_FILTERS: Array<{ value: "all" | ProviderCapability; label: string }> = [
  { value: "all", label: "All" },
  { value: "language", label: "Language" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "3d", label: "3D" },
];
const PROVIDER_CAPABILITY_LABELS: Record<ProviderCapability, string> = {
  language: "Language",
  image: "Image",
  video: "Video",
  "3d": "3D",
};

export function ModelsSettings({ view, onViewChange }: { view: ModelsView; onViewChange: (view: ModelsView) => void }) {
  const openProvider = (provider: ProviderSummary): void => onViewChange({ page: "provider", provider });
  if (view.page === "providers") {
    return <ProviderList onProvider={openProvider} />;
  }
  return <ProviderAuthView provider={view.provider} onBack={() => onViewChange({ page: "providers" })} onCompleted={() => onViewChange({ page: "providers" })} />;
}

function ProviderList({ onProvider }: { onProvider: (provider: ProviderSummary) => void }) {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [capability, setCapability] = useState<"all" | ProviderCapability>("all");
  useEffect(() => {
    let active = true;
    void listProviders().then((loaded) => {
      if (active) setProviders(loaded);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);
  async function toggleProvider(provider: ProviderSummary, enabled: boolean): Promise<void> {
    setPending((current) => new Set(current).add(provider.id));
    setError(undefined);
    setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, enabled } : item));
    try {
      const saved = await setProviderEnabled(provider.id, enabled);
      setProviders((current) => current.map((item) => item.id === provider.id ? saved : item));
    } catch (cause) {
      setProviders((current) => current.map((item) => item.id === provider.id ? provider : item));
      setError(errorMessage(cause));
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(provider.id); return next; });
    }
  }
  const rowActions = { onToggle: (provider: ProviderSummary, enabled: boolean) => void toggleProvider(provider, enabled), pending };
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProviders = providers.filter((provider) => (
    (capability === "all" || provider.capabilities.includes(capability))
    && (!normalizedQuery || [
      provider.name,
      providerDescription(provider),
      ...provider.capabilities.map((item) => PROVIDER_CAPABILITY_LABELS[item]),
    ].some((value) => value.toLowerCase().includes(normalizedQuery)))
  ));
  const connectedProviders = visibleProviders.filter((provider) => provider.status === "connected");
  const remainingProviders = visibleProviders.filter((provider) => provider.status !== "connected");
  const popularProviders = remainingProviders
    .filter((provider) => POPULAR_PROVIDER_IDS.includes(provider.id))
    .sort((first, second) => POPULAR_PROVIDER_IDS.indexOf(first.id) - POPULAR_PROVIDER_IDS.indexOf(second.id));
  const moreProviders = remainingProviders.filter((provider) => !POPULAR_PROVIDER_IDS.includes(provider.id));
  const filteredProviders = [...connectedProviders, ...popularProviders, ...moreProviders];
  const filtering = capability !== "all" || Boolean(normalizedQuery);
  return (
    <section className="settings-panel settings-overview-panel">
      <header className="settings-panel-header">
        <h3>Providers &amp; Models</h3>
        <label className="settings-provider-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search providers" aria-label="Search providers" />
        </label>
      </header>
      {adding ? <CustomProviderDialog onClose={() => setAdding(false)} onSaved={() => {
        setAdding(false);
        setQuery("");
        setCapability("all");
        void listProviders().then(setProviders).catch((cause) => setError(errorMessage(cause)));
      }} /> : null}
      <div className="settings-provider-list">
        <div className="settings-provider-toolbar">
          <SegmentedControl className="settings-provider-filters" label="Filter providers by capability" options={PROVIDER_CAPABILITY_FILTERS} value={capability} onChange={setCapability} />
          <button className="settings-secondary-button settings-provider-add" type="button" onClick={() => setAdding(true)}><Plus size={13} />Add provider</button>
        </div>
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={18} />Loading providers</div> : null}
        {!loading && providers.length === 0 && !error ? <p className="settings-empty">No configurable providers are available.</p> : null}
        {!loading && providers.length > 0 && visibleProviders.length === 0 ? <p className="settings-empty">No providers match these filters.</p> : null}
        {filtering && filteredProviders.length ? <ProviderGroup {...rowActions} title="Providers" providers={filteredProviders} onProvider={onProvider} /> : null}
        {!filtering && connectedProviders.length ? <ProviderGroup {...rowActions} title="Connected providers" providers={connectedProviders} onProvider={onProvider} /> : null}
        {!filtering && popularProviders.length ? <ProviderGroup {...rowActions} title="Popular providers" providers={popularProviders} onProvider={onProvider} /> : null}
        {!filtering && moreProviders.length ? (
          <section className="settings-provider-group">
            <button className="settings-provider-more" type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
              <span>More providers <small>({moreProviders.length})</small></span>
              <ChevronDown size={14} />
            </button>
            {moreOpen ? moreProviders.map((provider) => <ProviderRow {...rowActions} provider={provider} onProvider={onProvider} key={provider.id} />) : null}
          </section>
        ) : null}
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

type ProviderRowActions = { onToggle: (provider: ProviderSummary, enabled: boolean) => void; pending: Set<string> };

function ProviderGroup({ detail, onProvider, providers, title, ...actions }: { detail?: string; onProvider: (provider: ProviderSummary) => void; providers: ProviderSummary[]; title: string } & ProviderRowActions) {
  return (
    <section className="settings-provider-group">
      <h4>{title}</h4>
      {providers.map((provider) => <ProviderRow {...actions} provider={provider} detail={detail} featured={provider.id === "openrouter"} onProvider={onProvider} key={provider.id} />)}
    </section>
  );
}

function ProviderRow({ detail, featured = false, onProvider, provider, onToggle, pending }: { detail?: string; featured?: boolean; onProvider: (provider: ProviderSummary) => void; provider: ProviderSummary } & ProviderRowActions) {
  const ActionIcon = provider.status === "connecting" ? LoaderCircle : provider.status === "error" ? RefreshCw : provider.configured ? Settings : Plug;
  const actionLabel = `${providerAction(provider)} ${provider.name}`;
  return (
    <div className={`settings-provider-row${featured ? " is-featured" : ""}`}>
      <ProviderMark provider={provider} />
      <span className="settings-provider-copy">
        <strong className="settings-provider-name"><span>{provider.name}</span>{featured ? <small>Recommended</small> : null}</strong>
        <span className="settings-provider-details">
          <span className="settings-provider-description">{providerDescription(provider)}{detail ? <><i>·</i>{detail}</> : null}</span>
          <span className="settings-provider-capabilities" aria-label={`Provider labels: ${[...provider.capabilities.map((capability) => PROVIDER_CAPABILITY_LABELS[capability]), ...(provider.custom ? ["Custom"] : [])].join(", ")}`}>
            {provider.capabilities.map((capability) => <small key={capability}>{PROVIDER_CAPABILITY_LABELS[capability]}</small>)}
            {provider.custom ? <small>Custom</small> : null}
          </span>
        </span>
      </span>
      {provider.configured ? <label className="settings-toggle settings-provider-toggle" title={provider.enabled !== false ? "Enabled" : "Disabled"}>
        <input type="checkbox" role="switch" aria-label={`Enable ${provider.name}`} checked={provider.enabled !== false} disabled={pending.has(provider.id)} onChange={(event) => onToggle(provider, event.target.checked)} /><span aria-hidden="true" />
      </label> : provider.status === "not_configured" ? null : <em className={`settings-provider-status is-${provider.status}`}><i />{providerStatus(provider)}</em>}
      <button className="icon-button settings-provider-action" type="button" data-tooltip={actionLabel} aria-label={actionLabel} disabled={provider.status === "connecting" || pending.has(provider.id)} onClick={() => onProvider(provider)}><ActionIcon size={17} className={provider.status === "connecting" ? "spin" : undefined} aria-hidden="true" /></button>
    </div>
  );
}

function ProviderMark({ provider }: { provider: Pick<ModelProviderSummary, "id"> }) {
  const icon = PROVIDER_ICONS[provider.id];
  if (!icon) return <span className="settings-provider-mark-slot" aria-hidden="true"><Server size={20} /></span>;
  return <span className={`settings-provider-mark is-${icon.tone}`} aria-hidden="true"><img src={icon.src} alt="" /></span>;
}

function ProviderAuthView({ provider, onBack, onCompleted }: { provider: ProviderSummary; onBack: () => void; onCompleted: () => void }) {
  if (provider.custom) return <CustomProviderDetail provider={provider} onBack={onBack} onRemoved={onCompleted} />;
  if (provider.id === "meshy") return <MeshyAuthView provider={provider} onBack={onBack} onCompleted={onCompleted} />;
  if (SEEDANCE_PROVIDER_IDS.has(provider.id)) return <SeedanceAuthView provider={provider} onBack={onBack} onCompleted={onCompleted} />;
  const [method, setMethod] = useState<ModelAuthMethod | undefined>(provider.configured ? undefined : provider.methods.length === 1 ? provider.methods[0]?.type : undefined);
  if (provider.configured) return <ConnectedProvider provider={provider} onBack={onBack} />;
  if (!method) return <AuthMethodChoice provider={provider} onBack={onBack} onChoose={setMethod} />;
  return <ActiveProviderAuth provider={provider} method={method} onBack={onBack} onCompleted={onCompleted} />;
}

function SeedanceAuthView({ provider, onBack, onCompleted }: { provider: ProviderSummary; onBack: () => void; onCompleted: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [modelsRevision, setModelsRevision] = useState(0);
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await updateSeedanceApiKey(provider.id, apiKey);
      onCompleted();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  const inputId = `${provider.id}-api-key`;
  return (
    <section className="settings-panel settings-provider-detail">
      <ProviderDetailHeader provider={provider} onBack={onBack}>
        {provider.configured ? <ProviderEnableControl provider={provider} onChanged={() => setModelsRevision((value) => value + 1)} /> : null}
      </ProviderDetailHeader>
      <form className="settings-detail-field" onSubmit={(event) => void save(event)}>
        <label className="settings-search-field-label" htmlFor={inputId}>API key</label>
        <div className="settings-detail-inline">
          <input
            id={inputId}
            className="settings-search-input"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={provider.configured ? "Paste a new key to replace the current one" : `Paste your ${provider.name} API key`}
            disabled={saving}
          />
          <button className="settings-primary-button" type="submit" disabled={saving || !apiKey.trim()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {provider.configured && provider.id === "volcengine-ark" ? <ProviderImageModels key={`seedream-${modelsRevision}`} providerId={provider.id} /> : null}
      {provider.configured ? <SeedanceModels key={`seedance-${modelsRevision}`} providerId={provider.id} /> : null}
    </section>
  );
}

function ProviderImageModels({ providerId }: { providerId: string }) {
  const groupId = useId();
  const [models, setModels] = useState<ImageModel[]>();
  const [defaultModel, setDefaultModel] = useState<ImageModelRef>();
  const [busy, setBusy] = useState(false);
  const [emptyMessage, setEmptyMessage] = useState("No image models are available.");
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void listImageModelCatalog().then((catalog) => {
      if (!active) return;
      const status = catalog.providers.find((provider) => provider.provider === providerId);
      setModels(catalog.models.filter((model) => model.provider === providerId));
      setDefaultModel(catalog.defaultModel);
      setEmptyMessage(status?.message ?? "No image models are available.");
      setError(status?.state === "error" ? status.message : undefined);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [providerId]);

  async function chooseDefault(model: ImageModel): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const selected = { provider: model.provider, id: model.id };
      await setDefaultImageModel(selected);
      setDefaultModel(selected);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return (
    <section className="settings-detail-section provider-models" aria-label="Image models">
      <div className="provider-models-heading">
        <h4>Image models <small>{models?.length ?? ""}</small></h4>
      </div>
      {models?.length ? <p className="settings-detail-hint">Choose the default for AI image generation. Existing canvas nodes keep their selected model.</p> : null}
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {models ? (
        <div className="provider-models-list" role="list" aria-label="Image models">
          {models.map((model) => (
            <div className="provider-model-row" key={model.id} role="listitem">
              <label>
                <input type="radio" name={groupId} checked={defaultModel?.provider === model.provider && defaultModel.id === model.id} disabled={busy} aria-label={`Use ${model.name} as the default image model`} onChange={() => void chooseDefault(model)} />
                <span className="provider-model-copy">
                  <strong title={model.name}>{model.name}</strong>
                  <small title={model.id}>{model.id}</small>
                </span>
              </label>
              {defaultModel?.provider === model.provider && defaultModel.id === model.id ? <small className="provider-model-custom">Default</small> : null}
            </div>
          ))}
          {!models.length && !error ? <p className="settings-empty">{emptyMessage}</p> : null}
        </div>
      ) : !error ? <div className="settings-loading"><LoaderCircle className="spin" size={16} />Loading models</div> : null}
    </section>
  );
}

function SeedanceModels({ providerId }: { providerId: string }) {
  const [models, setModels] = useState<VideoModel[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void listVideoModelCatalog().then((catalog) => {
      if (active) setModels(catalog.models.filter((model) => model.provider === providerId));
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [providerId]);

  return (
    <section className="settings-detail-section provider-models" aria-label="Video models">
      <div className="provider-models-heading">
        <h4>Video models <small>{models?.length ?? ""}</small></h4>
      </div>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {models ? (
        <div className="provider-models-list" role="list" aria-label="Video models">
          {models.map((model) => (
            <div className="provider-model-row" key={model.id} role="listitem">
              <div className="provider-model-readonly">
                <span className="provider-model-copy">
                  <strong title={model.name}>{model.name}</strong>
                  <small title={model.id}>{model.id}</small>
                </span>
              </div>
            </div>
          ))}
          {!models.length ? <p className="settings-empty">No video models are available.</p> : null}
        </div>
      ) : !error ? <div className="settings-loading"><LoaderCircle className="spin" size={16} />Loading models</div> : null}
    </section>
  );
}

function CustomProviderDetail({ provider, onBack, onRemoved }: { provider: ProviderSummary; onBack: () => void; onRemoved: () => void }) {
  const [settings, setSettings] = useState<CustomProviderDetails>();
  const [editing, setEditing] = useState<CustomProviderField>();
  const [openingEditor, setOpeningEditor] = useState(false);
  const [modelsRevision, setModelsRevision] = useState(0);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void getCustomProvider(provider.id).then((value) => { if (active) setSettings(value); }).catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [provider.id]);
  async function openEditor(field: CustomProviderField): Promise<void> {
    if (openingEditor || deleting || editing) return;
    setOpeningEditor(true);
    setError(undefined);
    try {
      // Model edits on this page may have changed the settings since the detail first loaded.
      setSettings(await getCustomProvider(provider.id));
      setEditing(field);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setOpeningEditor(false); }
  }
  async function remove(): Promise<void> {
    setDeleting(true);
    setError(undefined);
    try { await removeCustomProvider(provider.id); onRemoved(); }
    catch (cause) { setError(errorMessage(cause)); setDeleting(false); }
  }
  const fields: Array<{ field: CustomProviderField; label: string; value: string }> = settings ? [
    { field: "apiKey", label: "API key", value: settings.authentication === "api_key" ? "••••••••" : "Not required" },
    { field: "baseUrl", label: "Base URL", value: settings.baseUrl },
    { field: "api", label: "API", value: PROVIDER_API_LABELS[settings.api] ?? settings.api },
  ] : [];
  return <section className="settings-panel settings-provider-detail">
    <ProviderDetailHeader provider={{ ...provider, name: settings?.name ?? provider.name }} onBack={onBack}>
      <button className="icon-button settings-provider-setting-edit settings-provider-delete" type="button" aria-label="Delete provider" data-tooltip="Delete provider" aria-expanded={confirmingDelete} disabled={deleting || openingEditor || Boolean(editing)} onClick={() => setConfirmingDelete((value) => !value)}><Trash2 size={15} aria-hidden="true" /></button>
      <ProviderEnableControl provider={provider} onChanged={() => setModelsRevision((value) => value + 1)} />
    </ProviderDetailHeader>
    {settings ? <div className="settings-provider-connection">
      {fields.map(({ field, label, value }) => <div className="settings-provider-setting-row" key={field}>
        <span className="settings-search-field-label">{label}</span>
        <span className="settings-provider-setting-value" title={field === "apiKey" ? undefined : value}>{value}</span>
        <button className="icon-button settings-provider-setting-edit" type="button" aria-label={`Edit ${label}`} data-tooltip={`Edit ${label}`} disabled={deleting || openingEditor || Boolean(editing)} onClick={() => void openEditor(field)}><Pencil size={15} aria-hidden="true" /></button>
      </div>)}
    </div> : !error ? <div className="settings-loading"><LoaderCircle className="spin" size={16} />Loading configuration</div> : null}
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    <ProviderModels key={modelsRevision} providerId={provider.id} onEditModels={() => void openEditor("models")} />
    {settings && CUSTOM_IMAGE_MODEL_APIS.some((api) => api === settings.api) ? <ProviderImageModels key={`images-${modelsRevision}`} providerId={provider.id} /> : null}
    {confirmingDelete ? <div className="settings-custom-provider-delete" role="group" aria-label="Delete provider confirmation">
      <span>Delete this provider, its key and model settings?</span><button className="settings-danger-button" type="button" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete provider"}</button><button className="settings-secondary-button" type="button" disabled={deleting} onClick={() => setConfirmingDelete(false)}>Cancel</button>
    </div> : null}
    {editing && settings ? <CustomProviderDialog settings={settings} initialFocus={editing} onClose={() => setEditing(undefined)} onSaved={(value) => { setSettings(value); setEditing(undefined); setModelsRevision((revision) => revision + 1); }} /> : null}
  </section>;
}

function MeshyAuthView({ provider, onBack, onCompleted }: { provider: ProviderSummary; onBack: () => void; onCompleted: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await updateMeshyApiKey(apiKey);
      onCompleted();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-panel settings-provider-detail">
      <ProviderDetailHeader provider={provider} onBack={onBack}>
        {provider.configured ? <ProviderEnableControl provider={provider} /> : null}
      </ProviderDetailHeader>
      <form className="settings-detail-field" onSubmit={(event) => void save(event)}>
        <label className="settings-search-field-label" htmlFor="meshy-api-key">API key</label>
        <div className="settings-detail-inline">
          <input
            id="meshy-api-key"
            className="settings-search-input"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={provider.configured ? "Paste a new key to replace the current one" : "Paste your Meshy API key"}
            disabled={saving}
          />
          <button className="settings-primary-button" type="submit" disabled={saving || !apiKey.trim()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
    </section>
  );
}

function AuthMethodChoice({ provider, onBack, onChoose }: { provider: ModelProviderSummary; onBack: () => void; onChoose: (method: ModelAuthMethod) => void }) {
  return (
    <section className="settings-panel settings-provider-detail">
      <ProviderDetailHeader provider={provider} onBack={onBack} />
      <div className="settings-detail-section">
        <DetailSectionHeader title="Connect" description="Choose how OhMyGame should connect to this provider." />
        <div className="settings-method-list">
          {provider.methods.map((method) => {
            const Icon = method.type === "oauth" ? UserRound : Code2;
            return (
              <button className="settings-method-row" type="button" key={method.type} onClick={() => onChoose(method.type)}>
                <span className="settings-method-icon"><Icon size={15} /></span>
                <span className="settings-method-copy">
                  <strong>{method.label}</strong>
                  <small>{method.type === "oauth" ? "Sign in with your account in the browser" : "Paste a key from your provider dashboard"}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ConnectedProvider({ provider, onBack }: { provider: ProviderSummary; onBack: () => void }) {
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState<ModelAuthMethod | "endpoint">();
  const [credentialType, setCredentialType] = useState(provider.credentialType ?? "api_key");
  const [modelsRevision, setModelsRevision] = useState(0);
  const endpoint = useProviderEndpoint(provider.id);
  function edit(setting: ModelAuthMethod | "endpoint"): void {
    setNotice(undefined);
    setError(undefined);
    setEditing(setting);
  }
  function completeAuth(method: ModelAuthMethod): void {
    setCredentialType(method);
    setEditing(undefined);
    setModelsRevision((value) => value + 1);
    setNotice(method === "oauth" ? "Browser sign-in connected." : "API key updated.");
  }
  async function saveEndpoint(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    try {
      await endpoint.save();
      notifyAgentModelsChanged();
      setEditing(undefined);
      setNotice("Base URL saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const displayedError = error ?? endpoint.error;
  // Only API keys can go through a proxy; a ChatGPT sign-in always talks to OpenAI directly.
  const showsEndpoint = endpoint.supported && credentialType !== "oauth";
  const canEditKey = credentialType !== "oauth" && provider.methods.some((method) => method.type === "api_key");
  const alternateMethod = provider.methods.length > 1 ? provider.methods.find((method) => method.type !== credentialType)?.type : undefined;
  return (
    <section className="settings-panel settings-provider-detail">
      <ProviderDetailHeader provider={provider} onBack={onBack}>
        <ProviderEnableControl provider={provider} onChanged={() => setModelsRevision((value) => value + 1)} />
      </ProviderDetailHeader>
      {alternateMethod || canEditKey || showsEndpoint ? <div className="settings-provider-connection">
        {alternateMethod ? <div className="settings-provider-setting-row settings-provider-auth-row">
          <span className="settings-search-field-label">Sign-in</span>
          <span className="settings-provider-setting-value">{credentialType === "oauth" ? "Browser sign-in" : "API key"}</span>
          <button className="settings-secondary-button" type="button" disabled={Boolean(editing)} onClick={() => edit(alternateMethod)}>{alternateMethod === "oauth" ? "Use browser sign-in" : "Use API key"}</button>
        </div> : null}
        {canEditKey ? <section aria-label="API key settings">
          <div className="settings-provider-setting-row">
            <span className="settings-search-field-label">API key</span>
            <span className="settings-provider-setting-value" aria-label="API key is configured">••••••••</span>
            <button className="icon-button settings-provider-setting-edit" type="button" aria-label="Edit API key" data-tooltip="Edit API key" aria-expanded={editing === "api_key"} disabled={Boolean(editing)} onClick={() => edit("api_key")}><Pencil size={15} aria-hidden="true" /></button>
          </div>
        </section> : null}
        {editing === "api_key" || editing === "oauth" ? <div className="settings-provider-setting-editor"><ActiveProviderAuth provider={provider} method={editing} inline onBack={() => setEditing(undefined)} onCompleted={() => completeAuth(editing)} onFailed={(message) => { setEditing(undefined); setError(message); }} /></div> : null}
        {showsEndpoint ? <section aria-label="Base URL settings">
          <div className="settings-provider-setting-row">
            <span className="settings-search-field-label">Base URL</span>
            <span className="settings-provider-setting-value" title={endpoint.savedBaseUrl}>{endpoint.loading ? "Loading…" : endpoint.savedBaseUrl || "Unavailable"}</span>
            <button className="icon-button settings-provider-setting-edit" type="button" aria-label="Edit Base URL" data-tooltip="Edit Base URL" aria-expanded={editing === "endpoint"} disabled={Boolean(editing) || endpoint.loading} onClick={() => edit("endpoint")}><Pencil size={15} aria-hidden="true" /></button>
          </div>
          {editing === "endpoint" ? <form className="settings-provider-setting-editor settings-detail-section" onSubmit={(event) => void saveEndpoint(event)}>
            <BaseUrlField endpoint={endpoint} />
            <div className="settings-form-actions">
              <button className="settings-secondary-button" type="button" disabled={endpoint.saving} onClick={() => { endpoint.reset(); setEditing(undefined); setError(undefined); }}>Cancel</button>
              <button className="settings-primary-button" type="submit" disabled={endpoint.loading || endpoint.saving || !endpoint.baseUrl.trim() || !endpoint.dirty}>{endpoint.saving ? "Saving…" : "Save"}</button>
            </div>
          </form> : null}
        </section> : null}
      </div> : null}
      {displayedError ? <p className="settings-error" role="alert">{displayedError}</p> : null}
      {notice ? <p className="settings-success" role="status">{notice}</p> : null}
      <ProviderModels key={modelsRevision} providerId={provider.id} />
      {provider.capabilities.includes("image") ? <ProviderImageModels key={`images-${modelsRevision}`} providerId={provider.id} /> : null}
    </section>
  );
}

function ActiveProviderAuth({ provider, method, inline = false, onBack, onCompleted, onFailed }: { provider: ModelProviderSummary; method: ModelAuthMethod; inline?: boolean; onBack: () => void; onCompleted: () => void; onFailed?: (error: string) => void }) {
  const [operationId, setOperationId] = useState<string>();
  const [prompt, setPrompt] = useState<{ id: string; value: ModelAuthPrompt }>();
  const [notification, setNotification] = useState<ModelAuthNotification>();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string>();
  const operationRef = useRef<string | undefined>(undefined);
  const openedUrl = useRef<string | undefined>(undefined);
  const endpoint = useProviderEndpoint(inline ? "" : provider.id);
  const editingKey = inline && method === "api_key";
  // A proxy Base URL only applies to API keys; never send a ChatGPT sign-in through it.
  const editsEndpoint = endpoint.supported && method === "api_key";

  useEffect(() => {
    let active = true;
    void startModelProviderLogin(provider.id, method).then((id) => {
      if (!active) {
        void cancelModelAuth(id).catch(() => undefined);
        return;
      }
      operationRef.current = id;
      setOperationId(id);
    }).catch((cause) => {
      if (active) fail(errorMessage(cause));
    });
    return () => {
      active = false;
      if (operationRef.current) void cancelModelAuth(operationRef.current).catch(() => undefined);
    };
  }, [method, provider.id]);

  useEffect(() => {
    if (!operationId) return;
    return subscribeToModelAuth(operationId, {
      onEvent: (event) => handleAuthEvent(event),
      onError: () => setError("Connection to the authentication flow was interrupted."),
    });
  }, [operationId]);

  function fail(message: string): void {
    if (onFailed) onFailed(message);
    else setError(message);
  }

  function handleAuthEvent(event: ModelAuthEvent): void {
    if (event.type === "notification") {
      setNotification(event.notification);
      return;
    }
    if (event.type === "prompt") {
      setPrompt({ id: event.promptId, value: event.prompt });
      setAnswer("");
      return;
    }
    if (event.type === "completed") {
      operationRef.current = undefined;
      notifyAgentModelsChanged();
      onCompleted();
    } else if (event.type === "cancelled") {
      operationRef.current = undefined;
      onBack();
    } else if (event.type === "error") {
      operationRef.current = undefined;
      fail(event.error);
    }
  }

  async function respond(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!operationId || !prompt) return;
    const value = prompt.value.type === "select" ? answer || prompt.value.options[0]?.id || "" : answer;
    try {
      if (editsEndpoint) await endpoint.save();
      await respondToModelAuth(operationId, prompt.id, value);
      setPrompt(undefined);
      setAnswer("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function cancel(): Promise<void> {
    if (operationId) await cancelModelAuth(operationId).catch(() => undefined);
    operationRef.current = undefined;
    onBack();
  }

  const external = authExternalTarget(notification);
  const displayedError = error ?? endpoint.error;
  // Browser sign-in also offers pasting the redirect URL, in case the callback never reaches the app.
  const browserFallback = prompt?.value.type === "manual_code" && Boolean(external);

  useEffect(() => {
    if (method !== "oauth" || !external || openedUrl.current === external) return;
    openedUrl.current = external;
    void openExternal(external).catch(() => undefined);
  }, [external, method]);
  return (
    <section className={inline ? undefined : "settings-panel settings-provider-detail"}>
      {!inline ? <ProviderDetailHeader provider={provider} onBack={() => void cancel()} /> : null}
      {prompt && !browserFallback ? (
        <form className="settings-detail-section" onSubmit={(event) => void respond(event)}>
          {editsEndpoint ? <BaseUrlField endpoint={endpoint} /> : null}
          <label className="settings-detail-field">
            <span className="settings-search-field-label">{editingKey && prompt.value.type === "secret" ? "New API key" : prompt.value.message}</span>
            {prompt.value.type === "select" ? (
              <select className="settings-search-input" value={answer || prompt.value.options[0]?.id || ""} onChange={(event) => setAnswer(event.target.value)}>
                {prompt.value.options.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
              </select>
            ) : (
              <input className="settings-search-input" type={prompt.value.type === "secret" ? "password" : "text"} value={answer} placeholder={editingKey && prompt.value.type === "secret" ? "Paste a new key to replace the current one" : prompt.value.placeholder} onChange={(event) => setAnswer(event.target.value)} autoFocus autoComplete={prompt.value.type === "secret" ? "new-password" : "off"} spellCheck={false} />
            )}
          </label>
          <div className="settings-form-actions">
            <button className="settings-secondary-button" type="button" onClick={() => void cancel()}>Cancel</button>
            <button className="settings-primary-button" type="submit" disabled={endpoint.loading || endpoint.saving || (editsEndpoint && !endpoint.baseUrl.trim()) || (prompt.value.type !== "select" && !prompt.value.optional && !answer.trim())}>{editingKey && prompt.value.type === "secret" ? "Save key" : "Continue"}</button>
          </div>
        </form>
      ) : (
        <div className="settings-detail-section">
          <div className="settings-detail-status settings-detail-waiting">
            <LoaderCircle className="spin" size={16} />
            <span className="settings-detail-status-copy">
              <strong>{method === "oauth" ? "Waiting for sign-in" : "Preparing configuration"}</strong>
              <small>{external && method === "oauth" ? "Finish signing in in your browser, then come back here." : notificationText(notification)}</small>
            </span>
          </div>
          {notification?.type === "device_code" ? <div className="settings-device-code">{notification.userCode}</div> : null}
          <div className="settings-form-actions">
            <button className="settings-secondary-button" type="button" onClick={() => void cancel()}>Cancel</button>
            {external ? <button className="settings-primary-button" type="button" onClick={() => void openExternal(external)}><ExternalLink size={14} />{method === "oauth" ? "Open browser again" : "Open browser"}</button> : null}
          </div>
          {browserFallback && prompt ? (
            <form className="settings-detail-field settings-auth-fallback" onSubmit={(event) => void respond(event)}>
              <label className="settings-detail-hint" htmlFor="model-auth-redirect">Browser didn't return here? Paste the address it ended on.</label>
              <div className="settings-detail-inline">
                <input id="model-auth-redirect" className="settings-search-input" value={answer} placeholder={prompt.value.type === "manual_code" ? prompt.value.placeholder : undefined} onChange={(event) => setAnswer(event.target.value)} spellCheck={false} />
                <button className="settings-secondary-button" type="submit" disabled={!answer.trim()}>Continue</button>
              </div>
            </form>
          ) : null}
        </div>
      )}
      {displayedError ? <p className="settings-error" role="alert">{displayedError}</p> : null}
    </section>
  );
}

function ProviderDetailHeader({ provider, onBack, children }: { provider: ModelProviderSummary; onBack: () => void; children?: ReactNode }) {
  return (
    <header className="settings-provider-detail-header">
      <button type="button" onClick={onBack} aria-label="Back"><ArrowLeft size={16} /></button>
      <ProviderMark provider={provider} />
      <span className="settings-provider-heading">
        <h3>{provider.name}</h3>
        <small>{providerDescription(provider)}</small>
      </span>
      {children}
    </header>
  );
}

function ProviderEnableControl({ provider, onChanged }: { provider: ProviderSummary; onChanged?: () => void }) {
  const [enabled, setEnabled] = useState(provider.enabled !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function toggle(next: boolean): Promise<void> {
    if (busy) return;
    const previous = enabled;
    setEnabled(next);
    setBusy(true);
    setError(undefined);
    try { setEnabled((await setProviderEnabled(provider.id, next)).enabled !== false); onChanged?.(); }
    catch (cause) { setEnabled(previous); setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="settings-provider-enable-control">
    <label className="settings-provider-enable-label" title={enabled ? "Available for new requests" : "Disabled · Your credentials and models are kept"}>
      <small>{enabled ? "Enabled" : "Disabled"}</small>
      <span className="settings-toggle"><input type="checkbox" role="switch" aria-label={`Enable ${provider.name}`} checked={enabled} disabled={busy} onChange={(event) => void toggle(event.target.checked)} /><span aria-hidden="true" /></span>
    </label>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
  </div>;
}

function DetailSectionHeader({ title, description }: { title: string; description: string }) {
  return <div className="settings-search-section-header"><h4>{title}</h4><p>{description}</p></div>;
}

function BaseUrlField({ endpoint }: { endpoint: ReturnType<typeof useProviderEndpoint> }) {
  return (
    <div className="settings-detail-field">
      <label className="settings-search-field-label" htmlFor="model-provider-base-url">Base URL</label>
      <div className="settings-detail-inline">
        <input id="model-provider-base-url" className="settings-search-input" value={endpoint.baseUrl} onChange={(event) => endpoint.setBaseUrl(event.target.value)} disabled={endpoint.loading || endpoint.saving} spellCheck={false} />
      </div>
      <small className="settings-detail-hint">Requests go to this OpenAI-compatible URL. Change it to use a proxy.</small>
    </div>
  );
}

function useProviderEndpoint(providerId: string) {
  const supported = providerId === "openai";
  const [baseUrl, setBaseUrl] = useState("");
  const [savedBaseUrl, setSavedBaseUrl] = useState("");
  const [loading, setLoading] = useState(supported);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!supported) return;
    let active = true;
    void getOpenAIEndpointSettings().then((settings) => {
      if (!active) return;
      setBaseUrl(settings.baseUrl);
      setSavedBaseUrl(settings.baseUrl);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [supported]);

  async function save(): Promise<void> {
    if (!supported) return;
    setSaving(true);
    setError(undefined);
    try {
      const settings = await updateOpenAIEndpointSettings(baseUrl.trim());
      setBaseUrl(settings.baseUrl);
      setSavedBaseUrl(settings.baseUrl);
    } finally {
      setSaving(false);
    }
  }

  return { supported, baseUrl, savedBaseUrl, setBaseUrl, reset: () => setBaseUrl(savedBaseUrl), dirty: baseUrl.trim() !== savedBaseUrl, loading, saving, error, save };
}

function providerDescription(provider: Pick<ModelProviderSummary, "methods"> & { custom?: boolean }): string {
  if (provider.custom) return "Custom endpoint";
  const oauth = provider.methods.some((method) => method.type === "oauth");
  const apiKey = provider.methods.some((method) => method.type === "api_key");
  if (oauth && apiKey) return "Browser sign-in or API key";
  if (oauth) return "Browser sign-in";
  return "API key";
}

function providerStatus(provider: ProviderSummary): string {
  if (provider.status === "connected") return "Connected";
  if (provider.status === "connecting") return "Checking…";
  if (provider.status === "error") return "Connection failed";
  return "Not configured";
}

function providerAction(provider: ProviderSummary): string {
  if (provider.status === "connected") return "Manage";
  if (provider.status === "connecting") return "Checking…";
  if (provider.status === "error") return "Retry";
  return "Connect";
}

function notificationText(notification: ModelAuthNotification | undefined): string {
  if (!notification) return "Starting authentication…";
  if (notification.type === "device_code") return "Enter the code in your browser.";
  if (notification.type === "auth_url") return notification.instructions ?? "Complete authentication in your browser.";
  return notification.message;
}

function authExternalTarget(notification: ModelAuthNotification | undefined): string | undefined {
  if (notification?.type === "auth_url") return notification.url;
  if (notification?.type === "device_code") return notification.verificationUri;
  if (notification?.type === "info") return notification.links?.[0]?.url;
  return undefined;
}

async function openExternal(url: string): Promise<void> {
  if (window.ohMyGameDesktop?.openExternal) {
    await window.ohMyGameDesktop.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
