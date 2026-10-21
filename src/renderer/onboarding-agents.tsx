import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentModel } from "../shared/contracts.js";
import type {
  AgentRuntimeId,
  AgentRuntimeStatus,
} from "../shared/agent-runtimes.js";
import {
  listAgentRuntimes,
  loginAgentRuntime,
  notifyAgentModelsChanged,
  recheckAgentRuntime,
  updateAgentRuntime,
} from "./api.js";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  LoaderCircle,
  Plug,
  RefreshCw,
  LogIn,
} from "./icons.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import { openModelAuthExternal } from "./use-model-provider-auth.js";
import { t } from "./i18n.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import brandMark from "../shared/assets/ohmygame-mark-v2.svg";

/** CLI discovery stays independent of provider loading, and never enables an agent. */
export function OnboardingAgents({
  busy,
  models,
  selectedAgent,
  choosing,
  onExpand,
  onSelectAgent,
  loadingRuntimes,
  onBusyChange,
  children,
}: {
  busy: boolean;
  models: readonly AgentModel[];
  selectedAgent: "pi" | AgentRuntimeId;
  choosing: boolean;
  onExpand: () => void;
  onSelectAgent: (id: "pi" | AgentRuntimeId) => void;
  loadingRuntimes?: AgentRuntimeId[];
  onBusyChange: (busy: boolean) => void;
  children: ReactNode;
}) {
  const generation = useReadyRuntimeGeneration();
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
  const options = useRef<HTMLDivElement>(null);
  const changeAgent = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (choosing)
      options.current
        ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
        ?.focus({ preventScroll: true });
    else changeAgent.current?.focus({ preventScroll: true });
  }, [choosing]);
  const [scrollable, setScrollable] = useState({ before: false, after: false });
  useEffect(() => {
    const element = options.current;
    if (!element) return;
    const update = () =>
      setScrollable({
        before: element.scrollLeft > 1,
        after:
          element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.shiftKey ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      )
        return;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientWidth
            : 1;
      const next = Math.max(
        0,
        Math.min(
          element.scrollWidth - element.clientWidth,
          element.scrollLeft + event.deltaY * unit,
        ),
      );
      if (next === element.scrollLeft) return;
      event.preventDefault();
      element.scrollLeft = next;
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update);
    element.addEventListener("wheel", wheel, { passive: false });
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
      element.removeEventListener("wheel", wheel);
    };
  }, [agents?.length, choosing]);

  function scrollOptions(direction: number) {
    options.current?.scrollBy({
      left: direction * options.current.clientWidth,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
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
  const selectedIcon =
    selectedAgent === "pi"
      ? { src: brandMark, tone: "brand" }
      : PROVIDER_ICONS[selectedAgent];
  const selectedName =
    selectedAgent === "pi" ? "OhMyGame" : (selected?.name ?? selectedAgent);

  return (
    <section
      className="onboarding-agents"
      aria-label={t("onboarding.localAgents")}
    >
      {choosing ? (
        <>
          <div className="onboarding-section-heading">
            <span>{t("onboarding.localAgents")}</span>
            <div className="onboarding-agent-actions">
              {scrollable.before || scrollable.after ? (
                <>
                  <button
                    type="button"
                    className="onboarding-text-button onboarding-icon-button"
                    aria-label={t("onboarding.previousAgents")}
                    title={t("onboarding.previousAgents")}
                    disabled={!scrollable.before}
                    onClick={() => scrollOptions(-1)}
                  >
                    <ChevronLeft size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="onboarding-text-button onboarding-icon-button"
                    aria-label={t("onboarding.nextAgents")}
                    title={t("onboarding.nextAgents")}
                    disabled={!scrollable.after}
                    onClick={() => scrollOptions(1)}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </>
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
          <div className="onboarding-agent-options" ref={options}>
            <button
              type="button"
              className="onboarding-agent-option"
              aria-label="OhMyGame"
              aria-pressed={selectedAgent === "pi"}
              disabled={busy || Boolean(pending)}
              onClick={() => {
                setError(undefined);
                onSelectAgent("pi");
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
              <small>{t("onboarding.builtInHint")}</small>
            </button>
            {(agents ?? []).map((agent) => {
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
              const statusLabel = !agent.installed
                ? t("codingAgents.notInstalled")
                : signedOut
                  ? t("common.signIn")
                  : problem
                    ? t("codingAgents.recheck")
                    : ready
                      ? t("onboarding.agentReady")
                      : t("onboarding.agentDetected");
              const StatusIcon = !agent.installed
                ? Download
                : signedOut
                  ? LogIn
                  : problem
                    ? RefreshCw
                    : ready
                      ? Check
                      : Plug;
              return (
                <button
                  type="button"
                  className="onboarding-agent-option"
                  key={agent.id}
                  aria-label={agent.name}
                  title={statusLabel}
                  aria-pressed={selectedAgent === agent.id}
                  disabled={busy || Boolean(pending) || Boolean(checking)}
                  onClick={() => {
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
                    ) : (
                      <StatusIcon
                        size={13}
                        className={ready ? "onboarding-agent-ready" : undefined}
                        aria-label={statusLabel}
                      />
                    )}
                  </span>
                  <span>{agent.name}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="onboarding-selected-agent">
          <span>
            {selectedIcon ? (
              <span
                className={`settings-provider-mark is-${selectedIcon.tone}`}
                aria-hidden="true"
              >
                <img src={selectedIcon.src} alt="" />
              </span>
            ) : null}
            {selectedName}
          </span>
          <button
            type="button"
            className="onboarding-text-button"
            aria-expanded={false}
            ref={changeAgent}
            disabled={busy || Boolean(pending)}
            onClick={onExpand}
          >
            {t("onboarding.changeAgent")}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {choosing ? (
        <p className="onboarding-agent-hint onboarding-agents-hint">
          {t("onboarding.agentsHint")}
        </p>
      ) : null}
      {!choosing ? (
        <div className="onboarding-agent-config">
          {selectedAgent !== "pi" ? (
            <>
              <p className="onboarding-agent-hint">
                {selected && !selected.installed
                  ? t("onboarding.installAgentHint", { name: selected.name })
                  : t("onboarding.cliHint")}
              </p>
              {selected?.installed &&
              selected.auth.status === "signed-out" &&
              login?.id !== selected.id ? (
                <button
                  type="button"
                  className="onboarding-text-button"
                  disabled={busy || Boolean(pending)}
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
          {children}
        </div>
      ) : null}
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
