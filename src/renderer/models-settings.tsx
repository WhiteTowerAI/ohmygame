import { ArrowLeft, ChevronDown, ChevronRight, Code2, ExternalLink, LoaderCircle, Pencil, Search, Server, Plus, Plug, RefreshCw, Settings, Trash2, UserRound } from "./icons.js";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  CustomProviderDetails,
  CustomProviderModel,
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
  getCustomProvider,
  removeProvider,
  setProviderEnabled,
  cancelModelAuth,
  getOpenAIEndpointSettings,
  listProviders,
  listImageModelCatalog,
  notifyAgentModelsChanged,
  respondToModelAuth,
  startModelProviderLogin,
  subscribeToModelAuth,
  updateOpenAIEndpointSettings,
  updateModel3DProviderApiKey,
  updateSeedanceApiKey,
  listVideoModelCatalog,
} from "./api.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import { CustomProviderDialog, PROVIDER_API_LABELS, type CustomProviderField } from "./custom-provider-dialog.js";
import { ProviderModels } from "./provider-models.js";
import { ProviderResponsesTransport } from "./responses-transport-settings.js";
import { Provider3DBalance } from "./provider-3d-balance.js";
import { MODEL3D_CONNECTION_ID } from "../shared/model3d-operations.js";
import { GlobalMediaModelDefaults } from "./media-model-defaults.js";
import { SegmentedControl } from "./segmented-control.js";
import { useAuth } from "./auth.js";
import { accountCloudState, cloudQuotaSummary, CloudQuotaDetails } from "./cloud-quota.js";
import { getCloudQuotas, MODELS_CHANGED_EVENT } from "./api.js";
import { HYPER3D_CONNECTION_ID } from "../shared/cloud-models.js";
import { isLocalModelProvider, LOCAL_MODEL_PROVIDERS, withLocalModelProviders, type LocalModelProviderId } from "./local-model-providers.js";
import { t } from "./i18n.js";

export type ModelsView = { page: "providers" } | { page: "provider"; provider: ProviderSummary };

const POPULAR_PROVIDER_IDS = ["openrouter", "openai", "anthropic", "meshy", "tripo"];
const SEEDANCE_PROVIDER_IDS = new Set(["volcengine-ark", "byteplus-modelark"]);
const PROVIDER_CAPABILITY_FILTERS: Array<{ value: "all" | ProviderCapability; label: string }> = [
  { value: "all", label: t("common.all") },
  { value: "language", label: t("capability.language") },
  { value: "image", label: t("capability.image") },
  { value: "video", label: t("capability.video") },
  { value: "3d", label: t("capability.3d") },
];
const PROVIDER_CAPABILITY_LABELS: Record<ProviderCapability, string> = {
  language: t("capability.language"),
  image: t("capability.image"),
  video: t("capability.video"),
  "3d": t("capability.3d"),
};

export function ModelsSettings({ view, onViewChange }: { view: ModelsView; onViewChange: (view: ModelsView) => void }) {
  const openProvider = (provider: ProviderSummary): void => onViewChange({ page: "provider", provider });
  if (view.page === "providers") {
    return <ProviderList onProvider={openProvider} />;
  }
  return <ProviderAuthView provider={view.provider} onBack={() => onViewChange({ page: "providers" })} onCompleted={() => onViewChange({ page: "providers" })} />;
}

