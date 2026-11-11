import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NEW_PLUGIN_TITLE, type PluginSetupSummary } from "../shared/plugin-setup.js";
import { deletePluginSetup, installPluginDraft, listPluginSetups, listStorePlugins, readPluginDraft, readPluginSetup, testPluginDraft,
  uninstallStorePlugin, updatePluginDraftIcon, waitForRuntime } from "./api.js";
import { AppRail, RailConversationsItem, type RailConversations } from "./app-sidebar.js";
import type { AppNavigationTarget } from "./routes.js";
import { PluginGlyph } from "./plugin-icons.js";
import { PluginIconPicker } from "./plugin-icon-picker.js";
import { groupStorePlugins, PluginExportDialog, type StorePluginGroup, storePluginSearchText, useEveryProjectSwitch } from "./plugin-store.js";
import { draftCheck, draftCheckLabel, PluginOverview } from "./plugin-builder-overview.js";
import { ProjectFrame, ProjectTop } from "./project-frame.js";
import { ProjectShell, type ProjectWorkspaceView } from "./project-shell.js";
import { pluginBuilderHash, pluginHash, pluginsTabHash } from "./routes.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { Check, CirclePlus, ExternalLink, FileText, LayoutGrid, LoaderCircle, MoreHorizontal, Package,
  Pencil, Plug, RefreshCw, Sparkles, Trash2, Upload, Wrench } from "./icons.js";
import { Alert, Button, Dialog, DropdownMenu, Empty, IconButton, Tooltip, type MenuEntry } from "./ui/index.js";
import "./plugin-builder.css";
import { language, t } from "./i18n.js";

const RECENT_LIMIT = 8;

/**
 * Mine: the plugins the person makes, a card each, as projects are. A plugin
 * made with AI opens its workspace, whose conversations are all about it; a
 * draft not installed yet is one too. One made in a folder (Develop) opens its
 * page. A plugin's newest workspace stands for it, and its menu opens any
 * earlier one.
 */
export function MinePlugins({ plugins, query, onOpenPlugin }: {
  /** Installed plugins the person makes: their own, and those developed from a folder. */
  plugins: readonly StorePluginGroup[];
  /** The page's search, lowercase. */
  query: string;
  onOpenPlugin: (id: string) => void;
}) {
  const generation = useReadyRuntimeGeneration();
  const [sessions, setSessions] = useState<PluginSetupSummary[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void waitForRuntime().then(listPluginSetups).then(items => { if (active) setSessions(items); })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [generation]);
  // Newest first, so each plugin's first workspace is its newest.
  const byPlugin = new Map<string, PluginSetupSummary[]>();
  for (const session of sessions ?? []) if (session.pluginId) byPlugin.set(session.pluginId, [...byPlugin.get(session.pluginId) ?? [], session]);
  const items = [
    ...(sessions ?? []).filter(session => !session.pluginId || byPlugin.get(session.pluginId)![0] === session)
      .map(session => ({ key: session.id, session, group: plugins.find(group => group.plugin.id === session.pluginId),
        earlier: session.pluginId ? byPlugin.get(session.pluginId)!.slice(1) : [] })),
    ...plugins.filter(group => !byPlugin.has(group.plugin.id)).map(group => ({ key: group.plugin.id, session: undefined, group, earlier: [] })),
  ].filter(({ session, group }) => (group ? storePluginSearchText(group.plugin) : workspaceTitle(session!.title).toLowerCase()).includes(query));
  // The plugins show even if the workspaces couldn't be read, or one couldn't be deleted.
  const alert = error ? <Alert tone="danger" title={t("pluginBuilder.loadFailed", { error })} /> : null;
  if ((!sessions && !error) || !items.length) return alert;
  return <section className="plugins-section" aria-label={t("plugins.minePlugins")}>
    <h2>{t("plugins.minePlugins")}<span className="plugins-count">{items.length}</span></h2>
    {alert}
    <div className="plugins-grid">{items.map(item => <MinePluginCard key={item.key} session={item.session} group={item.group} earlier={item.earlier} onOpenPlugin={onOpenPlugin}
      onDeleted={() => { setError(undefined); setSessions(current => current?.filter(session => session.id !== item.session?.id)); }}
      onError={cause => setError(message(cause))} />)}</div>
  </section>;
}

