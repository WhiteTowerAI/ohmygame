import {
  ChevronRight,
  ExternalLink,
  FolderPlus,
  FolderOpen,
  GitBranch,
  Heart,
  LoaderCircle,
  Package,
  Plus,
  Play,
  Plug,
  Search,
  WandSparkles,
} from "./icons.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  pluginComponentKey,
  isNewerPluginVersion,
  isPluginVersion,
  type PluginComponentSummary,
  type PluginConnectionSummary,
  type PluginDetail,
  type InstallPluginRequest,
  type PluginInstallCandidate,
  type PluginSettings,
  type PluginSummary,
} from "../shared/plugins.js";
import type { CommunityAuthor, CommunityStats, PublishPluginPublication } from "../shared/publish-v1.js";
import type { ProjectState } from "../shared/contracts.js";
import { getPluginPublication, inspectPluginSource, installCatalogPlugin, installPlugin, listPlugins, listProjects, publishPlugin, readPlugin, readPluginSkill, setPluginPublicationStatus, uninstallPlugin, updatePluginSettings, waitForRuntime } from "./api.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";
import { GodotIcon } from "./godot-icon.js";
import { MarkdownContent } from "./markdown-content.js";
import { useAuth } from "./auth.js";
import { CommunityAuthorView, CommunityLikeButton, useCommunityLike, useCommunityUseRecorder } from "./community-meta.js";

type PluginsView = { type: "catalog" } | { type: "detail"; pluginId: string };