function ProviderList({ onProvider }: { onProvider: (provider: ProviderSummary) => void }) {
  const auth = useAuth();
  const userId = auth.state.status === "signed-in" ? auth.state.user.id : undefined;
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [adding, setAdding] = useState<"custom" | LocalModelProviderId>();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [capability, setCapability] = useState<"all" | ProviderCapability>("all");
  useEffect(() => {
    let active = true, sequence = 0;
    const load = () => {
      const revision = ++sequence;
      void listProviders().then((loaded) => {
        if (active && revision === sequence) { setProviders(loaded); setError(undefined); }
      }).catch((cause) => {
        if (active && revision === sequence) setError(errorMessage(cause));
      }).finally(() => {
        if (active && revision === sequence) setLoading(false);
      });
    };
    load();
    window.addEventListener(MODELS_CHANGED_EVENT, load);
    window.addEventListener("focus", load);
    const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); window.removeEventListener(MODELS_CHANGED_EVENT, load); window.removeEventListener("focus", load); };
  }, [userId]);
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
  const openProvider = (provider: ProviderSummary): void => {
    if (!provider.custom && isLocalModelProvider(provider)) setAdding(provider.preset);
    else onProvider(provider);
  };
  const availableProviders = (loading ? providers : withLocalModelProviders(providers)).map((provider) => {
    if (!provider.managed) return provider;
    const cloud = accountCloudState(provider.cloud, userId);
    return { ...provider, cloud, ...(provider.cloud?.userId !== userId || !userId ? { configured: false, status: "not_configured" as const } : {}) };
  });
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProviders = availableProviders.filter((provider) => (
    // Hyper3D's account and key connections share one settings entry.
    (provider.id !== HYPER3D_CONNECTION_ID || !availableProviders.some((item) => item.id === "hyper3d"))
    && (capability === "all" || provider.capabilities.includes(capability))
    && (!normalizedQuery || [
      provider.name,
      ...(isLocalModelProvider(provider) ? [LOCAL_MODEL_PROVIDERS[provider.preset].name] : []),
      providerDescription(provider),
      ...provider.capabilities.map((item) => PROVIDER_CAPABILITY_LABELS[item]),
    ].some((value) => value.toLowerCase().includes(normalizedQuery)))
  ));
  const localProviders = visibleProviders.filter(isLocalModelProvider);
  const freeProviders = visibleProviders.filter((provider) => provider.managed === "free_cloud" || provider.id === "hyper3d");
  const connectedProviders = visibleProviders.filter((provider) => !freeProviders.includes(provider) && provider.status === "connected" && !isLocalModelProvider(provider));
  const remainingProviders = visibleProviders.filter((provider) => !freeProviders.includes(provider) && provider.status !== "connected" && !isLocalModelProvider(provider));
  const popularProviders = remainingProviders
    .filter((provider) => POPULAR_PROVIDER_IDS.includes(provider.id))
    .sort((first, second) => POPULAR_PROVIDER_IDS.indexOf(first.id) - POPULAR_PROVIDER_IDS.indexOf(second.id));
  const moreProviders = remainingProviders.filter((provider) => !POPULAR_PROVIDER_IDS.includes(provider.id));
  const filteredProviders = [...freeProviders, ...connectedProviders, ...popularProviders, ...localProviders, ...moreProviders];
  const filtering = capability !== "all" || Boolean(normalizedQuery);
  return (
    <section className="settings-panel settings-overview-panel">
      <header className="settings-panel-header">
        <h3>{t("providers.title")}</h3>
        <label className="settings-provider-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("providers.search")} aria-label={t("providers.search")} />
        </label>
      </header>
      {adding ? <CustomProviderDialog initialProvider={adding === "custom" ? undefined : LOCAL_MODEL_PROVIDERS[adding]} onClose={() => setAdding(undefined)} onSaved={() => {
        setAdding(undefined);
        setQuery("");
        setCapability("all");
        void listProviders().then(setProviders).catch((cause) => setError(errorMessage(cause)));
      }} /> : null}
      <div className="settings-provider-list">
        <div className="settings-provider-toolbar">
          <SegmentedControl className="settings-provider-filters" label={t("providers.filterLabel")} options={PROVIDER_CAPABILITY_FILTERS} value={capability} onChange={setCapability} />
          <button className="settings-add-button settings-provider-add" type="button" onClick={() => setAdding("custom")}><Plus size={13} />{t("providers.add")}</button>
        </div>
        {capability !== "language" ? <GlobalMediaModelDefaults capability={capability} /> : null}
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={18} />{t("providers.loadingProviders")}</div> : null}
        {!loading && visibleProviders.length === 0 ? <p className="settings-empty">{t("providers.noMatch")}</p> : null}
        {filtering && filteredProviders.length ? <ProviderGroup {...rowActions} title={t("providers.group.providers")} providers={filteredProviders} onProvider={openProvider} /> : null}
        {!filtering && freeProviders.length ? <ProviderGroup {...rowActions} title={t("providers.group.free")} providers={freeProviders} onProvider={openProvider} /> : null}
        {!filtering && connectedProviders.length ? <ProviderGroup {...rowActions} title={t("providers.group.connected")} providers={connectedProviders} onProvider={openProvider} /> : null}
        {!filtering && popularProviders.length ? <ProviderGroup {...rowActions} title={t("providers.group.popular")} providers={popularProviders} onProvider={openProvider} /> : null}
        {!filtering && localProviders.length ? <ProviderGroup {...rowActions} title={t("providers.group.local")} providers={localProviders} onProvider={openProvider} /> : null}
        {!filtering && moreProviders.length ? (
          <section className="settings-provider-group">
            <button className="settings-provider-more" type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
              <span>{t("providers.group.more")} <small>({moreProviders.length})</small></span>
              <ChevronDown size={14} />
            </button>
            {moreOpen ? moreProviders.map((provider) => <ProviderRow {...rowActions} provider={provider} onProvider={openProvider} key={provider.id} />) : null}
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
  const combined = provider.id === "hyper3d";
  const ActionIcon = combined ? Settings : provider.status === "connecting" ? LoaderCircle : provider.status === "error" ? RefreshCw : provider.configured ? Settings : Plug;
  const actionLabel = combined ? t("providers.manageHyper3d") : t("providers.rowAction", { action: providerAction(provider), name: provider.name });
  return (
    <div className={`settings-provider-row${featured ? " is-featured" : ""}`}>
      <ProviderMark provider={provider} />
      <span className="settings-provider-copy">
        <strong className="settings-provider-name"><span>{provider.name}</span>{featured ? <small>{t("providers.recommended")}</small> : null}</strong>
        <span className="settings-provider-details">
          <span className="settings-provider-description">{provider.managed ? cloudQuotaSummary(provider.cloud) : providerDescription(provider)}{detail ? <><i>·</i>{detail}</> : null}</span>
          <span className="settings-provider-capabilities" aria-label={t("providers.labels", { labels: [...provider.capabilities.map((capability) => PROVIDER_CAPABILITY_LABELS[capability]), ...(provider.custom && !isLocalModelProvider(provider) ? [t("providers.custom")] : [])].join(", ") })}>
            {provider.capabilities.map((capability) => <small key={capability}>{PROVIDER_CAPABILITY_LABELS[capability]}</small>)}
            {provider.custom && !isLocalModelProvider(provider) ? <small>{t("providers.custom")}</small> : null}
          </span>
        </span>
      </span>
      {combined || provider.configured ? <label className="settings-toggle settings-provider-toggle" title={provider.enabled !== false ? t("common.enabled") : t("common.disabled")}>
        <input type="checkbox" role="switch" aria-label={t("providers.enableProvider", { name: provider.name })} checked={provider.enabled !== false} disabled={pending.has(provider.id)} onChange={(event) => onToggle(provider, event.target.checked)} /><span aria-hidden="true" />
      </label> : provider.status === "not_configured" ? null : <em className={`settings-provider-status is-${provider.status}`}><i />{providerStatus(provider)}</em>}
      <button className="icon-button settings-provider-action" type="button" data-tooltip={actionLabel} aria-label={actionLabel} disabled={provider.status === "connecting" || pending.has(provider.id)} onClick={() => onProvider(provider)}><ActionIcon size={17} className={provider.status === "connecting" ? "spin" : undefined} aria-hidden="true" /></button>
    </div>
  );
}

function ProviderMark({ provider }: { provider: Pick<ProviderSummary, "id" | "preset"> }) {
  const icon = PROVIDER_ICONS[isLocalModelProvider(provider) ? provider.preset : provider.id];
  if (!icon) return <span className="settings-provider-mark-slot" aria-hidden="true"><Server size={20} /></span>;
  return <span className={`settings-provider-mark is-${icon.tone}`} aria-hidden="true"><img src={icon.src} alt="" /></span>;
}

function ProviderAuthView({ provider, onBack, onCompleted }: { provider: ProviderSummary; onBack: () => void; onCompleted: () => void }) {
  if (provider.id === "hyper3d" || provider.id === HYPER3D_CONNECTION_ID) return <Hyper3DProviderDetail provider={provider} onBack={onBack} />;
  if (provider.managed === "free_cloud") return <FreeCloudProviderDetail provider={provider} onBack={onBack} />;
  if (provider.custom) return <CustomProviderDetail provider={provider} onBack={onBack} onRemoved={onCompleted} />;
  if (provider.id === "meshy" || provider.id === "tripo") return <Native3DProviderAuthView provider={provider} onBack={onBack} onCompleted={onCompleted} />;
  if (SEEDANCE_PROVIDER_IDS.has(provider.id)) return <SeedanceAuthView provider={provider} onBack={onBack} onCompleted={onCompleted} />;
  const [method, setMethod] = useState<ModelAuthMethod | undefined>(provider.configured ? undefined : provider.methods.length === 1 ? provider.methods[0]?.type : undefined);
  if (provider.configured) return <ConnectedProvider provider={provider} onBack={onBack} onRemoved={onCompleted} />;
  if (!method) return <AuthMethodChoice provider={provider} onBack={onBack} onChoose={setMethod} />;
  return <ActiveProviderAuth provider={provider} method={method} onBack={onBack} onCompleted={onCompleted} />;
}

function Hyper3DProviderDetail({ provider, onBack }: { provider: ProviderSummary; onBack: () => void }) {
  const auth = useAuth();
  const userId = auth.state.status === "signed-in" ? auth.state.user.id : undefined;
  const [providers, setProviders] = useState([provider]);
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [modelsRevision, setModelsRevision] = useState(0);
  const refreshRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true, sequence = 0;
    const load = async (force = false) => {
      const revision = ++sequence;
      setRefreshing(true);
      try {
        if (force) await getCloudQuotas();
        const loaded = await listProviders();
        if (active && revision === sequence) { setProviders(loaded); setError(undefined); if (force) setModelsRevision((value) => value + 1); }
      } catch (cause) { if (active && revision === sequence) setError(errorMessage(cause)); }
      finally { if (active && revision === sequence) setRefreshing(false); }
    };
    refreshRef.current = load;
    const refresh = () => { void load(); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    const timer = setInterval(refresh, 30_000);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener(MODELS_CHANGED_EVENT, refresh); };
  }, [userId]);
  const keyProvider = providers.find((item) => item.id === "hyper3d");
  const account = providers.find((item) => item.id === HYPER3D_CONNECTION_ID);
  const current = keyProvider ?? { ...provider, id: "hyper3d", name: "Hyper3D" };
  return <section className="settings-panel settings-provider-detail">
    <ProviderDetailHeader provider={current} description={t("providers.hyper3d.description")} onBack={onBack}>
      <ProviderEnableControl provider={current} onChanged={() => void refreshRef.current()} />
    </ProviderDetailHeader>
    <FreeCloudAccount provider={account} refreshing={refreshing} onRefresh={() => void refreshRef.current(true)} />
    {keyProvider ? <Native3DProviderKeyForm key={String(keyProvider.configured)} provider={keyProvider} /> : null}
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    <ProviderModels key={`${userId}-${keyProvider?.configured}-${modelsRevision}`} providerId="hyper3d" additionalProviderId={account?.id}
      sourceLabels={{ hyper3d: keyProvider?.configured ? t("providers.hyper3d.yourKey") : t("providers.hyper3d.keyRequired"), [HYPER3D_CONNECTION_ID]: t("providers.hyper3d.freeAccount") }} />
  </section>;
}

