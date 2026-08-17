import { ArrowLeft, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ImageGenerationSettings,
  Model3DGenerationSettings,
  ModelAuthEvent,
  ModelAuthMethod,
  ModelAuthNotification,
  ModelAuthPrompt,
  ModelProviderSummary,
} from "../shared/contracts.js";
import {
  cancelModelAuth,
  disconnectModelProvider,
  getImageGenerationSettings,
  getModel3DGenerationSettings,
  listModelProviders,
  respondToModelAuth,
  startModelProviderLogin,
  subscribeToModelAuth,
  updateImageGenerationSettings,
  updateModel3DGenerationSettings,
} from "./api.js";
import { notifyAgentModelsChanged } from "./model-selector.js";

export type ModelsView = { page: "overview" } | { page: "providers" } | { page: "provider"; provider: ModelProviderSummary };

export function ModelsSettings({ view, onViewChange }: { view: ModelsView; onViewChange: (view: ModelsView) => void }) {
  if (view.page === "providers") {
    return <ProviderList onBack={() => onViewChange({ page: "overview" })} onProvider={(provider) => onViewChange({ page: "provider", provider })} />;
  }
  if (view.page === "provider") {
    return <ProviderAuthView provider={view.provider} onBack={() => onViewChange({ page: "providers" })} onCompleted={() => onViewChange({ page: "providers" })} />;
  }
  return <ModelsOverview onProviders={() => onViewChange({ page: "providers" })} />;
}

function ModelsOverview({ onProviders }: { onProviders: () => void }) {
  const [settings, setSettings] = useState<ImageGenerationSettings>();
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model3DSettings, setModel3DSettings] = useState<Model3DGenerationSettings>();
  const [model3DApiUrl, setModel3DApiUrl] = useState("");
  const [model3DApiKey, setModel3DApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingModel3D, setSavingModel3D] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    void Promise.all([getImageGenerationSettings(), getModel3DGenerationSettings()]).then(([loaded, loadedModel3D]) => {
      if (!active) return;
      setSettings(loaded);
      setApiUrl(loaded.apiUrl);
      setModel3DSettings(loadedModel3D);
      setModel3DApiUrl(loadedModel3D.apiUrl);
    }).catch((cause) => {
      if (active) setNotice(errorMessage(cause));
    });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!apiUrl.trim() || saving) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const updated = await updateImageGenerationSettings({ apiUrl: apiUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setSettings(updated);
      setApiUrl(updated.apiUrl);
      setApiKey("");
      setNotice("Image generation settings saved.");
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

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
      <h3>Models</h3>
      <div className="settings-field-group">
        <label>Language models</label>
        <button className="settings-provider-access" type="button" onClick={onProviders}>
          <span>Provider access</span><span>Configure</span>
        </button>
      </div>
      <form className="settings-image-form" onSubmit={(event) => void save(event)}>
        <h4>Image generation</h4>
        <label htmlFor="image-api-url">API endpoint</label>
        <input id="image-api-url" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
        <label htmlFor="image-api-key">API key</label>
        <input id="image-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.hasApiKey ? "API key is configured" : "Enter image API key"} />
        <div className="settings-form-actions">
          <button className="settings-primary-button" type="submit" disabled={saving || !apiUrl.trim()}>{saving ? <LoaderCircle className="spin" size={15} /> : null}Save</button>
        </div>
      </form>
      <form className="settings-image-form" onSubmit={(event) => void saveModel3D(event)}>
        <h4>3D generation</h4>
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

function ProviderList({ onBack, onProvider }: { onBack: () => void; onProvider: (provider: ModelProviderSummary) => void }) {
  const [providers, setProviders] = useState<ModelProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void listModelProviders().then((loaded) => {
      if (active) setProviders(loaded);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);
  return (
    <section className="settings-panel">
      <SettingsBack title="Language models" onBack={onBack} />
      <div className="settings-provider-list">
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={18} />Loading providers</div> : null}
        {!loading && providers.length === 0 && !error ? <p className="settings-empty">No configurable providers are available.</p> : null}
        {providers.map((provider) => (
          <div className="settings-provider-row" key={provider.id}>
            <span className="settings-provider-copy">
              <strong>{provider.name}</strong>
              <span className={provider.configured ? "settings-connected" : ""}>{provider.configured ? "Connected" : providerDescription(provider)}</span>
            </span>
            <button type="button" onClick={() => onProvider(provider)}>{provider.configured ? "Manage" : provider.methods.length === 1 && provider.methods[0]?.type === "oauth" ? "Sign in" : "Configure"}</button>
          </div>
        ))}
      </div>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
    </section>
  );
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
  return (
    <section className="settings-panel">
      <SettingsBack title={provider.name} onBack={onBack} />
      <div className="settings-auth-status"><span className="settings-status-dot" /><span><strong>Connected</strong>{provider.source ? <small>{provider.source}</small> : null}</span></div>
      <div className="settings-form-actions">
        {provider.credentialType ? <button className="settings-secondary-button" type="button" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? "Disconnecting…" : "Disconnect"}</button> : <span className="settings-managed-label">Managed outside OpenGame</span>}
      </div>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
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
  return (
    <section className="settings-panel">
      <SettingsBack title={provider.name} onBack={() => void cancel()} />
      {prompt ? (
        <form className="settings-auth-form" onSubmit={(event) => void respond(event)}>
          <label htmlFor="model-auth-answer">{prompt.value.message}</label>
          {prompt.value.type === "select" ? (
            <select id="model-auth-answer" value={answer || prompt.value.options[0]?.id || ""} onChange={(event) => setAnswer(event.target.value)}>
              {prompt.value.options.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
            </select>
          ) : (
            <input id="model-auth-answer" type={prompt.value.type === "secret" ? "password" : "text"} value={answer} placeholder={prompt.value.placeholder} onChange={(event) => setAnswer(event.target.value)} autoFocus />
          )}
          <div className="settings-form-actions"><button className="settings-primary-button" type="submit" disabled={!answer && prompt.value.type !== "select"}>Continue</button></div>
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
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
    </section>
  );
}

function SettingsBack({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="settings-back-heading"><button type="button" onClick={onBack} aria-label="Back"><ArrowLeft size={16} /></button><h3>{title}</h3></div>;
}

function providerDescription(provider: ModelProviderSummary): string {
  const oauth = provider.methods.some((method) => method.type === "oauth");
  const apiKey = provider.methods.some((method) => method.type === "api_key");
  if (oauth && apiKey) return "Browser sign-in or API key";
  if (oauth) return "Browser sign-in";
  return "API key";
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