/** A plugin the person makes, which opens where it's made; its menu opens its page or deletes the workspace. */
function MinePluginCard({ session, group, earlier, onOpenPlugin, onDeleted, onError }: {
  session: PluginSetupSummary | undefined;
  group: StorePluginGroup | undefined;
  /** The plugin's other workspaces, newest first. */
  earlier: readonly PluginSetupSummary[];
  onOpenPlugin: (id: string) => void;
  onDeleted: () => void;
  onError: (cause: unknown) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const plugin = group?.plugin;
  const working = session?.status === "working";
  const developed = plugin?.origin?.type === "development";
  const name = plugin?.displayName ?? workspaceTitle(session?.title ?? "");
  const remove = () => {
    if (!session) return;
    setConfirming(false);
    setRemoving(true);
    void deletePluginSetup(session.id).then(onDeleted, cause => {
      onError(cause);
      setRemoving(false);
    });
  };
  // A plugin made with AI whose workspace was deleted gets a new one; one from a folder opens its page.
  const open = () => {
    if (session) window.location.hash = pluginBuilderHash(session.id);
    else if (plugin && !developed) void openPluginBuilder(plugin.id, "edit").catch(onError);
    else if (plugin) onOpenPlugin(plugin.id);
  };
  const status = working ? t("pluginMine.status.working")
    : developed ? t("plugins.inDevelopment")
    : plugin ? t("pluginMine.status.installed", { version: plugin.version })
    : t(session?.status === "ready" ? "pluginMine.status.draft" : "pluginMine.status.idle");
  const date = (time: number) => new Date(time).toLocaleDateString(language, { month: "short", day: "numeric" });
  const updated = session ? date(session.updatedAt) : undefined;
  const menu: MenuEntry[] = [
    // One from a folder opens its page already.
    ...(plugin && (session || !developed) ? [{ label: t("pluginBuilder.open"), icon: <ExternalLink size={14} />, onSelect: () => onOpenPlugin(plugin.id) }] : []),
    ...earlier.map(other => ({ label: t("pluginMine.openEarlier", { date: date(other.updatedAt) }), icon: <Sparkles size={14} />,
      onSelect: () => { window.location.hash = pluginBuilderHash(other.id); } })),
    ...(session ? [
      ...(plugin && (session || !developed) || earlier.length ? ["separator" as const] : []),
      { label: t("pluginBuilder.deleteWorkspace"), icon: <Trash2 size={14} />, danger: true, disabled: working, onSelect: () => setConfirming(true) },
    ] : []),
  ];
  return <article className="plugin-card plugin-mine-card">
    <button type="button" className="plugin-card-link" onClick={open}>
      <span className="plugin-tile">{working ? <LoaderCircle className="spin" size={16} />
        : session && !plugin ? <PluginGlyph plugin={session} size={24} setupId={session.id} name={name} />
        : <PluginGlyph plugin={plugin ?? session!} size={24} name={name} />}</span>
      <span className="plugin-card-text">
        <strong><span className="plugin-card-name">{name}</span></strong>
        <small>{plugin?.description || t(session?.pluginId === undefined && session?.status !== "ready" ? "pluginMine.startHint" : "pluginMine.draftHint")}</small>
        <span className="plugins-meta">
          <span>{status}</span>
          {updated ? <span>{t("pluginMine.edited", { date: updated })}</span> : null}
        </span>
      </span>
    </button>
    {menu.length ? <DropdownMenu placement="bottom-end" items={menu} trigger={(props) => (
      <IconButton {...props} size="sm" disabled={removing} label={t("pluginBuilder.workspaceActions", { title: name })}>
        <MoreHorizontal size={16} />
      </IconButton>
    )} /> : null}
    <Dialog open={confirming} onClose={() => setConfirming(false)} size="sm"
      title={t("pluginBuilder.deleteTitle", { title: name })} description={t(plugin ? "pluginMine.deleteKeepsPlugin" : "pluginBuilder.deleteDescription")}
      footer={<>
        <Button onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={remove}>{t("common.delete")}</Button>
      </>} />
  </article>;
}

/** A new workspace is unnamed, and the daemon's name for that is English. */
function workspaceTitle(title: string): string {
  return title === NEW_PLUGIN_TITLE ? t("pluginBuilder.newPlugin") : title;
}

/** Ways to start, each the opening of a prompt to finish. */
const STARTERS = [
  { id: "skill", icon: FileText }, { id: "panel", icon: LayoutGrid }, { id: "tool", icon: Wrench }, { id: "mcp", icon: Plug },
] as const;

// What the rail last showed: opening another workspace remounts the page, and
// the rail shouldn't empty and refill.
let railSessions: PluginSetupSummary[] = [];

/** The rail: the recent AI workspaces and a new plugin. The rest are on the Plugins page. */
function BuilderRail({ sessionId, revision, conversations, onNavigate, onError }: {
  sessionId: string;
  /** The open workspace's conversations, for its item's hover list. */
  conversations?: RailConversations;
  /** What the rail shows of the open workspace: the list loads again when it changes. */
  revision?: string;
  onNavigate: (page: AppNavigationTarget) => void;
  onError: (cause: unknown) => void;
}) {
  const generation = useReadyRuntimeGeneration();
  const [sessions, setSessions] = useState(railSessions);
  useEffect(() => {
    let active = true;
    void waitForRuntime().then(listPluginSetups).then(next => {
      railSessions = next;
      if (active) setSessions(next);
    }).catch(() => { /* The rail keeps what it has; the page reports a daemon it can't reach. */ });
    return () => { active = false; };
  }, [generation, sessionId, revision]);
  // The list comes newest first; the open workspace stays on it however old.
  const listed = sessions.filter((session, index) => index < RECENT_LIMIT || session.id === sessionId);
  return <AppRail label={t("pluginBuilder.workspaces")} onNavigate={onNavigate}>
    {/* Each lists its conversations on hover, as a project does. */}
    {listed.map(session => <RailConversationsItem key={session.id} className="plugin-builder-rail-item"
      projectId={session.projectId} name={workspaceTitle(session.title)} updatedAt={new Date(session.updatedAt).toISOString()}
      cover={session.status === "working" ? <LoaderCircle className="spin" size={16} /> : <PluginGlyph plugin={session} size={18} setupId={session.id} />}
      hash={pluginBuilderHash(session.id)} conversationHash={id => pluginBuilderHash(session.id, id)}
      open={hash => { window.location.hash = hash; }}
      conversations={session.id === sessionId ? conversations : undefined} />)}
    <Tooltip content={t("pluginBuilder.newPlugin")} placement="right-start">
      <button type="button" className="sidebar-app sidebar-app-new" aria-label={t("pluginBuilder.newPlugin")} onClick={() => void openPluginBuilder().catch(onError)}><CirclePlus size={16} /></button>
    </Tooltip>
  </AppRail>;
}

async function loadBuilderSnapshot(sessionId: string) {
  const summary = await readPluginSetup(sessionId);
  const [draft, stored] = await Promise.all([
    readPluginDraft(sessionId),
    summary.pluginId ? listStorePlugins().then(rows => groupStorePlugins(rows).find(group => group.plugin.id === summary.pluginId)) : undefined,
  ]);
  return { summary, draft, stored };
}
type BuilderSnapshot = Awaited<ReturnType<typeof loadBuilderSnapshot>>;

/**
 * An AI workspace: its project's chat and files, with the plugin's Overview
 * beside them and its own rail and top bar.
 */
export function PluginBuilder({ sessionId, conversationId, onOpenConversation, onNavigate }: {
  sessionId: string;
  conversationId?: string;
  onOpenConversation: (conversationId: string, replace?: boolean) => void;
  onNavigate: (page: AppNavigationTarget) => void;
}) {
  const generation = useReadyRuntimeGeneration();
  const [summary, setSummary] = useState<PluginSetupSummary>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void waitForRuntime().then(() => readPluginSetup(sessionId))
      .then(next => { if (active) setSummary(next); })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [sessionId, generation, retry]);
  const rail = (conversations?: RailConversations) => <BuilderRail sessionId={sessionId} revision={summary && `${summary.title}:${summary.status}:${summary.icon?.path}`}
    conversations={conversations} onNavigate={onNavigate} onError={cause => setError(message(cause))} />;
  if (!summary) return <ProjectFrame rail={rail()} top={null}><div className="plugin-builder-card">
    {error ? <Alert tone="danger" title={error} action={<Button size="sm" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</Button>} />
      : <p className="plugin-builder-working" role="status"><LoaderCircle className="spin" size={13} />{t("pluginBuilder.opening")}</p>}
  </div></ProjectFrame>;
  return <ProjectShell key={summary.projectId} projectId={summary.projectId} conversationId={conversationId} onOpenConversation={onOpenConversation}
    onNavigate={onNavigate} onHome={() => { window.location.hash = pluginsTabHash("mine"); }} homeLabel={t("navigation.backTo", { page: t("plugins.title") })}
    workspace={{
      rail,
      // Once its plugin is installed, a workspace edits it, however it began.
      placeholder: t(summary.mode === "edit" || summary.pluginId ? "pluginBuilder.editPlaceholder" : "pluginBuilder.placeholder"),
      render: view => <BuilderView sessionId={sessionId} view={view} onChange={setSummary} />,
    }} />;
}

