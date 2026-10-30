import { useEffect, useState } from "react";
import { LoaderCircle } from "./icons.js";
import {
  externalClientAddArguments,
  type ExternalAgentClientId,
  type ExternalAgentSettings,
  type ExternalMcpClientActivity,
  type ExternalMcpLauncher,
} from "../shared/external-mcp.js";
import { getExternalAgentSettings, updateExternalAgentSettings } from "./api.js";
import { language, t } from "./i18n.js";
import { Alert, Badge, CodeBlock, Switch } from "./ui/index.js";
import { SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";

/**
 * Settings → MCP Server: lets coding agents outside OhMyGame use its tools
 * through the `ohmygame-studio` MCP server. The switch publishes the server;
 * people add it to each client with the commands shown, as in the lab.
 */
export function ExternalAgentsSettings() {
  const [settings, setSettings] = useState<ExternalAgentSettings>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void getExternalAgentSettings()
      .then((loaded) => active && setSettings(loaded))
      .catch((cause) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, []);
  async function setEnabled(enabled: boolean): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      setSettings(await updateExternalAgentSettings({ enabled }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
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
          <SettingsRow title={t("externalAgents.title")} description={t("externalAgents.description")}>
            <Switch
              label={t("externalAgents.title")}
              checked={settings.enabled}
              disabled={saving}
              onChange={(enabled) => void setEnabled(enabled)}
            />
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      {settings && !settings.enabled ? (
        <Alert title={t("externalAgents.off")}>{t("externalAgents.offHint")}</Alert>
      ) : null}
      {settings?.enabled && !settings.launcher ? (
        <SettingsNote>{t("externalAgents.desktopOnly")}</SettingsNote>
      ) : null}
      {settings?.enabled && settings.launcher ? <Connect launcher={settings.launcher} skillDirectory={settings.skillDirectory} /> : null}
      {settings?.enabled && settings.recent?.length ? <RecentClients clients={settings.recent} /> : null}
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </>
  );
}

/** Each client's `mcp add` command, the launcher for every other client, and the Skill to copy. */
function Connect({ launcher, skillDirectory }: { launcher: ExternalMcpLauncher; skillDirectory?: string }) {
  const command = (id: ExternalAgentClientId, cli: string) => [cli, ...externalClientAddArguments(id, launcher)].map(quote).join(" ");
  // Set apart from the command: `NAME=value command` only works in a POSIX shell, and Windows needs one.
  const environment = Object.entries(launcher.env).map(([name, value]) => `${name}=${value}`);
  return (
    <SettingsGroup title={t("externalAgents.manual")}>
      <div className="settings-pad settings-form">
        <CodeBlock title="Claude Code" code={command("claude-code", "claude")} />
        <CodeBlock title="Codex" code={command("codex", "codex")} />
        <CodeBlock title={t("externalAgents.otherClients")} code={[launcher.command, ...launcher.args].map(quote).join(" ")} />
        {environment.length ? <CodeBlock title={t("externalAgents.otherClientsEnvironment")} code={environment.join("\n")} /> : null}
        {skillDirectory ? <CodeBlock title={t("externalAgents.skill")} code={skillDirectory} /> : null}
      </div>
    </SettingsGroup>
  );
}

/** Clients that used the server since OhMyGame started. */
function RecentClients({ clients }: { clients: ExternalMcpClientActivity[] }) {
  return (
    <SettingsGroup title={t("externalAgents.recent")}>
      {clients.map((client) => (
        <SettingsRow key={client.name} title={clientLabel(client.name)} description={t("externalAgents.recentDetail", { time: usedAgo(client.lastUsedAt), count: client.calls })}>
          <Badge tone={client.active ? "success" : "outline"}>{t(client.active ? "externalAgents.online" : "externalAgents.offline")}</Badge>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

/** Known clients by their product name; others as they call themselves. */
function clientLabel(name: string): string {
  const id = name.toLowerCase();
  if (id.includes("claude")) return "Claude Code";
  if (id.includes("codex")) return "Codex";
  return name;
}

function usedAgo(value: string, now = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "second");
}

function quote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
