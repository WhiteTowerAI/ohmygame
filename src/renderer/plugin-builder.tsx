import { useEffect, useRef, useState } from "react";
import { NEW_PLUGIN_TITLE, type PluginDraft, type PluginDraftPlugin, type PluginSetupState, type PluginSetupSummary } from "../shared/plugin-setup.js";
import type { StorePlugin } from "../shared/plugins.js";
import { preferredAgentModel } from "../shared/agent-models.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { abortPluginSetup, clearPluginSetupConversation, deletePluginSetup, installPluginDraft, listPluginSetups, listStorePlugins, promptPluginSetup, readPluginDraft,
  readPluginDraftFile, readPluginSetup, testPluginDraft, uninstallStorePlugin, updatePluginDraftIcon, waitForRuntime } from "./api.js";
import { AppRail, RECENT_LIMIT } from "./app-sidebar.js";
import type { AppNavigationTarget } from "./routes.js";
import { PluginGlyph } from "./plugin-icons.js";
import { PluginIconPicker } from "./plugin-icon-picker.js";
import { groupStorePlugins, useEveryProjectSwitch } from "./plugin-store.js";
import { draftCheck, draftCheckLabel, PluginOverview } from "./plugin-builder-overview.js";
import { AgentTimeline } from "./agent-timeline.js";
import { useAgentModels } from "./model-selector.js";
import { PromptBox, type PromptInput } from "./prompt-box.js";
import { WorkspaceFileBrowser } from "./coding-workspace.js";
import { HighlightedCode } from "./highlighted-code.js";
import { MarkdownContent } from "./markdown-content.js";
import { PanelLayout, PanelToolbar, type Layout } from "./panel-layout.js";
import { ProjectFrame, ProjectTop } from "./project-frame.js";
import { ComposerActions } from "./composer-actions.js";
import { pluginBuilderHash, pluginHash } from "./routes.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { readPluginBuilderInput, removePluginBuilderInput, savePluginBuilderInput } from "./plugin-builder-drafts.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { ArrowLeft, Check, CirclePlus, ExternalLink, FileCode2, FileText, LayoutGrid, LoaderCircle, MessageCircle, MessageSquarePlus, MoreHorizontal, Package,
  Pencil, Plug, RefreshCw, Sparkles, Trash2, Wrench } from "./icons.js";
import { Alert, Button, Dialog, DropdownMenu, Empty, IconButton, Tooltip, type MenuEntry } from "./ui/index.js";
import "./home.css";
import "./plugin-builder.css";
import { t } from "./i18n.js";

/**
 * The AI workspaces under the Plugins page: each conversation that creates,
 * edits or configures a plugin, to pick up again.
 */
export function PluginBuilderSessions() {
  const generation = useReadyRuntimeGeneration();
  const [sessions, setSessions] = useState<PluginSetupSummary[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void waitForRuntime().then(listPluginSetups).then(items => { if (active) setSessions(items); })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [generation]);
  if (error) return <Alert tone="danger" title={t("pluginBuilder.loadFailed", { error })} />;
  if (!sessions.length) return null;
  return <section className="plugins-section" aria-label={t("pluginBuilder.workspaces")}>
    <h2>{t("pluginBuilder.continue")} <span className="plugins-count">{sessions.length}</span></h2>
    <div className="plugins-grid">{sessions.map(session => <PluginBuilderSessionCard key={session.id} session={session}
      onDeleted={() => setSessions(current => current.filter(item => item.id !== session.id))}
      onError={cause => setError(message(cause))} />)}</div>
  </section>;
}