/** The workspace's top bar and Overview, which read the draft again as the agent changes it. */
function BuilderView({ sessionId, view, onChange }: { sessionId: string; view: ProjectWorkspaceView; onChange: (summary: PluginSetupSummary) => void }) {
  const [snapshot, setSnapshot] = useState<BuilderSnapshot>();
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<string>();
  const [iconEditing, setIconEditing] = useState(false);
  const [confirming, setConfirming] = useState<"workspace" | "uninstall">();
  const [exporting, setExporting] = useState(false);
  const { summary, draft, stored } = snapshot ?? {};
  const draftPlugin = draft?.plugin;
  const disabled = view.busy || Boolean(operation);
  const upToDate = Boolean(stored && draft?.revision && draft.revision === draft.installedRevision);

  async function refresh() {
    const next = await loadBuilderSnapshot(sessionId);
    setSnapshot(next);
    setError(undefined);
    onChange(next.summary);
  }
  useEffect(() => {
    void refresh().catch(cause => setError(message(cause)));
    // While the agent works, its draft changes under it.
    if (!view.busy) return;
    const timer = window.setInterval(() => void refresh().catch(() => {}), 3000);
    return () => window.clearInterval(timer);
  }, [sessionId, view.revision, view.busy]);
  const everyProject = useEveryProjectSwitch(refresh);

  async function action(name: string, run: () => Promise<void>) {
    if (disabled) return;
    setOperation(name); setError(undefined);
    try { await run(); } catch (cause) { setError(message(cause)); }
    finally { setOperation(undefined); }
  }

  const menu: MenuEntry[] = summary ? [
    ...(draftPlugin && !draft?.errors.length ? [{ label: t("pluginIconPicker.change"), icon: <Pencil size={14} />, disabled, onSelect: () => setIconEditing(true) }] : []),
    ...(stored ? [
      { label: t("pluginBuilder.open"), icon: <ExternalLink size={14} />, onSelect: () => { window.location.hash = pluginHash(summary.pluginId!); } },
      { label: t("pluginStore.export"), icon: <Upload size={14} />, disabled, onSelect: () => setExporting(true) },
    ] : []),
    ...(draftPlugin || stored ? ["separator" as const] : []),
    ...(stored ? [{ label: t("pluginControls.uninstall"), icon: <Package size={14} />, danger: true, disabled, onSelect: () => setConfirming("uninstall") }] : []),
    { label: t(draft?.path ? "pluginBuilder.deleteDraft" : "pluginBuilder.deleteWorkspace"), icon: <Trash2 size={14} />, danger: true, disabled, onSelect: () => setConfirming("workspace") },
  ] : [];
  const notice = error ?? everyProject.error;
  const check = draft?.path ? draftCheck(draft) : undefined;
  const unsaved = Boolean(stored && draft?.revision && !upToDate);
  const status = view.busy ? t("pluginBuilder.status.working") : check ? <>
    <span className={check === "failed" ? "plugin-builder-status-failed" : undefined}>{draftCheckLabel(check)}</span>
    {unsaved ? ` · ${t("pluginBuilder.uninstalledChanges")}` : null}
  </> : undefined;

  return <>
    {createPortal(<ProjectTop name={summary ? workspaceTitle(summary.title) : ""} icon={draftPlugin ? <PluginGlyph plugin={draftPlugin} size={16} setupId={sessionId} /> : undefined}
      menu={menu} status={status}>
      {draftPlugin ? <Button size="sm" variant="primary" disabled={disabled || Boolean(draft?.errors.length) || upToDate}
        icon={operation === "installing" ? <LoaderCircle className="spin" size={14} /> : upToDate ? <Check size={14} /> : <Package size={14} />}
        onClick={() => void action("installing", async () => {
          if (!draft?.revision) return;
          try { await installPluginDraft(sessionId, draft.revision); }
          finally { await refresh(); }
        })}>{upToDate ? t("pluginBuilder.installed") : summary?.pluginId ? t("pluginBuilder.update") : t("pluginBuilder.install")}</Button> : null}
    </ProjectTop>, view.top)}
    {createPortal(<IconButton size="sm" label={t("pluginBuilder.refresh")} disabled={disabled} onClick={() => void action("refreshing", refresh)}>
      <RefreshCw size={14} />
    </IconButton>, view.panel.toolbar)}
    {createPortal(<div className="plugin-builder-panel">
      {notice ? <Alert tone="danger" title={notice} /> : null}
      {draft?.path ? <PluginOverview draft={draft} setupId={sessionId} stored={stored?.plugin} disabled={disabled} operation={operation} everyProject={everyProject}
        onEditIcon={draftPlugin && !draft.errors.length ? () => setIconEditing(true) : undefined} onOpenFile={file => view.openFile(draft.path === "." ? file : `${draft.path}/${file}`)}
        onTest={server => void action(`test:${server}`, async () => {
          if (!draft.revision) return;
          await testPluginDraft(sessionId, server, draft.revision);
          await refresh();
        })} /> : view.busy ? <Empty icon={<Sparkles size={20} />} title={t("pluginBuilder.writingDraft")} />
        : <Empty icon={<Sparkles size={20} />} title={t("pluginBuilder.startTitle")} description={t("pluginBuilder.noDraftHint")} action={<div className="plugin-builder-starters">
          {STARTERS.map(({ id, icon: Icon }) => <Button key={id} variant="ghost" size="sm" icon={<Icon size={14} />} onClick={() => view.ask(t(`pluginBuilder.starter.${id}.prompt`))}>
            {t(`pluginBuilder.starter.${id}.label`)}</Button>)}
        </div>} />}
    </div>, view.panel.body)}
    {exporting && stored ? <PluginExportDialog plugin={stored.plugin} onClose={() => setExporting(false)} /> : null}
    {iconEditing && draftPlugin && draft?.revision ? <PluginIconPicker plugin={draftPlugin} setupId={sessionId} files={draft.files} disabled={disabled} onClose={() => setIconEditing(false)}
      onSave={async change => {
        setOperation("saving-icon");
        try {
          const next = await updatePluginDraftIcon(sessionId, { ...change, revision: draft.revision! });
          setSnapshot(current => current && { ...current, draft: next });
          onChange(await readPluginSetup(sessionId));
        } finally { setOperation(undefined); }
      }} /> : null}
    <Dialog open={confirming !== undefined} onClose={() => setConfirming(undefined)} size="sm"
      title={confirming === "workspace" ? t("pluginBuilder.deleteTitle", { title: workspaceTitle(summary?.title ?? "") }) : t("pluginControls.uninstall")}
      description={confirming === "workspace" ? t("pluginBuilder.deleteDescription") : t("pluginControls.confirmUninstall", { name: stored?.plugin.displayName ?? "" })}
      footer={<>
        <Button onClick={() => setConfirming(undefined)}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => {
          const target = confirming;
          setConfirming(undefined);
          if (target === "workspace") void action("deleting", async () => {
            await deletePluginSetup(sessionId);
            window.location.hash = pluginsTabHash("mine");
          });
          else void action("uninstalling", async () => {
            if (stored) for (const version of stored.versions) await uninstallStorePlugin(stored.plugin.id, version.version);
            await refresh();
          });
        }}>{confirming === "uninstall" ? t("pluginControls.uninstallShort") : t("common.delete")}</Button>
      </>} />
  </>;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
