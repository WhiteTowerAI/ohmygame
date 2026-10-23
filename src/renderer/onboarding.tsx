import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  AgentModelCatalog,
  AgentModelRef,
  ModelAuthMethod,
  ProviderSummary,
} from "../shared/contracts.js";
import type { OnboardingStatus, OnboardingStep } from "../shared/onboarding.js";
import {
  findAgentModel,
  preferredAgentModel,
  recommendedAgentModel,
} from "../shared/agent-models.js";
import {
  isAgentRuntimeId,
  nativeEffort,
  type AgentRuntimeId,
} from "../shared/agent-runtimes.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import {
  getCustomProvider,
  listModels,
  listProviders,
  MODELS_CHANGED_EVENT,
  setProviderEnabled,
  updateAgentDefaults,
} from "./api.js";
import {
  Check,
  ChevronDown,
  Plug,
  LoaderCircle,
  Plus,
  Search,
  Server,
  Settings,
  Key,
  LogIn,
} from "./icons.js";
import { ActiveProviderAuth } from "./models-settings.js";
import { CustomProviderForm } from "./custom-provider-dialog.js";
import { CanvasChipSelect } from "./canvas-chip-select.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import { groupProviders } from "./provider-groups.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { OnboardingMedia } from "./onboarding-media.js";
import { OnboardingAgents } from "./onboarding-agents.js";
import { OnboardingDemo } from "./onboarding-demo.js";
import { t } from "./i18n.js";
import "./onboarding.css";

type Connection = { provider: ProviderSummary; method: ModelAuthMethod };

