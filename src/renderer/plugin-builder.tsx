import { useEffect, useRef, useState } from "react";
import type { PluginDraft, PluginSetupState, PluginSetupSummary } from "../shared/plugin-setup.js";
import type { PluginDetail } from "../shared/plugins.js";
import { pluginComponentKey } from "../shared/plugins.js";
import { preferredAgentModel } from "../shared/agent-models.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { abortPluginSetup, deletePluginSetup, installPluginDraft, listPluginSetups, promptPluginSetup, readPluginDraft,
  readPluginDraftFile, readPluginSetup, readPlugin, readPluginSkill, testPluginDraft, uninstallPlugin, updatePluginSettings, waitForRuntime } from "./api.js";
import { AgentTimeline } from "./agent-timeline.js";
import { useAgentModels } from "./model-selector.js";
import { PromptBox } from "./prompt-box.js";
import { PluginConfigurationPanel, PluginMcpPanel, PluginUninstallButton } from "./plugin-controls.js";
import { WorkspaceFileBrowser } from "./coding-workspace.js";
import { HighlightedCode } from "./highlighted-code.js";
import { MarkdownContent } from "./markdown-content.js";
import { WorkspaceTabs, type WorkspaceTabOption } from "./workspace-tabs.js";
import { WorkspaceShell, WorkspaceAgentPane, WorkspaceBackButton } from "./workspace-shell.js";
import { ComposerActions } from "./composer-actions.js";
import { readChatLayout } from "./chat-layout.js";
import { pluginBuilderHash, pluginHash, settingsHash } from "./routes.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { readPluginBuilderInput, removePluginBuilderInput, savePluginBuilderInput } from "./plugin-builder-drafts.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { ArrowLeft, Check, ChevronRight, FileCode2, FileText, LoaderCircle, Package, MessageSquarePlus, PanelToggle,
  Plug, RefreshCw, Settings, Trash2 } from "./icons.js";
import "./plugin-builder.css";
import { t } from "./i18n.js";

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
  if (error) return <p className="plugins-inline-error" role="alert">{t("pluginBuilder.loadFailed", { error })}</p>;
  if (!sessions.length) return null;
  return <section className="plugin-builder-recents" aria-label={t("pluginBuilder.workspaces")}>
    <h2>{t("pluginBuilder.continue")}</h2>
    <div>{sessions.map(session => <a href={pluginBuilderHash(session.id)} key={session.id}>
      <Package size={18} /><span><strong>{session.title}</strong><small>{statusLabel(session.status)}</small></span><ChevronRight size={14} />
    </a>)}</div>
  </section>;
}

type BuilderView = "overview" | "files" | "configuration" | "checks";
const TABS: WorkspaceTabOption<BuilderView>[] = [
  { id: "overview", label: t("pluginBuilder.tab.overview"), icon: Package }, { id: "files", label: t("pluginBuilder.tab.files"), icon: FileCode2 },
  { id: "configuration", label: t("pluginBuilder.tab.setup"), icon: Settings }, { id: "checks", label: t("pluginBuilder.tab.checks"), icon: Check },
];

async function loadBuilderSnapshot(sessionId: string, state?: PluginSetupState) {
  state ??= await readPluginSetup(sessionId);
  const [draft, installed] = await Promise.all([
    readPluginDraft(sessionId),
    state.pluginId ? readPlugin(state.pluginId) : undefined,
  ]);
  return { state, draft, installed };
}

