import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AgentModel } from "../shared/contracts.js";
import {
  isAgentRuntimeId,
  type AgentRuntimeId,
  type AgentRuntimeStatus,
} from "../shared/agent-runtimes.js";
import {
  listAgentRuntimes,
  loginAgentRuntime,
  notifyAgentModelsChanged,
  recheckAgentRuntime,
  updateAgentRuntime,
} from "./api.js";
import { Check, LoaderCircle, LogIn, RefreshCw } from "./icons.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import { openModelAuthExternal } from "./use-model-provider-auth.js";
import { t } from "./i18n.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import brandMark from "../shared/assets/ohmygame-mark-v2.svg";

/**
 * The agents as a list of cards: OhMyGame first, then the coding agents found on
 * this machine. The chosen card opens its setup below it. CLI discovery stays
 * independent of provider loading, and never enables an agent.
 */
export function OnboardingAgents({
  busy,
  models,
  selectedAgent,
  onSelectAgent,
  loadingRuntimes,
  onBusyChange,
  children,
}: {
  busy: boolean;
  models: readonly AgentModel[];
  selectedAgent: "pi" | AgentRuntimeId;
  onSelectAgent: (id: "pi" | AgentRuntimeId) => void;
  loadingRuntimes?: AgentRuntimeId[];
  onBusyChange: (busy: boolean) => void;
  children: ReactNode;
}) {
  const generation = useReadyRuntimeGeneration();
  const describedBy = useId();
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [pending, setPending] = useState<AgentRuntimeId | "scan">();
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
            notifyAgentModelsChanged();
          }
        })
        .catch((cause) => {
          if (active && current === revision.current)
            setLoadError(errorMessage(cause));
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      active = false;
      ++revision.current;
      window.removeEventListener("focus", load);
    };
  }, [generation]);

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
    const agent = await recheckAgentRuntime(id);
    remember(agent);
    if (agent.installed && !agent.enabled) await useAgent(agent);
    else notifyAgentModelsChanged();
    if (
      agent.installed &&
      agent.auth.status === "signed-out" &&
      loginId.current !== id
    )
      await signIn(id);
  }

  async function useAgent(agent: AgentRuntimeStatus) {
    if (!agent.enabled) {
      remember(await updateAgentRuntime(agent.id, { enabled: true }));
      notifyAgentModelsChanged();
    }
  }

  async function signIn(id: AgentRuntimeId) {
    const started = await loginAgentRuntime(id);
    loginId.current = id;
    setCopied(false);
    setLogin({ id, ...started });
    if (started.url) await openModelAuthExternal(started.url);
  }

  const selected = agents?.find((agent) => agent.id === selectedAgent);
  const installUrl = selected?.diagnostics.find(
    (diagnostic) => diagnostic.code === "not-installed",
  )?.command;
  const displayedError = error ?? loadError;
  const locked = busy || Boolean(pending);

  const agentSetup = (
    <>
      {selected ? (
        <>
          {!selected.installed ? (
            <p className="onboarding-agent-hint">
              {t("onboarding.installAgentHint", { name: selected.name })}
            </p>
          ) : null}
          {selected.installed &&
          selected.auth.status === "signed-out" &&
          login?.id !== selected.id ? (
            <button
              type="button"
              className="onboarding-text-button"
              disabled={locked}
              onClick={() =>
                void run(selected.id, async () => {
                  await useAgent(selected);
                  await signIn(selected.id);
                })
              }
            >
              <LogIn size={14} aria-hidden="true" />
              {t("common.signIn")}
            </button>
          ) : null}
          {!selected.installed ? (
            <div className="onboarding-agent-install-actions">
              {installUrl ? (
                <button
                  type="button"
                  className="onboarding-text-button"
                  disabled={locked}
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
                disabled={locked}
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
            disabled={locked}
            onClick={() => void run(login.id, () => recheck(login.id))}
          >
            {t("codingAgents.recheck")}
          </button>
        </div>
      ) : null}
      {children}
    </>
  );

  // One row of agents, all in sight, then the chosen one's setup below it.
  const tile = ({
    id,
    name,
    icon,
    status,
    tone,
    disabled,
    onClick,
  }: {
    id: "pi" | AgentRuntimeId;
    name: string;
    icon: { src: string; tone: string };
    status: ReactNode;
    tone?: "ready" | "muted";
    disabled: boolean;
    onClick: () => void;
  }) => {
    // The name labels the tile; its status describes it.
    const statusId = `${describedBy}-${id}-status`;
    return (
      <button
        key={id}
        type="button"
        className={`onboarding-agent-option${selectedAgent === id ? " is-selected" : ""}`}
        aria-label={name}
        aria-describedby={statusId}
        aria-pressed={selectedAgent === id}
        disabled={disabled}
        onClick={onClick}
      >
        <span
          className={`settings-provider-mark is-${icon.tone}`}
          aria-hidden="true"
        >
          <img src={icon.src} alt="" />
        </span>
        <span className="onboarding-agent-name">{name}</span>
        <span
          id={statusId}
          className={`onboarding-agent-status${tone ? ` is-${tone}` : ""}`}
        >
          {status}
        </span>
      </button>
    );
  };
  const piReady = models.some((model) => !isAgentRuntimeId(model.provider));

  return (
    <section
      className="onboarding-agents"
      aria-label={t("onboarding.localAgents")}
    >
      <div className="onboarding-agent-options">
        {tile({
          id: "pi",
          name: "OhMyGame",
          icon: { src: brandMark, tone: "brand" },
          status: piReady ? (
            <>
              <Check size={12} aria-hidden="true" />
              {t("onboarding.agentReady")}
            </>
          ) : (
            t("onboarding.builtIn")
          ),
          tone: piReady ? "ready" : undefined,
          disabled: locked,
          onClick: () => {
            setError(undefined);
            onSelectAgent("pi");
          },
        })}
        {(agents ?? []).map((agent) => {
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
          const statusLabel = !agent.installed
            ? t("codingAgents.notInstalled")
            : signedOut
              ? t("onboarding.agentSignedOut")
              : problem
                ? t("codingAgents.recheck")
                : ready
                  ? t("onboarding.agentReady")
                  : t("onboarding.agentDetected");
          return tile({
            id: agent.id,
            name: agent.name,
            icon: PROVIDER_ICONS[agent.id] ?? { src: brandMark, tone: "brand" },
            status:
              pending === agent.id || checking ? (
                <LoaderCircle
                  size={12}
                  className="spin"
                  aria-label={t("common.loading")}
                />
              ) : (
                <>
                  {ready ? <Check size={12} aria-hidden="true" /> : null}
                  {statusLabel}
                </>
              ),
            tone: ready ? "ready" : !agent.installed ? "muted" : undefined,
            disabled: locked || Boolean(checking),
            onClick: () => {
              setError(undefined);
              onSelectAgent(agent.id);
              if (!agent.installed) return;
              void run(agent.id, async () => {
                if (signedOut) {
                  await useAgent(agent);
                  await signIn(agent.id);
                } else if (problem) {
                  await recheck(agent.id);
                } else {
                  await useAgent(agent);
                }
              });
            },
          });
        })}
        {!agents && !displayedError ? (
          <span
            className="onboarding-agent-option is-placeholder"
            role="status"
          >
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
            <span className="onboarding-agent-status">
              {t("codingAgents.checking")}
            </span>
          </span>
        ) : null}
        {/* A failed scan, or a later refresh that fails, offers the whole
            scan again beside the agents it still shows. */}
        {displayedError ? (
          <button
            type="button"
            className="onboarding-agent-option is-placeholder"
            aria-label={t("agents.rescan")}
            disabled={locked}
            onClick={() =>
              void run("scan", async () => {
                setAgents(await listAgentRuntimes(true));
                setLoadError(undefined);
                notifyAgentModelsChanged();
              })
            }
          >
            <RefreshCw
              size={16}
              className={pending === "scan" ? "spin" : undefined}
              aria-hidden="true"
            />
            <span className="onboarding-agent-status">
              {t("agents.rescan")}
            </span>
          </button>
        ) : null}
      </div>
      <div className="onboarding-agent-config">{agentSetup}</div>
      {displayedError ? (
        <p className="onboarding-error" role="alert">
          {displayedError}
        </p>
      ) : null}
    </section>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
