import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  LoaderCircle,
  RefreshCw,
  Terminal,
} from "./icons.js";
import { isAccountRuntimeId } from "../shared/agent-runtimes.js";
import type {
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
import { Badge, Button, Field, IconButton, Input, RadioGroup, Switch } from "./ui/index.js";
import { SettingsDetailHead, SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";
import { AgentUsageDetails, AgentUsageInline } from "./agent-usage.js";
import { t } from "./i18n.js";
import { AgentAccountProfiles } from "./agent-account-profiles.js";

/**
 * The coding agent CLIs in Agents: those found on this computer, each with
 * its sign-in and a switch that offers its models in the model picker.
 */
export function CodingAgentsGroup({
  models,
  defaultAgent,
  onOpen,
  actions,
}: {
  /** Model probes can also report fresh account limits; reload status when they finish. */
  models?: readonly AgentModel[];
  /** The agent whose model new conversations start with, if it is a CLI. */
  defaultAgent?: AgentRuntimeId;
  onOpen: (id: AgentRuntimeId) => void;
  actions?: ReactNode;
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
    <SettingsGroup
      className="coding-agents-group"
      title={t("codingAgents.title")}
      description={t("settings.agents.codingHint")}
      actions={actions}
    >
      {!agents && !error ? (
        <div className="settings-loading-row">
          <LoaderCircle className="spin" size={16} />
          {t("codingAgents.checking")}
        </div>
      ) : null}
      {(agents ?? []).map((agent) => {
        const action = agent.installed
          ? t("codingAgents.manage", { name: agent.name })
          : t("codingAgents.setUp", { name: agent.name });
        return (
          <SettingsRow
            key={agent.id}
            className="settings-agent-row"
            icon={<AgentMark id={agent.id} />}
            title={
              <>
                {agent.name}
                {agent.id === defaultAgent ? (
                  <Badge tone="outline">{t("agents.default")}</Badge>
                ) : null}
              </>
            }
            description={agentSummary(agent)}
            onClick={() => onOpen(agent.id)}
          >
            {agent.installed && agent.enabled && agent.limits?.length ? (
              <AgentUsageInline limits={agent.limits} compact />
            ) : null}
            {agent.installed ? (
              <Switch
                label={t("codingAgents.enable", { name: agent.name })}
                checked={agent.enabled}
                disabled={pending.has(agent.id)}
                onChange={(enabled) => void toggle(agent, enabled)}
              />
            ) : (
              <Button size="sm" onClick={() => onOpen(agent.id)}>
                {t("settings.agents.setUp")}
              </Button>
            )}
            <IconButton size="sm" label={action} onClick={() => onOpen(agent.id)}>
              <ChevronRight size={16} />
            </IconButton>
          </SettingsRow>
        );
      })}
      {error ? (
        <div className="settings-pad">
          <SettingsNote tone="danger">{error}</SettingsNote>
        </div>
      ) : null}
    </SettingsGroup>
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
  const back = t("settings.agents.back");
  if (!agent) {
    return (
      <>
        <SettingsDetailHead mark={<AgentMark id={id} />} title={t("settings.nav.agents")} onBack={onBack} backLabel={back} />
        {error ? (
          <SettingsNote tone="danger">{error}</SettingsNote>
        ) : (
          <div className="settings-loading-row">
            <LoaderCircle className="spin" size={16} />
            {t("codingAgents.checking")}
          </div>
        )}
      </>
    );
  }
  const problems = agent.diagnostics;
  return (
    <div className="settings-form coding-agent-detail">
      <SettingsDetailHead
        mark={<AgentMark id={agent.id} />}
        title={agent.name}
        description={agentSummary(agent)}
        onBack={onBack}
        backLabel={back}
      >
        {agent.installed ? (
          <Switch
            label={t("codingAgents.enable", { name: agent.name })}
            checked={agent.enabled}
            disabled={busy !== undefined}
            onChange={(enabled) => void update({ enabled })}
          />
        ) : null}
      </SettingsDetailHead>
      <SettingsGroup title={t("codingAgents.status")}>
        <SettingsRow
          title={t("settings.agents.version")}
          description={agent.version ? `v${agent.version}` : t("codingAgents.versionUnknown")}
        >
          <IconButton
            size="sm"
            label={t("codingAgents.recheck")}
            disabled={busy !== undefined}
            onClick={() => void recheck()}
          >
            <RefreshCw size={15} className={busy === "recheck" ? "spin" : undefined} />
          </IconButton>
        </SettingsRow>
        {agent.installed && agent.id === "opencode-cli" ? (
          <SettingsRow title={t("codingAgents.account")} description={t("codingAgents.openCodeAccounts")} />
        ) : null}
        {problems.length ? (
          <div className="settings-pad settings-form" aria-label={t("codingAgents.diagnostics")} role="group">
            {problems.map((diagnostic) => (
              <Diagnostic key={diagnostic.code} agent={agent} diagnostic={diagnostic} />
            ))}
          </div>
        ) : null}
      </SettingsGroup>
      {isAccountRuntimeId(agent.id) ? <AgentAccountProfiles key={agent.id} runtime={agent.id} defaultProfileId={agent.defaultProfileId ?? "system"} onDefault={(defaultProfileId) => update({ defaultProfileId })} onLogin={signIn} onRemoved={async () => {
        setAgent((await listAgentRuntimes()).find((item) => item.id === id));
        notifyAgentModelsChanged();
      }} disabled={busy !== undefined} /> : null}
      {login ? <LoginHint login={login} /> : null}
      {agent.installed && agent.id !== "opencode-cli" ? (
        // OpenCode bills each model provider; its account has no quota of its own.
        <SettingsGroup title={t("agentUsage.title")}>
          <div className="settings-pad">
            {agent.limits?.length ? (
              <AgentUsageDetails limits={agent.limits} />
            ) : (
              <p className="settings-muted">{t("agentUsage.empty", { name: agent.name })}</p>
            )}
          </div>
        </SettingsGroup>
      ) : null}
      <SettingsGroup title={t("codingAgents.configuration")} description={agent.installed ? t("codingAgents.cliConfigHint", { name: agent.name }) : undefined}>
        {agent.installed ? (
          <div className="settings-pad settings-form">
            <RadioGroup
              label={t("codingAgents.permissions")}
              value={agent.permissionMode}
              onChange={(permissionMode) => void update({ permissionMode })}
              options={[
                { value: "standard", label: t("codingAgents.permissionStandard"), description: t("settings.agents.permissionStandardHint") },
                { value: "full", label: t("codingAgents.permissionFull"), description: t("codingAgents.permissionFullHint", { name: agent.name }) },
              ]}
            />
            {agent.permissionMode === "full" ? (
              <SettingsNote role="status">{t("settings.agents.permissionFullNote", { name: agent.name })}</SettingsNote>
            ) : null}
          </div>
        ) : null}
        <form className="settings-pad" onSubmit={savePath}>
          <Field
            label={t("codingAgents.executable")}
            hint={
              <>
                {t("codingAgents.executableHint")}
                {agent.binaryPath ? (
                  <span className="coding-agent-executable-path">
                    {" "}
                    {agent.binarySource
                      ? `${t(`codingAgents.binarySource.${agent.binarySource}`)}: `
                      : ""}
                    <code>{agent.binaryPath}</code>
                  </span>
                ) : null}
              </>
            }
          >
            {(props) => (
              <div className="settings-inline">
                <Input
                  {...props}
                  value={binaryPath}
                  placeholder={t("codingAgents.executablePlaceholder")}
                  spellCheck={false}
                  onChange={(event) => setBinaryPath(event.target.value)}
                />
                <Button
                  type="submit"
                  disabled={busy !== undefined || binaryPath.trim() === (agent.configuredBinaryPath ?? "")}
                >
                  {t("common.save")}
                </Button>
              </div>
            )}
          </Field>
        </form>
      </SettingsGroup>
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </div>
  );
}

function LoginHint({ login }: { login: { url?: string; command?: string } }) {
  if (login.url) {
    return (
      <SettingsNote role="status">
        {t("codingAgents.loginOpened")}{" "}
        <button
          type="button"
          className="coding-agent-link"
          onClick={() => void openModelAuthExternal(login.url!)}
        >
          {t("codingAgents.openAgain")}
        </button>
      </SettingsNote>
    );
  }
  return login.command ? (
    <SettingsNote role="status">
      <p>{t("codingAgents.loginCommand")}</p>
      <CommandText command={login.command} />
    </SettingsNote>
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
  const blocking =
    diagnostic.code === "not-installed" ||
    diagnostic.code === "runtime-incompatible";
  return (
    <div
      className={`settings-note coding-agent-diagnostic${blocking ? " is-danger" : ""} is-${diagnostic.code}`}
      role={blocking ? "alert" : "status"}
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
        {agent.id === "codex-cli" &&
        diagnostic.capability ===
          "Windows sandbox filesystem read restrictions" ? (
          <>
            {" "}
            <button
              type="button"
              className="coding-agent-link"
              onClick={() =>
                void openModelAuthExternal(
                  "https://learn.chatgpt.com/docs/windows/windows-sandbox",
                )
              }
            >
              {t("codingAgents.sandboxGuide")}
            </button>
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
    <span className="settings-command coding-agent-command">
      <code>{command}</code>
      <IconButton
        size="sm"
        label={copied ? t("codingAgents.copied") : t("codingAgents.copyCommand")}
        onClick={() =>
          void navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </IconButton>
    </span>
  );
}

export function AgentMark({ id }: { id: AgentRuntimeId }) {
  const icon = PROVIDER_ICONS[id];
  return (
    <span className={`settings-mark${icon ? ` is-${icon.tone}` : ""}`} aria-hidden="true">
      {icon ? <img src={icon.src} alt="" /> : <Terminal size={18} />}
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
      if (
        agent.id === "codex-cli" &&
        diagnostic.capability === "Windows sandbox filesystem read restrictions"
      )
        return t("codingAgents.diagnostic.codexWindowsSandbox");
      if (
        agent.id === "opencode-cli" &&
        diagnostic.capability ===
          "no saved OpenCode permissions for this project"
      )
        return t("codingAgents.diagnostic.openCodeSavedPermissions");
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