export function PluginBuilder({ sessionId }: { sessionId: string }) {
  const generation = useReadyRuntimeGeneration();
  const catalog = useAgentModels();
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof loadBuilderSnapshot>>>();
  const { state, draft, installed } = snapshot ?? {};
  const [input, setInput] = useState(() => readPluginBuilderInput(sessionId, typeof window === "undefined" ? undefined : window.localStorage));
  const [view, setView] = useState<BuilderView>("overview");
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [fileRequest, updateFileRequest] = useState<{ path: string; id: number }>();
  const [chatLayout] = useState(readChatLayout);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const draftPlugin = draft?.plugin;
  const plugin = draftPlugin ?? installed;
  const model = preferredAgentModel(catalog.models, input.model ?? state?.model, catalog.defaultModel);
  const reasoning = model ? clampReasoningLevel(input.reasoningLevel ?? state?.reasoningLevel ?? catalog.defaultReasoningLevel, model.reasoningLevels) : undefined;
  const disabled = Boolean(state?.busy || operation);
  const upToDate = Boolean(installed?.installed && draft?.revision && draft.revision === draft.installedRevision);

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
    setAgentCollapsed(false);
    setInput(current => ({ ...current, prompt: current.prompt.trim() ? `${current.prompt.trimEnd()}\n\n${prompt}` : prompt }));
    requestAnimationFrame(() => textarea.current?.focus());
  }
  function setFileRequest(file: string) { updateFileRequest({ path: file, id: Date.now() }); }
  async function toggleMcp(id: string, enabled: boolean) {
    if (!installed) return;
    const components = Object.fromEntries([
      ...installed.skills.map(skill => [pluginComponentKey("skill", skill.id), skill.enabled]),
      ...(installed.mcpServers ?? []).map(server => [pluginComponentKey("mcp", server.id), server.enabled]),
    ]);
    await updatePluginSettings(installed.id, { enabled: installed.enabled, components: { ...components, [pluginComponentKey("mcp", id)]: enabled } });
    await refresh();
  }
  function previewContent() {
    switch (view) {
      case "overview":
        return <>
          {draft?.errors.length ? <p className="plugin-builder-error" role="alert">{draft.errors.join(" ")}</p> : null}
          {plugin ? <PluginOverview plugin={plugin} onChooseView={setView} onChooseFile={file => { setView("files"); setFileRequest(file); }} /> : <EmptyView label={t("pluginBuilder.noDraft")} />}
        </>;
      case "files":
        return <PluginFiles sessionId={sessionId} draft={draft} installed={installed} request={fileRequest} />;
      case "configuration": {
        if (!plugin) return <EmptyView label={t("pluginBuilder.noConfiguration")} />;
        const installedSetup = draftPlugin ? undefined : installed;
        const hasConnections = Boolean(installedSetup && (installedSetup.mcpServers?.length || installedSetup.connections.length));
        return <>
          <fieldset className="plugin-builder-config" disabled={disabled}>
            <PluginConfigurationPanel key={`${sessionId}:${draft?.revision ?? plugin.id}`} plugin={plugin} setupId={draftPlugin ? sessionId : undefined} compact onChanged={() => void refresh().catch(cause => setError(message(cause)))} />
          </fieldset>
          {installedSetup ? <PluginMcpPanel plugin={installedSetup} onChanged={() => void refresh().catch(cause => setError(message(cause)))} onAssist={() => {
            setView("overview");
            prefill("Inspect this plugin's configuration and diagnose any connection problems. Report what needs to be changed before making changes.");
          }} onToggle={(id, enabled) => void action("configuring", () => toggleMcp(id, enabled))} /> : null}
          {!Object.keys(plugin.configuration ?? {}).length && !hasConnections ? <EmptyView label={t("pluginBuilder.noConfiguration")} /> : null}
        </>;
      }
      case "checks":
        if (!draft?.path && installed) {
          if (!installed.mcpServers?.length && !installed.connections.length) return <EmptyView label={t("pluginBuilder.noChecks")} />;
          return <button type="button" className="plugin-detail-secondary" onClick={() => setView("configuration")}>{t("pluginBuilder.testConnections")}<ChevronRight size={14} /></button>;
        }
        return <PluginChecks draft={draft} disabled={disabled} operation={operation} onTest={server => void action(`test:${server}`, async () => {
          if (!draft?.revision) return;
          await testPluginDraft(sessionId, server, draft.revision);
          await refresh();
        })} />;
    }
  }

  const goToPlugins = () => { window.location.hash = settingsHash("plugins"); };
  return <WorkspaceShell className="plugin-builder-shell" chatLayout={chatLayout} agentCollapsed={agentCollapsed}
    onHome={goToPlugins} homeLabel={t("pluginBuilder.backToPlugins")} homeIcon={ArrowLeft} onExpandAgent={() => setAgentCollapsed(false)}
    agent={<WorkspaceAgentPane label={t("pluginBuilder.assistant")}
      actions={<>
        <button className="icon-button pane-header-action" type="button" disabled={disabled} title={t("pluginBuilder.newPlugin")} aria-label={t("pluginBuilder.newPlugin")}
          onClick={() => void action("creating", () => openPluginBuilder())}>
          {operation === "creating" ? <LoaderCircle className="spin" size={14} /> : <MessageSquarePlus size={14} />}
        </button>
        <button className="icon-button pane-header-action" type="button" onClick={() => setAgentCollapsed(true)} title={t("projectShell.hideAgent")} aria-label={t("projectShell.hideAgent")}><PanelToggle size={14} /></button>
      </>}
      bodyRef={timeline} onScroll={event => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}>
        <div className="timeline" aria-live="polite">
          {!state && !error ? <p className="plugin-builder-working" role="status"><LoaderCircle className="spin" size={13} />{t("pluginBuilder.opening")}</p> : null}
          {state ? <AgentTimeline turns={state.turns} onAddToChat={prefill} onOpenWorkspaceFile={file => { setView("files"); setFileRequest(file); }} /> : null}
          {state?.status === "interrupted" ? <p className="plugin-builder-notice" role="status">{t("pluginBuilder.interrupted")}</p> : null}
        </div>
        <div className="composer">
          {error || state?.error ? <p className="plugin-builder-error" role="alert">{error ?? state?.error}{!state ? <button type="button" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button> : null}</p> : null}
          <PromptBox value={input.prompt} onChange={prompt => setInput(current => ({ ...current, prompt }))} onSubmit={() => void send()}
            textareaRef={textarea} variant="project" disabled={!state} placeholder={t("pluginBuilder.placeholder")}
            actions={<ComposerActions models={catalog.models} status={catalog.status} value={model} reasoningLevel={reasoning} disabled={disabled}
              onChange={(selected, level) => setInput(current => ({ ...current, model: { provider: selected.provider, id: selected.id }, reasoningLevel: level }))}
              onReasoningChange={level => setInput(current => ({ ...current, reasoningLevel: level }))}
              showStop={Boolean(state?.busy)} sendLabel={t("pluginBuilder.send")} stopLabel={t("pluginBuilder.stop")}
              sendDisabled={!state || !model || !input.prompt.trim() || disabled}
              onStop={() => { void abortPluginSetup(sessionId).catch(cause => setError(message(cause))); }}
            />} />
        </div>
    </WorkspaceAgentPane>}
  >
      <section className="viewer-pane plugin-builder-preview" aria-label={t("pluginBuilder.preview")} data-active-tab={view === "files" ? "code" : view}>
        <header className="pane-header viewer-header window-drag-handle">
          <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
          <div className={`viewer-navigation${chatLayout === "right" ? " is-chat-right" : ""}`}>
            {chatLayout === "right" ? <>
              <WorkspaceBackButton onClick={goToPlugins} label={t("pluginBuilder.backToPlugins")} icon={ArrowLeft} />
              {agentCollapsed ? <button className="icon-button pane-header-action" type="button" title={t("workspace.showAgent")} aria-label={t("workspace.showAgent")} onClick={() => setAgentCollapsed(false)}><PanelToggle size={14} /></button> : null}
            </> : null}
            <WorkspaceTabs tabs={TABS} active={view} onChange={setView} label={t("pluginBuilder.views")} />
          </div>
          <div className="viewer-publish">
            <button className="icon-button pane-header-action" aria-label={t("pluginBuilder.refresh")} title={t("pluginBuilder.refresh")} type="button" disabled={disabled} onClick={() => void action("refreshing", refresh)}><RefreshCw size={14} /></button>
            {state?.pluginId ? <button className="icon-button pane-header-action" type="button" title={t("pluginBuilder.open")} aria-label={t("pluginBuilder.open")} onClick={() => { window.location.hash = pluginHash(state.pluginId!); }}><ChevronRight size={14} /></button> : null}
            {installed?.installed ? <PluginUninstallButton plugin={installed} disabled={disabled} compact onUninstall={() => void action("uninstalling", async () => {
              await uninstallPlugin(installed.id);
              await refresh();
            })} /> : state ? <button className="icon-button pane-header-action" type="button" disabled={disabled}
              title={draft?.path ? t("pluginBuilder.deleteDraft") : t("pluginBuilder.deleteWorkspace")} aria-label={draft?.path ? t("pluginBuilder.deleteDraft") : t("pluginBuilder.deleteWorkspace")}
              onClick={() => {
                if (!window.confirm(t("pluginBuilder.confirmDelete", { title: state.title }))) return;
                void action("deleting", async () => {
                  await deletePluginSetup(sessionId);
                  removePluginBuilderInput(sessionId, window.localStorage);
                  goToPlugins();
                });
              }}><Trash2 size={14} /></button> : null}
            {draftPlugin ? <button className="publish-button workspace-publish-button" type="button" disabled={disabled || Boolean(draft?.errors.length) || upToDate} onClick={() => void action("installing", async () => {
              if (!draft?.revision) return;
              try { await installPluginDraft(sessionId, draft.revision); }
              finally { await refresh(); }
            })}>{operation === "installing" ? <LoaderCircle className="spin" size={14} /> : upToDate ? <Check size={14} /> : <Package size={14} />}<span>{upToDate ? t("pluginBuilder.installed") : state?.pluginId ? t("pluginBuilder.update") : t("pluginBuilder.install")}</span></button> : null}
          </div>
        </header>
        <div className={`plugin-builder-preview-content is-${view}`}>{previewContent()}</div>
      </section>
  </WorkspaceShell>;
}

