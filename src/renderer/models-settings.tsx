import { ArrowLeft, ChevronDown, ChevronRight, Code2, ExternalLink, LoaderCircle, Search, UserRound } from "./icons.js";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  ModelAuthEvent,
  ModelAuthMethod,
  ModelAuthNotification,
  ModelAuthPrompt,
  ImageModel,
  ModelProviderSummary,
  ProviderCapability,
  ProviderSummary,
  VideoModel,
} from "../shared/contracts.js";
import {
  cancelModelAuth,
  disconnectModelProvider,
  getOpenAIEndpointSettings,
  listProviders,
  listImageModelCatalog,
  notifyAgentModelsChanged,
  respondToModelAuth,
  startModelProviderLogin,
  subscribeToModelAuth,
  updateOpenAIEndpointSettings,
  updateMeshyApiKey,
  clearMeshyApiKey,
  updateSeedanceApiKey,
  clearSeedanceApiKey,
  listVideoModelCatalog,
} from "./api.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
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
      <div className="settings-provider-list">
        <SegmentedControl className="settings-provider-filters" label="Filter providers by capability" options={PROVIDER_CAPABILITY_FILTERS} value={capability} onChange={setCapability} />
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={18} />Loading providers</div> : null}
        {!loading && providers.length === 0 && !error ? <p className="settings-empty">No configurable providers are available.</p> : null}
        {!loading && providers.length > 0 && visibleProviders.length === 0 ? <p className="settings-empty">No providers match these filters.</p> : null}
        {filtering && filteredProviders.length ? <ProviderGroup title="Providers" providers={filteredProviders} onProvider={onProvider} /> : null}
        {!filtering && connectedProviders.length ? <ProviderGroup title="Connected providers" providers={connectedProviders} onProvider={onProvider} /> : null}
        {!filtering && popularProviders.length ? <ProviderGroup title="Popular providers" providers={popularProviders} onProvider={onProvider} /> : null}
        {!filtering && moreProviders.length ? (
          <section className="settings-provider-group">
            <button className="settings-provider-more" type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
              <span>More providers <small>({moreProviders.length})</small></span>
              <ChevronDown size={14} />
            </button>
            {moreOpen ? moreProviders.map((provider) => <ProviderRow provider={provider} onProvider={onProvider} key={provider.id} />) : null}
          </section>
        ) : null}
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

function ProviderGroup({ detail, onProvider, providers, title }: { detail?: string; onProvider: (provider: ProviderSummary) => void; providers: ProviderSummary[]; title: string }) {
  return (
    <section className="settings-provider-group">
      <h4>{title}</h4>
      {providers.map((provider) => <ProviderRow provider={provider} detail={detail} featured={provider.id === "openrouter"} onProvider={onProvider} key={provider.id} />)}
    </section>
  );
}

function ProviderRow({ detail, featured = false, onProvider, provider }: { detail?: string; featured?: boolean; onProvider: (provider: ProviderSummary) => void; provider: ProviderSummary }) {
  return (
    <div className={`settings-provider-row${featured ? " is-featured" : ""}`}>
      <ProviderMark provider={provider} />
      <span className="settings-provider-copy">
        <strong className="settings-provider-name"><span>{provider.name}</span>{featured ? <small>Recommended</small> : null}</strong>
        <span className="settings-provider-details">
          <span className="settings-provider-description">{providerDescription(provider)}{detail ? <><i>·</i>{detail}</> : null}</span>
          <span className="settings-provider-capabilities" aria-label={`Capabilities: ${provider.capabilities.map((capability) => PROVIDER_CAPABILITY_LABELS[capability]).join(", ")}`}>
            {provider.capabilities.map((capability) => <small key={capability}>{PROVIDER_CAPABILITY_LABELS[capability]}</small>)}
          </span>
        </span>
      </span>
      {provider.status === "not_configured" ? null : <em className={`settings-provider-status is-${provider.status}`}><i />{providerStatus(provider)}</em>}
      <button className={featured ? "is-primary" : undefined} type="button" disabled={provider.status === "connecting"} onClick={() => onProvider(provider)}>{providerAction(provider)}</button>
    </div>
  );
}

function ProviderMark({ provider }: { provider: Pick<ModelProviderSummary, "id"> }) {
  const icon = PROVIDER_ICONS[provider.id];
  if (!icon) return <span className="settings-provider-mark-slot" aria-hidden="true" />;
  return <span className={`settings-provider-mark is-${icon.tone}`} aria-hidden="true"><img src={icon.src} alt="" /></span>;
}

