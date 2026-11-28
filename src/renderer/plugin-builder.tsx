import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NEW_PLUGIN_TITLE, type PluginSetupSummary } from "../shared/plugin-setup.js";
import { allowPluginDraftRun, deletePluginSetup, installPluginDraft, readPluginLog, listPluginSetups, listStorePlugins, readPluginDraft, readPluginSetup, testPluginDraft,
  uninstallStorePlugin, updatePluginDraftIcon, waitForRuntime } from "./api.js";
import { AppRail, RailConversationsItem, type RailConversations } from "./app-sidebar.js";
import type { AppNavigationTarget } from "./routes.js";
import { PluginGlyph } from "./plugin-icons.js";
import { PluginIconPicker } from "./plugin-icon-picker.js";
import { groupStorePlugins, PluginExportDialog, useEveryProjectSwitch } from "./plugin-store.js";
import { draftCheck, draftCheckLabel, PluginOverview } from "./plugin-builder-overview.js";
import { ProjectFrame, ProjectTop } from "./project-frame.js";
import { ProjectShell, type ProjectWorkspaceView } from "./project-shell.js";
import { pluginBuilderHash, pluginHash, pluginsTabHash } from "./routes.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { openPluginBuilder, takePendingBuilderPrompt } from "./plugin-builder-navigation.js";
import { PluginLogDialog } from "./plugin-log.js";
import { PluginPublishDialog } from "./plugin-publish.js";
import { NativeCodeWarning, PluginCapabilityList } from "./plugin-consent-dialog.js";
import type { TryPlugin } from "./plugin-try.js";
import { Bell, Check, CirclePlus, ExternalLink, FileText, FolderPlus, Palette, LayoutGrid, Spinner, Package,
  Pencil, Plug, RefreshCw, Share2, Sparkles, Toolbox, Trash2, Upload } from "./icons.js";
import { Alert, Button, Dialog, Empty, IconButton, Tooltip, useContextMenu, type MenuEntry } from "./ui/index.js";
import "./plugin-builder.css";
import { language, t } from "./i18n.js";

const RECENT_LIMIT = 8;

/**
 * The Plugin Builder's workspaces, newest first, for Installed's Made by you
 * group: a draft not installed yet is a row there, and opens its workspace.
 */
export function usePluginWorkspaces(): { sessions?: PluginSetupSummary[]; error?: string; removed: (id: string) => void } {
  const generation = useReadyRuntimeGeneration();
  const [sessions, setSessions] = useState<PluginSetupSummary[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void waitForRuntime().then(listPluginSetups).then(items => { if (active) { setSessions(items); setError(undefined); } })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [generation]);
  return { ...(sessions ? { sessions } : {}), ...(error ? { error } : {}), removed: (id) => setSessions(current => current?.filter(session => session.id !== id)) };
}

/**
 * The drafts among the workspaces: each plugin's newest workspace whose
 * plugin isn't installed, or a workspace that hasn't made one yet.
 */
export function pluginDrafts(sessions: readonly PluginSetupSummary[], installed: ReadonlySet<string>, query: string): PluginSetupSummary[] {
  const seen = new Set<string>();
  return sessions.filter(session => {
    const key = session.pluginId ?? session.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return !(session.pluginId && installed.has(session.pluginId)) && workspaceTitle(session.title).toLowerCase().includes(query);
  });
}

