import { ArrowLeft, Box, Check, ExternalLink, Image as ImageIcon, LoaderCircle, Package, RefreshCw, Search, SlidersHorizontal, Trash2, Video } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { PiPackageSummary, ToolDefinition } from "../shared/contracts.js";
import { getToolSettings, installPiPackage, listInstalledPiPackages, listPiPackages, listTools, removePiPackage, updateToolSettings, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import type { SidebarPage } from "./routes.js";

export function PluginsPage({ onNavigate }: { onNavigate: (page: SidebarPage) => void }) {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [installedTools, setInstalledTools] = useState<ToolDefinition["id"][]>([]);
  const [enabledTools, setEnabledTools] = useState<ToolDefinition["id"][]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [updatingTool, setUpdatingTool] = useState<ToolDefinition["id"]>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<"plugins" | "manage">("plugins");
  const [packages, setPackages] = useState<PiPackageSummary[]>([]);
  const [installedPackages, setInstalledPackages] = useState<PiPackageSummary[]>([]);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [packagePhase, setPackagePhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [packageError, setPackageError] = useState<string>();
  const [updatingPackage, setUpdatingPackage] = useState<string>();
  const [packagePage, setPackagePage] = useState(1);
  const [hasMorePackages, setHasMorePackages] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<string>();
  const [packageNotice, setPackageNotice] = useState<string>();
  const packageRequestRef = useRef(0);

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      const [available, settings] = await Promise.all([listTools(), getToolSettings()]);
      setTools(available);
      setInstalledTools(settings.installedTools);
      setEnabledTools(settings.enabledTools);
      setInstalledPackages(await listInstalledPiPackages());
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    setPackages([]);
    setPackagePage(1);
    void loadPackages(1, false);
  }, [searchQuery]);

  async function loadPackages(page = packagePage, append = false): Promise<void> {
    const requestId = ++packageRequestRef.current;
    setPackagePhase("loading");
    setPackageError(undefined);
    try {
      const result = await listPiPackages(searchQuery, page);
      if (requestId !== packageRequestRef.current) return;
      setPackages((current) => append ? [...current, ...result.packages] : result.packages);
      setPackagePage(page);
      setHasMorePackages(result.hasMore);
      setPackagePhase("ready");
    } catch (cause) {
      if (requestId !== packageRequestRef.current) return;
      setPackageError(errorMessage(cause));
      setPackagePhase("error");
    }
  }

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

  async function installTool(tool: ToolDefinition): Promise<void> {
    if (updatingTool || installedTools.includes(tool.id)) return;
    setUpdatingTool(tool.id);
    setError(undefined);
    try {
      const settings = await updateToolSettings({
        installedTools: [...installedTools, tool.id],
        enabledTools: [...enabledTools, tool.id],
      });
      setInstalledTools(settings.installedTools);
      setEnabledTools(settings.enabledTools);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdatingTool(undefined);
    }
  }

  async function installPackage(name: string): Promise<void> {
    if (localStorage.getItem("open-game-pi-package-warning-accepted") !== "1") {
      setPendingInstall(name);
      return;
    }
    await performPackageInstall(name);
  }

  async function performPackageInstall(name: string): Promise<void> {
    if (updatingPackage) return;
    setUpdatingPackage(name);
    setPackageError(undefined);
    setPackageNotice(undefined);
    try {
      await installPiPackage(name);
      setInstalledPackages(await listInstalledPiPackages());
      setPackages((items) => items.map((item) => item.name === name ? { ...item, installed: true } : item));
      setPackageNotice("Installed. New conversations will use this package.");
    } catch (cause) {
      setPackageError(errorMessage(cause));
    } finally {
      setUpdatingPackage(undefined);
    }
  }

  async function uninstallPackage(item: PiPackageSummary): Promise<void> {
    if (updatingPackage) return;
    setUpdatingPackage(item.installSpec);
    setPackageError(undefined);
    setPackageNotice(undefined);
    try {
      await removePiPackage(item.installSpec);
      setInstalledPackages((items) => items.filter((candidate) => candidate.installSpec !== item.installSpec));
      setPackages((items) => items.map((candidate) => candidate.name === item.name ? { ...candidate, installed: false } : candidate));
      setPackageNotice("Removed. Existing conversations keep their currently loaded resources.");
    } catch (cause) {
      setPackageError(errorMessage(cause));
    } finally {
      setUpdatingPackage(undefined);
    }
  }

  function confirmPackageInstall(): void {
    if (!pendingInstall) return;
    localStorage.setItem("open-game-pi-package-warning-accepted", "1");
    const name = pendingInstall;
    setPendingInstall(undefined);
    void performPackageInstall(name);
  }

  const installed = tools.filter((tool) => installedTools.includes(tool.id));
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleInstalledTools = installed.filter((tool) => pluginSearchText(tool).includes(normalizedQuery));
  const visibleInstalledPackages = installedPackages.filter((item) => packageSearchText(item).includes(normalizedQuery));
  const visibleAvailableTools = tools.filter((tool) => !installedTools.includes(tool.id) && pluginSearchText(tool).includes(normalizedQuery));
  const installedCount = installed.length + installedPackages.length;

  return (
    <main className="home-shell">
      <AppSidebar active="plugins" onNavigate={onNavigate} />
      <section className="plugins-content">
        <div className="plugins-main">
          {view === "manage" ? (
            <ManagePlugins
              tools={installed}
              packages={installedPackages}
              enabledTools={enabledTools}
              updatingTool={updatingTool}
              updatingPackage={updatingPackage}
              error={error}
              notice={packageNotice}
              onBack={() => setView("plugins")}
              onSetEnabled={setEnabled}
              onRemovePackage={uninstallPackage}
            />
          ) : (
            <>
              <header className="plugins-heading">
                <h1>Plugins</h1>
                <p>Install plugins and choose what your agent can use.</p>
              </header>
              <form className="plugins-search" onSubmit={(event: FormEvent) => { event.preventDefault(); setSearchQuery(query.trim()); }}>
                <Search size={15} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins..." aria-label="Search plugins" />
              </form>

              {phase === "loading" ? <div className="plugins-state"><LoaderCircle className="spin" size={16} />Loading plugins</div> : null}
              {phase === "error" ? (
                <div className="plugins-state plugins-state-error" role="alert">
                  <span>{error}</span>
                  <button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button>
                </div>
              ) : null}
              {phase === "ready" ? (
                <>
                  <section className="plugins-installed" aria-labelledby="plugins-installed-title">
                    <header>
                      <h2 id="plugins-installed-title">Installed</h2>
                      {installedCount ? <button type="button" onClick={() => setView("manage")}><SlidersHorizontal size={13} />Manage</button> : null}
                    </header>
                    {error ? <p className="plugins-inline-error" role="alert">{error}</p> : null}
                    {visibleInstalledTools.length || visibleInstalledPackages.length ? (
                      <div className="plugins-installed-scroll">
                        {visibleInstalledTools.map((tool) => <InstalledPluginCard key={tool.id} tool={tool} />)}
                        {visibleInstalledPackages.map((item) => <InstalledPackageCard key={item.installSpec} item={item} />)}
                      </div>
                    ) : <p className="plugins-empty">{installedCount ? "No installed plugins match your search." : "No plugins installed yet."}</p>}
                  </section>

                  <section className="plugins-explore" aria-labelledby="plugins-explore-title">
                    <header className="plugins-section-heading">
                      <h2 id="plugins-explore-title">Explore</h2>
                      <span>Discover more capabilities for your agent.</span>
                    </header>
                    {packagePhase === "loading" && packages.length === 0 ? <div className="plugins-state plugins-state-compact"><LoaderCircle className="spin" size={16} />Loading packages</div> : null}
                    {packagePhase === "error" ? <div className="plugins-state plugins-state-error plugins-state-compact" role="alert"><span>{packageError}</span><button type="button" onClick={() => void loadPackages(packagePage, packagePage > 1)}><RefreshCw size={14} />Retry</button></div> : null}
                    {visibleAvailableTools.length || packages.length ? <div className="plugins-explore-grid">
                      {visibleAvailableTools.map((tool) => <OpenGameToolRow key={tool.id} tool={tool} updating={updatingTool === tool.id} onInstall={() => void installTool(tool)} />)}
                      {packages.map((item) => <PiPackageRow key={item.name} item={item} updating={updatingPackage === item.name} onInstall={() => void installPackage(item.name)} />)}
                    </div> : null}
                    {hasMorePackages ? <button className="plugins-load-more" type="button" onClick={() => void loadPackages(packagePage + 1, true)} disabled={packagePhase === "loading"}>{packagePhase === "loading" ? <LoaderCircle className="spin" size={14} /> : null}{packagePhase === "loading" ? "Loading…" : "Load more"}</button> : null}
                    {packagePhase === "ready" && packages.length === 0 && visibleAvailableTools.length === 0 ? <p className="plugins-empty">No plugins found.</p> : null}
                    {packageError && packagePhase !== "error" ? <p className="plugins-inline-error" role="alert">{packageError}</p> : null}
                    {packageNotice ? <p className="plugins-inline-notice" role="status">{packageNotice}</p> : null}
                  </section>
                </>
              ) : null}
            </>
          )}
        </div>
      </section>
      {pendingInstall ? <PiPackageWarningDialog onCancel={() => setPendingInstall(undefined)} onConfirm={confirmPackageInstall} /> : null}
    </main>
  );
}