function ProviderAuthView({ provider, onBack, onCompleted }: { provider: ModelProviderSummary; onBack: () => void; onCompleted: () => void }) {
  if (provider.id === "meshy") return <MeshyAuthView provider={provider} onBack={onBack} onCompleted={onCompleted} />;
  if (SEEDANCE_PROVIDER_IDS.has(provider.id)) return <SeedanceAuthView provider={provider} onBack={onBack} onCompleted={onCompleted} />;
  const [method, setMethod] = useState<ModelAuthMethod | undefined>(provider.configured ? undefined : provider.methods.length === 1 ? provider.methods[0]?.type : undefined);
  if (provider.configured) return <ConnectedProvider provider={provider} onBack={onBack} onDisconnected={onCompleted} />;
  if (!method) return <AuthMethodChoice provider={provider} onBack={onBack} onChoose={setMethod} />;
  return <ActiveProviderAuth provider={provider} method={method} onBack={onBack} onCompleted={onCompleted} />;
}

function SeedanceAuthView({ provider, onBack, onCompleted }: { provider: ModelProviderSummary; onBack: () => void; onCompleted: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
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

  async function clear(): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      await clearSeedanceApiKey(provider.id);
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
      <ProviderDetailHeader provider={provider} onBack={onBack} />
      {provider.configured ? (
        <ProviderStatusRow source={provider.source}>
          <button className="settings-danger-button" type="button" disabled={saving} onClick={() => void clear()}>Disconnect</button>
        </ProviderStatusRow>
      ) : null}
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
      {provider.configured && provider.id === "volcengine-ark" ? <SeedreamModels providerId={provider.id} /> : null}
      {provider.configured ? <SeedanceModels providerId={provider.id} /> : null}
    </section>
  );
}

