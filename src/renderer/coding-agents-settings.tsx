import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  LoaderCircle,
  RefreshCw,
  Settings,
  Terminal,
} from "./icons.js";
import {
  AGENT_PERMISSION_MODES,
  FULL_ACCESS_PERMISSION_MODES,
  isAccountRuntimeId,
} from "../shared/agent-runtimes.js";
import type {
  AgentPermissionMode,
  AgentRuntimeDiagnostic,
  AgentRuntimeId,
  AgentRuntimeStatus,
} from "../shared/agent-runtimes.js";
import type { AgentModel } from "../shared/contracts.js";
import {
  listAgentRuntimes,
  loginAgentRuntime,
  MODELS_CHANGED_EVENT,
  notifyAgentModelsChanged,
  recheckAgentRuntime,
  updateAgentRuntime,
} from "./api.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import { openModelAuthExternal } from "./use-model-provider-auth.js";
import { SegmentedControl } from "./segmented-control.js";
import { AgentUsageDetails, AgentUsageInline } from "./agent-usage.js";
import { t } from "./i18n.js";
import { AgentAccountProfiles } from "./agent-account-profiles.js";

type PermissionModeKey =
  | "claudeDefault"
  | "claudeAcceptEdits"
  | "claudeAuto"
  | "claudeBypass"
  | "codexWorkspace"
  | "codexFullAccess"
  | "openCodeRules"
  | "openCodeAllow";

/** Each agent's own permission modes, by the names their CLIs give them. */
const PERMISSION_MODE_KEYS: Record<
  AgentRuntimeId,
  Partial<Record<AgentPermissionMode, PermissionModeKey>>
> = {
  "claude-code-cli": {
    default: "claudeDefault",
    acceptEdits: "claudeAcceptEdits",
    auto: "claudeAuto",
    bypassPermissions: "claudeBypass",
  },
  "codex-cli": {
    ":workspace": "codexWorkspace",
    ":danger-full-access": "codexFullAccess",
  },
  "opencode-cli": { default: "openCodeRules", allow: "openCodeAllow" },
};

function permissionOptions(
  runtime: AgentRuntimeId,
): { value: AgentPermissionMode; label: string }[] {
  return AGENT_PERMISSION_MODES[runtime].map((value) => ({
    value,
    label: t(`codingAgents.permissionMode.${PERMISSION_MODE_KEYS[runtime][value]!}`),
  }));
}

/**
 * The coding agent CLIs in Agents: those found on this computer, each with
 * its sign-in and a switch that offers its models in the model picker.
 */
