import { useEffect, useRef, useState } from "react";
import type {
  AgentModelCatalog,
  ModelAuthMethod,
  ProviderSummary,
} from "../shared/contracts.js";
import type { OnboardingStatus, OnboardingStep } from "../shared/onboarding.js";
import {
  findAgentModel,
  preferredAgentModel,
  recommendedAgentModel,
} from "../shared/agent-models.js";
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
  LoaderCircle,
  Plus,
  Search,
  Server,
} from "./icons.js";
import { ActiveProviderAuth } from "./models-settings.js";
import { CustomProviderForm } from "./custom-provider-dialog.js";
import { groupModelsByProvider } from "./model-selector.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import { groupProviders } from "./provider-groups.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { WindowDragRegion } from "./window-drag-region.js";
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
  const [running, setRunning] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const busy = running || savingProvider;
  const failedAction = useRef<(() => Promise<void>) | undefined>(undefined);
  const [connection, setConnection] = useState<Connection>();
  const [adding, setAdding] = useState(false);
  const [customSettings, setCustomSettings] =
    useState<Awaited<ReturnType<typeof getCustomProvider>>>();
  const [refresh, setRefresh] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const model =
    phase === "ready"
      ? preferredAgentModel(catalog.models, undefined, catalog.defaultModel)
      : undefined;
  const languageProviders = providers.filter(
    (provider) =>
      provider.capabilities.includes("language") &&
      // Signing in to OpenAI covers ChatGPT subscriptions; keep the legacy entry only once saved.
      (provider.id !== "openai-codex" || chatConnected(provider)),
  );
  useEffect(() => {
    if (!adding) heading.current?.focus({ preventScroll: true });
  }, [step, adding, connection]);
  useEffect(() => {
    if (step !== "connect") return;
    setPhase("loading");
    let active = true,
      sequence = 0;
    const load = () => {
      const current = ++sequence;
      void Promise.all([listProviders(), listModels()])
        .then(([loadedProviders, loadedCatalog]) => {
          if (!active || current !== sequence) return;
          setProviders(loadedProviders);
          setCatalog(loadedCatalog);
          setPhase("ready");
          setLoadError(undefined);
        })
        .catch((cause) => {
          if (!active || current !== sequence) return;
          setPhase("error");
          setLoadError(errorMessage(cause));
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
      await selectProviderModel(current.id);
      setRefresh((value) => value + 1);
    } else if (current.custom) {
      setCustomSettings(await getCustomProvider(current.id));
      setAdding(true);
    } else {
      setConnection({ provider: current, method });
    }
  }

  /** The provider connected last during setup supplies the default model. */
  async function selectProviderModel(providerId: string) {
    const latest = await listModels();
    const next = recommendedAgentModel(latest.models, providerId);
    if (next) await chooseModel(latest, next);
  }

  async function chooseModel(
    current: AgentModelCatalog,
    next: AgentModelCatalog["models"][number],
  ) {
    if (findAgentModel([next], current.defaultModel)) return;
    await updateAgentDefaults({
      model: next,
      reasoningLevel: clampReasoningLevel(
        current.defaultReasoningLevel,
        next.reasoningLevels,
      ),
    });
  }

  function completed(providerId: string) {
    setConnection(undefined);
    setPhase("loading");
    void run(async () => {
      try {
        await selectProviderModel(providerId);
      } finally {
        setRefresh((value) => value + 1);
      }
    });
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
      {phase === "loading" ? (
        <p className="onboarding-status" role="status">
          <LoaderCircle className="spin" size={16} />
          {t("onboarding.loadingProviders")}
        </p>
      ) : null}
      {phase !== "loading" ? (
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
      ) : null}
      {model ? (
        <ReadyModel
          models={catalog.models}
          model={model}
          busy={busy}
          onChange={(next) =>
            void run(async () => {
              await chooseModel(catalog, next);
              setRefresh((value) => value + 1);
            })
          }
        />
      ) : phase === "ready" && languageProviders.some(chatConnected) ? (
        <p className="onboarding-lede">{t("onboarding.needsLanguageModel")}</p>
      ) : null}
    </>
  );

  return (
    <main
      className={`onboarding onboarding-${step}${adding ? " onboarding-custom" : ""}`}
      aria-label={t("onboarding.welcome")}
      aria-busy={busy}
    >
      <WindowDragRegion />
      <div className="onboarding-content">
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
        ) : (
          connectionContent
        )}
        {error || loadError ? (
          <div className="onboarding-feedback">
            <p className="onboarding-error" role="alert">
              {error ?? loadError}
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
        <footer className="onboarding-footer">
          {step === "welcome" ? (
            <button
              className="onboarding-primary-button"
              type="button"
              disabled={busy}
              onClick={() => navigate("connect")}
            >
              {t("onboarding.next")}
            </button>
          ) : (
            <>
              <button
                className="onboarding-primary-button"
                type="button"
                disabled={busy || !model}
                onClick={() => {
                  if (model) void run(() => onFinish("completed"));
                }}
              >
                {t("onboarding.startCreating")}
              </button>
              {model ? null : (
                <button
                  className="onboarding-text-button onboarding-skip-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => onFinish("skipped"))}
                >
                  {t("onboarding.skipAndStart")}
                </button>
              )}
            </>
          )}
        </footer>
      ) : null}
      <nav
        className="onboarding-progress"
        aria-label={t("onboarding.gettingStarted")}
      >
        {(["welcome", "connect"] as const).map((target, index) => (
          <button
            key={target}
            className={step === target ? "is-current" : undefined}
            type="button"
            aria-label={t("onboarding.step", {
              number: index + 1,
              title: t(
                target === "welcome"
                  ? "onboarding.welcomeStep"
                  : "onboarding.providerStep",
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
  const groups = groupModelsByProvider(models);
  return (
    <div className="onboarding-ready" role="status">
      <Check size={16} />
      {t("onboarding.readyWith")}{" "}
      {models.length > 1 ? (
        <span className="onboarding-model-select">
          <select
            aria-label={t("onboarding.defaultModel")}
            value={`${model.provider}/${model.id}`}
            disabled={busy}
            onChange={(event) => {
              const next = models.find(
                (item) => `${item.provider}/${item.id}` === event.target.value,
              );
              if (next) onChange(next);
            }}
          >
            {groups.map((group) => (
              <optgroup label={group.providerName} key={group.provider}>
                {group.models.map((item) => (
                  <option
                    value={`${item.provider}/${item.id}`}
                    key={`${item.provider}/${item.id}`}
                  >
                    {item.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <ChevronDown size={12} aria-hidden="true" />
        </span>
      ) : (
        <strong>{model.name}</strong>
      )}{" "}
      <span className="onboarding-ready-provider">· {model.providerName}</span>
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
  const collapsed = !filtering && featured.length > 0 && more.length > 0;
  const row = (provider: ProviderSummary) => (
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
        {chatConnected(provider) || provider.custom ? (
          <button
            className="onboarding-text-button"
            type="button"
            disabled={
              busy || (chatConnected(provider) && provider.enabled !== false)
            }
            onClick={() => onChoose(provider, "api_key")}
          >
            {chatConnected(provider)
              ? provider.enabled === false
                ? t("common.enable")
                : t("providers.status.connected")
              : t("onboarding.configure")}
          </button>
        ) : (
          provider.methods.map((method) => (
            <button
              className="onboarding-text-button"
              type="button"
              key={method.type}
              disabled={busy}
              onClick={() => onChoose(provider, method.type)}
            >
              {method.type === "oauth"
                ? t("common.signIn")
                : t("providers.apiKey")}
            </button>
          ))
        )}
      </div>
    </div>
  );
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
        {(collapsed ? featured : visible).map(row)}
        {collapsed ? (
          <button
            className="onboarding-text-button onboarding-more-providers"
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            {t("providers.group.more")} <small>({more.length})</small>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        ) : null}
        {collapsed && moreOpen ? more.map(row) : null}
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

/** OpenAI can have an image-only connection, which does not make chat ready. */
function chatConnected(provider: ProviderSummary): boolean {
  return provider.languageConfigured ?? provider.configured;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
