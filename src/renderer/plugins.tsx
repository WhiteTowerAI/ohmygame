import { AddMcpPluginDialog, PluginAssistantDialog, PluginConfigurationPanel, PluginMcpPanel } from "./plugin-controls.js";
import {
  ChevronRight,
  ExternalLink,
  FolderPlus,
  FolderOpen,
  GitBranch,
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
  type PluginComponentSummary,
  type PluginDetail,
  type InstallPluginRequest,
  type PluginInstallCandidate,
  type PluginSettings,
  type PluginSummary,
} from "../shared/plugins.js";
import type { ProjectState } from "../shared/contracts.js";
import { inspectPluginSource, installPlugin, listPlugins, listProjects, readPlugin, readPluginSkill, uninstallPlugin, updatePluginSettings, waitForRuntime } from "./api.js";
import { SidebarPageHeader } from "./sidebar-page.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";
import { GodotIcon } from "./godot-icon.js";
import { MarkdownContent } from "./markdown-content.js";

export function PluginsSettings({ pluginId, onPluginChange, onTryPlugin }: {
  pluginId?: string;
  onPluginChange: (pluginId?: string) => void;
  onTryPlugin: (plugin: PluginDetail, prompt: string, projectId?: string) => Promise<void>;
}) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [detailResult, setDetailResult] = useState<{ pluginId: string; plugin?: PluginDetail; error?: string }>();
  const [detailRetry, setDetailRetry] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [updating, setUpdating] = useState<string>();
  const [adding, setAdding] = useState<"install">();
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

  useEffect(() => { void load(); }, [catalogRetry]);
  useEffect(() => {
    setDetailResult(undefined);
    setError(undefined);
    if (!pluginId) return;
    let disposed = false;
    void (async () => {
      try {
        await waitForRuntime();
        if (disposed) return;
        const plugin = await readPlugin(pluginId);
        if (!disposed) setDetailResult({ pluginId, plugin });
      } catch (cause) {
        if (!disposed) setDetailResult({ pluginId, error: errorMessage(cause) });
      }
    })();
    return () => { disposed = true; };
  }, [pluginId, detailRetry]);

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

  async function updatePlugin(plugin: PluginDetail, settings: PluginSettings): Promise<void> {
    if (updating) return;
    setUpdating(plugin.id);
    setError(undefined);
    try {
      const updated = await updatePluginSettings(plugin.id, settings);
      setDetailResult((current) => current?.pluginId === updated.id ? { pluginId: updated.id, plugin: updated } : current);
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
      await load();
      showCatalog();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdating(undefined);
    }
  }

  function capabilitiesChanged(): void { setCatalogRetry(v => v + 1); setDetailRetry(v => v + 1); }

  async function installFromFolder(): Promise<void> {
    setAddMenuOpen(false);
    setError(undefined);
    try {
      const selected = await window.ohMyGameDesktop?.selectPluginDirectory();
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
      onPluginChange(installedPlugin.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAdding(undefined);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visible = plugins.filter((plugin) => pluginSearchText(plugin).includes(normalizedQuery));
  const installed = visible.filter((plugin) => plugin.installed);
  const currentDetail = detailResult?.pluginId === pluginId ? detailResult : undefined;
  const detail = currentDetail?.plugin;
  const detailTitle = pluginId
    ? detail?.displayName ?? plugins.find((plugin) => plugin.id === pluginId)?.displayName ?? "Plugin"
    : undefined;

  return <section className="plugins-settings">
    <SidebarPageHeader
      title={detailTitle ?? "Plugins"}
      breadcrumb={pluginId ? { label: "Plugins", onClick: showCatalog } : undefined}
    >
      {!pluginId ? (
        <div className="plugins-toolbar">
          <label className="plugins-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins..." aria-label="Search plugins" />
          </label>
          <div className="plugins-add" ref={addMenu}>
            <button className="settings-add-button" type="button" disabled={Boolean(adding)} aria-haspopup="menu" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((current) => !current)}>{adding ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}{adding ? "Installing..." : "Add plugin"}</button>
            {addMenuOpen ? <div className="plugins-add-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); setAssistantOpen(true); }}><Package size={14} /><span><strong>Create with AI</strong><small>Build a plugin with the agent</small></span></button>
              <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); setMcpOpen(true); }}><Plug size={14} /><span><strong>Add MCP service...</strong><small>Connect tools through a plugin</small></span></button>
              {window.ohMyGameDesktop ? <button type="button" role="menuitem" onClick={() => void installFromFolder()}><FolderOpen size={14} /><span><strong>Install from folder...</strong><small>Choose a local plugin directory</small></span></button> : null}
              <button type="button" role="menuitem" onClick={openGitInstallDialog}><GitBranch size={14} /><span><strong>Install from Git...</strong><small>Clone a public HTTPS repository</small></span></button>
            </div> : null}
          </div>
        </div>
      ) : null}
    </SidebarPageHeader>
    {pluginId ? <PluginDetailView
      key={pluginId}
      phase={!currentDetail ? "loading" : currentDetail.error ? "error" : "ready"}
      plugin={detail}
      updating={updating === detail?.id}
      error={currentDetail?.error ?? error}
      onRetry={() => setDetailRetry((current) => current + 1)}
      onTogglePlugin={(enabled) => detail && void updatePlugin(detail, { ...componentSettings(detail), enabled })}
      onToggleComponent={(component, enabled) => detail && void updatePlugin(detail, {
        enabled: detail.enabled,
        components: { ...componentSettings(detail).components, [pluginComponentKey("skill", component.id)]: enabled },
      })}
      onBrowse={() => detail && void browsePlugin(detail)}
      onBrowseSkill={(skillId) => detail && void browsePluginSkill(detail.id, skillId)}
      onRemove={() => detail && void removePlugin(detail)}
      onCapabilitiesChanged={capabilitiesChanged}
      onAssist={() => setAssistantOpen(true)}
      onMcpToggle={(id, enabled) => detail && void updatePlugin(detail, { enabled: detail.enabled, components: { ...componentSettings(detail).components, [pluginComponentKey("mcp", id)]: enabled } })}
      onTry={onTryPlugin}
    /> : <>
      {phase === "ready" && ((!gitDialogOpen && error) || catalogWarning) ? <p className="plugins-inline-error" role="alert">{!gitDialogOpen && error ? error : catalogWarning}</p> : null}
      {phase === "loading" ? <PluginState>Loading plugins</PluginState> : null}
      {phase === "error" ? <PluginError message={error} onRetry={() => void load()} /> : null}
      {phase === "ready" ? <>
        <InstalledPlugins
          plugins={installed}
          collapsible={!normalizedQuery}
          onOpenPlugin={onPluginChange}
        />
      </> : null}
    </>}
    {assistantOpen ? <PluginAssistantDialog pluginId={pluginId} onClose={() => { setAssistantOpen(false); capabilitiesChanged(); }} onChanged={capabilitiesChanged} /> : null}
    {mcpOpen ? <AddMcpPluginDialog onClose={() => setMcpOpen(false)} onInstalled={id => { setMcpOpen(false); capabilitiesChanged(); onPluginChange(id); }} /> : null}
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
  </section>;

  function showCatalog(): void {
    onPluginChange();
  }

  async function browsePlugin(plugin: Pick<PluginSummary, "id">): Promise<void> {
    setError(undefined);
    try {
      await window.ohMyGameDesktop?.browsePluginDirectory(plugin.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function browsePluginSkill(pluginId: string, skillId: string): Promise<void> {
    setError(undefined);
    try {
      await window.ohMyGameDesktop?.revealPluginSkill(pluginId, skillId);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
}

const INSTALLED_PLUGIN_LIMIT = 6;

function InstalledPlugins({ plugins, collapsible, onOpenPlugin }: {
  plugins: PluginSummary[];
  collapsible: boolean;
  onOpenPlugin: (id: string) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const limited = collapsible && !expanded && plugins.length > INSTALLED_PLUGIN_LIMIT;
  const displayed = limited ? plugins.slice(0, INSTALLED_PLUGIN_LIMIT) : plugins;
  return <section className="plugins-installed" aria-labelledby="installed-plugins-title">
    <h2 id="installed-plugins-title">Installed</h2>
    {plugins.length ? <div className="plugins-installed-grid">
      {displayed.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} onOpen={() => onOpenPlugin(plugin.id)} />)}
    </div> : <p className="plugins-empty">No installed plugins match your search.</p>}
    {collapsible && plugins.length > INSTALLED_PLUGIN_LIMIT ? <button className="plugins-show-more" type="button" onClick={() => setExpanded((current) => !current)}>{expanded ? "Show less" : `Show more (${plugins.length - INSTALLED_PLUGIN_LIMIT})`}</button> : null}
  </section>;
}

function PluginCard({ plugin, onOpen }: { plugin: PluginSummary; onOpen: () => void }): ReactNode {
  return <article className={`plugin-catalog-card${plugin.installed && !plugin.enabled ? " is-disabled" : ""}`}>
    <button className="plugin-card-open" type="button" onClick={onOpen}>
      <PluginIcon plugin={plugin} />
      <span className="plugin-card-copy">
        <span className="plugin-card-title"><strong>{plugin.displayName}</strong>{plugin.configurationStatus === "needs-configuration" ? <small className="plugin-status">Needs configuration</small> : null}{plugin.installed && !plugin.enabled ? <small className="plugin-status">Disabled</small> : null}</span>
        <span className="plugin-card-description">{plugin.description}</span>
      </span>
    </button>
  </article>;
}

function PluginDetailView({ phase, plugin, updating, error, onRetry, onTogglePlugin, onToggleComponent, onBrowse, onBrowseSkill, onRemove, onTry, onCapabilitiesChanged, onMcpToggle, onAssist }: {
  phase: "loading" | "ready" | "error";
  plugin?: PluginDetail;
  updating: boolean;
  error?: string;
  onRetry: () => void;
  onTogglePlugin: (enabled: boolean) => void;
  onToggleComponent: (component: PluginComponentSummary, enabled: boolean) => void;
  onBrowse: () => void;
  onBrowseSkill: (skillId: string) => void;
  onRemove: () => void;
  onCapabilitiesChanged: () => void;
  onMcpToggle: (id: string, enabled: boolean) => void;
  onAssist: () => void;
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
        <div className="plugin-detail-copy">
          <div className="plugin-detail-title">
            <h2>{plugin.displayName}</h2>
            {plugin.preinstalled ? <small className="plugin-detail-badge">Included</small> : null}
          </div>
          <p>{plugin.description}</p>
          <div className="plugin-detail-hero-actions" ref={tryMenu}>
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
        </div>
      </header>
      {error ? <p className="plugins-inline-error" role="alert">{error}</p> : null}
      <PluginManagement plugin={plugin} updating={updating} onBrowse={onBrowse} onRemove={onRemove} onToggle={togglePlugin} />
      {plugin.longDescription ? <section className="plugin-about"><h2>About</h2><p>{plugin.longDescription}</p></section> : null}
      {prompts.length ? <section className="plugin-prompts">
        <h2>Try it</h2>
        <div>{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => choosePrompt(prompt)}>
          <span className="plugin-prompt-copy">
            <span className="plugin-prompt-reference">{plugin.id === "ohmygame:godot" ? <GodotIcon size={14} /> : <Package size={14} aria-hidden="true" />}{plugin.displayName}</span>
            <span className="plugin-prompt-text">{prompt}</span>
          </span>
          <ChevronRight size={14} />
        </button>)}</div>
        {tryNotice ? <p role="status">{tryNotice}</p> : null}
      </section> : null}
      <SkillSection pluginId={plugin.id} items={plugin.skills} installed={plugin.installed} disabled={updating || !plugin.enabled} onBrowse={onBrowseSkill} onToggle={onToggleComponent} />
      <PluginConfigurationPanel plugin={plugin} onChanged={onCapabilitiesChanged} />
      <PluginMcpPanel plugin={plugin} onToggle={onMcpToggle} onAssist={onAssist} onChanged={onCapabilitiesChanged} />
      {!plugin.mcpServers?.length && !plugin.connections.length ? <button type="button" onClick={onAssist}>Configure with AI</button> : null}
    </> : null}
  </section>;
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
        {installed && window.ohMyGameDesktop ? <button className="plugin-skill-browse" type="button" title="Show in Finder" aria-label={`Show ${item.name} in Finder`} onClick={() => onBrowse(item.id)}><FolderOpen size={14} /></button> : null}
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
      ...(plugin.mcpServers ?? []).map(item => [pluginComponentKey("mcp", item.id), item.enabled]),
    ]),
  };
}

