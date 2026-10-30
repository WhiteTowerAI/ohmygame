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
    <section className="settings-panel settings-overview-panel external-agents-settings">
      <header className="settings-panel-header">
        <h3>{t("externalAgents.title")}</h3>
      </header>
      <div className="settings-provider-list">
        {!settings && !error ? (
          <div className="settings-loading">
            <LoaderCircle className="spin" size={18} />
            {t("externalAgents.loading")}
          </div>
        ) : null}
        {settings ? (
          <section className="settings-provider-group">
            <div className="settings-provider-row is-featured">
              <span className="settings-provider-mark-slot" aria-hidden="true">
                <Terminal size={20} />
              </span>
              <span className="settings-provider-copy">
                <strong className="settings-provider-name">
                  <span>{t("externalAgents.enable")}</span>
                </strong>
                <span className="settings-provider-details">
                  <span className="settings-provider-description">
                    {t("externalAgents.description")}
                  </span>
                </span>
              </span>
              <label
                className="settings-toggle settings-provider-toggle"
                title={
                  settings.enabled ? t("common.enabled") : t("common.disabled")
                }
              >
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={t("externalAgents.enable")}
                  checked={settings.enabled}
                  disabled={pending !== undefined}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void change("enabled", () =>
                      updateExternalAgentSettings({ enabled }),
                    );
                  }}
                />
                <span aria-hidden="true" />
              </label>
            </div>
          </section>
        ) : null}
        {settings?.enabled && !settings.launcher ? (
          <p className="settings-provider-description">
            {t("externalAgents.desktopOnly")}
          </p>
        ) : null}
        {settings?.enabled && settings.launcher ? (
          <section
            className="settings-provider-group external-agents-clients"
            aria-label={t("externalAgents.clients")}
          >
            <h4>{t("externalAgents.clients")}</h4>
            {settings.clients.map((client) => {
              const { name, runtime } = CLIENTS[client.id];
              const busy = pending === client.id;
              const actionLabel = t(
                client.connected ? "externalAgents.disconnect" : "externalAgents.connect",
              );
              return (
                <div className="settings-provider-row" key={client.id}>
                  <AgentMark id={runtime} />
                  <span className="settings-provider-copy">
                    <strong className="settings-provider-name">
                      <span>{name}</span>
                    </strong>
                    <span className="settings-provider-details">
                      <span className="settings-provider-description">
                        {!client.available
                          ? t("codingAgents.notFound")
                          : client.connected
                            ? t("externalAgents.connected")
                            : t("externalAgents.notConnected")}
                      </span>
                    </span>
                  </span>
                  {client.available ? (
                    <button
                      type="button"
                      className={`external-agent-action${client.connected ? " is-danger" : ""}`}
                      aria-label={actionLabel}
                      title={actionLabel}
                      aria-busy={busy}
                      disabled={pending !== undefined}
                      onClick={() =>
                        void change(client.id, () =>
                          client.connected
                            ? disconnectExternalAgent(client.id)
                            : connectExternalAgent(client.id),
                        )
                      }
                    >
                      {busy ? (
                        <LoaderCircle
                          className="spin"
                          size={14}
                          aria-hidden="true"
                        />
                      ) : client.connected ? (
                        <CircleX size={16} aria-hidden="true" />
                      ) : (
                        <Plug size={16} aria-hidden="true" />
                      )}
                    </button>
                  ) : null}
                </div>
              );
            })}
            <ManualSetup launcher={settings.launcher} />
          </section>
        ) : null}
        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** For DeepSeek Harness and other clients OhMyGame cannot configure itself. */
function ManualSetup({ launcher }: { launcher: ExternalMcpLauncher }) {
  const environment = Object.entries(launcher.env).map(
    ([name, value]) => `${name}=${value}`,
  );
  return (
    <details className="external-agents-manual">
      <summary>{t("externalAgents.otherClients")}</summary>
      <p className="settings-provider-description">
        {t("externalAgents.otherClientsHint", {
          name: EXTERNAL_MCP_SERVER_NAME,
        })}
      </p>
      <CommandText
        command={[launcher.command, ...launcher.args].map(quote).join(" ")}
      />
      {environment.length ? (
        <p className="settings-provider-description">
          {t("externalAgents.environment", { value: environment.join(" ") })}
        </p>
      ) : null}
    </details>
  );
}

function quote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