export function CodingAgentsGroup({
  models,
  defaultAgent,
  onOpen,
}: {
  /** Model probes can also report fresh account limits; reload status when they finish. */
  models?: readonly AgentModel[];
  /** The agent whose model new conversations start with, if it is a CLI. */
  defaultAgent?: AgentRuntimeId;
  onOpen: (id: AgentRuntimeId) => void;
}) {
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<Set<AgentRuntimeId>>(new Set());
  useEffect(() => {
    let active = true;
    const load = () =>
      void listAgentRuntimes()
        .then((loaded) => {
          if (active) {
            setAgents(loaded);
            setError(undefined);
          }
        })
        .catch((cause) => {
          if (active) setError(errorMessage(cause));
        });
    load();
    window.addEventListener(MODELS_CHANGED_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.removeEventListener(MODELS_CHANGED_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, [models]);
  async function toggle(
    agent: AgentRuntimeStatus,
    enabled: boolean,
  ): Promise<void> {
    setPending((current) => new Set(current).add(agent.id));
    setAgents((current) =>
      current?.map((item) =>
        item.id === agent.id ? { ...item, enabled } : item,
      ),
    );
    try {
      const saved = await updateAgentRuntime(agent.id, { enabled });
      setAgents((current) =>
        current?.map((item) => (item.id === agent.id ? saved : item)),
      );
      notifyAgentModelsChanged();
    } catch (cause) {
      setAgents((current) =>
        current?.map((item) => (item.id === agent.id ? agent : item)),
      );
      setError(errorMessage(cause));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(agent.id);
        return next;
      });
    }
  }
  return (
    <section
      className="settings-provider-group coding-agents-group"
      aria-label={t("codingAgents.title")}
    >
      <h4>{t("codingAgents.title")}</h4>
      {!agents && !error ? (
        <div className="settings-loading">
          <LoaderCircle className="spin" size={18} />
          {t("codingAgents.checking")}
        </div>
      ) : null}
      {(agents ?? []).map((agent) => {
        const action = agent.installed
          ? t("codingAgents.manage", { name: agent.name })
          : t("codingAgents.setUp", { name: agent.name });
        return (
          <div className="settings-provider-row" key={agent.id}>
            <AgentMark id={agent.id} />
            <span className="settings-provider-copy">
              <strong className="settings-provider-name">
                <span>{agent.name}</span>
                {agent.id === defaultAgent ? (
                  <small>{t("agents.default")}</small>
                ) : null}
              </strong>
              <span className="settings-provider-details">
                <span className="settings-provider-description">
                  {agentSummary(agent)}
                </span>
              </span>
              {agent.limits?.length ? (
                <AgentUsageInline limits={agent.limits} />
              ) : null}
            </span>
            {agent.installed ? (
              <label
                className="settings-toggle settings-provider-toggle"
                title={
                  agent.enabled ? t("common.enabled") : t("common.disabled")
                }
              >
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={t("codingAgents.enable", { name: agent.name })}
                  checked={agent.enabled}
                  disabled={pending.has(agent.id)}
                  onChange={(event) => void toggle(agent, event.target.checked)}
                />
                <span aria-hidden="true" />
              </label>
            ) : (
              <em className="settings-provider-status is-not_configured">
                {t("codingAgents.notInstalled")}
              </em>
            )}
            <button
              className="icon-button settings-provider-action"
              type="button"
              data-tooltip={action}
              aria-label={action}
              onClick={() => onOpen(agent.id)}
            >
              <Settings size={17} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function CodingAgentDetail({
  id,
  onBack,
}: {
  id: AgentRuntimeId;
  onBack: () => void;
}) {
  const [agent, setAgent] = useState<AgentRuntimeStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"recheck" | "login" | "save">();
  const [login, setLogin] = useState<{ url?: string; command?: string }>();
  const [binaryPath, setBinaryPath] = useState("");
  useEffect(() => {
    let active = true;
    void listAgentRuntimes()
      .then((agents) => {
        const found = agents.find((item) => item.id === id);
        if (!active || !found) return;
        setAgent(found);
        setBinaryPath(found.configuredBinaryPath ?? "");
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [id]);
  async function run(
    kind: "recheck" | "login" | "save",
    work: () => Promise<void>,
  ): Promise<void> {
    if (busy) return;
    setBusy(kind);
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  }
  const recheck = () =>
    run("recheck", async () => {
      const status = await recheckAgentRuntime(id);
      setAgent(status);
      setBinaryPath(status.configuredBinaryPath ?? "");
      notifyAgentModelsChanged();
    });
  const signIn = (profileId: string) =>
    run("login", async () => {
      const started = await loginAgentRuntime(id, profileId);
      setLogin(started);
      if (started.url)
        await openModelAuthExternal(started.url).catch(() => undefined);
    });
  const update = (change: Parameters<typeof updateAgentRuntime>[1]) =>
    run("save", async () => {
      const status = await updateAgentRuntime(id, change);
      setAgent(status);
      setBinaryPath(status.configuredBinaryPath ?? "");
      notifyAgentModelsChanged();
    });
  function savePath(event: FormEvent): void {
    event.preventDefault();
    void update({ binaryPath: binaryPath.trim() });
  }
  if (!agent) {
    return (
      <section className="settings-panel settings-provider-detail">
        <header className="settings-provider-detail-header">
          <button
            className="icon-button settings-provider-back"
            type="button"
            onClick={onBack}
            aria-label={t("common.back")}
          >
            <ArrowLeft size={16} />
          </button>
        </header>
        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : (
          <div className="settings-loading">
            <LoaderCircle className="spin" size={18} />
            {t("codingAgents.checking")}
          </div>
        )}
      </section>
    );
  }
  const problems = agent.diagnostics;
  return (
    <section className="settings-panel settings-provider-detail coding-agent-detail">
      <header className="settings-provider-detail-header">
        <button
          className="icon-button settings-provider-back"
          type="button"
          onClick={onBack}
          aria-label={t("common.back")}
        >
          <ArrowLeft size={16} />
        </button>
        <AgentMark id={agent.id} />
        <span className="settings-provider-heading">
          <h3>{agent.name}</h3>
        </span>
        {agent.installed ? (
          <div className="settings-provider-enable-control">
            <label className="settings-provider-enable-label">
              <small>
                {agent.enabled ? t("common.enabled") : t("common.disabled")}
              </small>
              <span className="settings-toggle">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={t("codingAgents.enable", { name: agent.name })}
                  checked={agent.enabled}
                  disabled={busy !== undefined}
                  onChange={(event) =>
                    void update({ enabled: event.target.checked })
                  }
                />
                <span aria-hidden="true" />
              </span>
            </label>
          </div>
        ) : null}
      </header>
      <div className="settings-provider-connection">
        <div className="settings-provider-setting-row">
          <span className="settings-search-field-label">
            {t("codingAgents.status")}
          </span>
          <span className="settings-provider-setting-value">
            {agentSummary(agent)}
          </span>
          <button
            type="button"
            className="icon-button settings-provider-setting-edit"
            disabled={busy !== undefined}
            onClick={() => void recheck()}
            aria-label={t("codingAgents.recheck")}
            data-tooltip={t("codingAgents.recheck")}
          >
            <RefreshCw
              size={15}
              className={busy === "recheck" ? "spin" : undefined}
              aria-hidden="true"
            />
          </button>
        </div>
        {agent.installed && agent.id === "opencode-cli" ? (
          <div className="settings-provider-setting-row settings-provider-auth-row">
            <span className="settings-search-field-label">{t("codingAgents.account")}</span>
            <span className="settings-provider-setting-value">{t("codingAgents.openCodeAccounts")}</span>
          </div>
        ) : null}
      </div>
      {isAccountRuntimeId(agent.id) ? <AgentAccountProfiles key={agent.id} runtime={agent.id} defaultProfileId={agent.defaultProfileId ?? "system"} onDefault={(defaultProfileId) => update({ defaultProfileId })} onLogin={signIn} onRemoved={async () => {
        setAgent((await listAgentRuntimes()).find((item) => item.id === id));
        notifyAgentModelsChanged();
      }} disabled={busy !== undefined} /> : null}
      {login ? <LoginHint login={login} /> : null}
      {agent.installed && agent.id !== "opencode-cli" ? (
        // OpenCode bills each model provider; its account has no quota of its own.
        <section className="settings-detail-section">
          <h4>{t("agentUsage.title")}</h4>
          {agent.limits?.length ? (
            <AgentUsageDetails limits={agent.limits} />
          ) : (
            <p className="cloud-quota-note">
              {t("agentUsage.empty", { name: agent.name })}
            </p>
          )}
        </section>
      ) : null}
      {problems.length ? (
        <section
          className="settings-detail-section"
          aria-label={t("codingAgents.diagnostics")}
        >
          {problems.map((diagnostic) => (
            <Diagnostic
              key={diagnostic.code}
              agent={agent}
              diagnostic={diagnostic}
            />
          ))}
        </section>
      ) : null}
      {agent.installed ? (
        <section className="settings-detail-section">
          <h4>{t("codingAgents.configuration")}</h4>
          <div className="coding-agent-permission">
            <span className="settings-search-field-label">
              {t("codingAgents.permissions")}
            </span>
            <SegmentedControl
              className="settings-chat-layout-control"
              label={t("codingAgents.permissions")}
              options={permissionOptions(agent.id)}
              value={agent.permissionMode}
              onChange={(permissionMode) => void update({ permissionMode })}
            />
          </div>
          <p
            className={
              agent.permissionMode === FULL_ACCESS_PERMISSION_MODES[agent.id]
                ? "coding-agent-warning"
                : "settings-detail-hint"
            }
            role="note"
          >
            {t(
              `codingAgents.permissionModeHint.${PERMISSION_MODE_KEYS[agent.id][agent.permissionMode]!}`,
            )}
          </p>
          <p className="settings-detail-hint">
            {t("codingAgents.permissionModesHint", { name: agent.name })}
          </p>
          <p className="settings-detail-hint">
            {t("codingAgents.cliConfigHint", { name: agent.name })}
          </p>
        </section>
      ) : null}
      <section className="settings-detail-section">
        <form className="settings-detail-field" onSubmit={savePath}>
          <label
            className="settings-search-field-label"
            htmlFor={`${agent.id}-executable`}
          >
            {t("codingAgents.executable")}
          </label>
          <div className="settings-detail-inline">
            <input
              id={`${agent.id}-executable`}
              aria-describedby={`${agent.id}-executable-hint`}
              className="settings-search-input"
              value={binaryPath}
              placeholder={t("codingAgents.executablePlaceholder")}
              spellCheck={false}
              onChange={(event) => setBinaryPath(event.target.value)}
            />
            <button
              type="submit"
              className="settings-secondary-button"
              disabled={
                busy !== undefined ||
                binaryPath.trim() === (agent.configuredBinaryPath ?? "")
              }
            >
              {t("common.save")}
            </button>
          </div>
        </form>
        <p className="settings-detail-hint" id={`${agent.id}-executable-hint`}>
          {t("codingAgents.executableHint")}
        </p>
        {agent.binaryPath ? (
          <p className="settings-detail-hint coding-agent-executable-path">
            {agent.binarySource
              ? `${t(`codingAgents.binarySource.${agent.binarySource}`)}: `
              : ""}
            <code>{agent.binaryPath}</code>
          </p>
        ) : null}
      </section>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function LoginHint({ login }: { login: { url?: string; command?: string } }) {
  if (login.url) {
    return (
      <p className="settings-detail-hint" role="status">
        {t("codingAgents.loginOpened")}{" "}
        <button
          type="button"
          className="coding-agent-link"
          onClick={() => void openModelAuthExternal(login.url!)}
        >
          {t("codingAgents.openAgain")}
        </button>
      </p>
    );
  }
  return login.command ? (
    <div className="settings-detail-hint" role="status">
      {t("codingAgents.loginCommand")} <CommandText command={login.command} />
    </div>
  ) : null;
}

function Diagnostic({
  agent,
  diagnostic,
}: {
  agent: AgentRuntimeStatus;
  diagnostic: AgentRuntimeDiagnostic;
}) {
  const text = diagnosticText(agent, diagnostic);
  return (
    <div
      className={`coding-agent-diagnostic is-${diagnostic.code}`}
      role={
        diagnostic.code === "not-installed" ||
        diagnostic.code === "runtime-incompatible"
          ? "alert"
          : "status"
      }
    >
      <Terminal size={14} aria-hidden="true" />
      <span>
        {text}
        {diagnostic.command && diagnostic.code === "not-installed" ? (
          <>
            {" "}
            <button
              type="button"
              className="coding-agent-link"
              onClick={() => void openModelAuthExternal(diagnostic.command!)}
            >
              {t("codingAgents.installGuide")}
            </button>
          </>
        ) : null}
        {diagnostic.command && diagnostic.code === "signed-out" ? (
          <>
            {" "}
            <CommandText command={diagnostic.command} />
          </>
        ) : null}
      </span>
    </div>
  );
}

export function CommandText({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <span className="coding-agent-command">
      <code>{command}</code>
      <button
        type="button"
        className="icon-button"
        aria-label={t("codingAgents.copyCommand")}
        data-tooltip={
          copied ? t("codingAgents.copied") : t("codingAgents.copyCommand")
        }
        onClick={() =>
          void navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        {copied ? (
          <Check size={13} aria-hidden="true" />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
      </button>
    </span>
  );
}

export function AgentMark({ id }: { id: AgentRuntimeId }) {
  const icon = PROVIDER_ICONS[id];
  if (!icon)
    return (
      <span className="settings-provider-mark-slot" aria-hidden="true">
        <Terminal size={20} />
      </span>
    );
  return (
    <span
      className={`settings-provider-mark is-${icon.tone}`}
      aria-hidden="true"
    >
      <img src={icon.src} alt="" />
    </span>
  );
}

function agentSummary(agent: AgentRuntimeStatus): string {
  if (!agent.installed)
    return t(
      agent.diagnostics.some((item) => item.code === "invalid-executable")
        ? "codingAgents.invalidExecutable"
        : "codingAgents.notFound",
    );
  const version = agent.version
    ? `v${agent.version}`
    : t("codingAgents.versionUnknown");
  if (
    agent.diagnostics.some(
      (diagnostic) => diagnostic.code === "runtime-incompatible",
    )
  )
    return t("codingAgents.needsUpdate", { version });
  if (agent.diagnostics.some((item) => item.code === "probe-failed"))
    return t("codingAgents.checkFailed", { version });
  if (agent.auth.status === "signed-out")
    return t("codingAgents.installedSignedOut", { version });
  return t("codingAgents.installed", { version });
}

function diagnosticText(
  agent: AgentRuntimeStatus,
  diagnostic: AgentRuntimeDiagnostic,
): string {
  switch (diagnostic.code) {
    case "not-installed":
      return t("codingAgents.diagnostic.notInstalled", { name: agent.name });
    case "invalid-executable":
      return t("codingAgents.diagnostic.invalidExecutable");
    case "runtime-incompatible":
      return t(
        diagnostic.capability
          ? "codingAgents.diagnostic.capabilityMissing"
          : "codingAgents.diagnostic.runtimeIncompatible",
        {
          name: agent.name,
          capability: diagnostic.capability,
        },
      );
    case "signed-out":
      return t("codingAgents.diagnostic.signedOut", { name: agent.name });
    case "models-unavailable":
      return t("codingAgents.diagnostic.modelsUnavailable", {
        name: agent.name,
      });
    default:
      return t("codingAgents.diagnostic.probeFailed", { name: agent.name });
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