interface ManagePluginsProps {
  tools: ToolDefinition[];
  packages: PiPackageSummary[];
  enabledTools: ToolDefinition["id"][];
  updatingTool?: ToolDefinition["id"];
  updatingPackage?: string;
  error?: string;
  notice?: string;
  onBack: () => void;
  onSetEnabled: (tool: ToolDefinition, enabled: boolean) => Promise<void>;
  onRemovePackage: (item: PiPackageSummary) => Promise<void>;
}

function ManagePlugins({ tools, packages, enabledTools, updatingTool, updatingPackage, error, notice, onBack, onSetEnabled, onRemovePackage }: ManagePluginsProps): ReactNode {
  return <section className="plugins-manage" aria-labelledby="plugins-manage-title">
    <button className="plugins-back" type="button" onClick={onBack}><ArrowLeft size={14} />Back to Plugins</button>
    <header className="plugins-heading">
      <h1 id="plugins-manage-title">Manage plugins</h1>
      <p>Choose which installed tools your agent can use.</p>
    </header>
    {error ? <p className="plugins-inline-error" role="alert">{error}</p> : null}
    {notice ? <p className="plugins-inline-notice" role="status">{notice}</p> : null}
    <div className="plugins-manage-list">
      {tools.map((tool) => {
        const enabled = enabledTools.includes(tool.id);
        return <div className="plugin-row" key={tool.id}>
          <PluginIcon tool={tool} />
          <span className="plugin-row-copy"><strong>{pluginName(tool)}</strong><span>OpenGame</span></span>
          <span className="plugin-agent-access">Agent access</span>
          <button className="plugin-switch" type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? "Disable" : "Enable"} ${pluginName(tool)}`} disabled={Boolean(updatingTool)} onClick={() => void onSetEnabled(tool, !enabled)}><span /></button>
        </div>;
      })}
      {packages.map((item) => <PiPackageRow key={item.installSpec} item={item} updating={updatingPackage === item.installSpec} onRemove={() => void onRemovePackage(item)} />)}
    </div>
  </section>;
}

function InstalledPluginCard({ tool }: { tool: ToolDefinition }): ReactNode {
  return <article className="plugin-installed-card">
    <PluginIcon tool={tool} />
    <strong>{pluginName(tool)}</strong>
  </article>;
}

function InstalledPackageCard({ item }: { item: PiPackageSummary }): ReactNode {
  return <article className="plugin-installed-card">
    <span className="plugin-row-icon plugin-row-icon-pi"><Package size={17} /></span>
    <strong>{item.name}</strong>
  </article>;
}

function OpenGameToolRow({ tool, updating, onInstall }: { tool: ToolDefinition; updating: boolean; onInstall: () => void }): ReactNode {
  return <div className="plugin-row">
    <PluginIcon tool={tool} />
    <span className="plugin-row-copy"><strong>{pluginName(tool)}</strong><span>{pluginDescription(tool)}</span><small>OpenGame · Agent tool</small></span>
    <span className="plugin-package-actions"><button type="button" disabled={updating} onClick={onInstall}>{updating ? <LoaderCircle className="spin" size={13} /> : null}{updating ? "Installing…" : "Install"}</button></span>
  </div>;
}

function PiPackageWarningDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }): ReactNode {
  const dialogRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    confirmRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = Array.from(dialogRef.current?.querySelectorAll("button") ?? []);
    const first = buttons[0];
    const last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return <div className="plugins-warning-backdrop" role="presentation">
    <section ref={dialogRef} className="plugins-warning" role="alertdialog" aria-modal="true" aria-labelledby="plugins-warning-title" aria-describedby="plugins-warning-description" onKeyDown={handleKeyDown}>
      <h2 id="plugins-warning-title">Review Pi package access</h2>
      <p id="plugins-warning-description">Pi packages can run code with full access to your computer. Only install packages you trust.</p>
      <div><button type="button" onClick={onCancel}>Cancel</button><button ref={confirmRef} type="button" onClick={onConfirm}>Install package</button></div>
    </section>
  </div>;
}

function PiPackageRow({ item, updating, onInstall, onRemove }: { item: PiPackageSummary; updating: boolean; onInstall?: () => void; onRemove?: () => void }): ReactNode {
  return <div className="plugin-row plugin-row-package">
    <span className="plugin-row-icon plugin-row-icon-pi"><Package size={17} /></span>
    <span className="plugin-row-copy"><strong>{item.name}</strong><span>{item.description || "Pi package"}</span><small>{item.sourceType} · {item.resourceTypes.length ? item.resourceTypes.join(" · ") : "Pi package"} · {item.compatibility === "not-verified" ? "Compatibility not verified" : item.compatibility === "not-applicable" ? "Pi terminal only" : "Works in OpenGame"}</small></span>
    <span className="plugin-package-actions">
      {item.sourceType === "npm" ? <button className="plugin-package-link" type="button" onClick={() => void openExternal(`https://pi.dev/packages/${piPackagePath(item.name)}`)} aria-label={`View ${item.name} on Pi`}><ExternalLink size={14} /></button> : null}
      {item.installed && onRemove ? <button type="button" disabled={updating} onClick={onRemove}>{updating ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}{updating ? "Removing…" : "Remove"}</button> : item.installed ? <button type="button" disabled><Check size={13} />Installed</button> : <button type="button" disabled={updating} onClick={onInstall}>{updating ? <LoaderCircle className="spin" size={13} /> : null}{updating ? "Installing…" : "Install"}</button>}
    </span>
  </div>;
}

function piPackagePath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

async function openExternal(url: string): Promise<void> {
  if (window.openGameDesktop?.openExternal) await window.openGameDesktop.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function PluginIcon({ tool }: { tool: ToolDefinition }): ReactNode {
  return (
    <span className={`plugin-row-icon plugin-row-icon-${tool.category}`} aria-hidden="true">
      {tool.outputKind === "model" ? <Box size={17} /> : tool.outputKind === "video" ? <Video size={17} /> : <ImageIcon size={17} />}
    </span>
  );
}

function pluginName(tool: ToolDefinition): string {
  if (tool.id === "generate-image") return "Image Generation";
  if (tool.id === "image-to-3d") return "3D Generation";
  return "Video Generation";
}

function pluginDescription(tool: ToolDefinition): string {
  if (tool.id === "generate-image") return "Create and edit images for your game.";
  if (tool.id === "image-to-3d") return "Turn reference images into 3D assets.";
  return "Animate reference images into videos.";
}

function pluginSearchText(tool: ToolDefinition): string {
  return `${pluginName(tool)} ${pluginDescription(tool)}`.toLowerCase();
}

function packageSearchText(item: PiPackageSummary): string {
  return `${item.name} ${item.description ?? ""}`.toLowerCase();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong";
}