export function PluginsPage({ onNavigate, onAddPlugin, onTryPlugin }: {
  onNavigate: (page: AppNavigationTarget) => void;
  onAddPlugin: () => Promise<void>;
  onTryPlugin: (plugin: PluginDetail, prompt: string, projectId?: string) => Promise<void>;
}) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [explorePlugins, setExplorePlugins] = useState<PluginSummary[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [view, setView] = useState<PluginsView>({ type: "catalog" });
  const [detail, setDetail] = useState<PluginDetail>();
  const [detailPhase, setDetailPhase] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [updating, setUpdating] = useState<string>();
  const [adding, setAdding] = useState<"create" | "install">();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [gitDialogOpen, setGitDialogOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [installSource, setInstallSource] = useState<InstallPluginRequest>();
  const [installCandidates, setInstallCandidates] = useState<PluginInstallCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<string>();
  const [publishVersion, setPublishVersion] = useState<{ plugin: PluginDetail; value: string }>();
  const [publication, setPublication] = useState<PublishPluginPublication | null>();
  const addMenu = useRef<HTMLDivElement>(null);
  const [catalogWarning, setCatalogWarning] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const auth = useAuth();
  const recordUse = useCommunityUseRecorder();
  const detailCatalogId = detail ? pluginCatalogId(detail) : undefined;

  async function load(): Promise<void> {
    setPhase("loading");
    setCatalogWarning(undefined);
    setError(undefined);
    try {
      await waitForRuntime();
      const catalog = await listPlugins();
      setPlugins(catalog.plugins);
      setExplorePlugins(catalog.explore);
      setCatalogWarning(catalog.errors.map((entry) => entry.message).join("\n") || undefined);
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    let active = true;
    setPublication(undefined);
    if (detail) void loadPublication(detail).then((next) => {
      if (active) setPublication(next);
    });
    return () => { active = false; };
  }, [auth.state.status, detail?.id, detail?.installed, detailCatalogId]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!addMenu.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [addMenuOpen]);

  async function openPlugin(pluginId: string): Promise<void> {
    setView({ type: "detail", pluginId });
    setDetail(undefined);
    setPublication(undefined);
    setDetailPhase("loading");
    setError(undefined);
    setNotice(undefined);
    try {
      const loaded = await readPlugin(pluginId);
      const summary = plugins.find((plugin) => plugin.id === pluginId);
      const next = summary ? { ...loaded, latestVersion: summary.latestVersion, updateAvailable: summary.updateAvailable } : loaded;
      setDetail(next);
      setDetailPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setDetailPhase("error");
    }
  }

  async function loadPublication(plugin: PluginDetail): Promise<PublishPluginPublication | null> {
    const catalog = plugin.catalog ?? (plugin.source.type === "catalog" ? plugin.source : undefined);
    if (!plugin.installed || !catalog || auth.state.status !== "signed-in") return null;
    try {
      const accessToken = await auth.requestAccessToken();
      return accessToken ? await getPluginPublication(plugin.id, accessToken) : null;
    } catch {
      return null;
    }
  }

  async function updatePlugin(plugin: PluginDetail, settings: PluginSettings): Promise<void> {
    if (updating) return;
    setUpdating(plugin.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await updatePluginSettings(plugin.id, settings);
      setDetail((current) => current?.id === updated.id ? updated : current);
      setPlugins((items) => items.map((item) => item.id === updated.id ? pluginSummary(updated) : item));
      setExplorePlugins((items) => items.map((item) => item.id === updated.id ? { ...item, enabled: updated.enabled } : item));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdating(undefined);
    }
  }

  async function removePlugin(plugin: PluginSummary): Promise<void> {
    if (updating || plugin.source.type === "builtIn") return;
    setUpdating(plugin.id);
    setError(undefined);
    try {
      await uninstallPlugin(plugin.id);
      await load();
      setDetail(undefined);
      setView({ type: "catalog" });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdating(undefined);
    }
  }

  async function installFromCatalog(plugin: PluginDetail): Promise<void> {
    if (updating) return;
    setUpdating(plugin.id);
    setError(undefined);
    try {
      const firstInstall = !plugin.installed;
      const installed = await installCatalogPlugin(plugin.id);
      if (firstInstall && plugin.source.type === "catalog") {
        void recordUse("plugin", plugin.source.pluginId).catch(() => undefined);
      }
      setDetail(installed);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdating(undefined);
    }
  }

  async function sharePlugin(plugin: PluginDetail): Promise<void> {
    if (updating) return;
    if (!publication && !window.confirm(`Publish “${plugin.displayName}” to Explore? You confirm that you have permission to publish this Plugin.`)) return;
    if (!plugin.version) {
      setError(undefined);
      setPublishVersion({ plugin, value: "0.1.0" });
      return;
    }
    await publishPluginRelease(plugin, plugin.version);
  }

  async function submitPublishVersion(): Promise<void> {
    if (!publishVersion || updating) return;
    const version = publishVersion.value.trim();
    if (!isPluginVersion(version)) {
      setError("Enter a semantic version such as 0.1.0");
      return;
    }
    await publishPluginRelease(publishVersion.plugin, version);
  }

  function closePublishVersion(): void {
    setPublishVersion(undefined);
    setError(undefined);
  }

  async function publishPluginRelease(plugin: PluginDetail, version: string): Promise<void> {
    const accessToken = await auth.requestAccessToken();
    if (!accessToken) return;
    setUpdating(plugin.id);
    setError(undefined);
    const publishingUpdate = Boolean(publication);
    try {
      await publishPlugin(plugin.id, accessToken, version);
      await load();
      const updated = await readPlugin(plugin.id);
      setDetail(updated);
      setPublication(await getPluginPublication(plugin.id, accessToken));
      setPublishVersion(undefined);
      setNotice(publishingUpdate ? "Published update to Explore" : "Published to Explore");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdating(undefined);
    }
  }

  async function setPublicationStatus(plugin: PluginDetail, status: "listed" | "unlisted"): Promise<void> {
    if (updating) return;
    const accessToken = await auth.requestAccessToken();
    if (!accessToken) return;
    setUpdating(plugin.id);
    setError(undefined);
    setNotice(undefined);
    try {
      await setPluginPublicationStatus(plugin.id, accessToken, status);
      setPublication(await getPluginPublication(plugin.id, accessToken));
      await load();
      setDetail(await readPlugin(plugin.id));
      setNotice(status === "listed" ? "Republished to Explore" : "Removed from Explore");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdating(undefined);
    }
  }

  async function addPlugin(): Promise<void> {
    if (adding) return;
    setAdding("create");
    setError(undefined);
    try {
      await onAddPlugin();
    } catch (cause) {
      setError(errorMessage(cause));
      setAdding(undefined);
    }
  }

  async function installFromFolder(): Promise<void> {
    setAddMenuOpen(false);
    setError(undefined);
    try {
      const selected = await window.openGameDesktop?.selectPluginDirectory();
      if (!selected) return;
      await prepareInstall({ type: "directory", path: selected });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function openGitInstallDialog(): void {
    setAddMenuOpen(false);
    setGitDialogOpen(true);
    setGitUrl("");
    setInstallSource(undefined);
    setInstallCandidates([]);
    setSelectedCandidate(undefined);
    setError(undefined);
  }

  function closeInstallDialog(): void {
    setGitDialogOpen(false);
    setGitUrl("");
    setInstallSource(undefined);
    setInstallCandidates([]);
    setSelectedCandidate(undefined);
    setError(undefined);
  }

  async function installFromGit(): Promise<void> {
    const url = gitUrl.trim();
    const source = installSource ?? (url ? { type: "git" as const, url } : undefined);
    if (!source) return;
    if (!installCandidates.length) await prepareInstall(source);
    else if (selectedCandidate) await installSelectedPlugin({ ...source, candidate: selectedCandidate });
  }

  async function prepareInstall(input: InstallPluginRequest): Promise<void> {
    if (adding) return;
    setAdding("install");
    setError(undefined);
    try {
      const inspection = await inspectPluginSource(input);
      if (inspection.candidates.length === 1) {
        await installSelectedPlugin({ ...input, candidate: inspection.candidates[0]!.key }, true);
        return;
      }
      setInstallSource(input);
      setInstallCandidates(inspection.candidates);
      setSelectedCandidate(inspection.candidates[0]?.key);
      setGitDialogOpen(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAdding(undefined);
    }
  }

  async function installSelectedPlugin(input: InstallPluginRequest, alreadyBusy = false): Promise<void> {
    if (adding && !alreadyBusy) return;
    if (!alreadyBusy) setAdding("install");
    setError(undefined);
    try {
      const installedPlugin = await installPlugin(input);
      setPlugins((items) => [...items.filter((item) => item.id !== installedPlugin.id), pluginSummary(installedPlugin)]);
      closeInstallDialog();
      setDetail(installedPlugin);
      setDetailPhase("ready");
      setView({ type: "detail", pluginId: installedPlugin.id });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAdding(undefined);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visible = plugins.filter((plugin) => pluginSearchText(plugin).includes(normalizedQuery));
  const installed = visible.filter((plugin) => plugin.installed);
  const explore = explorePlugins.filter((plugin) => pluginSearchText(plugin).includes(normalizedQuery));
  const detailTitle = view.type === "detail"
    ? detail?.displayName ?? plugins.find((plugin) => plugin.id === view.pluginId)?.displayName ?? "Plugin"
    : undefined;

  return <SidebarPageLayout active="plugins" onNavigate={onNavigate}>
    <SidebarPageHeader
      title={detailTitle ?? "Plugins"}
      breadcrumb={view.type === "detail" ? { label: "Plugins", onClick: showCatalog } : undefined}
    >
      {view.type === "catalog" ? (
        <div className="plugins-toolbar">
          <label className="plugins-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins..." aria-label="Search plugins" />
          </label>
          <div className="plugins-add" ref={addMenu}>
            <button className="plugins-add-button" type="button" disabled={Boolean(adding)} aria-haspopup="menu" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((current) => !current)}>{adding ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}{adding === "create" ? "Opening..." : adding === "install" ? "Installing..." : "Add plugin"}</button>
            {addMenuOpen ? <div className="plugins-add-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); void addPlugin(); }}><Package size={14} /><span><strong>Create with AI</strong><small>Build a plugin with the agent</small></span></button>
              {window.openGameDesktop ? <button type="button" role="menuitem" onClick={() => void installFromFolder()}><FolderOpen size={14} /><span><strong>Install from folder...</strong><small>Choose a local plugin directory</small></span></button> : null}
              <button type="button" role="menuitem" onClick={openGitInstallDialog}><GitBranch size={14} /><span><strong>Install from Git...</strong><small>Clone a public HTTPS repository</small></span></button>
            </div> : null}
          </div>
        </div>
      ) : null}
    </SidebarPageHeader>
    {view.type === "detail" ? <PluginDetailView
      phase={detailPhase}
      plugin={detail}
      updating={updating === detail?.id}
      error={error}
      notice={notice}
      onRetry={() => void openPlugin(view.pluginId)}
      onTogglePlugin={(enabled) => detail && void updatePlugin(detail, { ...componentSettings(detail), enabled })}
      onToggleComponent={(component, enabled) => detail && void updatePlugin(detail, {
        enabled: detail.enabled,
        components: { ...componentSettings(detail).components, [pluginComponentKey("skill", component.id)]: enabled },
      })}
      onBrowse={() => detail && void browsePlugin(detail)}
      onBrowseSkill={(skillId) => detail && void browsePluginSkill(detail.id, skillId)}
      onRemove={() => detail && void removePlugin(detail)}
      onInstall={() => detail && void installFromCatalog(detail)}
      onPublish={() => detail && void sharePlugin(detail)}
      publication={publication}
      onSetPublicationStatus={(status) => detail && void setPublicationStatus(detail, status)}
      onTry={onTryPlugin}
    /> : <>
      {phase === "ready" && ((!gitDialogOpen && error) || catalogWarning) ? <p className="plugins-inline-error" role="alert">{!gitDialogOpen && error ? error : catalogWarning}</p> : null}
      {phase === "loading" ? <PluginState>Loading plugins</PluginState> : null}
      {phase === "error" ? <PluginError message={error} onRetry={() => void load()} /> : null}
      {phase === "ready" ? <>
        <InstalledPlugins
          plugins={installed}
          collapsible={!normalizedQuery}
          viewerId={auth.state.status === "signed-in" ? auth.state.user.id : undefined}
          onOpenPlugin={(id) => void openPlugin(id)}
        />
        <ExplorePlugins plugins={explore} viewerId={auth.state.status === "signed-in" ? auth.state.user.id : undefined} onOpenPlugin={(id) => void openPlugin(id)} />
      </> : null}
    </>}
    {gitDialogOpen ? <div className="plugin-install-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !adding) closeInstallDialog();
    }}>
      <form className="plugin-install-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-install-title" onKeyDown={(event) => {
        if (event.key === "Escape" && !adding) closeInstallDialog();
      }} onSubmit={(event) => { event.preventDefault(); void installFromGit(); }}>
        <header><h2 id="plugin-install-title">{installCandidates.length ? "Choose a plugin" : "Install from Git"}</h2><p>{installCandidates.length ? `Select a plugin from ${installCandidates[0]!.marketplace.displayName}.` : "Enter a public HTTPS repository or marketplace URL."}</p></header>
        {installCandidates.length ? <div className="plugin-install-candidates" role="radiogroup" aria-label="Plugins">
          {installCandidates.map((candidate) => <button type="button" role="radio" aria-checked={selectedCandidate === candidate.key} className={selectedCandidate === candidate.key ? "is-selected" : ""} key={candidate.key} onClick={() => setSelectedCandidate(candidate.key)}>
            <span><strong>{candidate.displayName}</strong><small>{candidate.description}</small></span>
            <span className="plugin-install-candidate-meta"><small>{candidate.skillCount} skill{candidate.skillCount === 1 ? "" : "s"}</small><span className="plugin-install-candidate-radio" aria-hidden="true" /></span>
          </button>)}
        </div> : <label><span>Repository or marketplace URL</span><input autoFocus type="url" required disabled={Boolean(adding)} value={gitUrl} placeholder="https://github.com/example/plugin" onChange={(event) => setGitUrl(event.target.value)} /></label>}
        {error ? <p className="plugin-install-error" role="alert">{error}</p> : null}
        <footer><button type="button" disabled={Boolean(adding)} onClick={closeInstallDialog}>Cancel</button><button className="plugin-install-submit" type="submit" disabled={Boolean(adding) || (installCandidates.length ? !selectedCandidate : !gitUrl.trim())}>{adding === "install" ? <LoaderCircle className="spin" size={13} /> : null}{adding === "install" ? "Installing..." : "Install"}</button></footer>
      </form>
    </div> : null}
    {publishVersion ? <div className="plugin-install-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !updating) closePublishVersion();
    }}>
      <form className="plugin-install-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-publish-title" onKeyDown={(event) => {
        if (event.key === "Escape" && !updating) closePublishVersion();
      }} onSubmit={(event) => { event.preventDefault(); void submitPublishVersion(); }}>
        <header><h2 id="plugin-publish-title">Publish Plugin</h2><p>Publish a semantic version to OpenGame Explore.</p></header>
        <label><span>Version</span><input autoFocus required disabled={Boolean(updating)} value={publishVersion.value} placeholder="0.1.0" onChange={(event) => { setPublishVersion((current) => current ? { ...current, value: event.target.value } : current); setError(undefined); }} /></label>
        {error ? <p className="plugin-install-error" role="alert">{error}</p> : null}
        <footer><button type="button" disabled={Boolean(updating)} onClick={closePublishVersion}>Cancel</button><button className="plugin-install-submit" type="submit" disabled={Boolean(updating) || !publishVersion.value.trim()}>{updating ? <LoaderCircle className="spin" size={13} /> : null}{updating ? "Publishing..." : "Publish"}</button></footer>
      </form>
    </div> : null}
  </SidebarPageLayout>;

  function showCatalog(): void {
    setView({ type: "catalog" });
  }

  async function browsePlugin(plugin: Pick<PluginSummary, "id">): Promise<void> {
    setError(undefined);
    try {
      await window.openGameDesktop?.browsePluginDirectory(plugin.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function browsePluginSkill(pluginId: string, skillId: string): Promise<void> {
    setError(undefined);
    try {
      await window.openGameDesktop?.revealPluginSkill(pluginId, skillId);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
}

const INSTALLED_PLUGIN_LIMIT = 6;

function InstalledPlugins({ plugins, collapsible, viewerId, onOpenPlugin }: {
  plugins: PluginSummary[];
  collapsible: boolean;
  viewerId?: string;
  onOpenPlugin: (id: string) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const limited = collapsible && !expanded && plugins.length > INSTALLED_PLUGIN_LIMIT;
  const displayed = limited ? plugins.slice(0, INSTALLED_PLUGIN_LIMIT) : plugins;
  return <section className="plugins-installed" aria-labelledby="installed-plugins-title">
    <h2 id="installed-plugins-title">Installed</h2>
    {plugins.length ? <div className="plugins-installed-grid">
      {displayed.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} viewerId={viewerId} onOpen={() => onOpenPlugin(plugin.id)} />)}
    </div> : <p className="plugins-empty">No installed plugins match your search.</p>}
    {collapsible && plugins.length > INSTALLED_PLUGIN_LIMIT ? <button className="plugins-show-more" type="button" onClick={() => setExpanded((current) => !current)}>{expanded ? "Show less" : `Show more (${plugins.length - INSTALLED_PLUGIN_LIMIT})`}</button> : null}
  </section>;
}

function ExplorePlugins({ plugins, viewerId, onOpenPlugin }: { plugins: PluginSummary[]; viewerId?: string; onOpenPlugin: (id: string) => void }): ReactNode {
  return <section className="plugins-explore" aria-labelledby="explore-plugins-title">
    <header className="plugins-section-heading"><h2 id="explore-plugins-title">Explore</h2><span>Discover more capabilities for your agent.</span></header>
    {plugins.length ? <div className="plugins-explore-grid">{plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} viewerId={viewerId} onOpen={() => onOpenPlugin(plugin.id)} />)}</div> : <p className="plugins-empty">No additional plugins match your search.</p>}
  </section>;
}

function PluginCard({ plugin, viewerId, onOpen }: { plugin: PluginSummary; viewerId?: string; onOpen: () => void }): ReactNode {
  return <article className={`plugin-catalog-card${plugin.installed && !plugin.enabled ? " is-disabled" : ""}`}>
    <button className="plugin-card-open" type="button" onClick={onOpen}>
      <PluginIcon plugin={plugin} />
      <span className="plugin-card-copy">
        <span className="plugin-card-title"><strong>{plugin.displayName}</strong>{plugin.curation === "featured" ? <small className="plugin-featured-badge">Featured</small> : null}{viewerId && plugin.author?.id === viewerId ? <small className="plugin-yours-badge">Yours</small> : null}<ExplorePluginStatus plugin={plugin} /></span>
        <span className="plugin-card-description">{plugin.description}</span>
        <PluginCardMeta plugin={plugin} />
      </span>
    </button>
  </article>;
}

function ExplorePluginStatus({ plugin }: { plugin: PluginSummary }): ReactNode {
  if (plugin.updateAvailable) return <small className="plugin-explore-status is-update">Update available</small>;
  if (!plugin.installed) return null;
  return <small className="plugin-explore-status">{plugin.enabled ? "Installed" : "Disabled"}</small>;
}

function PluginDetailView({ phase, plugin, publication, updating, error, notice, onRetry, onTogglePlugin, onToggleComponent, onBrowse, onBrowseSkill, onRemove, onInstall, onPublish, onSetPublicationStatus, onTry }: {
  phase: "loading" | "ready" | "error";
  plugin?: PluginDetail;
  publication?: PublishPluginPublication | null;
  updating: boolean;
  error?: string;
  notice?: string;
  onRetry: () => void;
  onTogglePlugin: (enabled: boolean) => void;
  onToggleComponent: (component: PluginComponentSummary, enabled: boolean) => void;
  onBrowse: () => void;
  onBrowseSkill: (skillId: string) => void;
  onRemove: () => void;
  onInstall: () => void;
  onPublish: () => void;
  onSetPublicationStatus: (status: "listed" | "unlisted") => void;
  onTry: (plugin: PluginDetail, prompt: string, projectId?: string) => Promise<void>;
}): ReactNode {
  const [tryPrompt, setTryPrompt] = useState<string>();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [projectPhase, setProjectPhase] = useState<"loading" | "ready" | "error" | "starting">("loading");
  const [projectError, setProjectError] = useState<string>();
  const [projectQuery, setProjectQuery] = useState("");
  const [tryNotice, setTryNotice] = useState<string>();
  const tryMenu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tryPrompt) return;
    const close = (event: MouseEvent) => {
      if (!tryMenu.current?.contains(event.target as Node)) setTryPrompt(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTryPrompt(undefined);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [tryPrompt]);

  async function openProjectPicker(prompt: string): Promise<void> {
    setTryPrompt(prompt);
    setProjectQuery("");
    setProjectError(undefined);
    setProjectPhase("loading");
    try {
      const items = await listProjects();
      const projectTypes = plugin?.projectTypes;
      const compatible = projectTypes?.length
        ? items.filter((project) => projectTypes.includes(project.type))
        : items;
      setProjects(compatible.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setProjectPhase("ready");
    } catch (cause) {
      setProjectError(errorMessage(cause));
      setProjectPhase("error");
    }
  }

  function choosePrompt(prompt: string): void {
    if (!plugin?.installed) {
      setTryNotice("Install this plugin to try an example.");
      return;
    }
    if (!plugin.enabled) {
      setTryNotice("Enable this plugin to try an example.");
      return;
    }
    setTryNotice(undefined);
    void openProjectPicker(prompt);
  }

  function togglePlugin(enabled: boolean): void {
    setTryPrompt(undefined);
    setTryNotice(undefined);
    onTogglePlugin(enabled);
  }

  async function startPlugin(projectId?: string): Promise<void> {
    if (!plugin || !tryPrompt || projectPhase === "starting") return;
    setProjectPhase("starting");
    setProjectError(undefined);
    try {
      await onTry(plugin, tryPrompt, projectId);
    } catch (cause) {
      setProjectError(errorMessage(cause));
      setProjectPhase("error");
    }
  }

  const normalizedProjectQuery = projectQuery.trim().toLowerCase();
  const visibleProjects = projects.filter((project) => !normalizedProjectQuery || project.name.toLowerCase().includes(normalizedProjectQuery));
  const prompts = plugin?.defaultPrompts ?? [];
  const firstPrompt = prompts[0];
  const canPublish = plugin?.source.type === "directory" || plugin?.source.type === "git";
  const canShare = Boolean(canPublish && plugin && !pluginCatalogId(plugin));
  const publishUpdateAvailable = Boolean(plugin?.version && publication && isNewerPluginVersion(plugin.version, publication.version));
  const emptyProjectLabel = normalizedProjectQuery
    ? "No matching projects"
    : plugin?.projectTypes?.length === 1 ? `No ${projectTypeLabel(plugin.projectTypes[0])} projects yet` : "No compatible projects yet";
  return <section className="plugin-detail">
    {phase === "loading" ? <PluginState>Loading plugin</PluginState> : null}
    {phase === "error" ? <PluginError message={error} onRetry={onRetry} /> : null}
    {phase === "ready" && plugin ? <>
      <header className="plugin-detail-hero">
        <PluginIcon plugin={plugin} large />
        <div className="plugin-detail-copy">
          <div className="plugin-detail-title">
            <h2>{plugin.displayName}</h2>
            {plugin.curation === "featured" ? <small className="plugin-featured-badge">Featured</small> : null}
            {plugin.preinstalled ? <small className="plugin-detail-badge">Included</small> : null}
          </div>
          <p>{plugin.description}</p>
          {plugin.author && plugin.stats && pluginCatalogId(plugin) ? <PluginCommunityByline author={plugin.author} stats={plugin.stats} /> : null}
          <div className="plugin-detail-hero-actions" ref={tryMenu}>
            {plugin.stats && pluginCatalogId(plugin) ? <PluginLikeAction id={pluginCatalogId(plugin)!} stats={plugin.stats} /> : null}
            {!plugin.installed ? <button className="plugin-detail-primary" type="button" disabled={updating} onClick={onInstall}>{updating ? <LoaderCircle className="spin" size={13} /> : null}{updating ? "Installing..." : "Install"}</button> : null}
            {plugin.installed && plugin.updateAvailable ? <button className="plugin-detail-primary" type="button" disabled={updating} onClick={onInstall}>{updating ? <LoaderCircle className="spin" size={13} /> : null}{updating ? "Updating..." : `Update to v${plugin.latestVersion}`}</button> : null}
            {plugin.installed && !plugin.updateAvailable && publication?.status === "unlisted" ? <button className="plugin-detail-primary" type="button" disabled={updating} onClick={() => onSetPublicationStatus("listed")}>{updating ? <LoaderCircle className="spin" size={13} /> : null}{updating ? "Publishing..." : "Republish"}</button> : null}
            {plugin.installed && !plugin.updateAvailable && publication?.status !== "unlisted" && publishUpdateAvailable ? <button className="plugin-detail-primary" type="button" disabled={updating} onClick={onPublish}>{updating ? <LoaderCircle className="spin" size={13} /> : null}{updating ? "Publishing..." : "Publish update"}</button> : null}
            {plugin.installed && !plugin.updateAvailable && canShare ? <button className="plugin-detail-primary" type="button" disabled={updating} onClick={onPublish}>{updating ? <LoaderCircle className="spin" size={13} /> : null}{updating ? "Publishing..." : "Publish"}</button> : null}
            {plugin.installed && plugin.enabled && !plugin.updateAvailable && !canShare && publication?.status !== "unlisted" && !publishUpdateAvailable && firstPrompt ? <button className="plugin-detail-primary" type="button" aria-haspopup="dialog" aria-expanded={Boolean(tryPrompt)} onClick={() => choosePrompt(firstPrompt)}><Play size={13} />Try now</button> : null}
            {tryPrompt ? <div className="plugin-try-popover project-switcher-popover" role="dialog" aria-label={`Try ${plugin.displayName}`}>
              <div className="plugin-try-heading"><strong>Choose a project</strong><span>The prompt will be added to a new conversation.</span></div>
              <label className="project-switcher-search">
                <Search size={13} />
                <input value={projectQuery} placeholder="Search projects" aria-label="Search projects" onChange={(event) => setProjectQuery(event.target.value)} />
              </label>
              <div className="project-switcher-list">
                {projectPhase === "loading" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />Loading projects</div> : null}
                {projectPhase === "error" ? <div className="project-switcher-state is-error"><span>{projectError}</span><button type="button" onClick={() => void openProjectPicker(tryPrompt)}>Retry</button></div> : null}
                {projectPhase === "starting" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />Starting conversation</div> : null}
                {projectPhase === "ready" ? visibleProjects.map((project) => <button className="project-switcher-item" type="button" key={project.id} onClick={() => void startPlugin(project.id)}>
                  <ProjectTypeIcon type={project.type} />
                  <span><strong>{project.name}</strong><small>{projectTypeLabel(project.type)}</small></span>
                  <ChevronRight size={13} />
                </button>) : null}
                {projectPhase === "ready" && !visibleProjects.length ? <div className="project-switcher-state">{emptyProjectLabel}</div> : null}
              </div>
              <div className="project-switcher-footer"><button type="button" disabled={projectPhase === "starting"} onClick={() => void startPlugin()}><FolderPlus size={14} />New {projectTypeLabel(plugin.projectTypes?.[0] ?? "web-game")} project</button></div>
            </div> : null}
          </div>
        </div>
      </header>
      {error ? <p className="plugins-inline-error" role="alert">{error}</p> : null}
      {notice ? <p className="plugins-inline-notice" role="status">{notice}</p> : null}
      <PluginManagement plugin={plugin} publication={publication} updating={updating} onBrowse={onBrowse} onRemove={onRemove} onToggle={togglePlugin} onSetPublicationStatus={onSetPublicationStatus} />
      {plugin.longDescription ? <section className="plugin-about"><h2>About</h2><p>{plugin.longDescription}</p></section> : null}
      {prompts.length ? <section className="plugin-prompts">
        <h2>Try it</h2>
        <div>{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => choosePrompt(prompt)}>
          <span className="plugin-prompt-copy">
            <span className="plugin-prompt-reference">{plugin.id === "opengame:godot" ? <GodotIcon size={14} /> : <Package size={14} aria-hidden="true" />}{plugin.displayName}</span>
            <span className="plugin-prompt-text">{prompt}</span>
          </span>
          <ChevronRight size={14} />
        </button>)}</div>
        {tryNotice ? <p role="status">{tryNotice}</p> : null}
      </section> : null}
      <SkillSection pluginId={plugin.id} items={plugin.skills} installed={plugin.installed} disabled={updating || !plugin.enabled} onBrowse={onBrowseSkill} onToggle={onToggleComponent} />
      <ConnectionSection items={plugin.connections} />
    </> : null}
  </section>;
}

function PluginCommunityByline({ author, stats }: { author: CommunityAuthor; stats: CommunityStats }): ReactNode {
  return <div className="plugin-community-byline">
    <CommunityAuthorView author={author} prefix="Shared by" />
    <span>{stats.uses} installs</span>
  </div>;
}

function PluginLikeAction({ id, stats }: { id: string; stats: CommunityStats }): ReactNode {
  const like = useCommunityLike("plugin", id, stats);
  return <CommunityLikeButton
    busy={like.busy}
    count={like.counts.likes}
    liked={like.liked}
    onToggle={() => void like.toggle()}
    showLabel
  />;
}

function ConnectionSection({ items }: { items: PluginConnectionSummary[] }): ReactNode {
  if (!items.length) return null;
  return <section className="plugin-components"><h2>Connections</h2><div>{items.map((item) => <div className="plugin-component-row" key={item.id}>
    <span className="plugin-component-icon"><Plug size={15} /></span>
    <span className="plugin-row-copy"><strong>{item.name}</strong><span>{item.status === "not-configured" ? "Not configured" : item.status === "disabled" ? "Disabled in Settings" : "Available"}</span></span>
    <button className={`plugin-connection-status is-${item.status ?? "enabled"}`} type="button" onClick={() => { window.location.hash = "#/settings/connections" }}>{item.status === "not-configured" ? "Set up in Settings" : "Manage in Settings"}</button>
  </div>)}</div></section>;
}

function SkillSection({ pluginId, items, installed, disabled, onBrowse, onToggle }: {
  pluginId: string;
  items: PluginComponentSummary[];
  installed: boolean;
  disabled: boolean;
  onBrowse: (skillId: string) => void;
  onToggle: (component: PluginComponentSummary, enabled: boolean) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState<{ id: string; phase: "loading" | "ready" | "error"; content?: string; error?: string }>();
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    setExpanded(undefined);
  }, [pluginId]);

  async function loadContent(item: PluginComponentSummary): Promise<void> {
    const currentRequest = ++requestId.current;
    setExpanded({ id: item.id, phase: "loading" });
    try {
      const result = await readPluginSkill(pluginId, item.id);
      if (requestId.current === currentRequest) setExpanded({ id: item.id, phase: "ready", content: result.content });
    } catch (cause) {
      if (requestId.current === currentRequest) setExpanded({ id: item.id, phase: "error", error: errorMessage(cause) });
    }
  }

  function toggleContent(item: PluginComponentSummary): void {
    if (expanded?.id === item.id) {
      requestId.current += 1;
      setExpanded(undefined);
    } else {
      void loadContent(item);
    }
  }

  if (!items.length) return null;
  return <section className="plugin-components plugin-skills"><h2>Skills</h2><div>{items.map((item) => {
    const open = expanded?.id === item.id;
    return <div className="plugin-skill-item" key={item.id}>
      <div className="plugin-component-row plugin-skill-row">
        <button className="plugin-skill-open" type="button" aria-expanded={open} onClick={() => toggleContent(item)}>
          <span className="plugin-component-icon"><WandSparkles size={15} /></span>
          <span className="plugin-row-copy"><strong>{item.name}</strong>{item.description ? <span>{item.description}</span> : null}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        {installed && window.openGameDesktop ? <button className="plugin-skill-browse" type="button" title="Show in Finder" aria-label={`Show ${item.name} in Finder`} onClick={() => onBrowse(item.id)}><FolderOpen size={14} /></button> : null}
        {installed ? <PluginSwitch checked={item.enabled} disabled={disabled} label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`} onClick={() => onToggle(item, !item.enabled)} /> : null}
      </div>
      {open ? <div className="plugin-skill-content">
        {expanded.phase === "loading" ? <div className="plugin-skill-state"><LoaderCircle className="spin" size={13} />Loading skill</div> : null}
        {expanded.phase === "error" ? <div className="plugin-skill-state is-error"><span>{expanded.error}</span><button type="button" onClick={() => void loadContent(item)}>Retry</button></div> : null}
        {expanded.phase === "ready" ? <MarkdownContent text={expanded.content ?? ""} /> : null}
      </div> : null}
    </div>;
  })}</div></section>;
}

function PluginSwitch({ checked, disabled, label, onClick }: { checked: boolean; disabled: boolean; label: string; onClick: () => void }): ReactNode {
  return <button className="plugin-switch" type="button" role="switch" aria-checked={checked} disabled={disabled} aria-label={label} onClick={onClick}><span /></button>;
}

function PluginState({ children }: { children: ReactNode }): ReactNode {
  return <div className="plugins-state"><LoaderCircle className="spin" size={16} />{children}</div>;
}

function PluginError({ message, onRetry }: { message?: string; onRetry: () => void }): ReactNode {
  return <div className="plugins-state plugins-state-error" role="alert"><span>{message}</span><button type="button" onClick={onRetry}>Retry</button></div>;
}

function componentSettings(plugin: PluginDetail): PluginSettings {
  return {
    enabled: plugin.enabled,
    components: Object.fromEntries([
      ...plugin.skills.map((item) => [pluginComponentKey("skill", item.id), item.enabled]),
    ]),
  };
}

function pluginSummary(plugin: PluginDetail): PluginSummary {
  const { longDescription: _longDescription, skills: _skills, connections: _connections, defaultPrompts: _defaultPrompts, projectTypes: _projectTypes, ...summary } = plugin;
  return summary;
}

function PluginIcon({ plugin, large = false }: { plugin: Pick<PluginSummary, "id" | "source">; large?: boolean }): ReactNode {
  const size = large ? 42 : 29;
  const godot = plugin.id === "opengame:godot";
  return <span className={`plugin-row-icon plugin-row-icon-${godot ? "godot" : "media"}${large ? " plugin-row-icon-large" : ""}`}>{godot ? <GodotIcon size={size} /> : plugin.source.type !== "builtIn" ? <Package size={size} /> : <WandSparkles size={size} />}</span>;
}

function PluginCardMeta({ plugin }: { plugin: PluginSummary }): ReactNode {
  if (!plugin.author || !plugin.stats || !pluginCatalogId(plugin)) {
    return <small className="plugin-card-marketplace">{pluginSourceLabel(plugin)}</small>;
  }
  return <span className="plugin-card-community">
    <CommunityAuthorView author={plugin.author} prefix="Shared by" />
    <span className="plugin-card-stats"><span><Heart size={11} />{plugin.stats.likes}</span><span>{plugin.stats.uses} installs</span></span>
  </span>;
}

function pluginCatalogId(plugin: Pick<PluginSummary, "source" | "catalog">): string | undefined {
  return plugin.catalog?.pluginId ?? (plugin.source.type === "catalog" ? plugin.source.pluginId : undefined);
}

function pluginSearchText(plugin: PluginSummary): string {
  return `${plugin.name} ${plugin.displayName} ${plugin.description} ${plugin.marketplace.displayName}`.toLowerCase();
}

function pluginSourceLabel(plugin: Pick<PluginSummary, "marketplace" | "origin" | "curation">): string {
  if (plugin.origin?.type === "github") {
    return `${plugin.curation === "featured" ? "Featured · " : ""}GitHub · ${plugin.origin.repository}`;
  }
  return plugin.marketplace.id === "opengame" || plugin.marketplace.id === "personal"
    ? plugin.marketplace.displayName
    : `Marketplace · ${plugin.marketplace.displayName}`;
}

function PluginManagement({ plugin, publication, updating, onBrowse, onRemove, onToggle, onSetPublicationStatus }: {
  plugin: PluginDetail;
  publication?: PublishPluginPublication | null;
  updating: boolean;
  onBrowse: () => void;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
  onSetPublicationStatus: (status: "listed" | "unlisted") => void;
}): ReactNode {
  const repository = plugin.origin?.repository;
  const version = plugin.version ?? plugin.latestVersion;
  const showLatest = Boolean(plugin.updateAvailable && plugin.latestVersion);
  const canBrowse = (plugin.source.type === "directory" || plugin.source.type === "git") && Boolean(window.openGameDesktop);
  const canStartPublication = !pluginCatalogId(plugin) && (plugin.source.type === "directory" || plugin.source.type === "git");
  let source: ReactNode;
  if (plugin.preinstalled || plugin.source.type === "builtIn") {
    source = "Included with OpenGame";
  } else if (plugin.origin?.type === "github") {
    source = <RepositoryLink repository={plugin.origin.repository} />;
  } else if (plugin.origin?.type === "claude-marketplace") {
    source = `Claude Marketplace · ${plugin.origin.marketplace}`;
  } else if (plugin.source.type === "catalog") {
    source = "OpenGame Explore";
  } else if (plugin.source.type === "directory") {
    source = "Local folder";
  } else {
    source = "Git repository";
  }
  return <section className="plugin-management">
    <h2>Management</h2>
    <dl>
      <div><dt>Status</dt><dd>{!plugin.installed ? "Not installed" : plugin.enabled ? "Enabled" : "Disabled"}</dd></div>
      {version ? <div><dt>Version</dt><dd>v{version}</dd></div> : null}
      {showLatest ? <div><dt>Latest</dt><dd>v{plugin.latestVersion}</dd></div> : null}
      <div><dt>Source</dt><dd>{source}</dd></div>
      {plugin.origin?.type === "claude-marketplace" && repository ? <div><dt>Repository</dt><dd><RepositoryLink repository={repository} /></dd></div> : null}
      {publication ? <div><dt>Explore</dt><dd>{publication.status === "listed" ? "Published" : "Unlisted"} · v{publication.version}</dd></div>
        : canStartPublication ? <div><dt>Explore</dt><dd>Not published</dd></div> : null}
    </dl>
    {plugin.installed ? <div className="plugin-section-actions">
      <button className="plugin-detail-secondary" type="button" disabled={updating} onClick={() => onToggle(!plugin.enabled)}>{plugin.enabled ? "Disable" : "Enable"}</button>
      {plugin.source.type !== "builtIn" ? <button className="plugin-detail-secondary" type="button" disabled={updating} onClick={() => {
        if (window.confirm(`Uninstall “${plugin.displayName}”?`)) onRemove();
      }}>Uninstall</button> : null}
      {canBrowse ? <button className="plugin-detail-secondary" type="button" disabled={updating} onClick={onBrowse}>Open folder</button> : null}
      {publication?.status === "listed" ? <button className="plugin-detail-secondary" type="button" disabled={updating} onClick={() => {
        if (window.confirm(`Remove “${plugin.displayName}” from Explore? Existing installations will keep working.`)) onSetPublicationStatus("unlisted");
      }}>Unpublish</button> : null}
    </div> : null}
  </section>;
}

function RepositoryLink({ repository }: { repository: string }): ReactNode {
  return <a href={`https://github.com/${repository}`} target="_blank" rel="noreferrer">GitHub · {repository}<ExternalLink size={11} /></a>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong";
}
