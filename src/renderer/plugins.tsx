import { PluginIntegrationPanel } from "./plugin-integration.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { AddMcpPluginDialog, PluginConfigurationPanel, PluginMcpPanel, PluginUninstallButton } from "./plugin-controls.js";
import { PluginBuilderSessions } from "./plugin-builder.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import {
  BadgeCheck,
  ChevronLeft,
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
  Sparkles,
  WandSparkles,
} from "./icons.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PLUGIN_CONTRIBUTIONS,
  pluginComponentKey,
  pluginCollection,
  pluginContributions,
  type PluginComponentSummary,
  type PluginContribution,
  type PluginDetail,
  type InstallPluginRequest,
  type PluginInstallCandidate,
  type PluginSettings,
  type PluginSummary,
} from "../shared/plugins.js";
import { PROJECT_TYPE_IDS, type ProjectState, type ProjectType } from "../shared/contracts.js";
import { inspectPluginSource, installPlugin, listPlugins, listProjects, readPlugin, readPluginSkill, uninstallPlugin, updatePluginSettings, waitForRuntime } from "./api.js";
import { SidebarPageHeader } from "./sidebar-page.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";
import { PluginGlyph } from "./plugin-icons.js";
import { MarkdownContent } from "./markdown-content.js";
import { t } from "./i18n.js";
import { PluginDependencyPanel, PluginExportButton, PluginImportDialog } from "./plugin-portability.js";
import { Alert, Badge, Button, Dialog, DropdownMenu, Empty, Field, IconButton, Input, SearchInput, Select, Spinner, Switch, Tabs, type MenuEntry } from "./ui/index.js";
import "./plugins.css";

const PLUGIN_CATEGORIES = [
  { id: "creation", plugins: ["ohmygame:game-studio", "ohmygame:web-game-studio", "ohmygame:threejs-world"] },
  { id: "engines", plugins: ["ohmygame:godot", "ohmygame:taptap-maker", "ohmygame:cocos-creator", "ohmygame:unity", "ohmygame:unreal-engine", "ohmygame:wechat-minigame", "ohmygame:douyin-minigame"] },
  { id: "assets", plugins: ["ohmygame:blender", "ohmygame:img2threejs", "ohmygame:aseprite", "ohmygame:tiled"] },
  { id: "other", plugins: [] },
] as const;
const PLUGIN_ORDER: readonly string[] = PLUGIN_CATEGORIES.flatMap(category => [...category.plugins]);

type CatalogTab = "installed" | "browse" | "skills";
type BrowseSource = "all" | "public" | "personal";
type SkillEntry = { plugin: PluginDetail; skill: PluginComponentSummary };

function pluginCategory(plugin: PluginSummary) {
  return PLUGIN_CATEGORIES.find(category => category.plugins.some(id => id === plugin.id))?.id ?? "other";
}

function compareCatalogPlugins(left: PluginSummary, right: PluginSummary): number {
  const rank = (id: string) => {
    const index = PLUGIN_ORDER.indexOf(id);
    return index < 0 ? PLUGIN_ORDER.length : index;
  };
  return rank(left.id) - rank(right.id) || left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id);
}