function PluginOverview({ plugin, onChooseView, onChooseFile }: {
  plugin: PluginDetail; onChooseView: (view: BuilderView) => void; onChooseFile: (file: string) => void;
}) {
  return <div className="plugin-builder-overview">
    <div className="plugin-builder-overview-heading"><h2>{plugin.displayName}</h2>{plugin.version ? <small>v{plugin.version}</small> : null}</div>
    {plugin.description ? <p className="plugin-builder-description">{plugin.description}</p> : null}
    {plugin.skills.length ? <section><div className="plugin-builder-section-heading"><h3>{t("plugins.skills")}</h3><span>{plugin.skills.length}</span></div>{plugin.skills.map(skill => <button className="plugin-builder-component" type="button" key={skill.id} title={skill.description} onClick={() => onChooseFile(skill.id)}><FileText size={15} /><strong>{skill.name}</strong><ChevronRight size={14} /></button>)}</section> : null}
    {plugin.mcpServers?.length ? <section><div className="plugin-builder-section-heading"><h3>{t("pluginControls.mcpServices")}</h3><span>{plugin.mcpServers.length}</span></div>{plugin.mcpServers.map(server => <button className="plugin-builder-component" type="button" key={server.id} onClick={() => onChooseView("checks")}><Plug size={15} /><strong>{server.name}</strong><ChevronRight size={14} /></button>)}</section> : null}
  </div>;
}

