import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentModel } from "../shared/contracts.js";
import { isAgentRuntimeId } from "../shared/agent-runtimes.js";
import type {
  AgentRuntimeId,
  AgentRuntimeStatus,
} from "../shared/agent-runtimes.js";
import {
  listAgentRuntimes,
  loginAgentRuntime,
  MODELS_CHANGED_EVENT,
  notifyAgentModelsChanged,
  recheckAgentRuntime,
  updateAgentRuntime,
} from "./api.js";
import { Check, LoaderCircle, RefreshCw } from "./icons.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import { openModelAuthExternal } from "./use-model-provider-auth.js";
import { t } from "./i18n.js";
import brandMark from "../shared/assets/ohmygame-mark-v2.svg";

/** CLI discovery stays independent of provider loading, and never enables an agent. */
export function OnboardingAgents({
  busy,
  models,
  selectedAgent,
  onSelectAgent,
  loadingRuntimes,
  onBusyChange,
  onConnected,
  onUseBuiltIn,
  children,
}: {
  busy: boolean;
  models: readonly AgentModel[];
  selectedAgent: "pi" | AgentRuntimeId;
  onSelectAgent: (id: "pi" | AgentRuntimeId) => void;
  loadingRuntimes?: AgentRuntimeId[];
  onBusyChange: (busy: boolean) => void;
  onConnected: (id: AgentRuntimeId) => Promise<void>;
  onUseBuiltIn: () => Promise<void>;
  children: ReactNode;
}) {
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [pending, setPending] = useState<AgentRuntimeId | "scan">();
  const [more, setMore] = useState(false);
  const [login, setLogin] = useState<{
    id: AgentRuntimeId;
    url?: string;
    command?: string;
  }>();
  const [copied, setCopied] = useState(false);
  const loginId = useRef<AgentRuntimeId | undefined>(undefined);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const load = () => {
      const current = ++revision.current;
      void (async () => {
        if (loginId.current) await recheckAgentRuntime(loginId.current);
        return listAgentRuntimes();
      })()
        .then((loaded) => {
          if (!active || current !== revision.current) return;
          setAgents(loaded);
          setLoadError(undefined);
          if (
            loaded.some(
              (agent) =>
                agent.id === loginId.current &&
                agent.auth.status === "signed-in",
            )
          ) {
            loginId.current = undefined;
            setLogin(undefined);
          }
        })
        .catch((cause) => {
          if (active && current === revision.current)
            setLoadError(errorMessage(cause));
        });
    };
    load();
    window.addEventListener("focus", load);
    window.addEventListener(MODELS_CHANGED_EVENT, load);
    return () => {
      active = false;
      ++revision.current;
      window.removeEventListener("focus", load);
      window.removeEventListener(MODELS_CHANGED_EVENT, load);
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function run(id: AgentRuntimeId | "scan", action: () => Promise<void>) {
    if (busy || pending) return;
    ++revision.current;
    setPending(id);
    onBusyChange(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(undefined);
      onBusyChange(false);
    }
  }

  function remember(status: AgentRuntimeStatus) {
    setAgents((current) =>
      current?.map((agent) => (agent.id === status.id ? status : agent)),
    );
    if (status.auth.status === "signed-in" && loginId.current === status.id) {
      loginId.current = undefined;
      setLogin(undefined);
    }
  }

  async function recheck(id: AgentRuntimeId) {
    remember(await recheckAgentRuntime(id));
    notifyAgentModelsChanged();
  }

  async function useAgent(agent: AgentRuntimeStatus) {
    if (!agent.enabled)
      remember(await updateAgentRuntime(agent.id, { enabled: true }));
    try {
      await onConnected(agent.id);
    } finally {
      notifyAgentModelsChanged();
    }
  }

  const selected = agents?.find((agent) => agent.id === selectedAgent);
  const installUrl = selected?.diagnostics.find(
    (diagnostic) => diagnostic.code === "not-installed",
  )?.command;
  const displayedError = error ?? loadError;

  return (
    <section
      className="onboarding-agents"
      aria-label={t("onboarding.localAgents")}
    >
      <div className="onboarding-section-heading">
        <span>{t("onboarding.localAgents")}</span>
        <div className="onboarding-agent-actions">
          {agents?.some(
            (agent) => agent.id === "opencode-cli" && !agent.enabled,
          ) ? (
            <button
              type="button"
              className="onboarding-text-button"
              aria-expanded={more}
              onClick={() => setMore(!more)}
            >
              {more ? t("onboarding.fewerAgents") : t("onboarding.moreAgents")}
            </button>
          ) : null}
          <button
            type="button"
            className="onboarding-text-button"
            aria-label={t("agents.rescan")}
            disabled={busy || Boolean(pending)}
            onClick={() =>
              void run("scan", async () => {
                setAgents(await listAgentRuntimes(true));
                setLoadError(undefined);
                notifyAgentModelsChanged();
              })
            }
          >
            <RefreshCw
              size={13}
              className={pending === "scan" ? "spin" : undefined}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
      <div className="onboarding-agent-options">
        <button
          type="button"
          className="onboarding-agent-option"
          aria-label="OhMyGame"
          aria-pressed={selectedAgent === "pi"}
          disabled={busy || Boolean(pending)}
          onClick={() => {
            setError(undefined);
            onSelectAgent("pi");
            if (models.some((model) => !isAgentRuntimeId(model.provider)))
              void onUseBuiltIn();
          }}
        >
          <span className="onboarding-agent-title">
            <span
              className="settings-provider-mark is-brand"
              aria-hidden="true"
            >
              <img src={brandMark} alt="" />
            </span>
            <Check
              size={13}
              className="onboarding-agent-ready"
              aria-label={t("common.enabled")}
            />
          </span>
          <span>OhMyGame</span>
          <small>Pi · {t("onboarding.builtInHint")}</small>
        </button>
        {(agents ?? [])
          .filter(
            (agent) => agent.id !== "opencode-cli" || more || agent.enabled,
          )
          .map((agent) => {
            const icon = PROVIDER_ICONS[agent.id];
            const ready =
              agent.installed &&
              agent.enabled &&
              models.some((model) => model.provider === agent.id);
            const checking = loadingRuntimes?.includes(agent.id);
            const problem = agent.diagnostics.some(
              (diagnostic) =>
                diagnostic.code === "runtime-incompatible" ||
                diagnostic.code === "probe-failed" ||
                diagnostic.code === "models-unavailable",
            );
            const signedOut = agent.auth.status === "signed-out";
            return (
              <button
                type="button"
                className="onboarding-agent-option"
                key={agent.id}
                aria-label={agent.name}
                aria-pressed={selectedAgent === agent.id}
                disabled={busy || Boolean(pending) || Boolean(checking)}
                onClick={() => {
                  setError(undefined);
                  onSelectAgent(agent.id);
                  if (!agent.installed) return;
                  void run(agent.id, async () => {
                    if (signedOut) {
                      const started = await loginAgentRuntime(agent.id);
                      loginId.current = agent.id;
                      setCopied(false);
                      setLogin({ id: agent.id, ...started });
                      if (started.url) await openModelAuthExternal(started.url);
                    } else if (problem) {
                      await recheck(agent.id);
                    } else {
                      await useAgent(agent);
                    }
                  });
                }}
              >
                <span className="onboarding-agent-title">
                  {icon ? (
                    <span
                      className={`settings-provider-mark is-${icon.tone}`}
                      aria-hidden="true"
                    >
                      <img src={icon.src} alt="" />
                    </span>
                  ) : null}
                  {pending === agent.id || checking ? (
                    <LoaderCircle
                      size={13}
                      className="spin"
                      aria-label={t("common.loading")}
                    />
                  ) : ready ? (
                    <Check
                      size={13}
                      className="onboarding-agent-ready"
                      aria-label={t("onboarding.agentReady")}
                    />
                  ) : null}
                </span>
                <span>{agent.name}</span>
                <small>
                  {!agent.installed
                    ? t("codingAgents.notInstalled")
                    : signedOut
                      ? t("common.signIn")
                      : problem
                        ? t("codingAgents.recheck")
                        : ready
                          ? null
                          : t("onboarding.agentDetected")}
                </small>
              </button>
            );
          })}
      </div>
      <div className="onboarding-agent-config">
        {selectedAgent !== "pi" ? (
          <>
            <p className="onboarding-agent-hint">
              {selected && !selected.installed
                ? t("onboarding.installAgentHint", { name: selected.name })
                : t("onboarding.cliHint")}
            </p>
            {selected && !selected.installed ? (
              <div className="onboarding-agent-install-actions">
                {installUrl ? (
                  <button
                    type="button"
                    className="onboarding-text-button"
                    disabled={busy || Boolean(pending)}
                    onClick={() =>
                      void run(selected.id, () =>
                        openModelAuthExternal(installUrl),
                      )
                    }
                  >
                    {t("codingAgents.installGuide")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="onboarding-text-button"
                  disabled={busy || Boolean(pending)}
                  onClick={() =>
                    void run(selected.id, () => recheck(selected.id))
                  }
                >
                  {t("codingAgents.recheck")}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
        {!agents && !displayedError ? (
          <p className="onboarding-status" role="status">
            <LoaderCircle className="spin" size={14} />
            {t("codingAgents.checking")}
          </p>
        ) : null}
        {login && login.id === selectedAgent ? (
          <div className="onboarding-agent-login" role="status">
            {login.url ? (
              <button
                type="button"
                className="onboarding-text-button"
                onClick={() =>
                  void run(login.id, () => openModelAuthExternal(login.url!))
                }
              >
                {t("codingAgents.openAgain")}
              </button>
            ) : login.command ? (
              <>
                <p>{t("codingAgents.loginCommand")}</p>
                <code>{login.command}</code>
                <button
                  type="button"
                  className="onboarding-text-button"
                  onClick={() =>
                    void navigator.clipboard.writeText(login.command!).then(
                      () => setCopied(true),
                      (cause) => setError(errorMessage(cause)),
                    )
                  }
                >
                  {copied
                    ? t("codingAgents.copied")
                    : t("codingAgents.copyCommand")}
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="onboarding-text-button"
              disabled={busy || Boolean(pending)}
              onClick={() => void run(login.id, () => recheck(login.id))}
            >
              {t("codingAgents.recheck")}
            </button>
          </div>
        ) : null}
        {displayedError ? (
          <p className="onboarding-error" role="alert">
            {displayedError}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
