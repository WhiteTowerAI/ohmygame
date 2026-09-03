import {
  ChevronRight,
  FolderPlus,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
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
  type PluginComponentSummary,
  type PluginConnectionSummary,
  type PluginDetail,
  type InstallPluginRequest,
  type PluginInstallCandidate,
  type PluginSettings,
  type PluginSummary,
} from "../shared/plugins.js";
import type { ProjectState } from "../shared/contracts.js";
import { inspectPluginSource, installPlugin, listPlugins, listProjects, readPlugin, readPluginSkill, uninstallPlugin, updatePluginSettings, waitForRuntime } from "./api.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";
import { GodotIcon } from "./godot-icon.js";
import { MarkdownContent } from "./markdown-content.js";

type PluginsView = { type: "catalog" } | { type: "detail"; pluginId: string };

export function PluginsPage({ onNavigate, onAddPlugin, onTryPlugin }: {
  onNavigate: (page: AppNavigationTarget) => void;
  onAddPlugin: () => Promise<void>;
  onTryPlugin: (plugin: PluginDetail, prompt: string, projectId?: string) => Promise<void>;
}) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
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
  const addMenu = useRef<HTMLDivElement>(null);
  const [catalogWarning, setCatalogWarning] = useState<string>();
  const [error, setError] = useState<string>();

  async function load(): Promise<void> {
    setPhase("loading");
    setCatalogWarning(undefined);
    setError(undefined);
    try {
      await waitForRuntime();
      const catalog = await listPlugins();
      setPlugins(catalog.plugins);
      setCatalogWarning(catalog.errors.map((entry) => entry.message).join("\n") || undefined);
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

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
    setDetailPhase("loading");
    setError(undefined);
    try {
      setDetail(await readPlugin(pluginId));
      setDetailPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setDetailPhase("error");
    }
  }

  async function updatePlugin(plugin: PluginDetail, settings: PluginSettings): Promise<void> {
    if (updating) return;
    setUpdating(plugin.id);
    setError(undefined);
    try {
      const updated = await updatePluginSettings(plugin.id, settings);
      setDetail((current) => current?.id === updated.id ? updated : current);
      setPlugins((items) => items.map((item) => item.id === updated.id ? pluginSummary(updated) : item));
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
      setPlugins((items) => items.filter((item) => item.id !== plugin.id));
      setDetail(undefined);
      setView({ type: "catalog" });
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
  const available = visible.filter((plugin) => !plugin.installed);
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
              <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); void addPlugin(); }}><Package size={14} /><span><strong>Create plugin</strong><small>Build a plugin with the agent</small></span></button>
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
      onRetry={() => void openPlugin(view.pluginId)}
      onTogglePlugin={(enabled) => detail && void updatePlugin(detail, { ...componentSettings(detail), enabled })}
      onToggleComponent={(component, enabled) => detail && void updatePlugin(detail, {
        enabled: detail.enabled,
        components: { ...componentSettings(detail).components, [pluginComponentKey("skill", component.id)]: enabled },
      })}
      onBrowse={() => detail && void browsePlugin(detail)}
      onRemove={() => detail && void removePlugin(detail)}
      onTry={onTryPlugin}
    /> : <>
      {phase === "ready" && ((!gitDialogOpen && error) || catalogWarning) ? <p className="plugins-inline-error" role="alert">{!gitDialogOpen && error ? error : catalogWarning}</p> : null}
      {phase === "loading" ? <PluginState>Loading plugins</PluginState> : null}
      {phase === "error" ? <PluginError message={error} onRetry={() => void load()} /> : null}
      {phase === "ready" ? <>
        <InstalledPlugins
          plugins={installed}
          collapsible={!normalizedQuery}
          busy={Boolean(updating)}
          onBrowse={(plugin) => void browsePlugin(plugin)}
          onOpenPlugin={(id) => void openPlugin(id)}
          onRemove={(plugin) => void removePlugin(plugin)}
          onToggle={(plugin) => void toggleSummary(plugin)}
        />
        <ExplorePlugins plugins={available} onOpenPlugin={(id) => void openPlugin(id)} />
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
  </SidebarPageLayout>;

  function showCatalog(): void {
    setView({ type: "catalog" });
  }

  async function toggleSummary(plugin: PluginSummary): Promise<void> {
    if (updating) return;
    setUpdating(plugin.id);
    setError(undefined);
    try {
      const full = await readPlugin(plugin.id);
      const updated = await updatePluginSettings(full.id, { ...componentSettings(full), enabled: !full.enabled });
      setPlugins((items) => items.map((item) => item.id === updated.id ? pluginSummary(updated) : item));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdating(undefined);
    }
  }

  async function browsePlugin(plugin: Pick<PluginSummary, "id">): Promise<void> {
    setError(undefined);
    try {
      await window.openGameDesktop?.browsePluginDirectory(plugin.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
}

const INSTALLED_PLUGIN_LIMIT = 6;

function InstalledPlugins({ plugins, collapsible, busy, onBrowse, onOpenPlugin, onRemove, onToggle }: {
  plugins: PluginSummary[];
  collapsible: boolean;
  busy: boolean;
  onBrowse: (plugin: PluginSummary) => void;
  onOpenPlugin: (id: string) => void;
  onRemove: (plugin: PluginSummary) => void;
  onToggle: (plugin: PluginSummary) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const limited = collapsible && !expanded && plugins.length > INSTALLED_PLUGIN_LIMIT;
  const displayed = limited ? plugins.slice(0, INSTALLED_PLUGIN_LIMIT) : plugins;
  return <section className="plugins-installed" aria-labelledby="installed-plugins-title">
    <h2 id="installed-plugins-title">Installed</h2>
    {plugins.length ? <div className="plugins-installed-grid">
      {displayed.map((plugin) => <InstalledPluginCard
        key={plugin.id}
        plugin={plugin}
        busy={busy}
        onBrowse={() => onBrowse(plugin)}
        onOpen={() => onOpenPlugin(plugin.id)}
        onRemove={() => onRemove(plugin)}
        onToggle={() => onToggle(plugin)}
      />)}
    </div> : <p className="plugins-empty">No installed plugins match your search.</p>}
    {collapsible && plugins.length > INSTALLED_PLUGIN_LIMIT ? <button className="plugins-show-more" type="button" onClick={() => setExpanded((current) => !current)}>{expanded ? "Show less" : `Show more (${plugins.length - INSTALLED_PLUGIN_LIMIT})`}</button> : null}
  </section>;
}

function ExplorePlugins({ plugins, onOpenPlugin }: { plugins: PluginSummary[]; onOpenPlugin: (id: string) => void }): ReactNode {
  return <section className="plugins-explore" aria-labelledby="explore-plugins-title">
    <header className="plugins-section-heading"><h2 id="explore-plugins-title">Explore</h2><span>Discover more capabilities for your agent.</span></header>
    {plugins.length ? <div className="plugins-explore-grid">{plugins.map((plugin) => <ExplorePluginCard key={plugin.id} plugin={plugin} onOpen={() => onOpenPlugin(plugin.id)} />)}</div> : <p className="plugins-empty">No additional plugins match your search.</p>}
  </section>;
}

function ExplorePluginCard({ plugin, onOpen }: { plugin: PluginSummary; onOpen: () => void }): ReactNode {
  return <article className="plugin-catalog-card is-trailing">
    <button className="plugin-card-open" type="button" onClick={onOpen}>
      <PluginIcon plugin={plugin} />
      <span className="plugin-card-copy"><strong>{plugin.displayName}</strong><span className="plugin-card-description">{plugin.description}</span><small className="plugin-card-marketplace">{pluginSourceLabel(plugin)}</small></span>
      <ChevronRight size={15} />
    </button>
  </article>;
}

function InstalledPluginCard({ plugin, busy, onBrowse, onOpen, onRemove, onToggle }: {
  plugin: PluginSummary;
  busy: boolean;
  onBrowse: () => void;
  onOpen: () => void;
  onRemove: () => void;
  onToggle: () => void;
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!card.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  return <article className={`plugin-catalog-card has-actions${plugin.enabled ? "" : " is-disabled"}`} ref={card}>
    <button className="plugin-card-open" type="button" onClick={onOpen}>
      <PluginIcon plugin={plugin} />
      <span className="plugin-card-copy">
        <span className="plugin-card-title"><strong>{plugin.displayName}</strong>{plugin.enabled ? null : <small>Disabled</small>}</span>
        <span className="plugin-card-description">{plugin.description}</span>
        <small className="plugin-card-marketplace">{pluginSourceLabel(plugin)}</small>
      </span>
    </button>
    <div className="plugin-card-actions">
      <button className="plugin-card-menu" type="button" disabled={busy} aria-label={`Plugin actions for ${plugin.displayName}`} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((current) => !current)}><MoreHorizontal size={16} /></button>
      {menuOpen ? <div className="plugin-card-actions-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpen(); }}>Open details</button>
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onToggle(); }}>{plugin.enabled ? "Disable" : "Enable"}</button>
        {plugin.source.type !== "builtIn" && window.openGameDesktop ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onBrowse(); }}>Browse directory</button> : null}
        {plugin.source.type !== "builtIn" ? <button className="plugin-card-action-remove" type="button" role="menuitem" onClick={() => {
          setMenuOpen(false);
          if (window.confirm(`Remove “${plugin.displayName}”?`)) onRemove();
        }}>Remove</button> : null}
      </div> : null}
    </div>
  </article>;
}

