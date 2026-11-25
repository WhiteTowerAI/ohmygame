import { useState } from "react";
import type { PluginMcpResult, StorePlugin } from "../shared/plugins.js";
import { testPluginMcpServer } from "./api.js";
import { language, t } from "./i18n.js";
import { ExternalLink } from "./icons.js";
import { Button } from "./ui/index.js";

/**
 * A plugin's MCP servers in its Settings: how to get each running, and a test
 * that connects with the saved settings and lists its tools, as the agent's
 * session would. A server that can't start says why.
 */
export function PluginMcpServers({ plugin, enabled }: { plugin: StorePlugin; enabled: boolean }) {
  if (!plugin.mcpServers?.length) return null;
  return (
    <section className="plugin-connection plugin-mcp-servers" aria-label={t("pluginControls.mcpServices")}>
      <h2>{t("pluginControls.mcpServices")}</h2>
      {!enabled ? <p>{t("pluginControls.enableStatus")}</p> : null}
      {/* A new address or package starts without the last result. */}
      {plugin.mcpServers.map((server) => <McpServer key={`${server.id}:${server.url ?? ""}:${plugin.revision}`} plugin={plugin} server={server} enabled={enabled} />)}
    </section>
  );
}

function McpServer({ plugin, server, enabled }: { plugin: StorePlugin; server: NonNullable<StorePlugin["mcpServers"]>[number]; enabled: boolean }) {
  const [result, setResult] = useState<PluginMcpResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await testPluginMcpServer(plugin.id, server.id));
    } catch (cause) {
      setResult(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="plugin-mcp-server">
      <div className="plugin-mcp-server-heading">
        <strong>{server.title}</strong>
        {server.url ? <code>{server.url}</code> : null}
      </div>
      {server.setup ? <p className="plugins-note">{server.setup}</p> : null}
      <div className="plugin-connection-actions">
        <Button size="sm" disabled={busy || !enabled} onClick={() => void test()}>
          {busy ? t("pluginControls.testing") : t("pluginControls.testConnection")}
        </Button>
        {server.docs ? <a href={server.docs} target="_blank" rel="noreferrer">{t("pluginControls.mcpDocs")}<ExternalLink size="xs" /></a> : null}
      </div>
      {result ? (
        <div className="plugin-mcp-result" role="status">
          <strong>{result.status === "connected" ? t("pluginControls.connectedTools", { count: result.toolCount }) : result.status === "needs-auth" ? t("pluginControls.authorizationRequired") : t("providers.status.failed")}</strong>
          {result.missingSettings?.length ? <p>{t("pluginControls.fillInSettings", { fields: result.missingSettings.join(language === "zh-CN" ? "、" : ", ") })}</p>
            : result.message ? <pre>{result.message}</pre> : null}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
