import { Box, Image as ImageIcon, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ToolDefinition } from "../shared/contracts.js";
import { getToolSettings, listTools, updateToolSettings, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import type { SidebarPage } from "./routes.js";

export function PluginsPage({ onNavigate }: { onNavigate: (page: SidebarPage) => void }) {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [installedTools, setInstalledTools] = useState<ToolDefinition["id"][]>([]);
  const [enabledTools, setEnabledTools] = useState<ToolDefinition["id"][]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [updatingTool, setUpdatingTool] = useState<ToolDefinition["id"]>();
  const [error, setError] = useState<string>();

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      const [available, settings] = await Promise.all([listTools(), getToolSettings()]);
      setTools(available);
      setInstalledTools(settings.installedTools);
      setEnabledTools(settings.enabledTools);
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  async function setEnabled(tool: ToolDefinition, enabled: boolean): Promise<void> {
    if (updatingTool) return;
    setUpdatingTool(tool.id);
    setError(undefined);
    try {
      const settings = await updateToolSettings({
        installedTools,
        enabledTools: enabled
          ? [...enabledTools, tool.id]
          : enabledTools.filter((id) => id !== tool.id),
      });
      setInstalledTools(settings.installedTools);
      setEnabledTools(settings.enabledTools);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdatingTool(undefined);
    }
  }

  const installed = tools.filter((tool) => installedTools.includes(tool.id));

  return (
    <main className="home-shell">
      <AppSidebar active="plugins" onNavigate={onNavigate} />
      <section className="plugins-content">
        <div className="plugins-main">
          <header className="plugins-heading">
            <h1>Plugins</h1>
            <p>Choose which installed tools your agent can use.</p>
          </header>

          {phase === "loading" ? <div className="plugins-state"><LoaderCircle className="spin" size={16} />Loading plugins</div> : null}
          {phase === "error" ? (
            <div className="plugins-state plugins-state-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button>
            </div>
          ) : null}
          {phase === "ready" ? (
            <section className="plugins-installed" aria-labelledby="plugins-installed-title">
              <header>
                <h2 id="plugins-installed-title">Installed plugins</h2>
                <span>{installed.length} {installed.length === 1 ? "plugin" : "plugins"}</span>
              </header>
              {error ? <p className="plugins-inline-error" role="alert">{error}</p> : null}
              {installed.length ? (
                <div className="plugins-list">
                  {installed.map((tool) => {
                    const enabled = enabledTools.includes(tool.id);
                    return (
                      <div className="plugin-row" key={tool.id}>
                        <PluginIcon tool={tool} />
                        <span className="plugin-row-copy">
                          <strong>{pluginName(tool)}</strong>
                          <span>{pluginDescription(tool)}</span>
                        </span>
                        <button
                          className="plugin-switch"
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          aria-label={`${enabled ? "Disable" : "Enable"} ${pluginName(tool)}`}
                          disabled={Boolean(updatingTool)}
                          onClick={() => void setEnabled(tool, !enabled)}
                        >
                          <span />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="plugins-empty">Install a tool from Images or 3D to add it to your agent.</p>
              )}
            </section>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function PluginIcon({ tool }: { tool: ToolDefinition }): ReactNode {
  return (
    <span className={`plugin-row-icon plugin-row-icon-${tool.category}`} aria-hidden="true">
      {tool.outputKind === "model" ? <Box size={17} /> : <ImageIcon size={17} />}
    </span>
  );
}

function pluginName(tool: ToolDefinition): string {
  return tool.id === "generate-image" ? "Image Generation" : "3D Generation";
}

function pluginDescription(tool: ToolDefinition): string {
  return tool.id === "generate-image"
    ? "Create and edit images for your game."
    : "Turn reference images into 3D assets.";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong";
}