function FreeCloudAccount({ provider, refreshing, onRefresh }: { provider?: ProviderSummary; refreshing: boolean; onRefresh: () => void }) {
  const auth = useAuth();
  const userId = auth.state.status === "signed-in" ? auth.state.user.id : undefined;
  const cloud = accountCloudState(provider?.cloud, userId);
  const needsSignIn = !userId || cloud?.availability === "sign_in_required";
  const quota = cloud?.quota;
  return <>
    <div className="settings-provider-connection">
      <div className="settings-provider-setting-row settings-provider-auth-row">
        <span className="settings-search-field-label">{t("providers.account")}</span>
        <span className="settings-provider-setting-value" title={auth.state.status === "signed-in" ? auth.state.user.email : undefined}>{auth.state.status === "signed-in" ? auth.state.user.email ?? auth.state.user.name : t("providers.ohMyGameAccount")}</span>
        {needsSignIn ? <button type="button" className="settings-add-button" onClick={auth.openSignIn}>{t("common.signIn")}</button> : null}
      </div>
    </div>
    <section className="settings-detail-section provider-models" aria-label={t("providers.quota.title")}>
      <div className="provider-models-heading">
        <h4>{t("providers.quota.title")}</h4>
        {userId ? <button type="button" className="icon-button settings-provider-setting-edit" disabled={refreshing} onClick={onRefresh} aria-label={t("providers.quota.refresh")} data-tooltip={t("providers.quota.refresh")}><RefreshCw size={15} className={refreshing ? "spin" : undefined} aria-hidden="true" /></button> : null}
      </div>
      {quota ? <CloudQuotaDetails quota={quota} /> : <p className="settings-detail-hint" role="status">{needsSignIn ? t("providers.quota.signIn") : refreshing ? t("providers.quota.checking") : cloudQuotaSummary(cloud)}</p>}
      {quota && cloud?.availability !== "ready" ? <p className="settings-detail-hint" role="status">{cloud?.availability === "personal_exhausted" ? t("providers.quota.exhausted") : cloudQuotaSummary(cloud)}</p> : null}
    </section>
  </>;
}