/** A draft in Installed's list: it opens its workspace, and its menu deletes it. */
export function PluginDraftRow({ session, onDeleted, onError }: {
  session: PluginSetupSummary;
  onDeleted: () => void;
  onError: (cause: unknown) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const working = session.status === "working";
  const name = workspaceTitle(session.title);
  const edited = new Date(session.updatedAt).toLocaleDateString(language, { month: "short", day: "numeric" });
  const context = useContextMenu([{ label: t("pluginBuilder.deleteWorkspace"), icon: <Trash2 size="sm" />, danger: true, disabled: working, onSelect: () => setConfirming(true) }]);
  const remove = () => {
    setConfirming(false);
    void deletePluginSetup(session.id).then(onDeleted, onError);
  };
  return <><li className="installed-plugin-row" onContextMenu={context.onContextMenu}>
    <button className="installed-plugin-open" type="button" onClick={() => { window.location.hash = pluginBuilderHash(session.id); }}>
      <span className="plugin-tile">{working ? <Spinner size="md" /> : <PluginGlyph plugin={session} size={24} setupId={session.id} name={name} />}</span>
      <span className="installed-plugin-label">
        <span className="installed-plugin-title"><span className="installed-plugin-name" title={name}>{name}</span></span>
        <span className="installed-plugin-meta">
          {t(working ? "pluginMine.status.working" : session.status === "idle" ? "pluginMine.status.idle" : "pluginMine.status.draft")}
          {" · "}{t("pluginMine.edited", { date: edited })}
        </span>
      </span>
    </button>
  </li>{context.menu}
  <Dialog open={confirming} onClose={() => setConfirming(false)} size="sm"
    title={t("pluginBuilder.deleteTitle", { title: name })} description={t("pluginBuilder.deleteDescription")}
    footer={<>
      <Button onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
      <Button variant="primary" onClick={remove}>{t("common.delete")}</Button>
    </>} /></>;
}

/** A new workspace is unnamed, and the daemon's name for that is English. */
function workspaceTitle(title: string): string {
  return title === NEW_PLUGIN_TITLE ? t("pluginBuilder.newPlugin") : title;
}

/** Ways to start, each the opening of a prompt to finish. */
const STARTERS = [
  { id: "skill", icon: FileText }, { id: "panel", icon: LayoutGrid }, { id: "tool", icon: Toolbox }, { id: "mcp", icon: Plug },
  { id: "hook", icon: Bell }, { id: "projectType", icon: FolderPlus }, { id: "theme", icon: Palette },
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
      cover={session.status === "working" ? <Spinner size="md" /> : <PluginGlyph plugin={session} size={18} setupId={session.id} />}
      hash={pluginBuilderHash(session.id)} conversationHash={id => pluginBuilderHash(session.id, id)}
      open={hash => { window.location.hash = hash; }}
      conversations={session.id === sessionId ? conversations : undefined} />)}
    <Tooltip content={t("pluginBuilder.newPlugin")} placement="right-start">
      <button type="button" className="sidebar-app sidebar-app-new" aria-label={t("pluginBuilder.newPlugin")} onClick={() => void openPluginBuilder().catch(onError)}><CirclePlus size="md" /></button>
    </Tooltip>
  </AppRail>;
}

async function loadBuilderSnapshot(sessionId: string) {
  const summary = await readPluginSetup(sessionId);
  const [draft, stored, log] = await Promise.all([
    readPluginDraft(sessionId),
    summary.pluginId ? listStorePlugins().then(rows => groupStorePlugins(rows).find(group => group.plugin.id === summary.pluginId)) : undefined,
    // What the installed version got wrong, in projects, since the app started.
    summary.pluginId ? readPluginLog(summary.pluginId).catch(() => undefined) : undefined,
  ]);
  return { summary, draft, stored, logErrors: log?.entries.filter(entry => entry.level === "error").length ?? 0 };
}
type BuilderSnapshot = Awaited<ReturnType<typeof loadBuilderSnapshot>>;

/**
 * An AI workspace: its project's chat and files, with the plugin's Overview
 * beside them and its own rail and top bar.
 */
export function PluginBuilder({ sessionId, conversationId, onOpenConversation, onNavigate, onTryPlugin }: {
  sessionId: string;
  conversationId?: string;
  onOpenConversation: (conversationId: string, replace?: boolean) => void;
  onNavigate: (page: AppNavigationTarget) => void;
  /** Tries the installed plugin in a project, as its page does. */
  onTryPlugin?: TryPlugin;
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
      : <p className="plugin-builder-working" role="status"><Spinner size="sm" />{t("pluginBuilder.opening")}</p>}
  </div></ProjectFrame>;
  return <ProjectShell key={summary.projectId} projectId={summary.projectId} conversationId={conversationId} onOpenConversation={onOpenConversation}
    onNavigate={onNavigate} onHome={() => { window.location.hash = pluginsTabHash("installed"); }} homeLabel={t("navigation.backTo", { page: t("plugins.title") })}
    workspace={{
      rail,
      // Once its plugin is installed, a workspace edits it, however it began.
      placeholder: t(summary.mode === "edit" || summary.pluginId ? "pluginBuilder.editPlaceholder" : "pluginBuilder.placeholder"),
      render: view => <BuilderView sessionId={sessionId} view={view} onChange={setSummary} onTryPlugin={onTryPlugin} />,
    }} />;
}

