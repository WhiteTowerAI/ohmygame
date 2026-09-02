import { ArrowLeft, ChevronDown, ExternalLink, LoaderCircle, Search } from "./icons.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Model3DGenerationSettings,
  ModelAuthEvent,
  ModelAuthMethod,
  ModelAuthNotification,
  ModelAuthPrompt,
  ModelProviderSummary,
  ProviderSummary,
} from "../shared/contracts.js";
import {
  cancelModelAuth,
  disconnectModelProvider,
  getOpenAIEndpointSettings,
  getModel3DGenerationSettings,
  listProviders,
  notifyAgentModelsChanged,
  respondToModelAuth,
  startModelProviderLogin,
  subscribeToModelAuth,
  updateModel3DGenerationSettings,
  updateOpenAIEndpointSettings,
} from "./api.js";
import { useAuth } from "./auth.js";
import openGameLogo from "../../build/logo.svg";
import { PROVIDER_ICONS } from "./provider-icons.js";

export type ModelsView = { page: "providers" } | { page: "provider"; provider: ProviderSummary };

const POPULAR_PROVIDER_IDS = ["openai", "anthropic", "meshy"];

export function ModelsSettings({ view, onViewChange }: { view: ModelsView; onViewChange: (view: ModelsView) => void }) {
  const openProvider = (provider: ProviderSummary): void => {
    if (provider.kind === "portal") {
      void openExternal("https://portal.open-game.ai");
      return;
    }
    onViewChange({ page: "provider", provider });
  };
  if (view.page === "providers") {
    return <ProviderList onProvider={openProvider} />;
  }
  if (view.provider.kind === "custom") return <CustomProviderSettings provider={view.provider} onBack={() => onViewChange({ page: "providers" })} />;
  if (view.provider.kind === "portal") return <ProviderList onProvider={openProvider} />;
  return <ProviderAuthView provider={view.provider} onBack={() => onViewChange({ page: "providers" })} onCompleted={() => onViewChange({ page: "providers" })} />;
}

function CustomProviderSettings({ provider, onBack }: { provider: ProviderSummary; onBack: () => void }) {
  const [model3DSettings, setModel3DSettings] = useState<Model3DGenerationSettings>();
  const [model3DApiUrl, setModel3DApiUrl] = useState("");
  const [model3DApiKey, setModel3DApiKey] = useState("");
  const [savingModel3D, setSavingModel3D] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    const load = getModel3DGenerationSettings().then((loaded) => {
          if (!active) return;
          setModel3DSettings(loaded);
          setModel3DApiUrl(loaded.apiUrl);
        });
    void load.catch((cause) => {
      if (active) setNotice(errorMessage(cause));
    });
    return () => { active = false; };
  }, []);

  async function saveModel3D(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!model3DApiUrl.trim() || savingModel3D) return;
    setSavingModel3D(true);
    setNotice(undefined);
    try {
      const updated = await updateModel3DGenerationSettings({
        apiUrl: model3DApiUrl.trim(),
        ...(model3DApiKey.trim() ? { apiKey: model3DApiKey.trim() } : {}),
      });
      setModel3DSettings(updated);
      setModel3DApiUrl(updated.apiUrl);
      setModel3DApiKey("");
      setNotice("3D generation settings saved.");
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setSavingModel3D(false);
    }
  }

  return (
    <section className="settings-panel">
      <SettingsBack title={provider.name} onBack={onBack} />
      <form className="settings-image-form" onSubmit={(event) => void saveModel3D(event)}>
        <label htmlFor="model-3d-api-url">API endpoint</label>
        <input id="model-3d-api-url" value={model3DApiUrl} onChange={(event) => setModel3DApiUrl(event.target.value)} placeholder="https://api.meshy.ai" />
        <label htmlFor="model-3d-api-key">API key</label>
        <input id="model-3d-api-key" type="password" value={model3DApiKey} onChange={(event) => setModel3DApiKey(event.target.value)} placeholder={model3DSettings?.hasApiKey ? "API key is configured" : "Enter Meshy API key"} />
        <div className="settings-form-actions">
          <button className="settings-primary-button" type="submit" disabled={savingModel3D || !model3DApiUrl.trim()}>{savingModel3D ? <LoaderCircle className="spin" size={15} /> : null}Save</button>
        </div>
      </form>
      {notice ? <p className={notice.endsWith("saved.") ? "settings-success" : "settings-error"} role="status">{notice}</p> : null}
    </section>
  );
}

