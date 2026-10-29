import { useEffect, useState } from "react";
import { CircleX, LoaderCircle, Plug, Terminal } from "./icons.js";
import type { AgentRuntimeId } from "../shared/agent-runtimes.js";
import {
  EXTERNAL_MCP_SERVER_NAME,
  type ExternalAgentClientId,
  type ExternalAgentSettings,
  type ExternalMcpLauncher,
} from "../shared/external-mcp.js";
import {
  connectExternalAgent,
  disconnectExternalAgent,
  getExternalAgentSettings,
  updateExternalAgentSettings,
} from "./api.js";
import { AgentMark, CommandText } from "./coding-agents-settings.js";
import { t } from "./i18n.js";
import { Button, Switch } from "./ui/index.js";
import { SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";

const CLIENTS: Record<
  ExternalAgentClientId,
  { name: string; runtime: AgentRuntimeId }
> = {
  "claude-code": { name: "Claude Code", runtime: "claude-code-cli" },
  codex: { name: "Codex", runtime: "codex-cli" },
};

/**
 * Settings → MCP Server: lets coding agents outside OhMyGame use its tools
 * through the `ohmygame-studio` MCP server. The switch publishes the server,
 * and each detected CLI is connected with its own `mcp add` command.
 */
export function ExternalAgentsSettings() {
  const [settings, setSettings] = useState<ExternalAgentSettings>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();
  useEffect(() => {
    let active = true;
    void getExternalAgentSettings()
      .then((loaded) => active && setSettings(loaded))
      .catch((cause) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, []);
  async function change(
    key: string,
    work: () => Promise<ExternalAgentSettings>,
  ): Promise<void> {
    setPending(key);
    setError(undefined);
    try {
      setSettings(await work());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(undefined);
    }
  }
  return (
    <>
      {!settings && !error ? (
        <div className="settings-loading-row">
          <LoaderCircle className="spin" size={16} />
          {t("externalAgents.loading")}
        </div>
      ) : null}
      {settings ? (
        <SettingsGroup>
          <SettingsRow
            icon={<span className="settings-mark" aria-hidden="true"><Terminal size={18} /></span>}
            title={t("externalAgents.enable")}
            description={t("externalAgents.description")}
          >
            <Switch
              label={t("externalAgents.enable")}
              checked={settings.enabled}
              disabled={pending !== undefined}
              onChange={(enabled) =>
                void change("enabled", () => updateExternalAgentSettings({ enabled }))
              }
            />
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      {settings?.enabled && !settings.launcher ? (
        <SettingsNote>{t("externalAgents.desktopOnly")}</SettingsNote>
      ) : null}
      {settings?.enabled && settings.launcher ? (
        <SettingsGroup className="external-agents-clients" title={t("externalAgents.clients")}>
          {settings.clients.map((client) => {
            const { name, runtime } = CLIENTS[client.id];
            const busy = pending === client.id;
            return (
              <SettingsRow
                key={client.id}
                icon={<AgentMark id={runtime} />}
                title={name}
                description={
                  !client.available
                    ? t("codingAgents.notFound")
                    : client.connected
                      ? t("externalAgents.connected")
                      : t("externalAgents.notConnected")
                }
              >
                {client.available ? (
                  <Button
                    size="sm"
                    variant={client.connected ? "ghost" : "secondary"}
                    className={`external-agent-action${client.connected ? " is-danger" : ""}`}
                    aria-label={t(client.connected ? "settings.mcp.disconnectName" : "settings.mcp.connectName", { name })}
                    aria-busy={busy}
                    disabled={pending !== undefined}
                    icon={busy ? <LoaderCircle className="spin" size={14} /> : client.connected ? <CircleX size={14} /> : <Plug size={14} />}
                    onClick={() =>
                      void change(client.id, () =>
                        client.connected
                          ? disconnectExternalAgent(client.id)
                          : connectExternalAgent(client.id),
                      )
                    }
                  >
                    {t(client.connected ? "externalAgents.disconnect" : "externalAgents.connect")}
                  </Button>
                ) : null}
              </SettingsRow>
            );
          })}
          <ManualSetup launcher={settings.launcher} />
        </SettingsGroup>
      ) : null}
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </>
  );
}

/** For DeepSeek Harness and other clients OhMyGame cannot configure itself. */
function ManualSetup({ launcher }: { launcher: ExternalMcpLauncher }) {
  const environment = Object.entries(launcher.env).map(
    ([name, value]) => `${name}=${value}`,
  );
  return (
    <details className="settings-pad settings-details external-agents-manual">
      <summary>{t("externalAgents.otherClients")}</summary>
      <div className="settings-form">
        <p className="settings-muted">
          {t("externalAgents.otherClientsHint", { name: EXTERNAL_MCP_SERVER_NAME })}
        </p>
        <CommandText command={[launcher.command, ...launcher.args].map(quote).join(" ")} />
        {environment.length ? (
          <p className="settings-muted">
            {t("externalAgents.environment", { value: environment.join(" ") })}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function quote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