/** The workspace's top bar and Overview, which read the draft again as the agent changes it. */
function BuilderView({ sessionId, view, onChange, onTryPlugin }: {
  sessionId: string; view: ProjectWorkspaceView; onChange: (summary: PluginSetupSummary) => void; onTryPlugin?: TryPlugin;
}) {
  const [snapshot, setSnapshot] = useState<BuilderSnapshot>();
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<string>();
  const [iconEditing, setIconEditing] = useState(false);
  const [confirming, setConfirming] = useState<"workspace" | "uninstall" | "more-asks">();
  const [exporting, setExporting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const { summary, draft, stored, logErrors } = snapshot ?? {};
  // A request left by Fix with AI elsewhere waits in the composer.
  useEffect(() => {
    const prompt = takePendingBuilderPrompt(sessionId);
    if (prompt) view.ask(prompt);
  }, [sessionId]);
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

  const install = () => void action("installing", async () => {
    if (!draft?.revision) return;
    try { await installPluginDraft(sessionId, draft.revision); }
    finally { await refresh(); }
  });
  const menu: MenuEntry[] = summary ? [
    ...(draftPlugin && !draft?.errors.length ? [{ label: t("pluginIconPicker.change"), icon: <Pencil size="sm" />, disabled, onSelect: () => setIconEditing(true) }] : []),
    ...(stored ? [
      { label: t("pluginBuilder.open"), icon: <ExternalLink size="sm" />, onSelect: () => { window.location.hash = pluginHash(summary.pluginId!); } },
      { label: t("pluginBuilder.publish.action"), icon: <Share2 size="sm" />, disabled, onSelect: () => setPublishing(true) },
      { label: t("pluginStore.export"), icon: <Upload size="sm" />, disabled, onSelect: () => setExporting(true) },
      { label: t("pluginLog.viewLog"), icon: <FileText size="sm" />, onSelect: () => setLogOpen(true) },
    ] : []),
    ...(draftPlugin || stored ? ["separator" as const] : []),
    ...(stored ? [{ label: t("pluginControls.uninstall"), icon: <Package size="sm" />, danger: true, disabled, onSelect: () => setConfirming("uninstall") }] : []),
    { label: t(draft?.path ? "pluginBuilder.deleteDraft" : "pluginBuilder.deleteWorkspace"), icon: <Trash2 size="sm" />, danger: true, disabled, onSelect: () => setConfirming("workspace") },
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
        icon={operation === "installing" ? <Spinner size="sm" /> : upToDate ? <Check size="sm" /> : <Package size="sm" />}
        onClick={() => {
          // An update that asks for more says so before it is allowed.
          if (draft?.update?.asks.added.length) setConfirming("more-asks");
          else install();
        }}>{upToDate ? t("pluginBuilder.installed") : summary?.pluginId ? t("pluginBuilder.update") : t("pluginBuilder.install")}</Button> : null}
    </ProjectTop>, view.top)}
    {createPortal(<IconButton size="sm" label={t("pluginBuilder.refresh")} disabled={disabled} onClick={() => void action("refreshing", refresh)}>
      <RefreshCw size="sm" />
    </IconButton>, view.panel.toolbar)}
    {createPortal(<div className="plugin-builder-panel">
      {notice ? <Alert tone="danger" title={notice} /> : null}
      {stored && logErrors ? <Alert tone="danger" title={t("pluginBuilder.installedErrors", { count: logErrors })}
        action={<Button size="sm" onClick={() => setLogOpen(true)}>{t("pluginLog.viewLog")}</Button>} /> : null}
      {draft?.path ? <PluginOverview draft={draft} setupId={sessionId} stored={stored?.plugin} disabled={disabled} operation={operation} everyProject={everyProject}
        onEditIcon={draftPlugin && !draft.errors.length ? () => setIconEditing(true) : undefined} onOpenFile={file => view.openFile(draft.path === "." ? file : `${draft.path}/${file}`)}
        onTest={server => void action(`test:${server}`, async () => {
          if (!draft.revision) return;
          await testPluginDraft(sessionId, server, draft.revision);
          await refresh();
        })}
        // What is tried is what was reviewed: only once the draft is the installed version.
        {...(upToDate && onTryPlugin ? { onTry: onTryPlugin } : {})}
        onAllowRun={key => void action("allowing-run", async () => {
          await allowPluginDraftRun(sessionId, key);
          await refresh();
        })} /> : view.busy ? <Empty icon={<Sparkles size="lg" />} title={t("pluginBuilder.writingDraft")} />
        : <Empty icon={<Sparkles size="lg" />} title={t("pluginBuilder.startTitle")} description={t("pluginBuilder.noDraftHint")} action={<div className="plugin-builder-starters">
          {STARTERS.map(({ id, icon: Icon }) => <Button key={id} variant="ghost" size="sm" icon={<Icon size={14} />} onClick={() => view.ask(t(`pluginBuilder.starter.${id}.prompt`))}>
            {t(`pluginBuilder.starter.${id}.label`)}</Button>)}
        </div>} />}
    </div>, view.panel.body)}
    {exporting && stored ? <PluginExportDialog plugin={stored.plugin} onClose={() => setExporting(false)} /> : null}
    {publishing && stored ? <PluginPublishDialog plugin={stored.plugin} onClose={() => setPublishing(false)} /> : null}
    {logOpen && stored ? <PluginLogDialog plugin={stored.plugin.id} displayName={stored.plugin.displayName} onClose={() => setLogOpen(false)}
      onChanged={() => void refresh().catch(() => {})} onFix={prompt => { setLogOpen(false); view.ask(prompt); }} /> : null}
    {iconEditing && draftPlugin && draft?.revision ? <PluginIconPicker plugin={draftPlugin} setupId={sessionId} files={draft.files} disabled={disabled} onClose={() => setIconEditing(false)}
      onSave={async change => {
        setOperation("saving-icon");
        try {
          const next = await updatePluginDraftIcon(sessionId, { ...change, revision: draft.revision! });
          setSnapshot(current => current && { ...current, draft: next });
          onChange(await readPluginSetup(sessionId));
        } finally { setOperation(undefined); }
      }} /> : null}
    <Dialog open={confirming === "more-asks"} onClose={() => setConfirming(undefined)} size="sm"
      title={t("pluginBuilder.updateAsksMoreTitle")} description={t("pluginBuilder.updateAsksMoreDescription")}
      footer={<>
        <Button onClick={() => setConfirming(undefined)}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => { setConfirming(undefined); install(); }}>{t("pluginBuilder.update")}</Button>
      </>}>
      {draft?.update ? <><PluginCapabilityList capabilities={draft.update.asks.added} newAsks={draft.update.asks.added} /><NativeCodeWarning asks={draft.update.asks.added} /></> : null}
    </Dialog>
    <Dialog open={confirming === "workspace" || confirming === "uninstall"} onClose={() => setConfirming(undefined)} size="sm"
      title={confirming === "workspace" ? t("pluginBuilder.deleteTitle", { title: workspaceTitle(summary?.title ?? "") }) : t("pluginControls.uninstall")}
      description={confirming === "workspace" ? t("pluginBuilder.deleteDescription") : t("pluginControls.confirmUninstall", { name: stored?.plugin.displayName ?? "" })}
      footer={<>
        <Button onClick={() => setConfirming(undefined)}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => {
          const target = confirming;
          setConfirming(undefined);
          if (target === "workspace") void action("deleting", async () => {
            await deletePluginSetup(sessionId);
            window.location.hash = pluginsTabHash("installed");
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