function PluginBuilderSessionCard({ session, onDeleted, onError }: {
  session: PluginSetupSummary;
  onDeleted: () => void;
  onError: (cause: unknown) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const working = session.status === "working";
  const remove = () => {
    setConfirming(false);
    setRemoving(true);
    void deletePluginWorkspace(session.id).then(onDeleted, cause => {
      onError(cause);
      setRemoving(false);
    });
  };
  return <article className="plugin-card plugin-builder-session-card">
    <a className="plugin-card-link" href={pluginBuilderHash(session.id)}>
      <span className="plugin-tile">{working ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}</span>
      <span className="plugin-card-text">
        <strong className="plugin-card-name">{workspaceTitle(session.title)}</strong>
        <small>{t(`pluginBuilder.mode.${session.mode ?? "create"}`)} · {statusLabel(session.status)}</small>
      </span>
    </a>
    <DropdownMenu placement="bottom-end" items={[
      { label: t("common.delete"), icon: <Trash2 size={14} />, danger: true, disabled: working, onSelect: () => setConfirming(true) },
    ]} trigger={(props) => (
      <IconButton {...props} size="sm" disabled={removing} label={t("pluginBuilder.workspaceActions", { title: workspaceTitle(session.title) })}>
        <MoreHorizontal size={16} />
      </IconButton>
    )} />
    <Dialog open={confirming} onClose={() => setConfirming(false)} size="sm"
      title={t("pluginBuilder.deleteTitle", { title: workspaceTitle(session.title) })} description={t("pluginBuilder.deleteDescription")}
      footer={<>
        <Button onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={remove}>{t("common.delete")}</Button>
      </>} />
  </article>;
}

async function deletePluginWorkspace(sessionId: string): Promise<void> {
  await deletePluginSetup(sessionId);
  removePluginBuilderInput(sessionId, window.localStorage);
}

/** A new workspace is unnamed, and the daemon's name for that is English. */
function workspaceTitle(title: string): string {
  return title === NEW_PLUGIN_TITLE ? t("pluginBuilder.newPlugin") : title;
}

const CHAT_WIDTH_KEY = "ohmygame-agent-width";
const DEFAULT_CHAT_WIDTH = 430;

function readChatWidth(): number {
  try { return Number(localStorage.getItem(CHAT_WIDTH_KEY)) || DEFAULT_CHAT_WIDTH; }
  catch { return DEFAULT_CHAT_WIDTH; }
}
function saveChatWidth(width: number) {
  try { localStorage.setItem(CHAT_WIDTH_KEY, String(width)); } catch { /* Layout still works without storage. */ }
}

/** The chat beside the plugin, in the project's panels. They stay in place. */
function builderLayout(): Layout {
  return {
    left: { panels: ["chat"], size: readChatWidth() },
    center: { panels: ["overview", "files"], active: "overview", size: 0 },
    right: { panels: [], size: 0 },
    bottom: { panels: [], size: 0 },
  };
}

/** Ways to start, each the opening of a prompt to finish. */
const STARTERS = [
  { id: "skill", icon: FileText }, { id: "panel", icon: LayoutGrid }, { id: "tool", icon: Wrench }, { id: "mcp", icon: Plug },
] as const;

// What the rail last showed: opening another workspace remounts the page, and
// the rail shouldn't empty and refill.
let railCache: { sessions: PluginSetupSummary[]; plugins: StorePlugin[] } = { sessions: [], plugins: [] };

/** The rail: back to Plugins, the recent AI workspaces, and a new plugin. The rest are on the Plugins page. */
function BuilderRail({ sessionId, title, status, plugin, onNavigate, onError }: {
  sessionId: string;
  /** The open workspace's name and status: the list loads again when they change. */
  title?: string;
  status?: string;
  plugin?: PluginDraftPlugin;
  onNavigate: (page: AppNavigationTarget) => void;
  onError: (cause: unknown) => void;
}) {
  const generation = useReadyRuntimeGeneration();
  const [{ sessions, plugins }, setRail] = useState(railCache);
  useEffect(() => {
    let active = true;
    void waitForRuntime().then(() => Promise.all([listPluginSetups(), listStorePlugins()]))
      .then(([sessions, plugins]) => {
        railCache = { sessions, plugins };
        if (active) setRail(railCache);
      }).catch(() => { /* The rail keeps what it has; the page reports a daemon it can't reach. */ });
    return () => { active = false; };
  }, [generation, sessionId, title, status]);
  // The list comes newest first; the open workspace stays on it however old.
  const listed = sessions.filter((session, index) => index < RECENT_LIMIT || session.id === sessionId);
  return <AppRail label={t("pluginBuilder.workspaces")} onNavigate={onNavigate}>
    <Tooltip content={t("pluginBuilder.backToPlugins")} placement="right-start">
      <a className="sidebar-app sidebar-app-new" href={pluginHash()} aria-label={t("pluginBuilder.backToPlugins")}><ArrowLeft size={16} /></a>
    </Tooltip>
    {listed.map(session => {
      const current = session.id === sessionId;
      const name = workspaceTitle(session.title);
      const icon = current ? plugin : plugins.find(item => item.id === session.pluginId);
      return <Tooltip key={session.id} content={name} placement="right-start">
        <a className={`sidebar-app plugin-builder-rail-item${current ? " is-active" : ""}`} href={pluginBuilderHash(session.id)} aria-label={name} aria-current={current ? "page" : undefined}>
          {session.status === "working" ? <LoaderCircle className="spin" size={16} />
            : icon?.icon ? <PluginGlyph plugin={icon} size={20} setupId={current ? sessionId : undefined} />
              : <span aria-hidden="true">{[...name][0]}</span>}
        </a>
      </Tooltip>;
    })}
    <Tooltip content={t("pluginBuilder.newPlugin")} placement="right-start">
      <button type="button" className="sidebar-app sidebar-app-new" aria-label={t("pluginBuilder.newPlugin")} onClick={() => void openPluginBuilder().catch(onError)}><CirclePlus size={16} /></button>
    </Tooltip>
  </AppRail>;
}

async function loadBuilderSnapshot(sessionId: string, state?: PluginSetupState) {
  state ??= await readPluginSetup(sessionId);
  const [draft, stored] = await Promise.all([
    readPluginDraft(sessionId),
    state.pluginId ? listStorePlugins().then(rows => groupStorePlugins(rows).find(group => group.plugin.id === state.pluginId)) : undefined,
  ]);
  return { state, draft, stored };
}

export function PluginBuilder({ sessionId, onNavigate }: { sessionId: string; onNavigate: (page: AppNavigationTarget) => void }) {
  const generation = useReadyRuntimeGeneration();
  const catalog = useAgentModels();
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof loadBuilderSnapshot>>>();
  const { state, draft } = snapshot ?? {};
  const [input, setInput] = useState(() => readPluginBuilderInput(sessionId, typeof window === "undefined" ? undefined : window.localStorage));
  const [layout, setLayout] = useState(builderLayout);
  const [iconEditing, setIconEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [fileRequest, updateFileRequest] = useState<{ path: string; id: number }>();
  const [confirming, setConfirming] = useState<"conversation" | "workspace" | "uninstall">();
  const promptInput = useRef<PromptInput>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const draftPlugin = draft?.plugin;
  const model = preferredAgentModel(catalog.models, input.model ?? state?.model, catalog.defaultModel);
  const reasoning = model ? clampReasoningLevel(input.reasoningLevel ?? state?.reasoningLevel ?? catalog.defaultReasoningLevel, model.reasoningLevels) : undefined;
  const disabled = Boolean(state?.busy || operation);
  const stored = snapshot?.stored;
  const upToDate = Boolean(stored && draft?.revision && draft.revision === draft.installedRevision);
  // A workspace starts as one prompt; its first message opens the chat beside the plugin.
  const starting = Boolean(state && !state.busy && !state.turns.length && !draft?.path);

  useEffect(() => { savePluginBuilderInput(sessionId, input, window.localStorage); }, [sessionId, input]);
  useEffect(() => {
    if (!state || !model || input.model) return;
    setInput(current => ({ ...current, model: { provider: model.provider, id: model.id }, reasoningLevel: reasoning }));
  }, [state?.id, model?.provider, model?.id]);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void waitForRuntime().then(() => loadBuilderSnapshot(sessionId))
      .then(next => { if (active) setSnapshot(next); })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [sessionId, generation, retry]);
  useEffect(() => {
    if (!state?.busy) return;
    let active = true, inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void readPluginSetup(sessionId).then(async next => {
        if (!active) return;
        if (!next.busy) {
          const snapshot = await loadBuilderSnapshot(sessionId, next);
          if (active) { setSnapshot(snapshot); setError(undefined); }
        } else {
          setSnapshot(current => current ? { ...current, state: next } : current);
          setError(undefined);
        }
      }).catch(cause => { if (active) setError(message(cause)); }).finally(() => { inFlight = false; });
    }, 700);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId, state?.busy]);
  useEffect(() => {
    if (state?.turns.length && following.current && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [state?.turns]);

  async function action(name: string, run: () => Promise<void>) {
    if (disabled) return;
    setOperation(name); setError(undefined);
    try { await run(); } catch (cause) { setError(message(cause)); }
    finally { setOperation(undefined); }
  }
  async function refresh() {
    setSnapshot(await loadBuilderSnapshot(sessionId));
  }
  const everyProject = useEveryProjectSwitch(refresh);
  async function send() {
    if (!state || !model || !input.prompt.trim() || disabled) return;
    const sent = input.prompt;
    await action("sending", async () => {
      const next = await promptPluginSetup(sessionId, sent, { provider: model.provider, id: model.id }, reasoning);
      setInput(current => current.prompt === sent ? { ...current, prompt: "" } : current);
      following.current = true;
      setSnapshot(current => current ? { ...current, state: next } : current);
      if (!next.busy) await refresh();
    });
  }
  function prefill(prompt: string) {
    setInput(current => ({ ...current, prompt: current.prompt.trim() ? `${current.prompt.trimEnd()}\n\n${prompt}` : prompt }));
    requestAnimationFrame(() => promptInput.current?.focus());
  }
  function openFile(file: string) {
    setLayout(current => ({ ...current, center: { ...current.center, active: "files" } }));
    updateFileRequest({ path: file, id: Date.now() });
  }

  const check = draft?.path ? draftCheck(draft) : undefined;
  const unsaved = Boolean(stored && draft?.revision && !upToDate);
  const status = state?.busy ? t("pluginBuilder.status.working") : check ? <>
    <span className={check === "failed" ? "plugin-builder-status-failed" : undefined}>{draftCheckLabel(check)}</span>
    {unsaved ? ` · ${t("pluginBuilder.uninstalledChanges")}` : null}
  </> : undefined;
  const menu: MenuEntry[] = state ? [
    ...(draftPlugin && !draft?.errors.length ? [{ label: t("pluginIconPicker.change"), icon: <Pencil size={14} />, disabled, onSelect: () => setIconEditing(true) }] : []),
    ...(stored ? [{ label: t("pluginBuilder.open"), icon: <ExternalLink size={14} />, onSelect: () => { window.location.hash = pluginHash(state.pluginId!); } }] : []),
    ...(draftPlugin || stored ? ["separator" as const] : []),
    ...(state.mode === "edit" ? [{ label: t("pluginBuilder.newConversation"), icon: <MessageSquarePlus size={14} />, disabled,
      onSelect: () => void action("creating", () => openPluginBuilder(state.pluginId, state.mode, true)) }] : []),
    { label: t("pluginBuilder.deleteConversation"), icon: <MessageCircle size={14} />, disabled: disabled || !state.turns.length, onSelect: () => setConfirming("conversation") },
    "separator",
    ...(stored ? [{ label: t("pluginControls.uninstall"), icon: <Package size={14} />, danger: true, disabled, onSelect: () => setConfirming("uninstall") }] : []),
    { label: t(draft?.path ? "pluginBuilder.deleteDraft" : "pluginBuilder.deleteWorkspace"), icon: <Trash2 size={14} />, danger: true, disabled, onSelect: () => setConfirming("workspace") },
  ] : [];

  const notice = error ?? everyProject.error ?? state?.error;
  const composer = <div className="composer">
    {notice ? <p className="plugin-builder-error" role="alert">{notice}</p> : null}
    <PromptBox value={input.prompt} onChange={prompt => setInput(current => ({ ...current, prompt }))} onSubmit={() => void send()}
      inputRef={promptInput} variant={starting ? "home" : "project"} disabled={!state} placeholder={t(state?.mode === "edit" ? "pluginBuilder.editPlaceholder" : "pluginBuilder.placeholder")}
      actions={<ComposerActions models={catalog.models} status={catalog.status} value={model} reasoningLevel={reasoning} disabled={disabled}
        onChange={(selected, level) => setInput(current => ({ ...current, model: { provider: selected.provider, id: selected.id }, reasoningLevel: level }))}
        onReasoningChange={level => setInput(current => ({ ...current, reasoningLevel: level }))}
        showStop={Boolean(state?.busy)} sendLabel={t("pluginBuilder.send")} stopLabel={t("pluginBuilder.stop")}
        sendDisabled={!state || !model || !input.prompt.trim() || disabled}
        onStop={() => { void abortPluginSetup(sessionId).catch(cause => setError(message(cause))); }}
      />} />
  </div>;
  const refreshButton = <PanelToolbar>
    <IconButton size="sm" label={t("pluginBuilder.refresh")} disabled={disabled} onClick={() => void action("refreshing", refresh)}><RefreshCw size={14} /></IconButton>
  </PanelToolbar>;
  const panels = [{
    id: "chat", title: t("pluginBuilder.tab.chat"), icon: <MessageCircle size={14} />, home: "left" as const,
    content: <section className="agent-pane plugin-builder-chat" aria-label={t("pluginBuilder.assistant")}>
      <div className="agent-body" ref={timeline} onScroll={event => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}>
        <div className="timeline" aria-live="polite">
          {state ? <AgentTimeline turns={state.turns} onAddToChat={prefill} onOpenWorkspaceFile={openFile} /> : null}
          {state?.status === "interrupted" ? <p className="plugin-builder-notice" role="status">{t("pluginBuilder.interrupted")}</p> : null}
        </div>
        {composer}
      </div>
    </section>,
  }, {
    id: "overview", title: t("pluginBuilder.tab.overview"), icon: <Package size={14} />, home: "center" as const, padded: true,
    content: <>
      {refreshButton}
      {draft?.path ? <PluginOverview draft={draft} setupId={sessionId} stored={stored?.plugin} disabled={disabled} operation={operation} everyProject={everyProject}
        onEditIcon={draftPlugin && !draft.errors.length ? () => setIconEditing(true) : undefined} onOpenFile={openFile}
        onTest={server => void action(`test:${server}`, async () => {
          if (!draft.revision) return;
          await testPluginDraft(sessionId, server, draft.revision);
          await refresh();
        })} /> : state?.busy ? <EmptyView label={t("pluginBuilder.writingDraft")} />
        : <EmptyView label={t("pluginBuilder.noDraft")} description={t("pluginBuilder.noDraftHint")} />}
    </>,
  }, {
    id: "files", title: t("pluginBuilder.tab.files"), icon: <FileCode2 size={14} />, home: "center" as const,
    // Only while it's open, or it reads the file for every draft you never look at.
    content: layout.center.active === "files" ? <>{refreshButton}<PluginFiles sessionId={sessionId} draft={draft} request={fileRequest} /></> : null,
  }];

  return <ProjectFrame
    rail={<BuilderRail sessionId={sessionId} title={state?.title} status={state?.status} plugin={draftPlugin} onNavigate={onNavigate} onError={cause => setError(message(cause))} />}
    top={<ProjectTop name={state ? workspaceTitle(state.title) : ""} icon={draftPlugin ? <PluginGlyph plugin={draftPlugin} size={16} setupId={sessionId} /> : undefined} menu={menu} status={status}>
      {draftPlugin ? <Button size="sm" variant="primary" disabled={disabled || Boolean(draft?.errors.length) || upToDate}
        icon={operation === "installing" ? <LoaderCircle className="spin" size={14} /> : upToDate ? <Check size={14} /> : <Package size={14} />}
        onClick={() => void action("installing", async () => {
          if (!draft?.revision) return;
          try { await installPluginDraft(sessionId, draft.revision); }
          finally { await refresh(); }
        })}>{upToDate ? t("pluginBuilder.installed") : state?.pluginId ? t("pluginBuilder.update") : t("pluginBuilder.install")}</Button> : null}
    </ProjectTop>}>
    {!state ? <div className="plugin-builder-card">
      {error ? <Alert tone="danger" title={error} action={<Button size="sm" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</Button>} />
        : <p className="plugin-builder-working" role="status"><LoaderCircle className="spin" size={13} />{t("pluginBuilder.opening")}</p>}
    </div> : starting ? <div className="plugin-builder-card">
      <div className="home-hero plugin-builder-start">
        <h1>{t("pluginBuilder.startTitle")}</h1>
        {composer}
        <div className="home-starts">
          {STARTERS.map(({ id, icon: Icon }) => <Button key={id} variant="ghost" size="sm" icon={<Icon size={14} />} onClick={() => prefill(t(`pluginBuilder.starter.${id}.prompt`))}>{t(`pluginBuilder.starter.${id}.label`)}</Button>)}
        </div>
      </div>
    </div> : <PanelLayout locked layout={layout} panels={panels} empty={null} onChange={next => {
      if (next.left.size !== layout.left.size) saveChatWidth(next.left.size);
      setLayout(next);
    }} />}
    {everyProject.dialog}
    {iconEditing && draftPlugin && draft?.revision ? <PluginIconPicker plugin={draftPlugin} setupId={sessionId} files={draft.files} disabled={disabled} onClose={() => setIconEditing(false)} onSave={async change => {
      setOperation("saving-icon");
      try {
        const nextDraft = await updatePluginDraftIcon(sessionId, { ...change, revision: draft.revision! });
        const nextState = await readPluginSetup(sessionId);
        setSnapshot(current => current ? { ...current, draft: nextDraft, state: nextState } : current);
      }
      finally { setOperation(undefined); }
    }} /> : null}
    <Dialog open={confirming !== undefined} onClose={() => setConfirming(undefined)} size="sm"
      title={confirming === "workspace" ? t("pluginBuilder.deleteTitle", { title: workspaceTitle(state?.title ?? "") }) : confirming === "uninstall" ? t("pluginControls.uninstall") : t("pluginBuilder.deleteConversationTitle")}
      description={confirming === "workspace" ? t("pluginBuilder.deleteDescription") : confirming === "uninstall" ? t("pluginControls.confirmUninstall", { name: stored?.plugin.displayName ?? "" }) : t("pluginBuilder.deleteConversationDescription")}
      footer={<>
        <Button onClick={() => setConfirming(undefined)}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => {
          const target = confirming;
          setConfirming(undefined);
          if (target === "workspace") void action("deleting", async () => {
            await deletePluginWorkspace(sessionId);
            window.location.hash = pluginHash();
          });
          else if (target === "uninstall") void action("uninstalling", async () => {
            if (stored) for (const version of stored.versions) await uninstallStorePlugin(stored.plugin.id, version.version);
            await refresh();
          });
          else void action("clearing", async () => {
            const next = await clearPluginSetupConversation(sessionId);
            setInput(current => ({ ...current, prompt: "" }));
            setSnapshot(current => current ? { ...current, state: next } : current);
          });
        }}>{confirming === "uninstall" ? t("pluginControls.uninstallShort") : t("common.delete")}</Button>
      </>} />
  </ProjectFrame>;
}