function SeedreamModels({ providerId }: { providerId: string }) {
  const [models, setModels] = useState<ImageModel[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void listImageModelCatalog().then((catalog) => {
      if (active) setModels(catalog.models.filter((model) => model.provider === providerId));
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [providerId]);

  return (
    <section className="settings-detail-section provider-models" aria-label="Image models">
      <div className="provider-models-heading">
        <h4>Image models <small>{models?.length ?? ""}</small></h4>
      </div>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {models ? (
        <div className="provider-models-list" role="list" aria-label="Image models">
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
          {!models.length ? <p className="settings-empty">No image models are available.</p> : null}
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

function MeshyAuthView({ provider, onBack, onCompleted }: { provider: ModelProviderSummary; onBack: () => void; onCompleted: () => void }) {
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

  async function clear(): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      await clearMeshyApiKey();
      onCompleted();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-panel settings-provider-detail">
      <ProviderDetailHeader provider={provider} onBack={onBack} />
      {provider.configured ? (
        <ProviderStatusRow source={provider.source}>
          <button className="settings-danger-button" type="button" disabled={saving} onClick={() => void clear()}>Disconnect</button>
        </ProviderStatusRow>
      ) : null}
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

function ConnectedProvider({ provider, onBack, onDisconnected }: { provider: ModelProviderSummary; onBack: () => void; onDisconnected: () => void }) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const endpoint = useProviderEndpoint(provider.id);
  async function disconnect(): Promise<void> {
    setDisconnecting(true);
    try {
      await disconnectModelProvider(provider.id);
      notifyAgentModelsChanged();
      onDisconnected();
    } catch (cause) {
      setError(errorMessage(cause));
      setDisconnecting(false);
    }
  }
  async function saveEndpoint(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    try {
      await endpoint.save();
      notifyAgentModelsChanged();
      setNotice("Base URL saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const displayedError = error ?? endpoint.error;
  // Only API keys can go through a proxy; a ChatGPT sign-in always talks to OpenAI directly.
  const showsEndpoint = endpoint.supported && provider.credentialType !== "oauth";
  return (
    <section className="settings-panel settings-provider-detail">
      <ProviderDetailHeader provider={provider} onBack={onBack} />
      <ProviderStatusRow source={provider.source}>
        {provider.credentialType ? (
          <button className="settings-danger-button" type="button" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? "Disconnecting…" : "Disconnect"}</button>
        ) : (
          <span className="settings-managed-label">Managed outside OhMyGame</span>
        )}
      </ProviderStatusRow>
      {showsEndpoint ? (
        <form onSubmit={(event) => void saveEndpoint(event)}>
          <BaseUrlField endpoint={endpoint}>
            <button className="settings-primary-button" type="submit" disabled={endpoint.loading || endpoint.saving || !endpoint.baseUrl.trim() || !endpoint.dirty}>{endpoint.saving ? "Saving…" : "Save"}</button>
          </BaseUrlField>
        </form>
      ) : null}
      {displayedError ? <p className="settings-error" role="alert">{displayedError}</p> : null}
      {notice ? <p className="settings-success" role="status">{notice}</p> : null}
      <ProviderModels providerId={provider.id} />
    </section>
  );
}

function ActiveProviderAuth({ provider, method, onBack, onCompleted }: { provider: ModelProviderSummary; method: ModelAuthMethod; onBack: () => void; onCompleted: () => void }) {
  const [operationId, setOperationId] = useState<string>();
  const [prompt, setPrompt] = useState<{ id: string; value: ModelAuthPrompt }>();
  const [notification, setNotification] = useState<ModelAuthNotification>();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string>();
  const operationRef = useRef<string | undefined>(undefined);
  const openedUrl = useRef<string | undefined>(undefined);
  const endpoint = useProviderEndpoint(provider.id);
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
      if (active) setError(errorMessage(cause));
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
      setError(event.error);
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
    <section className="settings-panel settings-provider-detail">
      <ProviderDetailHeader provider={provider} onBack={() => void cancel()} />
      {prompt && !browserFallback ? (
        <form className="settings-detail-section" onSubmit={(event) => void respond(event)}>
          {editsEndpoint ? <BaseUrlField endpoint={endpoint} /> : null}
          <label className="settings-detail-field">
            <span className="settings-search-field-label">{prompt.value.message}</span>
            {prompt.value.type === "select" ? (
              <select className="settings-search-input" value={answer || prompt.value.options[0]?.id || ""} onChange={(event) => setAnswer(event.target.value)}>
                {prompt.value.options.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
              </select>
            ) : (
              <input className="settings-search-input" type={prompt.value.type === "secret" ? "password" : "text"} value={answer} placeholder={prompt.value.placeholder} onChange={(event) => setAnswer(event.target.value)} autoFocus />
            )}
          </label>
          <div className="settings-form-actions">
            <button className="settings-secondary-button" type="button" onClick={() => void cancel()}>Cancel</button>
            <button className="settings-primary-button" type="submit" disabled={endpoint.loading || endpoint.saving || (editsEndpoint && !endpoint.baseUrl.trim()) || (prompt.value.type !== "select" && !prompt.value.optional && !answer.trim())}>Continue</button>
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

function ProviderDetailHeader({ provider, onBack }: { provider: ModelProviderSummary; onBack: () => void }) {
  return (
    <header className="settings-provider-detail-header">
      <button type="button" onClick={onBack} aria-label="Back"><ArrowLeft size={16} /></button>
      <ProviderMark provider={provider} />
      <span>
        <h3>{provider.name}</h3>
        <small>{providerDescription(provider)}</small>
      </span>
    </header>
  );
}

function ProviderStatusRow({ source, children }: { source?: string; children: ReactNode }) {
  return (
    <div className="settings-detail-status">
      <span className="settings-detail-status-line">
        <i aria-hidden="true" />
        <strong>Connected</strong>
        {source ? <small>{source}</small> : null}
      </span>
      {children}
    </div>
  );
}

function DetailSectionHeader({ title, description }: { title: string; description: string }) {
  return <div className="settings-search-section-header"><h4>{title}</h4><p>{description}</p></div>;
}

function BaseUrlField({ endpoint, children }: { endpoint: ReturnType<typeof useProviderEndpoint>; children?: ReactNode }) {
  return (
    <div className="settings-detail-field">
      <label className="settings-search-field-label" htmlFor="model-provider-base-url">Base URL</label>
      <div className="settings-detail-inline">
        <input id="model-provider-base-url" className="settings-search-input" value={endpoint.baseUrl} onChange={(event) => endpoint.setBaseUrl(event.target.value)} disabled={endpoint.loading || endpoint.saving} spellCheck={false} />
        {children}
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

  return { supported, baseUrl, setBaseUrl, dirty: baseUrl.trim() !== savedBaseUrl, loading, saving, error, save };
}

function providerDescription(provider: Pick<ModelProviderSummary, "methods">): string {
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
