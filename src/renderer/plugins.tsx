import {
  ArrowLeft,
  ChevronRight,
  Gamepad2,
  LoaderCircle,
  FolderOpen,
  Package,
  Plus,
  Plug,
  Search,
  SlidersHorizontal,
  Trash2,
  WandSparkles,
} from "./icons.js";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  pluginComponentKey,
  type ConfigurablePluginComponentType,
  type PluginComponentSummary,
  type PluginDetail,
  type PluginSettings,
  type PluginSummary,
} from "../shared/plugins.js";
import { listPlugins, readPlugin, removeLocalPlugin, updatePluginSettings, waitForRuntime } from "./api.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";

type PluginsView = { type: "catalog" } | { type: "manage" } | { type: "detail"; pluginId: string };

export function PluginsPage({ onNavigate, onAddPlugin }: {
  onNavigate: (page: AppNavigationTarget) => void;
  onAddPlugin: () => Promise<void>;
}) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [view, setView] = useState<PluginsView>({ type: "catalog" });
  const [detail, setDetail] = useState<PluginDetail>();
  const [detailPhase, setDetailPhase] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [updating, setUpdating] = useState<string>();
  const [adding, setAdding] = useState(false);
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

  async function removePlugin(plugin: PluginDetail): Promise<void> {
    if (updating || plugin.source.type !== "local") return;
    setUpdating(plugin.id);
    setError(undefined);
    try {
      await removeLocalPlugin(plugin.id);
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
    setAdding(true);
    setError(undefined);
    try {
      await onAddPlugin();
    } catch (cause) {
      setError(errorMessage(cause));
      setAdding(false);
    }
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visible = plugins.filter((plugin) => pluginSearchText(plugin).includes(normalizedQuery));
  const installed = visible.filter((plugin) => plugin.installed);
  const available = visible.filter((plugin) => !plugin.installed);

  return <SidebarPageLayout active="plugins" onNavigate={onNavigate}>
    <SidebarPageHeader title="Plugins">
      {view.type === "catalog" ? (
        <form className="plugins-search" onSubmit={(event: FormEvent) => { event.preventDefault(); setSearchQuery(query.trim()); }}>
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins..." aria-label="Search plugins" />
        </form>
      ) : null}
    </SidebarPageHeader>
    {view.type === "manage" ? <ManagePlugins
      plugins={plugins.filter((plugin) => plugin.installed)}
      updating={updating}
      error={error}
      onBack={() => setView({ type: "catalog" })}
      onOpenPlugin={(id) => void openPlugin(id)}
      onToggle={(plugin) => void toggleSummary(plugin)}
    /> : view.type === "detail" ? <PluginDetailView
      phase={detailPhase}
      plugin={detail}
      updating={updating === detail?.id}
      error={error}
      onBack={() => setView({ type: "catalog" })}
      onRetry={() => void openPlugin(view.pluginId)}
      onToggleComponent={(type, component, enabled) => detail && void updatePlugin(detail, {
        enabled: detail.enabled,
        components: { ...componentSettings(detail).components, [pluginComponentKey(type, component.id)]: enabled },
      })}
      onBrowse={() => detail && void browsePlugin(detail)}
      onRemove={() => detail && void removePlugin(detail)}
    /> : <>
      {phase === "ready" && (error || catalogWarning) ? <p className="plugins-inline-error" role="alert">{error ?? catalogWarning}</p> : null}
      {phase === "loading" ? <PluginState>Loading plugins</PluginState> : null}
      {phase === "error" ? <PluginError message={error} onRetry={() => void load()} /> : null}
      {phase === "ready" ? <>
        <InstalledPlugins
          plugins={installed}
          adding={adding}
          onAdd={() => void addPlugin()}
          onManage={() => setView({ type: "manage" })}
          onOpenPlugin={(id) => void openPlugin(id)}
        />
        <ExplorePlugins plugins={available} onOpenPlugin={(id) => void openPlugin(id)} />
      </> : null}
    </>}
  </SidebarPageLayout>;

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

  async function browsePlugin(plugin: PluginDetail): Promise<void> {
    setError(undefined);
    try {
      await window.openGameDesktop?.browsePluginDirectory(plugin.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
}

function InstalledPlugins({ plugins, adding, onAdd, onManage, onOpenPlugin }: {
  plugins: PluginSummary[];
  adding: boolean;
  onAdd: () => void;
  onManage: () => void;
  onOpenPlugin: (id: string) => void;
}): ReactNode {
  return <section className="plugins-installed" aria-labelledby="installed-plugins-title">
    <header>
      <h2 id="installed-plugins-title">Installed</h2>
      <span className="plugins-installed-actions">
        <button type="button" disabled={adding} onClick={onAdd}>{adding ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}{adding ? "Opening..." : "Add plugin"}</button>
        {plugins.length ? <button type="button" onClick={onManage}><SlidersHorizontal size={13} />Manage</button> : null}
      </span>
    </header>
    {plugins.length ? <div className="plugins-installed-scroll">
      {plugins.map((plugin) => <button className="plugin-installed-card" type="button" key={plugin.id} onClick={() => onOpenPlugin(plugin.id)}><PluginIcon plugin={plugin} /><strong>{plugin.displayName}</strong></button>)}
    </div> : <p className="plugins-empty">No installed plugins match your search.</p>}
  </section>;
}

function ExplorePlugins({ plugins, onOpenPlugin }: { plugins: PluginSummary[]; onOpenPlugin: (id: string) => void }): ReactNode {
  return <section className="plugins-explore" aria-labelledby="explore-plugins-title">
    <header className="plugins-section-heading"><h2 id="explore-plugins-title">Explore</h2><span>Discover more capabilities for your agent.</span></header>
    {plugins.length ? <div className="plugins-explore-grid">{plugins.map((plugin) => <button className="plugin-row plugin-row-main" type="button" key={plugin.id} onClick={() => onOpenPlugin(plugin.id)}><PluginIcon plugin={plugin} /><span className="plugin-row-copy"><strong>{plugin.displayName}</strong><span>{plugin.description}</span></span><ChevronRight size={15} /></button>)}</div> : <p className="plugins-empty">No additional plugins available.</p>}
  </section>;
}

function ManagePlugins({ plugins, updating, error, onBack, onOpenPlugin, onToggle }: {
  plugins: PluginSummary[];
  updating?: string;
  error?: string;
  onBack: () => void;
  onOpenPlugin: (id: string) => void;
  onToggle: (plugin: PluginSummary) => void;
}): ReactNode {
  return <section className="plugins-manage" aria-labelledby="plugins-manage-title">
    <button className="plugins-back" type="button" onClick={onBack}><ArrowLeft size={14} />Back to Plugins</button>
    <h2 className="plugins-manage-title" id="plugins-manage-title">Manage plugins</h2>
    {error ? <p className="plugins-inline-error" role="alert">{error}</p> : null}
    <div className="plugins-manage-list">{plugins.map((plugin) => <div className="plugin-row plugin-manage-heading" key={plugin.id}>
      <button className="plugin-row-main" type="button" onClick={() => onOpenPlugin(plugin.id)}><PluginIcon plugin={plugin} /><span className="plugin-row-copy"><strong>{plugin.displayName}</strong><span>{plugin.description}</span></span></button>
      <PluginSwitch checked={plugin.enabled} disabled={updating === plugin.id} label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.displayName}`} onClick={() => onToggle(plugin)} />
    </div>)}</div>
  </section>;
}

function PluginDetailView({ phase, plugin, updating, error, onBack, onRetry, onToggleComponent, onBrowse, onRemove }: {
  phase: "loading" | "ready" | "error";
  plugin?: PluginDetail;
  updating: boolean;
  error?: string;
  onBack: () => void;
  onRetry: () => void;
  onToggleComponent: (type: ConfigurablePluginComponentType, component: PluginComponentSummary, enabled: boolean) => void;
  onBrowse: () => void;
  onRemove: () => void;
}): ReactNode {
  return <section className="plugin-detail">
    <button className="plugins-back" type="button" onClick={onBack}><ArrowLeft size={14} />Back to Plugins</button>
    {phase === "loading" ? <PluginState>Loading plugin</PluginState> : null}
    {phase === "error" ? <PluginError message={error} onRetry={onRetry} /> : null}
    {phase === "ready" && plugin ? <>
      <header className="plugin-detail-hero">
        <PluginIcon plugin={plugin} large />
        <div><h2>{plugin.displayName}</h2><p>{plugin.description}</p><span>{plugin.marketplace.displayName}{plugin.version ? ` · v${plugin.version}` : ""}</span></div>
        {plugin.source.type === "local" ? <span className="plugin-detail-actions">
          {window.openGameDesktop ? <button type="button" disabled={updating} onClick={onBrowse}><FolderOpen size={13} />Browse directory</button> : null}
          <button type="button" disabled={updating} onClick={onRemove}><Trash2 size={13} />Remove</button>
        </span> : null}
      </header>
      {error ? <p className="plugins-inline-error" role="alert">{error}</p> : null}
      <ComponentSection title="Skills" items={plugin.skills} icon={() => <WandSparkles size={15} />} updating={updating} type="skill" onToggle={onToggleComponent} />
      <ComponentSection title="Connections" items={plugin.connections} icon={() => <Plug size={15} />} updating={updating} type="connection" onToggle={onToggleComponent} />
    </> : null}
  </section>;
}

function ComponentSection({ title, items, icon, updating, type, onToggle }: {
  title: string;
  items: PluginComponentSummary[];
  icon: (item: PluginComponentSummary) => ReactNode;
  updating: boolean;
  type: ConfigurablePluginComponentType;
  onToggle: (type: ConfigurablePluginComponentType, component: PluginComponentSummary, enabled: boolean) => void;
}): ReactNode {
  if (!items.length) return null;
  return <section className="plugin-components"><h2>{title}</h2><div>{items.map((item) => <div className="plugin-component-row" key={item.id}>
    <span className="plugin-component-icon">{icon(item)}</span>
    <span className="plugin-row-copy"><strong>{item.name}</strong>{item.description ? <span>{item.description}</span> : null}</span>
    <PluginSwitch checked={item.enabled} disabled={updating} label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`} onClick={() => onToggle(type, item, !item.enabled)} />
  </div>)}</div></section>;
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
      ...plugin.connections.map((item) => [pluginComponentKey("connection", item.id), item.enabled]),
    ]),
  };
}

function pluginSummary(plugin: PluginDetail): PluginSummary {
  const { skills: _skills, connections: _connections, ...summary } = plugin;
  return summary;
}

function PluginIcon({ plugin, large = false }: { plugin: Pick<PluginSummary, "id">; large?: boolean }): ReactNode {
  const size = large ? 22 : 17;
  const godot = plugin.id === "opengame:godot";
  return <span className={`plugin-row-icon plugin-row-icon-${godot ? "godot" : "media"}${large ? " plugin-row-icon-large" : ""}`}>{godot ? <Gamepad2 size={size} /> : plugin.id.startsWith("local:") ? <Package size={size} /> : <WandSparkles size={size} />}</span>;
}

function pluginSearchText(plugin: PluginSummary): string {
  return `${plugin.name} ${plugin.displayName} ${plugin.description}`.toLowerCase();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong";
}