function PluginFiles({ sessionId, draft, request }: { sessionId: string; draft?: PluginDraft; request?: { path: string; id: number } }) {
  const [selected, setSelected] = useState<string>();
  const [file, setFile] = useState<{ path: string; content: string }>();
  const [error, setError] = useState<string>();
  const [source, setSource] = useState(false);
  const files = draft?.path ? draft.files : [];
  const active = files.some(file => file.path === selected) ? selected : files.find(file => file.path.endsWith("SKILL.md"))?.path ?? files[0]?.path;
  useEffect(() => {
    if (!request) return;
    const match = files.find(file => request.path.endsWith(file.path));
    if (match) setSelected(match.path);
  }, [request?.id, draft?.revision]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setFile(undefined); setError(undefined);
    void readPluginDraftFile(sessionId, active).then(next => { if (current) setFile(next); })
      .catch(cause => { if (current) setError(message(cause)); });
    return () => { current = false; };
  }, [sessionId, active, draft?.revision]);
  if (!files.length) return <EmptyView label={t("pluginBuilder.noFiles")} />;
  return <WorkspaceFileBrowser files={files} selectedPath={active} onSelect={setSelected} loading={!file && !error} error={error}
    selectedFile={file ? { ...file, size: files.find(entry => entry.path === file.path)?.size ?? 0, binary: false } : undefined}
    fileActions={active?.endsWith(".md") ? <div className="file-open-actions"><button type="button" title={source ? t("pluginBuilder.readDocument") : t("pluginBuilder.viewSource")} aria-label={source ? t("pluginBuilder.readDocument") : t("pluginBuilder.viewSource")} onClick={() => setSource(value => !value)}>{source ? <FileText size={14} /> : <FileCode2 size={14} />}</button></div> : null}
    renderFile={file => file.path.endsWith(".md") && !source
      ? <div className="plugin-builder-file-markdown"><MarkdownContent text={(file.content ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")} /></div>
      : <HighlightedCode path={file.path} content={file.content ?? ""} />}
  />;
}

function EmptyView({ label, description }: { label: string; description?: string }) {
  return <Empty icon={<Sparkles size={20} />} title={label} description={description} />;
}
function statusLabel(status: PluginSetupSummary["status"]): string {
  return t(`pluginBuilder.status.${status}`);
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