function PluginDetailView({ phase, plugin, updating, error, onRetry, onTogglePlugin, onToggleComponent, onBrowse, onRemove, onTry }: {
  phase: "loading" | "ready" | "error";
  plugin?: PluginDetail;
  updating: boolean;
  error?: string;
  onRetry: () => void;
  onTogglePlugin: (enabled: boolean) => void;
  onToggleComponent: (component: PluginComponentSummary, enabled: boolean) => void;
  onBrowse: () => void;
  onRemove: () => void;
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
  const emptyProjectLabel = normalizedProjectQuery
    ? "No matching projects"
    : plugin?.projectTypes?.length === 1 ? `No ${projectTypeLabel(plugin.projectTypes[0])} projects yet` : "No compatible projects yet";
  return <section className="plugin-detail">
    {phase === "loading" ? <PluginState>Loading plugin</PluginState> : null}
    {phase === "error" ? <PluginError message={error} onRetry={onRetry} /> : null}
    {phase === "ready" && plugin ? <>
      <header className="plugin-detail-hero">
        <PluginIcon plugin={plugin} large />
        <div className="plugin-detail-copy"><h2>{plugin.displayName}</h2><p>{plugin.description}</p><span>{pluginQualifiedSource(plugin)}{plugin.version ? ` · v${plugin.version}` : ""}</span></div>
        <div className="plugin-detail-hero-actions" ref={tryMenu}>
          <PluginDetailActions
            plugin={plugin}
            updating={updating}
            onBrowse={onBrowse}
            onRemove={onRemove}
            onToggle={togglePlugin}
          />
          {!plugin.installed ? <button className="plugin-detail-primary" type="button" disabled title="Plugin installation is not available yet">Install</button> : null}
          {plugin.installed && !plugin.enabled ? <button className="plugin-detail-primary" type="button" disabled={updating} onClick={() => togglePlugin(true)}>{updating ? <LoaderCircle className="spin" size={13} /> : null}{updating ? "Enabling..." : "Enable"}</button> : null}
          {plugin.installed && plugin.enabled && firstPrompt ? <button className="plugin-detail-primary" type="button" aria-haspopup="dialog" aria-expanded={Boolean(tryPrompt)} onClick={() => choosePrompt(firstPrompt)}><Play size={13} />Try now</button> : null}
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
      </header>
      {error ? <p className="plugins-inline-error" role="alert">{error}</p> : null}
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
      <SkillSection pluginId={plugin.id} items={plugin.skills} disabled={updating || !plugin.enabled} onToggle={onToggleComponent} />
      <ConnectionSection items={plugin.connections} />
    </> : null}
  </section>;
}

function ConnectionSection({ items }: { items: PluginConnectionSummary[] }): ReactNode {
  if (!items.length) return null;
  return <section className="plugin-components"><h2>Connections</h2><div>{items.map((item) => <div className="plugin-component-row" key={item.id}>
    <span className="plugin-component-icon"><Plug size={15} /></span>
    <span className="plugin-row-copy"><strong>{item.name}</strong><span>{item.status === "not-configured" ? "Not configured" : item.status === "disabled" ? "Disabled in Settings" : "Available"}</span></span>
    <button className={`plugin-connection-status is-${item.status ?? "enabled"}`} type="button" onClick={() => { window.location.hash = "#/settings/connections" }}>{item.status === "not-configured" ? "Set up in Settings" : "Manage in Settings"}</button>
  </div>)}</div></section>;
}

function PluginDetailActions({ plugin, updating, onBrowse, onRemove, onToggle }: {
  plugin: PluginDetail;
  updating: boolean;
  onBrowse: () => void;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  if (!plugin.installed) return null;

  return <div className="plugin-detail-menu" ref={menu}>
    <button className="plugin-detail-menu-trigger" type="button" disabled={updating} aria-label={`Plugin actions for ${plugin.displayName}`} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((current) => !current)}><MoreHorizontal size={16} /></button>
    {menuOpen ? <div className="plugin-card-actions-menu plugin-detail-actions-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onToggle(!plugin.enabled); }}>{plugin.enabled ? "Disable plugin" : "Enable plugin"}</button>
      {plugin.source.type !== "builtIn" && window.openGameDesktop ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onBrowse(); }}>Browse directory</button> : null}
      {plugin.source.type !== "builtIn" ? <button className="plugin-card-action-remove" type="button" role="menuitem" onClick={() => {
        setMenuOpen(false);
        if (window.confirm(`Uninstall “${plugin.displayName}”?`)) onRemove();
      }}>Uninstall</button> : null}
    </div> : null}
  </div>;
}