function ProviderList({ onProvider }: { onProvider: (provider: ProviderSummary) => void }) {
  const auth = useAuth();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
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
  const visibleProviders = normalizedQuery ? providers.filter((provider) => [
    provider.name,
    providerDescription(provider),
  ].some((value) => value.toLowerCase().includes(normalizedQuery))) : providers;
  const portalProviders = visibleProviders.filter((provider) => provider.kind === "portal");
  const popularProviders = visibleProviders
    .filter((provider) => provider.kind !== "portal" && POPULAR_PROVIDER_IDS.includes(provider.id))
    .sort((first, second) => POPULAR_PROVIDER_IDS.indexOf(first.id) - POPULAR_PROVIDER_IDS.indexOf(second.id));
  const moreProviders = visibleProviders.filter((provider) => provider.kind !== "portal" && !POPULAR_PROVIDER_IDS.includes(provider.id));
  const portalAccount = auth.state.status === "signed-in" ? auth.state.user.email ?? auth.state.user.name : undefined;
  return (
    <section className="settings-panel settings-overview-panel">
      <header className="settings-panel-header">
        <h3>Providers</h3>
        <label className="settings-provider-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search providers" aria-label="Search providers" />
        </label>
      </header>
      <div className="settings-provider-list">
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={18} />Loading providers</div> : null}
        {!loading && providers.length === 0 && !error ? <p className="settings-empty">No configurable providers are available.</p> : null}
        {!loading && providers.length > 0 && visibleProviders.length === 0 ? <p className="settings-empty">No providers match your search.</p> : null}
        {portalProviders.length ? <ProviderGroup title="OpenGame" providers={portalProviders} featured detail={portalAccount} onProvider={onProvider} /> : null}
        {popularProviders.length ? <ProviderGroup title="Popular providers" providers={popularProviders} onProvider={onProvider} /> : null}
        {moreProviders.length ? (
          <section className="settings-provider-group">
            {normalizedQuery ? <h4>More providers</h4> : (
              <button className="settings-provider-more" type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
                <span>More providers <small>({moreProviders.length})</small></span>
                <ChevronDown size={14} />
              </button>
            )}
            {normalizedQuery || moreOpen ? moreProviders.map((provider) => <ProviderRow provider={provider} onProvider={onProvider} key={provider.id} />) : null}
          </section>
        ) : null}
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

function ProviderGroup({ detail, featured = false, onProvider, providers, title }: { detail?: string; featured?: boolean; onProvider: (provider: ProviderSummary) => void; providers: ProviderSummary[]; title: string }) {
  return (
    <section className="settings-provider-group">
      <h4>{title}</h4>
      {providers.map((provider) => <ProviderRow provider={provider} detail={detail} featured={featured} onProvider={onProvider} key={provider.id} />)}
    </section>
  );
}

function ProviderRow({ detail, featured = false, onProvider, provider }: { detail?: string; featured?: boolean; onProvider: (provider: ProviderSummary) => void; provider: ProviderSummary }) {
  return (
    <div className={`settings-provider-row${featured ? " is-featured" : ""}`}>
      <ProviderMark provider={provider} />
      <span className="settings-provider-copy">
        <strong className="settings-provider-name"><span>{provider.name}</span>{featured ? <small>Recommended</small> : null}</strong>
        <span className="settings-provider-description">{providerDescription(provider)}{detail ? <><i>·</i>{detail}</> : null}</span>
      </span>
      {provider.status === "not_configured" ? null : <em className={`settings-provider-status is-${provider.status}`}><i />{providerStatus(provider)}</em>}
      <button className={featured ? "is-primary" : undefined} type="button" disabled={provider.kind !== "portal" && provider.status === "connecting"} onClick={() => onProvider(provider)}>{providerAction(provider)}</button>
    </div>
  );
}

function ProviderMark({ provider }: { provider: ProviderSummary }) {
  if (provider.kind === "portal") {
    return <span className="settings-provider-mark is-opengame" aria-hidden="true"><img src={openGameLogo} alt="" /></span>;
  }
  const icon = PROVIDER_ICONS[provider.id];
  if (!icon) return <span className="settings-provider-mark-slot" aria-hidden="true" />;
  return <span className={`settings-provider-mark is-${icon.tone}`} aria-hidden="true"><img src={icon.src} alt="" /></span>;
}

function ProviderAuthView({ provider, onBack, onCompleted }: { provider: ModelProviderSummary; onBack: () => void; onCompleted: () => void }) {
  const [method, setMethod] = useState<ModelAuthMethod | undefined>(provider.configured ? undefined : provider.methods.length === 1 ? provider.methods[0]?.type : undefined);
  if (provider.configured) return <ConnectedProvider provider={provider} onBack={onBack} onDisconnected={onCompleted} />;
  if (!method) return <AuthMethodChoice provider={provider} onBack={onBack} onChoose={setMethod} />;
  return <ActiveProviderAuth provider={provider} method={method} onBack={onBack} onCompleted={onCompleted} />;
}

function AuthMethodChoice({ provider, onBack, onChoose }: { provider: ModelProviderSummary; onBack: () => void; onChoose: (method: ModelAuthMethod) => void }) {
  return (
    <section className="settings-panel">
      <SettingsBack title={provider.name} onBack={onBack} />
      <div className="settings-methods">
        {provider.methods.map((method) => <button type="button" key={method.type} onClick={() => onChoose(method.type)}>{method.label}</button>)}
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
  const managedByOpenGameAccount = provider.id === "opengame";
  return (
    <section className="settings-panel">
      <SettingsBack title={provider.name} onBack={onBack} />
      <div className="settings-auth-status"><span className="settings-status-dot" /><span><strong>Connected</strong>{provider.source ? <small>{provider.source}</small> : null}</span></div>
      {endpoint.supported ? (
        <form className="settings-auth-form" onSubmit={(event) => void saveEndpoint(event)}>
          <label htmlFor="model-provider-base-url">Base URL</label>
          <input id="model-provider-base-url" value={endpoint.baseUrl} onChange={(event) => endpoint.setBaseUrl(event.target.value)} disabled={endpoint.loading} />
          <div className="settings-form-actions">
            <button className="settings-primary-button" type="submit" disabled={endpoint.loading || endpoint.saving || !endpoint.baseUrl.trim()}>{endpoint.saving ? "Saving…" : "Save"}</button>
          </div>
        </form>
      ) : null}
      <div className="settings-form-actions">
        {managedByOpenGameAccount ? (
          <span className="settings-managed-label">Managed by your OpenGame account</span>
        ) : provider.credentialType ? (
          <button className="settings-secondary-button" type="button" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? "Disconnecting…" : "Disconnect"}</button>
        ) : (
          <span className="settings-managed-label">Managed outside OpenGame</span>
        )}
      </div>
      {displayedError ? <p className="settings-error" role="alert">{displayedError}</p> : null}
      {notice ? <p className="settings-success" role="status">{notice}</p> : null}
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
  const endpoint = useProviderEndpoint(provider.id);

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
      if (endpoint.supported) await endpoint.save();
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
  return (
    <section className="settings-panel">
      <SettingsBack title={provider.name} onBack={() => void cancel()} />
      {prompt ? (
        <form className="settings-auth-form" onSubmit={(event) => void respond(event)}>
          {endpoint.supported ? (
            <>
              <label htmlFor="model-provider-base-url">Base URL</label>
              <input id="model-provider-base-url" value={endpoint.baseUrl} onChange={(event) => endpoint.setBaseUrl(event.target.value)} disabled={endpoint.loading || endpoint.saving} />
            </>
          ) : null}
          <label htmlFor="model-auth-answer">{prompt.value.message}</label>
          {prompt.value.type === "select" ? (
            <select id="model-auth-answer" value={answer || prompt.value.options[0]?.id || ""} onChange={(event) => setAnswer(event.target.value)}>
              {prompt.value.options.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
            </select>
          ) : (
            <input id="model-auth-answer" type={prompt.value.type === "secret" ? "password" : "text"} value={answer} placeholder={prompt.value.placeholder} onChange={(event) => setAnswer(event.target.value)} autoFocus />
          )}
          <div className="settings-form-actions"><button className="settings-primary-button" type="submit" disabled={endpoint.loading || endpoint.saving || (endpoint.supported && !endpoint.baseUrl.trim()) || (!answer && prompt.value.type !== "select")}>Continue</button></div>
        </form>
      ) : (
        <div className="settings-waiting-card">
          <LoaderCircle className="spin" size={20} />
          <span><strong>{method === "oauth" ? "Waiting for sign-in" : "Preparing configuration"}</strong><small>{notificationText(notification)}</small></span>
        </div>
      )}
      {notification?.type === "device_code" ? <div className="settings-device-code">{notification.userCode}</div> : null}
      <div className="settings-form-actions">
        <button className="settings-secondary-button" type="button" onClick={() => void cancel()}>Cancel</button>
        {external ? <button className="settings-provider-button" type="button" onClick={() => void openExternal(external)}><ExternalLink size={14} />Open browser</button> : null}
      </div>
      {displayedError ? <p className="settings-error" role="alert">{displayedError}</p> : null}
    </section>
  );
}

function useProviderEndpoint(providerId: string) {
  const supported = providerId === "openai";
  const [baseUrl, setBaseUrl] = useState("");
  const [loading, setLoading] = useState(supported);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!supported) return;
    let active = true;
    void getOpenAIEndpointSettings().then((settings) => {
      if (active) setBaseUrl(settings.baseUrl);
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
    } finally {
      setSaving(false);
    }
  }

  return { supported, baseUrl, setBaseUrl, loading, saving, error, save };
}

function SettingsBack({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="settings-back-heading"><button type="button" onClick={onBack} aria-label="Back"><ArrowLeft size={16} /></button><h3>{title}</h3></div>;
}

function providerDescription(provider: ProviderSummary): string {
  if (provider.kind === "portal") return "Unified access to OpenGame models";
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
  if (provider.kind === "portal") return "Open Portal";
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
  if (window.openGameDesktop?.openExternal) {
    await window.openGameDesktop.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