export function PluginsSettings({ pluginId, onPluginChange, onTryPlugin }: {
  pluginId?: string;
  onPluginChange: (pluginId?: string) => void;
  onTryPlugin: (plugin: PluginDetail, prompt: string, projectId?: string) => Promise<void>;
}) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [catalogGeneration, setCatalogGeneration] = useState(0);
  const [detailResult, setDetailResult] = useState<{ pluginId: string; plugin?: PluginDetail; error?: string }>();
  const [detailRetry, setDetailRetry] = useState(0);
  const detailRequest = useRef({ pluginId, retry: detailRetry });
  const [skillCatalog, setSkillCatalog] = useState<{ generation: number; plugins: PluginDetail[]; error?: string }>();
  const [mcpOpen, setMcpOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [tab, setTab] = useState<CatalogTab>("installed");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<BrowseSource>("all");
  const [worksWith, setWorksWith] = useState<ProjectType | "all">("all");
  const [adds, setAdds] = useState<PluginContribution | "all">("all");
  const [updating, setUpdating] = useState<string>();
  const [adding, setAdding] = useState<"install">();
  const [gitDialogOpen, setGitDialogOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [installSource, setInstallSource] = useState<InstallPluginRequest>();
  const [installCandidates, setInstallCandidates] = useState<PluginInstallCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<string>();
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
      setCatalogGeneration(current => current + 1);
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, [catalogRetry, serviceGeneration]);
  useEffect(() => {
    const explicitReload = detailRequest.current.pluginId !== pluginId || detailRequest.current.retry !== detailRetry;
    detailRequest.current = { pluginId, retry: detailRetry };
    // A service refresh keeps an already loaded configuration and its unsaved fields.
    if (!explicitReload && detailResult?.plugin && detailResult.pluginId === pluginId) return;
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
  }, [pluginId, detailRetry, serviceGeneration]);
  // Skills live in each plugin's details, so the Skills tab reads them once per catalog load.
  useEffect(() => {
    if (pluginId || tab !== "skills" || phase !== "ready" || skillCatalog?.generation === catalogGeneration) return;
    let disposed = false;
    const generation = catalogGeneration;
    void Promise.allSettled(plugins.map(plugin => readPlugin(plugin.id))).then(results => {
      if (disposed) return;
      const failure = results.find(result => result.status === "rejected");
      setSkillCatalog({
        generation,
        plugins: results.flatMap(result => result.status === "fulfilled" ? [result.value] : []),
        error: failure ? errorMessage(failure.reason) : undefined,
      });
    });
    return () => { disposed = true; };
  }, [pluginId, tab, phase, catalogGeneration]);

  async function updatePlugin(plugin: Pick<PluginDetail, "id">, settings: PluginSettings): Promise<void> {
    if (updating) return;
    setUpdating(plugin.id);
    setError(undefined);
    try {
      const updated = await updatePluginSettings(plugin.id, settings);
      setDetailResult((current) => current?.pluginId === updated.id ? { pluginId: updated.id, plugin: updated } : current);
      setPlugins((items) => items.map((item) => item.id === updated.id ? pluginSummary(updated) : item));
      setSkillCatalog((current) => current && { ...current, plugins: current.plugins.map((item) => item.id === updated.id ? updated : item) });
      if (updated.enabled && updated.integration) onPluginChange(updated.id);
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
      // Reload like the other ways of adding a plugin, so Skills shows its skills too.
      capabilitiesChanged();
      closeInstallDialog();
      onPluginChange(installedPlugin.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAdding(undefined);
    }
  }

  function createWithAi(): void {
    void openPluginBuilder().catch(cause => setError(errorMessage(cause)));
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matching = plugins.filter(plugin => pluginSearchText(plugin).includes(normalizedQuery)).sort(compareCatalogPlugins);
  const publicPlugins = matching.filter(plugin => pluginCollection(plugin) === "public");
  const personalPlugins = matching.filter(plugin => pluginCollection(plugin) === "personal");
  const browsed = matching.filter(plugin => (source === "all" || pluginCollection(plugin) === source)
    && (worksWith === "all" || !plugin.projectTypes?.length || plugin.projectTypes.includes(worksWith))
    && (adds === "all" || pluginContributions(plugin).includes(adds)));
  const skills: SkillEntry[] = skillCatalog
    ? [...skillCatalog.plugins].sort(compareCatalogPlugins).flatMap(plugin => plugin.skills.map(skill => ({ plugin, skill })))
    : [];
  const visibleSkills = skills.filter(({ plugin, skill }) => `${skill.name} ${skill.description ?? ""} ${plugin.displayName}`.toLowerCase().includes(normalizedQuery));
  const addMenuItems: MenuEntry[] = [
    { label: t("plugins.createWithAi"), description: t("plugins.createWithAiHint"), icon: <Sparkles size={14} />, onSelect: createWithAi },
    { label: t("plugins.addMcp"), description: t("plugins.addMcpHint"), icon: <Plug size={14} />, onSelect: () => setMcpOpen(true) },
    "separator",
    ...(typeof window !== "undefined" && window.ohMyGameDesktop ? [{ label: t("plugins.fromFolder"), description: t("plugins.fromFolderHint"), icon: <FolderOpen size={14} />, onSelect: () => void installFromFolder() }] : []),
    { label: t("plugins.fromGit"), description: t("plugins.fromGitHint"), icon: <GitBranch size={14} />, onSelect: openGitInstallDialog },
    { label: t("pluginPortability.import"), description: t("pluginPortability.importMenuHint"), icon: <Package size={14} />, onSelect: () => setImportOpen(true) },
  ];
  const currentDetail = detailResult?.pluginId === pluginId ? detailResult : undefined;
  const detail = currentDetail?.plugin;
  const searchCopy = tab === "skills"
    ? { placeholder: t("plugins.searchSkills"), label: t("plugins.searchSkillsLabel") }
    : { placeholder: t("plugins.search"), label: t("plugins.searchLabel") };
  const createCard = (kind: "plugin" | "skill") => <button type="button" className="plugin-card plugin-card-create" onClick={createWithAi}>
    <span className="plugin-tile"><Sparkles size={18} /></span>
    <span className="plugin-card-text">
      <strong>{kind === "skill" ? t("plugins.createSkillWithAi") : t("plugins.createPluginWithAi")}</strong>
      <small>{t("plugins.createWithAiHint")}</small>
    </span>
  </button>;
  const togglePluginCard = (plugin: PluginSummary, enabled: boolean) => void updatePlugin(plugin, { enabled, components: {} });

  const installedTab = normalizedQuery ? (
    matching.length ? <PluginGrid plugins={matching} updating={Boolean(updating)} onOpen={onPluginChange} onToggle={togglePluginCard} />
      : <Empty title={t("plugins.noMatch")} />
  ) : <>
    {PLUGIN_CATEGORIES.map(category => ({ id: category.id, plugins: publicPlugins.filter(plugin => pluginCategory(plugin) === category.id) }))
      .filter(group => group.plugins.length)
      .map(group => <PluginGroup key={group.id} title={t(`plugins.categories.${group.id}`)} plugins={group.plugins}
        updating={Boolean(updating)} onOpen={onPluginChange} onToggle={togglePluginCard} />)}
    <section className="plugins-section" aria-label={t("plugins.personal")}>
      <h2>{t("plugins.personal")} <span className="plugins-count">{personalPlugins.length}</span></h2>
      <div className="plugins-grid">
        {personalPlugins.map(plugin => <PluginCard key={plugin.id} plugin={plugin} disabled={Boolean(updating)}
          onToggle={enabled => togglePluginCard(plugin, enabled)} onOpen={() => onPluginChange(plugin.id)} />)}
        {createCard("plugin")}
      </div>
    </section>
    <PluginBuilderSessions />
  </>;

  const browseTab = <>
    <div className="plugins-filters">
      <Select<BrowseSource> size="sm" label={t("plugins.sourceFilter")} value={source} onChange={setSource} options={[
        { value: "all", label: t("plugins.allSources") },
        { value: "public", label: t("plugins.officialSource") },
        { value: "personal", label: t("plugins.otherSources") },
      ]} />
      <Select<ProjectType | "all"> size="sm" label={t("plugins.worksWith")} value={worksWith} onChange={setWorksWith} options={[
        { value: "all", label: t("plugins.allProjectTypes") },
        ...PROJECT_TYPE_IDS.map(type => ({ value: type, label: projectTypeLabel(type) })),
      ]} />
      <Select<PluginContribution | "all"> size="sm" label={t("plugins.addsFilter")} value={adds} onChange={setAdds} options={[
        { value: "all", label: t("plugins.allContributions") },
        ...PLUGIN_CONTRIBUTIONS.map(kind => ({ value: kind, label: t(`plugins.contributions.${kind}`) })),
      ]} />
    </div>
    {browsed.length ? <div className="plugins-grid">
      {browsed.map(plugin => <BrowseCard key={plugin.id} plugin={plugin} onOpen={() => onPluginChange(plugin.id)} />)}
    </div> : <Empty title={t("plugins.noMatch")} description={t("plugins.browseEmpty")} action={<div className="plugins-empty-actions">
      <Button icon={<GitBranch size={14} />} onClick={openGitInstallDialog}>{t("plugins.installFromGit")}</Button>
      <Button icon={<Sparkles size={14} />} onClick={createWithAi}>{t("plugins.createWithAi")}</Button>
    </div>} />}
  </>;

  const skillCard = ({ plugin, skill }: SkillEntry) => {
    const pluginEnabled = plugin.installed && plugin.enabled;
    return <article key={`${plugin.id}:${skill.id}`} className={`plugin-card${pluginEnabled && skill.enabled ? "" : " is-off"}`}>
      <button type="button" className="plugin-card-link" onClick={() => onPluginChange(plugin.id)}>
        <PluginTile plugin={plugin} />
        <span className="plugin-card-text">
          <strong className="plugins-mono">{skill.name}</strong>
          {skill.description ? <small>{skill.description}</small> : null}
          <small>{t("plugins.fromPlugin", { name: plugin.displayName })}</small>
        </span>
      </button>
      {plugin.installed ? <Switch size="sm" checked={pluginEnabled && skill.enabled} disabled={Boolean(updating) || !plugin.enabled}
        label={skill.enabled ? t("plugins.disableName", { name: skill.name }) : t("plugins.enableName", { name: skill.name })}
        onChange={enabled => void updatePlugin(plugin, {
          enabled: plugin.enabled,
          components: { ...componentSettings(plugin).components, [pluginComponentKey("skill", skill.id)]: enabled },
        })} /> : null}
    </article>;
  };
  const publicSkills = visibleSkills.filter(entry => pluginCollection(entry.plugin) === "public");
  const personalSkills = visibleSkills.filter(entry => pluginCollection(entry.plugin) === "personal");
  const skillsTab = !skillCatalog ? <PluginState>{t("plugins.loadingSkills")}</PluginState> : <>
    {skillCatalog.error ? <Alert tone="danger" title={skillCatalog.error} /> : null}
    {normalizedQuery && !visibleSkills.length ? <Empty title={t("plugins.noMatchingSkills")} /> : <>
      {publicSkills.length ? <section className="plugins-section" aria-label={t("plugins.fromPlugins")}>
        <h2>{t("plugins.fromPlugins")} <span className="plugins-count">{publicSkills.length}</span></h2>
        <div className="plugins-grid">{publicSkills.map(skillCard)}</div>
      </section> : null}
      <section className="plugins-section" aria-label={t("plugins.personal")}>
        <h2>{t("plugins.personal")} <span className="plugins-count">{personalSkills.length}</span></h2>
        <div className="plugins-grid">
          {personalSkills.map(skillCard)}
          {createCard("skill")}
        </div>
      </section>
    </>}
  </>;

  return <section className="plugins-page">
    {pluginId ? <>
      <div className="plugins-back">
        <Button variant="ghost" icon={<ChevronLeft size={14} />} onClick={showCatalog}>{t("plugins.title")}</Button>
      </div>
      <PluginDetailView
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
        onAssist={() => void openPluginBuilder(pluginId).catch(cause => setError(errorMessage(cause)))}
        onMcpToggle={(id, enabled) => detail && void updatePlugin(detail, { enabled: detail.enabled, components: { ...componentSettings(detail).components, [pluginComponentKey("mcp", id)]: enabled } })}
        onTry={onTryPlugin}
      />
    </> : <>
      <SidebarPageHeader title={t("plugins.title")} actions={<div className="plugins-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder={searchCopy.placeholder} label={searchCopy.label} />
        <DropdownMenu placement="bottom-end" items={addMenuItems} trigger={(props) => (
          <Button {...props} variant="primary" disabled={Boolean(adding)} icon={adding ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}>{adding ? t("plugins.installing") : t("plugins.add")}</Button>
        )} />
      </div>} />
      <Tabs<CatalogTab> variant="pills" label={t("plugins.title")} value={tab} onChange={setTab} tabs={[
        { value: "installed", label: t("plugins.installedTab"), count: phase === "ready" ? plugins.length : undefined },
        { value: "browse", label: t("plugins.browseTab") },
        { value: "skills", label: t("plugins.skills"), count: skillCatalog ? skills.length : undefined },
      ]} />
      <div className="plugins-panel" role="tabpanel" aria-label={tab === "installed" ? t("plugins.installedTab") : tab === "browse" ? t("plugins.browseTab") : t("plugins.skills")}>
        {phase === "ready" && ((!gitDialogOpen && error) || catalogWarning) ? <Alert tone="danger" title={!gitDialogOpen && error ? error : catalogWarning} /> : null}
        {phase === "loading" ? <PluginState>{t("plugins.loading")}</PluginState> : null}
        {phase === "error" ? <PluginError message={error} onRetry={() => void load()} /> : null}
        {phase === "ready" ? tab === "browse" ? browseTab : tab === "skills" ? skillsTab : installedTab : null}
      </div>
    </>}
    {mcpOpen ? <AddMcpPluginDialog onClose={() => setMcpOpen(false)} onInstalled={id => { setMcpOpen(false); capabilitiesChanged(); onPluginChange(id); }} /> : null}
    {importOpen ? <PluginImportDialog onClose={() => setImportOpen(false)} onInstalled={plugin => { setImportOpen(false); capabilitiesChanged(); onPluginChange(plugin.id); }} /> : null}
    <Dialog open={gitDialogOpen} onClose={() => { if (!adding) closeInstallDialog(); }}
      title={installCandidates.length ? t("plugins.choose") : t("plugins.installFromGit")}
      description={installCandidates.length ? t("plugins.selectFrom", { marketplace: installCandidates[0]!.marketplace.displayName }) : t("plugins.enterUrl")}
      footer={<>
        <Button disabled={Boolean(adding)} onClick={closeInstallDialog}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" form="plugin-install-form" disabled={Boolean(adding) || (installCandidates.length ? !selectedCandidate : !gitUrl.trim())}
          icon={adding === "install" ? <LoaderCircle className="spin" size={14} /> : undefined}>{adding === "install" ? t("plugins.installing") : t("plugins.install")}</Button>
      </>}>
      <form id="plugin-install-form" className="plugins-install-form" onSubmit={(event) => { event.preventDefault(); void installFromGit(); }}>
        {installCandidates.length ? <div className="plugin-install-candidates" role="radiogroup" aria-label={t("plugins.title")}>
          {installCandidates.map((candidate) => <button type="button" role="radio" aria-checked={selectedCandidate === candidate.key} className={selectedCandidate === candidate.key ? "is-selected" : ""} key={candidate.key} onClick={() => setSelectedCandidate(candidate.key)}>
            <span><strong>{candidate.displayName}</strong><small>{candidate.description}</small></span>
            <span className="plugin-install-candidate-meta"><small>{t("plugins.skillCount", { count: candidate.skillCount })}</small><span className="plugin-install-candidate-radio" aria-hidden="true" /></span>
          </button>)}
        </div> : <Field label={t("plugins.repositoryUrl")}>{(props) => <Input {...props} autoFocus type="url" required disabled={Boolean(adding)} value={gitUrl}
          placeholder="https://github.com/example/plugin" onChange={(event) => setGitUrl(event.target.value)} />}</Field>}
        {error ? <Alert tone="danger" title={error} /> : null}
      </form>
    </Dialog>
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

/** A category of installed plugins: its first six cards, and the rest behind View all. */
function PluginGroup({ title, plugins, updating, onOpen, onToggle }: {
  title: string;
  plugins: PluginSummary[];
  updating: boolean;
  onOpen: (id: string) => void;
  onToggle: (plugin: PluginSummary, enabled: boolean) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const limited = !expanded && plugins.length > INSTALLED_PLUGIN_LIMIT;
  return <section className="plugins-section" aria-label={title}>
    <h2>{title} <span className="plugins-count">{plugins.length}</span></h2>
    <PluginGrid plugins={limited ? plugins.slice(0, INSTALLED_PLUGIN_LIMIT) : plugins} updating={updating} onOpen={onOpen} onToggle={onToggle} />
    {plugins.length > INSTALLED_PLUGIN_LIMIT ? <div><Button variant="ghost" size="sm" onClick={() => setExpanded((current) => !current)}>
      {expanded ? t("plugins.showLess") : t("plugins.viewAll", { count: plugins.length })}
    </Button></div> : null}
  </section>;
}

function PluginGrid({ plugins, updating, onOpen, onToggle }: {
  plugins: PluginSummary[];
  updating: boolean;
  onOpen: (id: string) => void;
  onToggle: (plugin: PluginSummary, enabled: boolean) => void;
}): ReactNode {
  return <div className="plugins-grid">
    {plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} disabled={updating} onToggle={enabled => onToggle(plugin, enabled)} onOpen={() => onOpen(plugin.id)} />)}
  </div>;
}

function PluginTile({ plugin, large = false }: { plugin: Parameters<typeof PluginGlyph>[0]["plugin"]; large?: boolean }): ReactNode {
  return <span className={`plugin-tile${large ? " plugin-tile-large" : ""}`}><PluginGlyph plugin={plugin} size={large ? 40 : 24} /></span>;
}

function PluginBadges({ plugin }: { plugin: PluginSummary }): ReactNode {
  return <>
    {plugin.beta ? <Badge tone="outline">{t("plugins.beta")}</Badge> : null}
    {plugin.configurationStatus === "needs-configuration" ? <Badge tone="outline">{t("plugins.needsConfiguration")}</Badge> : null}
  </>;
}

// The switch sits beside the card's button, not inside it.
function PluginCard({ plugin, disabled, onToggle, onOpen }: { plugin: PluginSummary; disabled: boolean; onToggle: (enabled: boolean) => void; onOpen: () => void }): ReactNode {
  return <article className={`plugin-card${plugin.installed && !plugin.enabled ? " is-off" : ""}`}>
    <button className="plugin-card-link" type="button" onClick={onOpen}>
      <PluginTile plugin={plugin} />
      <span className="plugin-card-text">
        <strong><span className="plugin-card-name">{plugin.displayName}</span><PluginBadges plugin={plugin} /></strong>
        <small>{plugin.description}</small>
        <PluginMeta plugin={plugin} />
      </span>
    </button>
    {plugin.installed ? <Switch size="sm" checked={plugin.enabled} disabled={disabled}
      label={`${plugin.enabled ? t("common.disable") : t("common.enable")} ${plugin.displayName}`} onChange={onToggle} /> : null}
  </article>;
}

/** Where an installed plugin applies and what it adds. */
function PluginMeta({ plugin }: { plugin: PluginSummary }): ReactNode {
  return <span className="plugins-meta">
    <span>{plugin.projectTypes?.length ? t("plugins.scopeTyped") : t("plugins.scopeAll")}</span>
    <PluginTags plugin={plugin} />
  </span>;
}

function PluginTags({ plugin }: { plugin: PluginSummary }): ReactNode {
  return <>
    {plugin.projectTypes?.map(type => <span key={type} className="plugins-tag">{projectTypeLabel(type)}</span>)}
    {pluginContributions(plugin).map(kind => <span key={kind} className="plugins-tag">
      {kind === "skills" ? t("plugins.skillCount", { count: plugin.skillCount }) : t(`plugins.contributions.${kind}`)}
    </span>)}
  </>;
}

/** A catalog listing: where it comes from, what it works with, and whether it is installed. */
function BrowseCard({ plugin, onOpen }: { plugin: PluginSummary; onOpen: () => void }): ReactNode {
  const official = pluginCollection(plugin) === "public";
  return <article className="plugin-card">
    <button className="plugin-card-link" type="button" onClick={onOpen}>
      <PluginTile plugin={plugin} />
      <span className="plugin-card-text">
        <strong>
          <span className="plugin-card-name">{plugin.displayName}</span>
          {official ? <BadgeCheck size={14} className="plugins-verified" aria-label={t("plugins.official")} /> : null}
          {plugin.beta ? <Badge tone="outline">{t("plugins.beta")}</Badge> : null}
        </strong>
        <small>{plugin.description}</small>
        <span className="plugins-meta">
          <span>{official ? t("plugins.officialSource") : plugin.marketplace.displayName}</span>
          <PluginTags plugin={plugin} />
        </span>
      </span>
    </button>
    {plugin.installed ? <span className="plugins-installed-label">{t("plugins.installed")}</span> : null}
  </article>;
}

type DetailTab = "about" | "skills" | "settings";

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
  const [tab, setTab] = useState<DetailTab>();
  const [tryPrompt, setTryPrompt] = useState<string>();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [projectPhase, setProjectPhase] = useState<"loading" | "ready" | "error" | "starting">("loading");
  const [projectError, setProjectError] = useState<string>();
  const [projectQuery, setProjectQuery] = useState("");
  const [actionError, setActionError] = useState<string>();
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

  function togglePlugin(enabled: boolean): void {
    setTryPrompt(undefined);
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

  if (phase === "loading") return <PluginState>{t("plugins.loadingPlugin")}</PluginState>;
  if (phase === "error" || !plugin) return <PluginError message={error} onRetry={onRetry} />;

  const normalizedProjectQuery = projectQuery.trim().toLowerCase();
  const visibleProjects = projects.filter((project) => !normalizedProjectQuery || project.name.toLowerCase().includes(normalizedProjectQuery));
  const prompts = plugin.defaultPrompts ?? [];
  const firstPrompt = prompts[0];
  const canTry = plugin.installed && plugin.enabled;
  const emptyProjectLabel = normalizedProjectQuery
    ? t("plugins.noMatchingProjects")
    : plugin.projectTypes?.length === 1 ? t("plugins.noTypedProjects", { type: projectTypeLabel(plugin.projectTypes[0]) }) : t("plugins.noCompatibleProjects");
  const tabs: { value: DetailTab; label: string; count?: number }[] = [
    ...(plugin.longDescription || prompts.length ? [{ value: "about" as const, label: t("plugins.about") }] : []),
    ...(plugin.skills.length ? [{ value: "skills" as const, label: t("plugins.skills"), count: plugin.skills.length }] : []),
    { value: "settings", label: t("common.settings") },
  ];
  // Open on what needs attention: settings while required values are missing.
  const shown = tab && tabs.some(item => item.value === tab) ? tab
    : plugin.configurationStatus === "needs-configuration" ? "settings" : tabs[0]!.value;
  const personal = pluginCollection(plugin) === "personal";

  return <div className="plugin-page">
    <header className="plugin-head">
      <PluginTile plugin={plugin} large />
      <div className="plugin-head-copy">
        <h1>
          <span>{plugin.displayName}</span>
          {plugin.beta ? <Badge tone="outline">{t("plugins.beta")}</Badge> : null}
          {plugin.preinstalled ? <Badge tone="outline">{t("plugins.included")}</Badge> : null}
        </h1>
        <p>{plugin.description}</p>
      </div>
      {canTry && firstPrompt ? <div className="plugin-head-actions" ref={tryMenu}>
        <Button variant="primary" icon={<Play size={14} />} aria-haspopup="dialog" aria-expanded={Boolean(tryPrompt)}
          onClick={() => void openProjectPicker(firstPrompt)}>{t("plugins.tryNow")}</Button>
        {tryPrompt ? <div className="plugin-try-popover project-switcher-popover" role="dialog" aria-label={t("plugins.tryName", { name: plugin.displayName })}>
          <div className="plugin-try-heading"><strong>{t("plugins.chooseProject")}</strong><span>{t("plugins.promptAdded")}</span></div>
          <label className="project-switcher-search">
            <Search size={13} />
            <input value={projectQuery} placeholder={t("projects.search")} aria-label={t("projects.search")} onChange={(event) => setProjectQuery(event.target.value)} />
          </label>
          <div className="project-switcher-list">
            {projectPhase === "loading" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />{t("projects.loading")}</div> : null}
            {projectPhase === "error" ? <div className="project-switcher-state is-error"><span>{projectError}</span><button type="button" onClick={() => void openProjectPicker(tryPrompt)}>{t("common.retry")}</button></div> : null}
            {projectPhase === "starting" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />{t("plugins.startingConversation")}</div> : null}
            {projectPhase === "ready" ? visibleProjects.map((project) => <button className="project-switcher-item" type="button" key={project.id} onClick={() => void startPlugin(project.id)}>
              <ProjectTypeIcon type={project.type} />
              <span><strong>{project.name}</strong><small>{projectTypeLabel(project.type)}</small></span>
              <ChevronRight size={13} />
            </button>) : null}
            {projectPhase === "ready" && !visibleProjects.length ? <div className="project-switcher-state">{emptyProjectLabel}</div> : null}
          </div>
          <div className="project-switcher-footer"><button type="button" disabled={projectPhase === "starting"} onClick={() => void startPlugin()}><FolderPlus size={14} />{t("plugins.newProject", { type: projectTypeLabel(plugin.projectTypes?.[0] ?? "web-game") })}</button></div>
        </div> : null}
      </div> : null}
    </header>
    {error || actionError ? <Alert tone="danger" title={error ?? actionError} /> : null}

    <div className="plugin-layout">
      <div className="plugin-main">
        {tabs.length > 1 ? <Tabs<DetailTab> variant="pills" label={plugin.displayName} value={shown} onChange={setTab} tabs={tabs} /> : null}
        {/* Every tab stays mounted, so unsaved configuration survives switching tabs. */}
        <div className="plugin-tab" role="tabpanel" aria-label={t("plugins.about")} hidden={shown !== "about"}>
          {plugin.longDescription ? <p className="plugin-long">{plugin.longDescription}</p> : null}
          {prompts.length ? <section className="plugins-section" aria-label={t("plugins.tryIt")}>
            <h2>{t("plugins.tryIt")}</h2>
            <div className="plugin-prompt-list">{prompts.map((prompt) => <button type="button" key={prompt} className="plugin-prompt" disabled={!canTry}
              onClick={() => void openProjectPicker(prompt)}>{prompt}</button>)}</div>
            {!canTry ? <p className="plugins-note" role="status">{plugin.installed ? t("plugins.enableToTry") : t("plugins.installToTry")}</p> : null}
          </section> : null}
        </div>
        <div className="plugin-tab" role="tabpanel" aria-label={t("plugins.skills")} hidden={shown !== "skills"}>
          <SkillSection pluginId={plugin.id} items={plugin.skills} installed={plugin.installed} disabled={updating || !plugin.enabled} onBrowse={onBrowseSkill} onToggle={onToggleComponent} />
        </div>
        <div className="plugin-tab plugin-settings" role="tabpanel" aria-label={t("common.settings")} hidden={shown !== "settings"}>
          <PluginConfigurationPanel plugin={plugin} onChanged={onCapabilitiesChanged} />
          {plugin.enabled && plugin.integration ? <PluginIntegrationPanel key={plugin.id} pluginId={plugin.id} /> : null}
          <PluginMcpPanel plugin={plugin} onToggle={onMcpToggle} onAssist={onAssist} onChanged={onCapabilitiesChanged} />
          <PluginDependencyPanel plugin={plugin} />
        </div>
      </div>
      <PluginManagement plugin={plugin} updating={updating} personal={personal} onBrowse={onBrowse} onRemove={onRemove} onToggle={togglePlugin}
        onAssist={!plugin.mcpServers?.length && !plugin.connections.length ? onAssist : undefined} onError={setActionError} />
    </div>
  </div>;
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
  return <div className="plugin-skill-list">{items.map((item) => {
    const open = expanded?.id === item.id;
    return <div className={`plugin-skill${open ? " is-open" : ""}`} key={item.id}>
      <div className="plugin-skill-row">
        <button className="plugin-skill-open" type="button" aria-expanded={open} onClick={() => toggleContent(item)}>
          <ChevronRight size={14} className="plugin-skill-caret" aria-hidden="true" />
          <span className="plugin-skill-copy"><strong className="plugins-mono">{item.name}</strong>{item.description ? <span>{item.description}</span> : null}</span>
        </button>
        {installed && window.ohMyGameDesktop ? <IconButton size="sm" label={t("plugins.showNameInFinder", { name: item.name })} onClick={() => onBrowse(item.id)}><FolderOpen size={14} /></IconButton> : null}
        {installed ? <Switch size="sm" checked={item.enabled} disabled={disabled} label={item.enabled ? t("plugins.disableName", { name: item.name }) : t("plugins.enableName", { name: item.name })} onChange={enabled => onToggle(item, enabled)} /> : null}
      </div>
      {open ? <div className="plugin-skill-content">
        {expanded.phase === "loading" ? <div className="plugins-state"><Spinner size={14} label={t("plugins.loadingSkill")} />{t("plugins.loadingSkill")}</div> : null}
        {expanded.phase === "error" ? <Alert tone="danger" title={expanded.error} action={<Button size="sm" onClick={() => void loadContent(item)}>{t("common.retry")}</Button>} /> : null}
        {expanded.phase === "ready" ? <MarkdownContent text={expanded.content ?? ""} /> : null}
      </div> : null}
    </div>;
  })}</div>;
}

function PluginState({ children }: { children: ReactNode }): ReactNode {
  return <div className="plugins-state"><Spinner size={14} label={typeof children === "string" ? children : undefined} />{children}</div>;
}

function PluginError({ message, onRetry }: { message?: string; onRetry: () => void }): ReactNode {
  return <Alert tone="danger" title={message ?? t("common.somethingWrong")} action={<Button size="sm" onClick={onRetry}>{t("common.retry")}</Button>} />;
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
  const { longDescription: _longDescription, skills: _skills, connections: _connections, defaultPrompts: _defaultPrompts, mcpServers: _mcpServers, mcpConfigPath: _mcpConfigPath, configuration: _configuration, ...summary } = plugin;
  return summary;
}

function pluginSearchText(plugin: PluginSummary): string {
  return `${plugin.name} ${plugin.displayName} ${plugin.description} ${plugin.marketplace.displayName}`.toLowerCase();
}

/** The side card: state, version and source, then what can be done with the plugin. */
function PluginManagement({ plugin, updating, personal, onBrowse, onRemove, onToggle, onAssist, onError }: {
  plugin: PluginDetail;
  updating: boolean;
  personal: boolean;
  onBrowse: () => void;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
  onAssist?: () => void;
  onError: (message: string) => void;
}): ReactNode {
  const repository = plugin.origin?.repository;
  const version = plugin.version;
  const canBrowse = personal && Boolean(window.ohMyGameDesktop);
  let source: ReactNode;
  if (plugin.preinstalled || plugin.source.type === "builtIn") {
    source = t("plugins.includedWithOhMyGame");
  } else if (plugin.origin?.type === "github") {
    source = <RepositoryLink repository={plugin.origin.repository} />;
  } else if (plugin.origin?.type === "claude-marketplace") {
    source = t("plugins.claudeMarketplace", { marketplace: plugin.origin.marketplace });
  } else if (plugin.source.type === "preinstalled") {
    source = t("plugins.includedWithOhMyGame");
  } else if (plugin.source.type === "authored") {
    source = t("plugins.createdWithAi");
  } else if (plugin.source.type === "archive") {
    source = t("pluginPortability.archiveSource");
  } else if (plugin.source.type === "directory") {
    source = t("plugins.localFolder");
  } else {
    source = t("plugins.gitRepository");
  }
  return <aside className="plugin-side" aria-label={t("plugins.management")}>
    <h2>{t("plugins.management")}</h2>
    <dl className="plugin-props">
      <dt>{t("plugins.status")}</dt>
      <dd className="plugin-state">
        {plugin.installed ? <Switch size="sm" checked={plugin.enabled} disabled={updating}
          label={`${plugin.enabled ? t("common.disable") : t("common.enable")} ${plugin.displayName}`} onChange={onToggle} /> : null}
        {!plugin.installed ? t("plugins.notInstalled") : plugin.enabled ? t("common.enabled") : t("common.disabled")}
      </dd>
      {version ? <><dt>{t("plugins.version")}</dt><dd className="plugins-mono">v{version}</dd></> : null}
      <dt>{t("plugins.source")}</dt><dd>{source}</dd>
      {plugin.origin?.type === "claude-marketplace" && repository ? <><dt>{t("plugins.repository")}</dt><dd><RepositoryLink repository={repository} /></dd></> : null}
    </dl>
    <div className="plugin-side-actions">
      {plugin.installed && personal ? <Button icon={<WandSparkles size={14} />} disabled={updating}
        onClick={() => void openPluginBuilder(plugin.id, "edit").catch(cause => onError(errorMessage(cause)))}>{t("plugins.editWithAi")}</Button> : null}
      {onAssist ? <Button icon={<Sparkles size={14} />} onClick={onAssist}>{t("plugins.askAboutPlugin")}</Button> : null}
      {canBrowse && plugin.installed ? <Button icon={<FolderOpen size={14} />} disabled={updating} onClick={onBrowse}>{t("plugins.openFolder")}</Button> : null}
      {plugin.installed && personal ? <PluginExportButton plugin={plugin} /> : null}
      <PluginUninstallButton plugin={plugin} disabled={updating} onUninstall={onRemove} />
    </div>
  </aside>;
}

function RepositoryLink({ repository }: { repository: string }): ReactNode {
  return <a href={`https://github.com/${repository}`} target="_blank" rel="noreferrer">GitHub · {repository}<ExternalLink size={11} /></a>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}