function FreeCloudProviderDetail({ provider, onBack }: { provider: ProviderSummary; onBack: () => void }) {
  const auth = useAuth();
  const userId = auth.state.status === "signed-in" ? auth.state.user.id : undefined;
  const [current, setCurrent] = useState(provider);
  const [modelsRevision, setModelsRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef<(force?: boolean) => void>(() => {});
  useEffect(() => {
    let active = true, sequence = 0;
    const load = (force = false) => {
      const revision = ++sequence;
      setRefreshing(true);
      void (force ? getCloudQuotas() : Promise.resolve()).then(listProviders).then((providers) => {
        if (!active || revision !== sequence) return;
        setCurrent(providers.find((item) => item.id === provider.id) ?? provider);
        setError(undefined);
        if (force) setModelsRevision((value) => value + 1);
      }).catch((cause) => { if (active && revision === sequence) setError(errorMessage(cause)); })
        .finally(() => { if (active && revision === sequence) setRefreshing(false); });
    };
    refreshRef.current = load;
    const refresh = () => load();
    refresh();
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    const timer = setInterval(refresh, 30_000);
    return () => { active = false; clearInterval(timer); window.removeEventListener(MODELS_CHANGED_EVENT, refresh); };
  }, [provider.id, userId]);
  return <section className="settings-panel settings-provider-detail">
    <ProviderDetailHeader provider={current} onBack={onBack}>
      <ProviderEnableControl provider={current} onChanged={() => refreshRef.current()} />
    </ProviderDetailHeader>
    <FreeCloudAccount provider={current} refreshing={refreshing} onRefresh={() => refreshRef.current(true)} />
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    <ProviderModels key={`${provider.id}-${userId}-${modelsRevision}`} providerId={provider.id} />
  </section>;
}

function SeedanceAuthView({ provider, onBack, onCompleted }: { provider: ProviderSummary; onBack: () => void; onCompleted: () => void }) {
  const deletion = useProviderDeletion(provider.id, onCompleted);
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
        {provider.configured ? <><ProviderDeleteButton deletion={deletion} disabled={saving} /><ProviderEnableControl provider={provider} disabled={deletion.busy} onChanged={() => setModelsRevision((value) => value + 1)} /></> : null}
      </ProviderDetailHeader>
      <ProviderDeleteConfirmation provider={provider} deletion={deletion} disabled={saving} />
      <form className="settings-detail-field" onSubmit={(event) => void save(event)}>
        <label className="settings-search-field-label" htmlFor={inputId}>{t("providers.apiKey")}</label>
        <div className="settings-detail-inline">
          <input
            id={inputId}
            className="settings-search-input"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={provider.configured ? t("providers.replaceKeyPlaceholder") : t("providers.keyPlaceholder", { name: provider.name })}
            disabled={saving || deletion.busy}
          />
          <button className="settings-primary-button" type="submit" disabled={saving || deletion.busy || !apiKey.trim()}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </form>
      {error || deletion.error ? <p className="settings-error" role="alert">{deletion.error ?? error}</p> : null}
      {provider.configured && provider.id === "volcengine-ark" ? <ProviderImageModels key={`seedream-${modelsRevision}`} providerId={provider.id} /> : null}
      {provider.configured ? <SeedanceModels key={`seedance-${modelsRevision}`} providerId={provider.id} /> : null}
    </section>
  );
}