export function Onboarding({
  step,
  onStepChange,
  onFinish,
}: {
  step: OnboardingStep;
  onStepChange: (step: OnboardingStep) => Promise<void>;
  onFinish: (status: Exclude<OnboardingStatus, "pending">) => Promise<void>;
}) {
  const generation = useReadyRuntimeGeneration();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [catalog, setCatalog] = useState<AgentModelCatalog>({
    models: [],
    defaultReasoningLevel: "medium",
  });
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [providerError, setProviderError] = useState<string>();
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [running, setRunning] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);
  const busy = running || savingProvider || savingAgent;
  const failedAction = useRef<(() => Promise<void>) | undefined>(undefined);
  const [connection, setConnection] = useState<Connection>();
  const [adding, setAdding] = useState(false);
  const [customSettings, setCustomSettings] =
    useState<Awaited<ReturnType<typeof getCustomProvider>>>();
  const [refresh, setRefresh] = useState(0);
  const [playWelcomeIntro, setPlayWelcomeIntro] = useState(step === "welcome");
  useEffect(() => {
    if (step !== "welcome") setPlayWelcomeIntro(false);
  }, [step]);
  const [choosingAgent, setChoosingAgent] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<"pi" | AgentRuntimeId>();
  const [selectedModels, setSelectedModels] = useState<
    Partial<Record<"pi" | AgentRuntimeId, AgentModelRef>>
  >({});
  const [connectedProvider, setConnectedProvider] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const preferredModel = preferredAgentModel(
    catalog.models,
    undefined,
    catalog.defaultModel,
  );
  const model = phase === "ready" ? preferredModel : undefined;
  const activeAgent =
    selectedAgent ??
    (isAgentRuntimeId(preferredModel?.provider)
      ? preferredModel.provider
      : "pi");
  const agentModels = catalog.models.filter((item) =>
    activeAgent === "pi"
      ? !isAgentRuntimeId(item.provider)
      : item.provider === activeAgent,
  );
  const agentModel =
    phase === "ready"
      ? preferredAgentModel(
          agentModels,
          selectedModels[activeAgent],
          activeAgent === "pi" && connectedProvider
            ? catalog.defaultModel?.provider === connectedProvider
              ? catalog.defaultModel
              : recommendedAgentModel(agentModels, connectedProvider)
            : catalog.defaultModel,
        )
      : undefined;
  const languageProviders = providers.filter(
    (provider) =>
      provider.capabilities.includes("language") &&
      // Signing in to OpenAI covers ChatGPT subscriptions; keep the legacy entry only once saved.
      (provider.id !== "openai-codex" || chatConnected(provider)),
  );
  useEffect(() => {
    if (step !== "connect") return;
    let active = true,
      sequence = 0;
    setLoadingProviders(true);
    const load = () => {
      const current = ++sequence;
      void listProviders()
        .then((loaded) => {
          if (!active || current !== sequence) return;
          setProviders(loaded);
          setProviderError(undefined);
          setLoadingProviders(false);
        })
        .catch((cause) => {
          if (!active || current !== sequence) return;
          setProviderError(errorMessage(cause));
          setLoadingProviders(false);
        });
    };
    load();
    window.addEventListener(MODELS_CHANGED_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.removeEventListener(MODELS_CHANGED_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, [step, generation, refresh]);
  useEffect(() => {
    if (!adding) heading.current?.focus({ preventScroll: true });
  }, [step, adding, connection]);
  useEffect(() => {
    if (step === "welcome") return;
    setPhase("loading");
    let active = true,
      sequence = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const load = () => {
      clearTimeout(retry);
      const current = ++sequence;
      void listModels({ agentRuntimes: true })
        .then((loadedCatalog) => {
          if (!active || current !== sequence) return;
          setCatalog(loadedCatalog);
          setPhase("ready");
          setLoadError(undefined);
          if (loadedCatalog.loadingRuntimes?.length && attempts++ < 5)
            retry = setTimeout(load, 3_000);
        })
        .catch((cause) => {
          if (!active || current !== sequence) return;
          setPhase("error");
          setLoadError(errorMessage(cause));
        });
    };
    const reload = () => {
      attempts = 0;
      load();
    };
    reload();
    if (step === "connect") {
      window.addEventListener(MODELS_CHANGED_EVENT, reload);
      window.addEventListener("focus", reload);
    }
    return () => {
      active = false;
      clearTimeout(retry);
      window.removeEventListener(MODELS_CHANGED_EVENT, reload);
      window.removeEventListener("focus", reload);
    };
  }, [step, generation, refresh]);

  async function run(action: () => Promise<void>) {
    if (running) return;
    setRunning(true);
    setError(undefined);
    try {
      await action();
      failedAction.current = undefined;
    } catch (cause) {
      failedAction.current = action;
      setError(errorMessage(cause));
    } finally {
      setRunning(false);
    }
  }

  async function connect(provider: ProviderSummary, method: ModelAuthMethod) {
    const latest = await listProviders();
    setProviders(latest);
    const current = latest.find((item) => item.id === provider.id);
    if (!current) throw new Error(t("onboarding.providerUnavailable"));
    if (chatConnected(current)) {
      if (current.enabled === false) {
        await setProviderEnabled(current.id, true);
      }
      completed(current.id);
    } else if (current.custom) {
      setCustomSettings(await getCustomProvider(current.id));
      setAdding(true);
    } else {
      setConnection({ provider: current, method });
    }
  }

  async function chooseModel(
    current: AgentModelCatalog,
    next: AgentModelCatalog["models"][number],
  ) {
    if (findAgentModel([next], current.defaultModel)) return;
    await updateAgentDefaults(
      isAgentRuntimeId(next.provider)
        ? {
            model: next,
            nativeReasoningLevel: nativeEffort(
              next,
              current.defaultNativeReasoningLevel,
            ),
          }
        : {
            model: next,
            reasoningLevel: clampReasoningLevel(
              current.defaultReasoningLevel,
              next.reasoningLevels,
            ),
          },
    );
    setCatalog((value) => ({ ...value, defaultModel: next }));
  }

  function completed(providerId: string) {
    setConnection(undefined);
    setConnectedProvider(providerId);
    setSelectedModels((value) => ({ ...value, pi: undefined }));
  }

  function selectAgent(id: "pi" | AgentRuntimeId) {
    setChoosingAgent(false);
    if (agentModel)
      setSelectedModels((value) => ({ ...value, [activeAgent]: agentModel }));
    setSelectedAgent(id);
    setError(undefined);
    failedAction.current = undefined;
  }

  function navigate(next: OnboardingStep) {
    if (busy) return;
    const reset = () => {
      setAdding(false);
      setConnection(undefined);
      setError(undefined);
      failedAction.current = undefined;
    };
    if (next === step) {
      if (adding || connection) reset();
      return;
    }
    void run(async () => {
      if (step === "connect" && next === "media" && agentModel)
        await chooseModel(catalog, agentModel);
      await onStepChange(next);
      reset();
      setLoadError(undefined);
    });
  }

  const connectionContent = adding ? (
    <>
      <h1 ref={heading} tabIndex={-1}>
        {customSettings
          ? t("onboarding.editProvider")
          : t("onboarding.addProvider")}
      </h1>
      <CustomProviderForm
        settings={customSettings}
        onClose={() => setAdding(false)}
        onSavingChange={setSavingProvider}
        onSaved={(saved) => {
          setAdding(false);
          completed(saved.id);
        }}
      />
    </>
  ) : connection ? (
    <>
      <h1 ref={heading} tabIndex={-1}>
        {t("onboarding.connectProvider", { name: connection.provider.name })}
      </h1>
      <p className="onboarding-lede">
        {connection.method === "oauth"
          ? t("providers.finishInBrowser")
          : t("onboarding.keyLocal")}
      </p>
      <div className="onboarding-auth">
        <ActiveProviderAuth
          key={`${connection.provider.id}:${connection.method}`}
          provider={connection.provider}
          method={connection.method}
          inline
          onBack={() => setConnection(undefined)}
          onCompleted={() => completed(connection.provider.id)}
          onFailed={(message) => {
            failedAction.current = () =>
              connect(connection.provider, connection.method);
            setConnection(undefined);
            setError(message);
          }}
        />
      </div>
    </>
  ) : (
    <>
      <h1 ref={heading} tabIndex={-1}>
        {t("onboarding.chooseProvider")}
      </h1>
      <OnboardingAgents
        busy={busy}
        models={catalog.models}
        selectedAgent={activeAgent}
        choosing={choosingAgent}
        onExpand={() => setChoosingAgent(true)}
        onSelectAgent={selectAgent}
        loadingRuntimes={catalog.loadingRuntimes}
        onBusyChange={setSavingAgent}
      >
        {activeAgent === "pi" ? (
          <>
            <div className="onboarding-provider-heading">
              {t("onboarding.providers")}
            </div>
            {loadingProviders ? (
              <p className="onboarding-status" role="status">
                <LoaderCircle className="spin" size={16} />
                {t("onboarding.loadingProviders")}
              </p>
            ) : (
              <ProviderPicker
                providers={languageProviders}
                busy={busy}
                onChoose={(provider, method) =>
                  void run(() => connect(provider, method))
                }
                onAdd={() => {
                  setCustomSettings(undefined);
                  setError(undefined);
                  failedAction.current = undefined;
                  setAdding(true);
                }}
              />
            )}
          </>
        ) : null}
        {agentModel ? (
          <ReadyModel
            models={agentModels}
            model={agentModel}
            busy={busy}
            onChange={(next) => {
              setSelectedModels((value) => ({ ...value, [activeAgent]: next }));
              setError(undefined);
              failedAction.current = undefined;
            }}
          />
        ) : null}
        {catalog.loadingRuntimes?.length ? (
          <p className="onboarding-status" role="status">
            {t("onboarding.loadingAgentModels")}
          </p>
        ) : null}
      </OnboardingAgents>
    </>
  );

  return (
    <main
      className={`onboarding onboarding-${step}${step === "welcome" && !playWelcomeIntro ? " onboarding-welcome-static" : ""}${adding ? " onboarding-custom" : ""}`}
      aria-label={t("onboarding.welcome")}
      aria-busy={busy}
    >
      <WindowDragRegion />
      <div key={`content-${step}`} className="onboarding-content">
        {step === "welcome" ? (
          <>
            <OnboardingDemo />
            <h1
              className="onboarding-welcome-title"
              ref={heading}
              tabIndex={-1}
              onAnimationEnd={(event) => {
                if (document.activeElement === document.body)
                  event.currentTarget.focus({ preventScroll: true });
              }}
            >
              {t("onboarding.tagline")}
            </h1>
          </>
        ) : step === "media" ? (
          <>
            <h1 ref={heading} tabIndex={-1}>
              {t("onboarding.mediaTitle")}
            </h1>
            <p className="onboarding-lede">{t("onboarding.mediaHint")}</p>
            <OnboardingMedia busy={busy} onSavingChange={setSavingProvider} />
          </>
        ) : (
          connectionContent
        )}
        {error ||
        loadError ||
        (step === "connect" &&
          !choosingAgent &&
          activeAgent === "pi" &&
          providerError) ? (
          <div className="onboarding-feedback">
            <p className="onboarding-error" role="alert">
              {error ?? loadError ?? providerError}
            </p>
            <button
              className="onboarding-text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setError(undefined);
                if (failedAction.current) void run(failedAction.current);
                else {
                  setPhase("loading");
                  setRefresh((value) => value + 1);
                }
              }}
            >
              {t("common.retry")}
            </button>
          </div>
        ) : null}
      </div>
      {!adding && (step === "welcome" || !connection) ? (
        <footer key={`footer-${step}`} className="onboarding-footer">
          {step === "welcome" ? (
            <button
              className="onboarding-primary-button"
              type="button"
              disabled={busy}
              onClick={() => navigate("connect")}
            >
              {t("onboarding.next")}
            </button>
          ) : step === "connect" ? (
            <>
              <button
                className="onboarding-primary-button"
                type="button"
                disabled={busy || choosingAgent || !agentModel}
                onClick={() => navigate("media")}
              >
                {t("onboarding.next")}
              </button>
              {!model ? (
                <button
                  className="onboarding-text-button onboarding-skip-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => onFinish("skipped"))}
                >
                  {t("onboarding.skipAndStart")}
                </button>
              ) : null}
            </>
          ) : (
            <button
              className="onboarding-primary-button"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  onFinish(catalog.models.length ? "completed" : "skipped"),
                )
              }
            >
              {t("onboarding.startCreating")}
            </button>
          )}
        </footer>
      ) : null}
      <nav
        className="onboarding-progress"
        aria-label={t("onboarding.gettingStarted")}
      >
        {(["welcome", "connect", "media"] as const).map((target, index) => (
          <button
            key={target}
            className={step === target ? "is-current" : undefined}
            type="button"
            aria-label={t("onboarding.step", {
              number: index + 1,
              title: t(
                target === "welcome"
                  ? "onboarding.welcomeStep"
                  : target === "connect"
                    ? "onboarding.providerStep"
                    : "onboarding.mediaStep",
              ),
            })}
            aria-current={step === target ? "step" : undefined}
            disabled={busy}
            onClick={() => navigate(target)}
          />
        ))}
      </nav>
    </main>
  );
}

