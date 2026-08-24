import { Box, Check, ExternalLink, Image as ImageIcon, LoaderCircle, Package, RefreshCw, Search, Trash2, Video } from "lucide-react";
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
  const [tab, setTab] = useState<"installed" | "explore">("installed");
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
    if (tab !== "explore") return;
    setPackages([]);
    setPackagePage(1);
    void loadPackages(1, false);
  }, [searchQuery, tab]);

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

  return (
    <main className="home-shell">
      <AppSidebar active="plugins" onNavigate={onNavigate} />
      <section className="plugins-content">
        <div className="plugins-main">
          <header className="plugins-heading">
            <h1>Plugins</h1>
            <p>OpenGame tools and Pi packages.</p>
          </header>

          <nav className="plugins-tabs" aria-label="Plugin views">
            <button className={tab === "installed" ? "is-active" : ""} type="button" onClick={() => setTab("installed")}>Installed</button>
            <button className={tab === "explore" ? "is-active" : ""} type="button" onClick={() => setTab("explore")}>Explore</button>
          </nav>

          {phase === "loading" ? <div className="plugins-state"><LoaderCircle className="spin" size={16} />Loading plugins</div> : null}
          {phase === "error" ? (
            <div className="plugins-state plugins-state-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button>
            </div>
          ) : null}
          {phase === "ready" && tab === "installed" ? (
            <section className="plugins-installed" aria-labelledby="plugins-installed-title">
              <header>
                <h2 id="plugins-installed-title">Installed plugins</h2>
                <span>{installed.length + installedPackages.length} {installed.length + installedPackages.length === 1 ? "plugin" : "plugins"}</span>
              </header>
              {error ? <p className="plugins-inline-error" role="alert">{error}</p> : null}
              {packageNotice ? <p className="plugins-inline-notice" role="status">{packageNotice}</p> : null}
              {installed.length || installedPackages.length ? (
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
                  {installedPackages.map((item) => (
                    <PiPackageRow key={item.installSpec} item={item} updating={updatingPackage === item.installSpec} onRemove={() => void uninstallPackage(item)} />
                  ))}
                </div>
              ) : (
                <p className="plugins-empty">Install a tool from Images or 3D to add it to your agent.</p>
              )}
            </section>
          ) : null}
          {tab === "explore" ? (
            <section className="plugins-explore" aria-labelledby="plugins-explore-title">
              <header className="plugins-explore-header">
                <div><h2 id="plugins-explore-title">Pi packages</h2><span>Discover packages published to npm.</span></div>
                <form className="plugins-search" onSubmit={(event: FormEvent) => { event.preventDefault(); setSearchQuery(query.trim()); }}><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search packages" aria-label="Search Pi packages" /></form>
              </header>
              {packagePhase === "loading" && packages.length === 0 ? <div className="plugins-state"><LoaderCircle className="spin" size={16} />Loading packages</div> : null}
              {packagePhase === "error" ? <div className="plugins-state plugins-state-error" role="alert"><span>{packageError}</span><button type="button" onClick={() => void loadPackages(packagePage, packagePage > 1)}><RefreshCw size={14} />Retry</button></div> : null}
              {packages.length ? <div className="plugins-list">{packages.map((item) => <PiPackageRow key={item.name} item={item} updating={updatingPackage === item.name} onInstall={() => void installPackage(item.name)} />)}</div> : null}
              {hasMorePackages ? <button className="plugins-load-more" type="button" onClick={() => void loadPackages(packagePage + 1, true)} disabled={packagePhase === "loading"}>{packagePhase === "loading" ? <LoaderCircle className="spin" size={14} /> : null}{packagePhase === "loading" ? "Loading…" : "Load more"}</button> : null}
              {packagePhase === "ready" && packages.length === 0 ? <p className="plugins-empty">{hasMorePackages ? "No verified packages on this page." : "No Pi packages found."}</p> : null}
              {packageError && packagePhase !== "error" ? <p className="plugins-inline-error" role="alert">{packageError}</p> : null}
              {packageNotice ? <p className="plugins-inline-notice" role="status">{packageNotice}</p> : null}
            </section>
          ) : null}
        </div>
      </section>
      {pendingInstall ? <PiPackageWarningDialog onCancel={() => setPendingInstall(undefined)} onConfirm={confirmPackageInstall} /> : null}
    </main>
  );
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong";
}