function pluginSummary(plugin: PluginDetail): PluginSummary {
  const { longDescription: _longDescription, skills: _skills, connections: _connections, defaultPrompts: _defaultPrompts, projectTypes: _projectTypes, mcpServers: _mcpServers, mcpConfigPath: _mcpConfigPath, configuration: _configuration, ...summary } = plugin;
  return summary;
}

function PluginIcon({ plugin, large = false }: { plugin: Pick<PluginSummary, "id" | "source">; large?: boolean }): ReactNode {
  const size = large ? 42 : 29;
  const godot = plugin.id === "ohmygame:godot";
  return <span className={`plugin-row-icon plugin-row-icon-${godot ? "godot" : "media"}${large ? " plugin-row-icon-large" : ""}`}>{godot ? <GodotIcon size={size} /> : plugin.source.type !== "builtIn" ? <Package size={size} /> : <WandSparkles size={size} />}</span>;
}

function pluginSearchText(plugin: PluginSummary): string {
  return `${plugin.name} ${plugin.displayName} ${plugin.description} ${plugin.marketplace.displayName}`.toLowerCase();
}

function PluginManagement({ plugin, updating, onBrowse, onRemove, onToggle }: {
  plugin: PluginDetail;
  updating: boolean;
  onBrowse: () => void;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
}): ReactNode {
  const repository = plugin.origin?.repository;
  const version = plugin.version;
  const canBrowse = (plugin.source.type === "directory" || plugin.source.type === "git") && Boolean(window.ohMyGameDesktop);
  let source: ReactNode;
  if (plugin.preinstalled || plugin.source.type === "builtIn") {
    source = "Included with OhMyGame";
  } else if (plugin.origin?.type === "github") {
    source = <RepositoryLink repository={plugin.origin.repository} />;
  } else if (plugin.origin?.type === "claude-marketplace") {
    source = `Claude Marketplace · ${plugin.origin.marketplace}`;
  } else if (plugin.source.type === "preinstalled") {
    source = "Included with OhMyGame";
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
      <div><dt>Source</dt><dd>{source}</dd></div>
      {plugin.origin?.type === "claude-marketplace" && repository ? <div><dt>Repository</dt><dd><RepositoryLink repository={repository} /></dd></div> : null}
    </dl>
    {plugin.installed ? <div className="plugin-section-actions">
      <button className="plugin-detail-secondary" type="button" disabled={updating} onClick={() => onToggle(!plugin.enabled)}>{plugin.enabled ? "Disable" : "Enable"}</button>
      {plugin.source.type !== "builtIn" ? <button className="plugin-detail-secondary" type="button" disabled={updating} onClick={() => {
        if (window.confirm(`Uninstall “${plugin.displayName}”?`)) onRemove();
      }}>Uninstall</button> : null}
      {canBrowse ? <button className="plugin-detail-secondary" type="button" disabled={updating} onClick={onBrowse}>Open folder</button> : null}
    </div> : null}
  </section>;
}

function RepositoryLink({ repository }: { repository: string }): ReactNode {
  return <a href={`https://github.com/${repository}`} target="_blank" rel="noreferrer">GitHub · {repository}<ExternalLink size={11} /></a>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong";
}