function ProviderMark({ id }: { id: string }) {
  const icon = PROVIDER_ICONS[id];
  return icon ? (
    <span
      className={`settings-provider-mark is-${icon.tone}`}
      aria-hidden="true"
    >
      <img src={icon.src} alt="" />
    </span>
  ) : (
    <Server size={18} aria-hidden="true" />
  );
}

function ReadyModel({
  models,
  model,
  busy,
  onChange,
}: {
  models: AgentModelCatalog["models"];
  model: AgentModelCatalog["models"][number];
  busy: boolean;
  onChange: (model: AgentModelCatalog["models"][number]) => void;
}) {
  return (
    <div className="onboarding-ready">
      {t("onboarding.defaultModel")}{" "}
      {models.length > 1 ? (
        <span className="onboarding-model-select">
          <CanvasChipSelect
            label={t("onboarding.defaultModel")}
            value={`${model.provider}/${model.id}`}
            disabled={busy}
            options={models.map((item) => ({
              value: `${item.provider}/${item.id}`,
              label: item.name,
              group: item.providerName,
            }))}
            onChange={(value) => {
              const next = models.find(
                (item) => `${item.provider}/${item.id}` === value,
              );
              if (next) onChange(next);
            }}
          />
        </span>
      ) : (
        <strong>{model.name}</strong>
      )}{" "}
      <span className="onboarding-ready-provider">
        <ProviderMark id={model.provider} />
        {model.providerName}
      </span>
    </div>
  );
}