function ProviderImageModels({ providerId }: { providerId: string }) {
  const [models, setModels] = useState<ImageModel[]>();
  const [emptyMessage, setEmptyMessage] = useState(t("providers.noImageModels"));
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void listImageModelCatalog().then((catalog) => {
      if (!active) return;
      const status = catalog.providers.find((provider) => provider.provider === providerId);
      setModels(catalog.models.filter((model) => model.provider === providerId));
      setEmptyMessage(status?.message ?? t("providers.noImageModels"));
      setError(status?.state === "error" ? status.message : undefined);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [providerId]);

  return (
    <section className="settings-detail-section provider-models" aria-label={t("providers.imageModels")}>
      <div className="provider-models-heading">
        <h4>{t("providers.imageModels")} <small>{models?.length ?? ""}</small></h4>
      </div>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {models ? (
        <div className="provider-models-list" role="list" aria-label={t("providers.imageModels")}>
          {models.map((model) => (
            <div className="provider-model-row" key={model.id} role="listitem">
              <label>
                <span className="provider-model-copy">
                  <strong title={model.name}>{model.name}</strong>
                  <small title={model.id}>{model.id}</small>
                </span>
              </label>
            </div>
          ))}
          {!models.length && !error ? <p className="settings-empty">{emptyMessage}</p> : null}
        </div>
      ) : !error ? <div className="settings-loading"><LoaderCircle className="spin" size={16} />{t("providers.loadingModels")}</div> : null}
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
    <section className="settings-detail-section provider-models" aria-label={t("providers.videoModels")}>
      <div className="provider-models-heading">
        <h4>{t("providers.videoModels")} <small>{models?.length ?? ""}</small></h4>
      </div>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {models ? (
        <div className="provider-models-list" role="list" aria-label={t("providers.videoModels")}>
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
          {!models.length ? <p className="settings-empty">{t("providers.noVideoModels")}</p> : null}
        </div>
      ) : !error ? <div className="settings-loading"><LoaderCircle className="spin" size={16} />{t("providers.loadingModels")}</div> : null}
    </section>
  );
}

function useProviderDeletion(providerId: string, onRemoved?: () => void) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try { await removeProvider(providerId); onRemoved?.(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return { confirming, setConfirming, busy, error, remove };
}

function ProviderDeleteButton({ deletion, disabled = false, label = t("providers.delete.button") }: { deletion: ReturnType<typeof useProviderDeletion>; disabled?: boolean; label?: string }) {
  return <button className="icon-button settings-provider-setting-edit settings-provider-delete" type="button" aria-label={label} data-tooltip={label} aria-expanded={deletion.confirming} disabled={deletion.busy || disabled} onClick={() => deletion.setConfirming((value) => !value)}><Trash2 size={15} aria-hidden="true" /></button>;
}

function ProviderDeleteConfirmation({ provider, deletion, disabled = false }: { provider: ProviderSummary; deletion: ReturnType<typeof useProviderDeletion>; disabled?: boolean }) {
  if (!deletion.confirming) return null;
  return <div className="settings-provider-delete-confirmation" role="group" aria-label={t("providers.delete.confirmation")}>
    <span>{provider.id === "hyper3d" ? t("providers.delete.hyper3d") : provider.custom ? t("providers.delete.custom") : t("providers.delete.builtIn")}{!provider.custom && provider.credentialType === "oauth" ? t("providers.delete.subscriptionKept") : null}</span>
    <button className="settings-danger-button" type="button" disabled={deletion.busy || disabled} onClick={() => void deletion.remove()}>{deletion.busy ? t("common.deleting") : provider.id === "hyper3d" ? t("providers.delete.removeKey") : t("providers.delete.button")}</button>
    <button className="settings-secondary-button" type="button" disabled={deletion.busy} onClick={() => deletion.setConfirming(false)}>{t("common.cancel")}</button>
  </div>;
}

function CustomProviderDetail({ provider, onBack, onRemoved }: { provider: ProviderSummary; onBack: () => void; onRemoved: () => void }) {
  const deletion = useProviderDeletion(provider.id, onRemoved);
  const [settings, setSettings] = useState<CustomProviderDetails>();
  const [editing, setEditing] = useState<CustomProviderField>();
  const [openingEditor, setOpeningEditor] = useState(false);
  const [modelsRevision, setModelsRevision] = useState(0);
  const deleting = deletion.busy;
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void (async () => {
      let value = await getCustomProvider(provider.id);
      if (value.modelConfigurationVersion !== 2) {
        await listImageModelCatalog().catch(() => undefined);
        value = await getCustomProvider(provider.id);
      }
      if (active) { setSettings(value); setModelsRevision((revision) => revision + 1); }
    })().catch((cause) => { if (active) setError(errorMessage(cause)); });
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
  const fields: Array<{ field: CustomProviderField; label: string; value: string }> = settings ? [
    { field: "apiKey", label: t("providers.apiKey"), value: settings.authentication === "api_key" ? "••••••••" : t("providers.notRequired") },
    { field: "baseUrl", label: t("providers.baseUrl"), value: settings.baseUrl },
    { field: "api", label: t("providers.api"), value: PROVIDER_API_LABELS[settings.api] ?? settings.api },
  ] : [];
  // Models may override the provider URL; show one balance per distinct compatible connection.
  const balanceConnections = new Map<string, CustomProviderModel>();
  for (const model of settings?.models ?? []) {
    const config = model.usages?.["3d"];
    if (!config) continue;
    const connection = JSON.stringify([config.protocol, (config.baseUrl ?? settings!.baseUrl).replace(/\/+$/, "")]);
    if (!balanceConnections.has(connection)) balanceConnections.set(connection, model);
  }
  return <section className="settings-panel settings-provider-detail">
    <ProviderDetailHeader provider={{ ...provider, name: settings?.name ?? provider.name }} onBack={onBack}>
      <ProviderDeleteButton deletion={deletion} disabled={openingEditor || Boolean(editing)} />
      <ProviderEnableControl provider={provider} disabled={deleting} onChanged={() => setModelsRevision((value) => value + 1)} />
    </ProviderDetailHeader>
    <ProviderDeleteConfirmation provider={provider} deletion={deletion} disabled={openingEditor || Boolean(editing)} />
    {settings ? <div className="settings-provider-connection">
      {fields.map(({ field, label, value }) => <div className="settings-provider-setting-row" key={field}>
        <span className="settings-search-field-label">{label}</span>
        <span className="settings-provider-setting-value" title={field === "apiKey" ? undefined : value}>{value}</span>
        <button className="icon-button settings-provider-setting-edit" type="button" aria-label={t("providers.edit", { label })} data-tooltip={t("providers.edit", { label })} disabled={deleting || openingEditor || Boolean(editing)} onClick={() => void openEditor(field)}><Pencil size={15} aria-hidden="true" /></button>
      </div>)}
    </div> : !error ? <div className="settings-loading"><LoaderCircle className="spin" size={16} />{t("providers.loadingConfiguration")}</div> : null}
    {settings && (settings.api === "openai-responses" || settings.models.some((model) => model.api === "openai-responses")) ? <ProviderResponsesTransport key={provider.id} providerId={provider.id} disabled={deleting || openingEditor || Boolean(editing)} /> : null}
    {error || deletion.error ? <p className="settings-error" role="alert">{deletion.error ?? error}</p> : null}
    {provider.configured ? [...balanceConnections].map(([connection, model]) => <Provider3DBalance key={connection} model={{ provider: provider.id, id: model.id }} label={balanceConnections.size > 1 ? t("providers.apiBalance", { model: model.name }) : undefined} />) : null}
    {settings ? <ProviderModels key={modelsRevision} providerId={provider.id} onEditModels={() => void openEditor("models")} /> : null}
    {editing && settings ? <CustomProviderDialog settings={settings} initialFocus={editing} onClose={() => setEditing(undefined)} onSaved={(value) => { setSettings(value); setEditing(undefined); setModelsRevision((revision) => revision + 1); }} /> : null}
  </section>;
}

function Native3DProviderAuthView({ provider, onBack, onCompleted }: { provider: ProviderSummary; onBack: () => void; onCompleted: () => void }) {
  return <section className="settings-panel settings-provider-detail">
    <ProviderDetailHeader provider={provider} description={t("providers.apiKey")} onBack={onBack}>
      {provider.configured ? <ProviderEnableControl provider={provider} /> : null}
    </ProviderDetailHeader>
    <Native3DProviderKeyForm provider={provider} onCompleted={onCompleted} />
    {provider.configured ? <ProviderModels providerId={provider.id} /> : null}
  </section>;
}

function Native3DProviderKeyForm({ provider, onCompleted }: { provider: ProviderSummary; onCompleted?: () => void }) {
  const deletion = useProviderDeletion(provider.id, onCompleted);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await updateModel3DProviderApiKey(provider.id, apiKey);
      setApiKey("");
      onCompleted?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return <>
    <ProviderDeleteConfirmation provider={provider} deletion={deletion} disabled={saving} />
    <form className="settings-detail-field" onSubmit={(event) => void save(event)}>
      <div className="provider-models-heading">
        <label className="settings-search-field-label" htmlFor={`${provider.id}-api-key`}>{provider.id === "hyper3d" ? t("providers.hyper3d.yourKey") : t("providers.apiKey")}</label>
        {provider.configured ? <ProviderDeleteButton deletion={deletion} disabled={saving} label={t("providers.delete.removeKey")} /> : null}
      </div>
      <div className="settings-detail-inline">
        <input id={`${provider.id}-api-key`} className="settings-search-input" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)}
          placeholder={provider.configured ? t("providers.replaceKeyPlaceholder") : t("providers.keyPlaceholder", { name: provider.name })} disabled={saving || deletion.busy} />
        <button className="settings-primary-button" type="submit" disabled={saving || deletion.busy || !apiKey.trim()}>{saving ? t("common.saving") : t("common.save")}</button>
      </div>
    </form>
    {provider.id === "hyper3d" ? <p className="settings-detail-hint">{t("providers.hyper3d.keyHint")}</p> : null}
    {provider.configured ? <Provider3DBalance model={{ provider: provider.id, id: MODEL3D_CONNECTION_ID }} /> : null}
    {error || deletion.error ? <p className="settings-error" role="alert">{deletion.error ?? error}</p> : null}
  </>;
}

