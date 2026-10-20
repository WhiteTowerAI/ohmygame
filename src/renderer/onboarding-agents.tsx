import { useEffect, useRef, useState } from "react";
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
  loadingRuntimes,
  onBusyChange,
  onConnected,
  onOpenProviders,
  onUseBuiltIn,
}: {
  busy: boolean;
  models: readonly AgentModel[];
  loadingRuntimes?: AgentRuntimeId[];
  onBusyChange: (busy: boolean) => void;
  onConnected: (id: AgentRuntimeId) => Promise<void>;
  onOpenProviders: () => void;
  onUseBuiltIn: () => Promise<void>;
}) {
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>();
  const [error, setError] = useState<string>();
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
          setError(undefined);
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
            setError(errorMessage(cause));
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

  async function useAgent(agent: AgentRuntimeStatus) {
    if (!agent.enabled)
      remember(await updateAgentRuntime(agent.id, { enabled: true }));
    try {
      await onConnected(agent.id);
    } finally {
      notifyAgentModelsChanged();
    }
  }

  return (
    <section
      className="onboarding-agents"
      aria-label={t("onboarding.localAgents")}
    >
      <div className="onboarding-section-heading">
        <span>{t("onboarding.localAgents")}</span>
        <button
          type="button"
          className="onboarding-text-button"
          aria-label={t("agents.rescan")}
          disabled={busy || Boolean(pending)}
          onClick={() =>
            void run("scan", async () => {
              setAgents(await listAgentRuntimes(true));
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
      <div
        className="onboarding-provider-row onboarding-agent-row"
        role="group"
        aria-label="OhMyGame"
      >
        <span>
          <span className="settings-provider-mark is-brand" aria-hidden="true">
            <img src={brandMark} alt="" />
          </span>
          <span className="onboarding-agent-copy">
            <span>
              OhMyGame <small>Pi</small>
            </span>
            <small>{t("onboarding.builtInHint")}</small>
          </span>
        </span>
        <div>
          <button
            className="onboarding-text-button"
            type="button"
            disabled={busy || Boolean(pending)}
            onClick={() =>
              models.some((model) => !isAgentRuntimeId(model.provider))
                ? void onUseBuiltIn()
                : onOpenProviders()
            }
          >
            {models.some((model) => !isAgentRuntimeId(model.provider))
              ? t("onboarding.useAgent")
              : t("onboarding.connectModel")}
          </button>
        </div>
      </div>
      {!agents && !error ? (
        <p className="onboarding-status" role="status">
          <LoaderCircle className="spin" size={14} />
          {t("codingAgents.checking")}
        </p>
      ) : null}
      {(agents ?? [])
        .filter((agent) => agent.id !== "opencode-cli" || more || agent.enabled)
        .map((agent) => {
          const icon = PROVIDER_ICONS[agent.id];
          const ready =
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
          const installUrl = agent.diagnostics.find(
            (diagnostic) => diagnostic.code === "not-installed",
          )?.command;
          return (
            <div
              className="onboarding-provider-row onboarding-agent-row"
              key={agent.id}
              role="group"
              aria-label={agent.name}
            >
              <span>
                {icon ? (
                  <span
                    className={`settings-provider-mark is-${icon.tone}`}
                    aria-hidden="true"
                  >
                    <img src={icon.src} alt="" />
                  </span>
                ) : null}
                <span className="onboarding-agent-copy">
                  <span>{agent.name}</span>
                  <small>
                    {ready
                      ? t("onboarding.agentReady")
                      : !agent.installed
                        ? t("codingAgents.notInstalled")
                        : signedOut
                          ? t("codingAgents.signedOut")
                          : problem
                            ? t("onboarding.agentNeedsCheck")
                            : t("onboarding.agentDetected")}
                  </small>
                </span>
              </span>
              <div>
                {ready ? (
                  <span className="onboarding-agent-ready">
                    <Check size={14} aria-label={t("onboarding.agentReady")} />
                  </span>
                ) : null}
                <button
                  type="button"
                  className="onboarding-text-button"
                  disabled={busy || Boolean(pending) || Boolean(checking)}
                  onClick={() =>
                    void run(agent.id, async () => {
                      if (!agent.installed) {
                        if (installUrl) await openModelAuthExternal(installUrl);
                      } else if (signedOut) {
                        const started = await loginAgentRuntime(agent.id);
                        loginId.current = agent.id;
                        setCopied(false);
                        setLogin({ id: agent.id, ...started });
                        if (started.url)
                          await openModelAuthExternal(started.url);
                      } else if (problem) {
                        remember(await recheckAgentRuntime(agent.id));
                        notifyAgentModelsChanged();
                      } else {
                        await useAgent(agent);
                      }
                    })
                  }
                >
                  {pending === agent.id || checking ? (
                    <LoaderCircle
                      size={13}
                      className="spin"
                      aria-label={t("common.loading")}
                    />
                  ) : !agent.installed ? (
                    t("codingAgents.installGuide")
                  ) : signedOut ? (
                    t("common.signIn")
                  ) : problem ? (
                    t("codingAgents.recheck")
                  ) : (
                    t("onboarding.useAgent")
                  )}
                </button>
              </div>
            </div>
          );
        })}
      {agents?.some(
        (agent) => agent.id === "opencode-cli" && !agent.enabled,
      ) ? (
        <button
          type="button"
          className="onboarding-text-button onboarding-more-providers"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          {more ? t("onboarding.fewerAgents") : t("onboarding.moreAgents")}
        </button>
      ) : null}
      {login ? (
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
            onClick={() =>
              void run(login.id, async () => {
                remember(await recheckAgentRuntime(login.id));
                notifyAgentModelsChanged();
              })
            }
          >
            {t("codingAgents.recheck")}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