function SkillSection({ pluginId, items, disabled, onToggle }: {
  pluginId: string;
  items: PluginComponentSummary[];
  disabled: boolean;
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
        <PluginSwitch checked={item.enabled} disabled={disabled} label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`} onClick={() => onToggle(item, !item.enabled)} />
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
  const size = large ? 30 : 17;
  const godot = plugin.id === "opengame:godot";
  return <span className={`plugin-row-icon plugin-row-icon-${godot ? "godot" : "media"}${large ? " plugin-row-icon-large" : ""}`}>{godot ? <GodotIcon size={size} /> : plugin.source.type !== "builtIn" ? <Package size={size} /> : <WandSparkles size={size} />}</span>;
}

function pluginSearchText(plugin: PluginSummary): string {
  return `${plugin.name} ${plugin.displayName} ${plugin.description} ${plugin.marketplace.displayName}`.toLowerCase();
}

function pluginSourceLabel(plugin: Pick<PluginSummary, "marketplace">): string {
  return plugin.marketplace.id === "opengame" || plugin.marketplace.id === "personal"
    ? plugin.marketplace.displayName
    : `Marketplace · ${plugin.marketplace.displayName}`;
}

function pluginQualifiedSource(plugin: Pick<PluginSummary, "name" | "marketplace">): string {
  return plugin.marketplace.id === "opengame" || plugin.marketplace.id === "personal"
    ? plugin.marketplace.displayName
    : `${plugin.name}@${plugin.marketplace.id}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong";
}