function authMethodLabel(method: ModelProviderSummary["methods"][number]): string {
  if (method.type === "api_key" && method.label.endsWith(" API key")) {
    return t("providers.connect.providerApiKey", { name: method.label.slice(0, -" API key".length) });
  }
  if (method.type === "api_key" && method.label === "API key") return t("providers.apiKey");
  if (method.type === "oauth" && method.label.startsWith("Sign in with ")) {
    return t("providers.connect.signInWith", { name: method.label.slice("Sign in with ".length) });
  }
  return method.label;
}

function AuthMethodChoice({ provider, onBack, onChoose }: { provider: ModelProviderSummary; onBack: () => void; onChoose: (method: ModelAuthMethod) => void }) {
  return (
    <section className="settings-panel settings-provider-detail">
      <ProviderDetailHeader provider={provider} onBack={onBack} />
      <div className="settings-detail-section">
        <DetailSectionHeader title={t("providers.connect.title")} description={t("providers.connect.description")} />
        <div className="settings-method-list">
          {provider.methods.map((method) => {
            const Icon = method.type === "oauth" ? UserRound : Code2;
            return (
              <button className="settings-method-row" type="button" key={method.type} onClick={() => onChoose(method.type)}>
                <span className="settings-method-icon"><Icon size={15} /></span>
                <span className="settings-method-copy">
                  <strong>{authMethodLabel(method)}</strong>
                  <small>{method.type === "oauth" ? t("providers.connect.oauthHint") : t("providers.connect.apiKeyHint")}</small>
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

function ConnectedProvider({ provider, onBack, onRemoved }: { provider: ProviderSummary; onBack: () => void; onRemoved: () => void }) {
  const deletion = useProviderDeletion(provider.id, onRemoved);
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
    setNotice(method === "oauth" ? t("providers.notice.oauth") : t("providers.notice.apiKey"));
  }
  async function saveEndpoint(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    try {
      await endpoint.save();
      notifyAgentModelsChanged();
      setEditing(undefined);
      setNotice(t("providers.notice.baseUrl"));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const displayedError = deletion.error ?? error ?? endpoint.error;
  // Only API keys can go through a proxy; a ChatGPT sign-in always talks to OpenAI directly.
  const showsEndpoint = endpoint.supported && credentialType !== "oauth";
  const canEditKey = credentialType !== "oauth" && provider.methods.some((method) => method.type === "api_key");
  const alternateMethod = provider.methods.length > 1 ? provider.methods.find((method) => method.type !== credentialType)?.type : undefined;
  return (
    <section className="settings-panel settings-provider-detail">
      <ProviderDetailHeader provider={provider} onBack={onBack}>
        <ProviderDeleteButton deletion={deletion} disabled={Boolean(editing) || endpoint.saving} />
        <ProviderEnableControl provider={provider} disabled={deletion.busy} onChanged={() => setModelsRevision((value) => value + 1)} />
      </ProviderDetailHeader>
      <ProviderDeleteConfirmation provider={{ ...provider, credentialType }} deletion={deletion} disabled={Boolean(editing) || endpoint.saving} />
      {alternateMethod || canEditKey || showsEndpoint ? <div className="settings-provider-connection">
        {alternateMethod ? <div className="settings-provider-setting-row settings-provider-auth-row">
          <span className="settings-search-field-label">{t("providers.signIn")}</span>
          <span className="settings-provider-setting-value">{credentialType === "oauth" ? t("providers.browserSignIn") : t("providers.apiKey")}</span>
          <button className="settings-secondary-button" type="button" disabled={Boolean(editing) || deletion.busy} onClick={() => edit(alternateMethod)}>{alternateMethod === "oauth" ? t("providers.useBrowserSignIn") : t("providers.useApiKey")}</button>
        </div> : null}
        {canEditKey ? <section aria-label={t("providers.apiKeySettings")}>
          <div className="settings-provider-setting-row">
            <span className="settings-search-field-label">{t("providers.apiKey")}</span>
            <span className="settings-provider-setting-value" aria-label={t("providers.apiKeyConfigured")}>••••••••</span>
            <button className="icon-button settings-provider-setting-edit" type="button" aria-label={t("providers.editApiKey")} data-tooltip={t("providers.editApiKey")} aria-expanded={editing === "api_key"} disabled={Boolean(editing) || deletion.busy} onClick={() => edit("api_key")}><Pencil size={15} aria-hidden="true" /></button>
          </div>
        </section> : null}
        {editing === "api_key" || editing === "oauth" ? <div className="settings-provider-setting-editor"><ActiveProviderAuth provider={provider} method={editing} inline onBack={() => setEditing(undefined)} onCompleted={() => completeAuth(editing)} onFailed={(message) => { setEditing(undefined); setError(message); }} /></div> : null}
        {showsEndpoint ? <section aria-label={t("providers.baseUrlSettings")}>
          <div className="settings-provider-setting-row">
            <span className="settings-search-field-label">{t("providers.baseUrl")}</span>
            <span className="settings-provider-setting-value" title={endpoint.savedBaseUrl}>{endpoint.loading ? t("common.loading") : endpoint.savedBaseUrl || t("providers.unavailable")}</span>
            <button className="icon-button settings-provider-setting-edit" type="button" aria-label={t("providers.editBaseUrl")} data-tooltip={t("providers.editBaseUrl")} aria-expanded={editing === "endpoint"} disabled={Boolean(editing) || endpoint.loading || deletion.busy} onClick={() => edit("endpoint")}><Pencil size={15} aria-hidden="true" /></button>
          </div>
          {editing === "endpoint" ? <form className="settings-provider-setting-editor settings-detail-section" onSubmit={(event) => void saveEndpoint(event)}>
            <BaseUrlField endpoint={endpoint} />
            <div className="settings-form-actions">
              <button className="settings-secondary-button" type="button" disabled={endpoint.saving} onClick={() => { endpoint.reset(); setEditing(undefined); setError(undefined); }}>{t("common.cancel")}</button>
              <button className="settings-primary-button" type="submit" disabled={endpoint.loading || endpoint.saving || !endpoint.baseUrl.trim() || !endpoint.dirty}>{endpoint.saving ? t("common.saving") : t("common.save")}</button>
            </div>
          </form> : null}
        </section> : null}
      </div> : null}
      {displayedError ? <p className="settings-error" role="alert">{displayedError}</p> : null}
      {notice ? <p className="settings-success" role="status">{notice}</p> : null}
      {provider.id === "openai" ? <ProviderResponsesTransport providerId={provider.id} disabled={deletion.busy || Boolean(editing)} /> : null}
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
  const apiKeyMethod = provider.methods.find((candidate) => candidate.type === "api_key");
  // Translate the SDK's standard key prompt, keeping multi-step/custom auth instructions intact.
  const standardKeyPrompt = method === "api_key" && prompt?.value.type === "secret"
    && apiKeyMethod && (apiKeyMethod.label === "API key" || apiKeyMethod.label.endsWith(" API key"))
    && prompt.value.message === `Enter ${apiKeyMethod.label}`;
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
      onError: () => setError(t("providers.authInterrupted")),
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
            <span className="settings-search-field-label">{editingKey && prompt.value.type === "secret" ? t("providers.newApiKey") : standardKeyPrompt ? t("providers.connect.enterApiKey", { name: provider.name }) : prompt.value.message}</span>
            {prompt.value.type === "select" ? (
              <select className="settings-search-input" value={answer || prompt.value.options[0]?.id || ""} onChange={(event) => setAnswer(event.target.value)}>
                {prompt.value.options.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
              </select>
            ) : (
              <input className="settings-search-input" type={prompt.value.type === "secret" ? "password" : "text"} value={answer} placeholder={editingKey && prompt.value.type === "secret" ? t("providers.replaceKeyPlaceholder") : standardKeyPrompt ? t("providers.keyPlaceholder", { name: provider.name }) : prompt.value.placeholder} onChange={(event) => setAnswer(event.target.value)} autoFocus autoComplete={prompt.value.type === "secret" ? "new-password" : "off"} spellCheck={false} />
            )}
          </label>
          <div className="settings-form-actions">
            <button className="settings-secondary-button" type="button" onClick={() => void cancel()}>{t("common.cancel")}</button>
            <button className="settings-primary-button" type="submit" disabled={endpoint.loading || endpoint.saving || (editsEndpoint && !endpoint.baseUrl.trim()) || (prompt.value.type !== "select" && !prompt.value.optional && !answer.trim())}>{editingKey && prompt.value.type === "secret" ? t("providers.saveKey") : t("common.continue")}</button>
          </div>
        </form>
      ) : (
        <div className="settings-detail-section">
          <div className="settings-detail-status settings-detail-waiting">
            <LoaderCircle className="spin" size={16} />
            <span className="settings-detail-status-copy">
              <strong>{method === "oauth" ? t("providers.waitingSignIn") : t("providers.preparing")}</strong>
              <small>{external && method === "oauth" ? t("providers.finishInBrowser") : notificationText(notification)}</small>
            </span>
          </div>
          {notification?.type === "device_code" ? <div className="settings-device-code">{notification.userCode}</div> : null}
          <div className="settings-form-actions">
            <button className="settings-secondary-button" type="button" onClick={() => void cancel()}>{t("common.cancel")}</button>
            {external ? <button className="settings-primary-button" type="button" onClick={() => void openExternal(external)}><ExternalLink size={14} />{method === "oauth" ? t("providers.openBrowserAgain") : t("providers.openBrowser")}</button> : null}
          </div>
          {browserFallback && prompt ? (
            <form className="settings-detail-field settings-auth-fallback" onSubmit={(event) => void respond(event)}>
              <label className="settings-detail-hint" htmlFor="model-auth-redirect">{t("providers.redirectHint")}</label>
              <div className="settings-detail-inline">
                <input id="model-auth-redirect" className="settings-search-input" value={answer} placeholder={prompt.value.type === "manual_code" ? prompt.value.placeholder : undefined} onChange={(event) => setAnswer(event.target.value)} spellCheck={false} />
                <button className="settings-secondary-button" type="submit" disabled={!answer.trim()}>{t("common.continue")}</button>
              </div>
            </form>
          ) : null}
        </div>
      )}
      {displayedError ? <p className="settings-error" role="alert">{displayedError}</p> : null}
    </section>
  );
}

function ProviderDetailHeader({ provider, onBack, children, title, description }: { provider: ModelProviderSummary; onBack: () => void; children?: ReactNode; title?: string; description?: string }) {
  return (
    <header className="settings-provider-detail-header">
      <button type="button" onClick={onBack} aria-label={t("common.back")}><ArrowLeft size={16} /></button>
      <ProviderMark provider={provider} />
      <span className="settings-provider-heading">
        <h3>{title ?? provider.name}</h3>
        <small>{description ?? providerDescription(provider)}</small>
      </span>
      {children}
    </header>
  );
}

function ProviderEnableControl({ provider, onChanged, disabled = false, label }: { provider: ProviderSummary; onChanged?: () => void; disabled?: boolean; label?: string }) {
  const [enabled, setEnabled] = useState(provider.enabled !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setEnabled(provider.enabled !== false); }, [provider.id, provider.enabled]);
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
    <label className="settings-provider-enable-label" title={enabled ? t("providers.availableForRequests") : t("providers.disabledKept")}>
      <small>{enabled ? t("common.enabled") : t("common.disabled")}</small>
      <span className="settings-toggle"><input type="checkbox" role="switch" aria-label={label ?? t("providers.enableProvider", { name: provider.name })} checked={enabled} disabled={busy || disabled} onChange={(event) => void toggle(event.target.checked)} /><span aria-hidden="true" /></span>
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
      <label className="settings-search-field-label" htmlFor="model-provider-base-url">{t("providers.baseUrl")}</label>
      <div className="settings-detail-inline">
        <input id="model-provider-base-url" className="settings-search-input" value={endpoint.baseUrl} onChange={(event) => endpoint.setBaseUrl(event.target.value)} disabled={endpoint.loading || endpoint.saving} spellCheck={false} />
      </div>
      <small className="settings-detail-hint">{t("providers.baseUrlHint")}</small>
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

function providerDescription(provider: Pick<ProviderSummary, "id" | "methods" | "custom" | "preset" | "managed">): string {
  if (provider.id === "hyper3d") return t("providers.description.hyper3d");
  if (provider.managed) return t("providers.group.free");
  if (isLocalModelProvider(provider)) return t("providers.description.local");
  if (provider.custom) return t("providers.description.custom");
  const oauth = provider.methods.some((method) => method.type === "oauth");
  const apiKey = provider.methods.some((method) => method.type === "api_key");
  if (oauth && apiKey) return t("providers.description.oauthOrKey");
  if (oauth) return t("providers.browserSignIn");
  return t("providers.apiKey");
}

function providerStatus(provider: ProviderSummary): string {
  if (provider.status === "connected") return t("providers.status.connected");
  if (provider.status === "connecting") return t("providers.status.checking");
  if (provider.status === "error") return t("providers.status.failed");
  return t("providers.status.notConfigured");
}

function providerAction(provider: ProviderSummary): string {
  if (provider.status === "connected") return t("providers.action.manage");
  if (provider.status === "connecting") return t("providers.status.checking");
  if (provider.status === "error") return t("common.retry");
  return t("providers.action.connect");
}

function notificationText(notification: ModelAuthNotification | undefined): string {
  if (!notification) return t("providers.auth.starting");
  if (notification.type === "device_code") return t("providers.auth.deviceCode");
  if (notification.type === "auth_url") return notification.instructions ?? t("providers.auth.complete");
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