function PluginFiles({ sessionId, draft, installed, request }: { sessionId: string; draft?: PluginDraft; installed?: PluginDetail; request?: { path: string; id: number } }) {
  const [selected, setSelected] = useState<string>();
  const [file, setFile] = useState<{ path: string; content: string }>();
  const [error, setError] = useState<string>();
  const [source, setSource] = useState(false);
  const files = draft?.path ? draft.files : installed?.skills.map(skill => ({ path: skill.id, size: 0 })) ?? [];
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
    void (draft?.path ? readPluginDraftFile(sessionId, active) : installed ? readPluginSkill(installed.id, active).then(file => ({ path: active, content: file.content })) : Promise.reject(new Error(t("pluginBuilder.noFile")))).then(next => { if (current) setFile(next); })
      .catch(cause => { if (current) setError(message(cause)); });
    return () => { current = false; };
  }, [sessionId, active, draft?.revision, installed?.id]);
  if (!files.length) return <EmptyView label={t("pluginBuilder.noFiles")} />;
  return <WorkspaceFileBrowser files={files} selectedPath={active} onSelect={setSelected} loading={!file && !error} error={error}
    selectedFile={file ? { ...file, size: files.find(entry => entry.path === file.path)?.size ?? 0, binary: false } : undefined}
    fileActions={active?.endsWith(".md") ? <div className="file-open-actions"><button type="button" title={source ? t("pluginBuilder.readDocument") : t("pluginBuilder.viewSource")} aria-label={source ? t("pluginBuilder.readDocument") : t("pluginBuilder.viewSource")} onClick={() => setSource(value => !value)}>{source ? <FileText size={14} /> : <FileCode2 size={14} />}</button></div> : null}
    renderFile={file => file.path.endsWith(".md") && !source
      ? <div className="plugin-builder-file-markdown"><MarkdownContent text={(file.content ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")} /></div>
      : <HighlightedCode path={file.path} content={file.content ?? ""} />}
  />;
}

function PluginChecks({ draft, disabled, operation, onTest }: {
  draft?: PluginDraft; disabled: boolean; operation?: string; onTest: (server: string) => void;
}) {
  if (!draft?.path) return <EmptyView label={t("pluginBuilder.noChecks")} />;
  return <div className="plugin-builder-checks">
    <div className={`plugin-builder-check ${draft.errors.length ? "has-error" : "is-passed"}`}><Check size={18} /><span><strong>{t("pluginBuilder.packageStructure")}</strong></span><small>{draft.errors.length ? t("pluginBuilder.needsChanges") : t("pluginBuilder.passed")}</small></div>
    {draft.errors.map(error => <p className="plugin-builder-error" role="alert" key={error}>{error}</p>)}
    {draft.plugin?.mcpServers?.map(server => {
      const check = draft.checks?.[server.id];
      const current = check?.revision === draft.revision;
      const result = current ? check?.result : undefined;
      return <div className="plugin-builder-service-check" key={server.id}><div className="plugin-builder-check"><Plug size={18} /><span><strong>{server.name}</strong><small>{result?.status === "connected" ? t("pluginBuilder.connectedTools", { count: result.toolCount }) : result?.status === "needs-auth" ? t("pluginControls.authorizationRequired") : result?.status === "failed" ? t("providers.status.failed") : check ? t("pluginBuilder.outdated") : t("pluginBuilder.notTested")}</small></span><button className="plugin-detail-secondary" type="button" aria-label={t("pluginBuilder.testServer", { name: server.name })} disabled={disabled || Boolean(draft.errors.length)} onClick={() => onTest(server.id)}>{operation === `test:${server.id}` ? <LoaderCircle className="spin" size={12} /> : null}{t("pluginControls.test")}</button></div>{result?.message && result.status !== "connected" ? <details className="plugin-builder-notice"><summary>{t("common.details")}</summary><pre>{result.message}</pre></details> : null}</div>;
    })}
  </div>;
}

function EmptyView({ label }: { label: string }) {
  return <div className="plugin-builder-preview-empty"><span>{label}</span></div>;
}
function statusLabel(status: PluginSetupSummary["status"]): string {
  return t(`pluginBuilder.status.${status}`);
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