function ProviderPicker({
  providers,
  busy,
  onChoose,
  onAdd,
}: {
  providers: ProviderSummary[];
  busy: boolean;
  onChoose: (provider: ProviderSummary, method: ModelAuthMethod) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const filtering = Boolean(query.trim());
  const visible = providers.filter((provider) =>
    `${provider.name} ${provider.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  // Setup has no free or local groups; those providers stay under More.
  const { connected, popular, more } = groupProviders(visible, {
    isConnected: chatConnected,
    isFree: () => false,
    isLocal: () => false,
  });
  const featured = [...connected, ...popular];
  const hasMore = !filtering && featured.length > 0 && more.length > 0;
  const row = (provider: ProviderSummary) => {
    const connected = chatConnected(provider);
    return (
      <div
        className="onboarding-provider-row"
        key={provider.id}
        role="group"
        aria-label={provider.name}
      >
        <span>
          <ProviderMark id={provider.id} />
          {provider.name}
        </span>
        <div>
          {connected ? (
            <button
              type="button"
              className="onboarding-text-button onboarding-icon-button"
              aria-label={
                provider.enabled === false
                  ? t("common.enable")
                  : t("providers.status.connected")
              }
              title={
                provider.enabled === false
                  ? t("common.enable")
                  : t("providers.status.connected")
              }
              disabled={busy || provider.enabled !== false}
              onClick={() => onChoose(provider, "api_key")}
            >
              {provider.enabled === false ? (
                <Plug size={16} aria-hidden="true" />
              ) : (
                <Check
                  size={16}
                  className="onboarding-connected"
                  aria-hidden="true"
                />
              )}
            </button>
          ) : provider.custom ? (
            <button
              className="onboarding-text-button onboarding-icon-button"
              type="button"
              aria-label={t("onboarding.configure")}
              title={t("onboarding.configure")}
              disabled={busy}
              onClick={() => onChoose(provider, "api_key")}
            >
              <Settings size={16} aria-hidden="true" />
            </button>
          ) : (
            provider.methods.map((method) => (
              <button
                className="onboarding-text-button onboarding-icon-button"
                type="button"
                key={method.type}
                aria-label={
                  method.type === "oauth"
                    ? t("common.signIn")
                    : t("providers.apiKey")
                }
                title={
                  method.type === "oauth"
                    ? t("common.signIn")
                    : t("providers.apiKey")
                }
                disabled={busy}
                onClick={() => onChoose(provider, method.type)}
              >
                {method.type === "oauth" ? (
                  <LogIn size={16} aria-hidden="true" />
                ) : (
                  <Key size={16} aria-hidden="true" />
                )}
              </button>
            ))
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="onboarding-picker">
      <div className="onboarding-search-row">
        <label className="onboarding-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("providers.search")}
            placeholder={t("onboarding.searchProviders")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="onboarding-text-button onboarding-add-provider"
          type="button"
          aria-label={t("onboarding.addCustomProvider")}
          title={t("onboarding.addCustomProvider")}
          disabled={busy}
          onClick={onAdd}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="onboarding-provider-list">
        {(hasMore ? featured : visible).map(row)}
        {hasMore && !moreOpen ? (
          <button
            className="onboarding-text-button onboarding-more-providers"
            type="button"
            onClick={() => setMoreOpen(true)}
          >
            {t("providers.group.more")} <small>({more.length})</small>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        ) : null}
        {hasMore && moreOpen ? more.map(row) : null}
        {!visible.length ? (
          <p className="onboarding-lede">{t("onboarding.noProviders")}</p>
        ) : null}
      </div>
    </div>
  );
}

export function OnboardingLoading({
  error,
  onRetry,
}: {
  error?: string;
  onRetry: () => void;
}) {
  return (
    <main
      className="onboarding onboarding-loading"
      aria-label={t("onboarding.preparing")}
    >
      <WindowDragRegion />
      {error ? (
        <>
          <p className="onboarding-error" role="alert">
            {error}
          </p>
          <button
            className="onboarding-text-button"
            type="button"
            onClick={onRetry}
          >
            {t("common.retry")}
          </button>
        </>
      ) : (
        <p className="onboarding-status" role="status">
          <LoaderCircle className="spin" size={16} />
          {t("onboarding.gettingReady")}
        </p>
      )}
    </main>
  );
}

/** The studio mounts behind this brief, one-time greeting after setup saves. */
export function OnboardingArrival({ onComplete }: { onComplete: () => void }) {
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const heading = useRef<HTMLHeadingElement>(null);
  const duration = 1_900;
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) {
      complete.current();
      return;
    }
    heading.current?.focus({ preventScroll: true });
    const finish = () => complete.current();
    const timer = setTimeout(finish, duration);
    motion.addEventListener("change", finish);
    return () => {
      clearTimeout(timer);
      motion.removeEventListener("change", finish);
    };
  }, []);
  return (
    <div
      className="onboarding-arrival"
      style={{ "--arrival-duration": `${duration}ms` } as CSSProperties}
    >
      <WindowDragRegion />
      <h1 ref={heading} tabIndex={-1}>
        {t("onboarding.arrival")}
      </h1>
    </div>
  );
}

/** OpenAI can have an image-only connection, which does not make chat ready. */
function chatConnected(provider: ProviderSummary): boolean {
  return provider.languageConfigured ?? provider.configured;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
