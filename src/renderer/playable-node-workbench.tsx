import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Box,
  Clipboard,
  FileCode2,
  Film,
  Folder,
  Image as ImageIcon,
  InfoCircle,
  LoaderCircle,
  MoreHorizontal,
  MousePointer2,
  Music2,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "./icons.js";
import {
  PLAYABLE_SHELL_ID,
  type JsonObject,
  type JsonValue,
  type NodeGraph,
  type PlayableAssetDefinition,
  type PlayableNavigationMode,
  type PlayableNode,
  type PlayableSignal,
} from "../shared/playable-nodes.js";
import { playableSignalsOf } from "../shared/playable-graph.js";
import type { NodePlayerDefinition, PlayablePreviewOptions } from "../shared/playable-player-protocol.js";
import type { PlayablePickResult } from "../shared/playable-picker.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import {
  formatPreviewStateInput,
  parsePreviewStateInput,
  playableAssetType,
  playableRuntimeKey,
  type PlayableProjectValidationIssue,
} from "../shared/playable-editor.js";
import { getNodeRuntime } from "./api.js";
import { loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { LibraryAssetPicker, NodeWorkbenchLayout, uploadLibraryFile, WorkbenchBreadcrumb, WorkbenchPreview } from "./node-workbench.js";
import { createMemoryStorage, NodePlayer } from "./playable-player.js";
import { loadPlayableAssets } from "./playable-assets.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { usePlayableChatReport, type PlayableChatState } from "./playable-chat.js";
import { useTechnicalDetails } from "./playable-details.js";

const ASSET_UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.mp3,.wav";
const ACTIVITY_LIMIT = 6;

export interface PlayableAssetRequest extends PlayableAssetDefinition {
  name: string;
}

/** Graph edits the Workbenches make to a Node's or the Shell's Signals. */
export interface PlayableSignalEdits {
  onSignalLabel: (surfaceId: string, signalId: string, label: string) => void;
  /** `undefined` disconnects the Signal; `mode` defaults to the edge's current one. */
  onSignalTarget: (surfaceId: string, signalId: string, targetNodeId: string | undefined, mode?: PlayableNavigationMode) => void;
  /** Puts a request in the chat prompt, such as creating the Scene an Exit should open. */
  onAskAgent?: (text: string) => void;
}

/** A Playtest that starts somewhere other than the saved game. */
export interface PlaytestStart {
  nodeId: string;
  state: JsonObject;
}

export interface PreviewRuntime {
  definition?: NodePlayerDefinition;
  assets?: Record<string, Blob>;
  error?: string;
}

/**
 * One Node's Workbench: a live preview that reports navigation instead of
 * leaving the Node, a preview bar, and an inspector for the parts of the Node
 * the graph owns. The Node's code stays with the Agent; "Open source" is the
 * way to read it.
 */
export function PlayableNodeWorkbench({
  projectId,
  node,
  graph,
  issues,
  revision,
  onClose,
  onOpenNode,
  onOpenSource,
  onRename,
  onSignalLabel,
  onSignalTarget,
  onAskAgent,
  onAddAsset,
  onRemoveAsset,
  onPlayFromHere,
  onSnapshot,
  onChatContextChange,
  headerActions,
}: {
  projectId: string;
  node: PlayableNode;
  graph: NodeGraph;
  issues: readonly PlayableProjectValidationIssue[];
  /** Changes whenever the project's files were saved, so the preview reloads. */
  revision: number;
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
  onOpenSource: () => void;
  onRename: (title: string) => void;
  onAddAsset: (asset: PlayableAssetRequest) => void;
  onRemoveAsset: (assetId: string) => void;
  /** Opens a Playtest that starts at this Scene with the preview's values. */
  onPlayFromHere?: (start: PlaytestStart) => void;
  /** Receives the preview's Runtime snapshots; undefined when a new session starts. */
  onSnapshot?: (snapshot: NodeRuntimeSnapshot | undefined) => void;
  onChatContextChange?: (state: PlayableChatState | undefined) => void;
  /** Project tools shown in the header, such as the State panel toggle. */
  headerActions?: ReactNode;
} & PlayableSignalEdits) {
  const technical = useTechnicalDetails();
  const runtime = usePlayablePreviewRuntime(projectId, revision);
  const [session, setSession] = useState(0);
  const [previewState, setPreviewState] = useState<JsonObject>({});
  const [stateOpen, setStateOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<NodeRuntimeSnapshot>();
  const [diagnostics, setDiagnostics] = useState<{ message: string; at: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PlayablePickResult>();
  const [storage] = useState(createMemoryStorage);
  const page = useRef<HTMLElement>(null);

  // Any new session starts with a clean activity log.
  useEffect(() => {
    setSnapshot(undefined);
    setDiagnostics([]);
    onSnapshot?.(undefined);
  }, [runtime.definition, node.id, session, previewState]);

  useEffect(() => {
    setPicking(false);
    setPicked(undefined);
  }, [node.id]);

  usePlayableChatReport({
    graph,
    surface: { kind: "node", nodeId: node.id },
    picked,
    clearPicked: () => setPicked(undefined),
    stage: page,
    onChange: onChatContextChange,
  });

  const reportSnapshot = useCallback((next: NodeRuntimeSnapshot) => {
    setSnapshot(next);
    onSnapshot?.(next);
  }, [onSnapshot]);
  const onDiagnostic = useCallback((message: string) => {
    setDiagnostics((current) => [...current.slice(-19), { message, at: new Date().toISOString() }]);
  }, []);
  const onPick = useCallback((pick: PlayablePickResult) => {
    setPicked(pick);
    setPicking(false);
  }, []);
  const onPickCancel = useCallback(() => setPicking(false), []);

  const preview: PlayablePreviewOptions = {
    policy: "report",
    startNodeId: node.id,
    ...(Object.keys(previewState).length ? { previewState } : {}),
  };
  const overrides = Object.keys(previewState).length;
  const nodeIssues = issues.filter((issue) => issue.surfaceId === node.id
    || issue.path.startsWith(`nodes/${node.id}/`)
    || Object.values(node.source).includes(issue.path));

  const actions = <>
    <button type="button" className="playable-workbench-tool" title="Play this Scene again from the start" aria-label="Replay" disabled={!runtime.definition} onClick={() => setSession((current) => current + 1)}><RotateCcw size={13} /><span>Replay</span></button>
    <button type="button" className={`playable-workbench-tool${stateOpen ? " is-active" : ""}`} title="Choose the Variables this preview starts with" aria-pressed={stateOpen} onClick={() => setStateOpen((open) => !open)}><Box size={13} /><span>Start with…{overrides ? ` (${overrides})` : ""}</span></button>
    <PointAtButton picking={picking} disabled={!runtime.definition} onToggle={() => setPicking((current) => !current)} />
    {onPlayFromHere ? <button type="button" className="playable-workbench-tool" title="Playtest the game from this Scene" aria-label="Play from here" onClick={() => onPlayFromHere({ nodeId: node.id, state: previewState })}><Play size={12} fill="currentColor" /><span>Play from here</span></button> : null}
  </>;

  const footer = <>
    {stateOpen ? <PreviewStateEditor initialState={graph.initialState} previewState={previewState} onChange={setPreviewState} /> : null}
    {picked ? <PickedElement pick={picked} onClear={() => setPicked(undefined)} /> : null}
    <PreviewActivity graph={graph} snapshot={snapshot} diagnostics={diagnostics} buildError={runtime.error} onOpenNode={onOpenNode} onSignalTarget={onSignalTarget} onAskAgent={onAskAgent} />
  </>;

  const previewPane = <WorkbenchPreview
    ariaLabel={`${node.title} live preview`}
    viewport={graph.viewport}
    stageClassName="playable-workbench-stage"
    actions={actions}
    footer={footer}
  >
    {runtime.definition && runtime.assets ? <NodePlayer
      key={session}
      definition={runtime.definition}
      assets={runtime.assets}
      saveKey={`ohmygame:playable:preview:${projectId}`}
      storage={storage}
      preview={preview}
      picking={picking}
      onPick={onPick}
      onPickCancel={onPickCancel}
      onSnapshot={reportSnapshot}
      onDiagnostic={onDiagnostic}
    /> : <div className={`playable-workbench-stage-state${runtime.error ? " is-error" : ""}`} role={runtime.error ? "alert" : undefined}>
      {runtime.error ?? "Loading preview..."}
    </div>}
  </WorkbenchPreview>;

  const inspector = <aside className="story-inspector playable-workbench-inspector" aria-label="Scene inspector">
    <div className="story-inspector-content">
      <label className="story-inspector-field">
        <span>Title</span>
        <CommitInput value={node.title} ariaLabel="Scene title" maxLength={120} onCommit={onRename} />
      </label>
      {technical || graph.entryNodeId === node.id ? <p className="playable-workbench-meta">
        {technical ? <>ID <code>{node.id}</code></> : null}
        {graph.entryNodeId === node.id ? <b title="The player starts here">Start</b> : null}
      </p> : null}
      {nodeIssues.length ? <ul className="playable-workbench-issues" role="alert">
        {nodeIssues.map((issue, index) => <li key={`${index}:${issue.message}`}><InfoCircle size={12} /><span>{issue.message}</span></li>)}
      </ul> : null}
      <PlayableExitsSection
        surfaceId={node.id}
        signals={node.signals}
        graph={graph}
        emptyText="This Scene has no exits yet. Ask the AI to add a button or choice that leads somewhere."
        onOpenNode={onOpenNode}
        onSignalLabel={onSignalLabel}
        onSignalTarget={onSignalTarget}
      />
      <PlayableAssetsSection projectId={projectId} assetIds={node.assets} graph={graph} issues={issues} emptyText="This Scene uses no assets yet." onAddAsset={onAddAsset} onRemoveAsset={onRemoveAsset} />
      <PlayableStateUsedSection nodeId={node.id} snapshot={snapshot} />
    </div>
  </aside>;

  return <section ref={page} className="story-node-editor-page playable-workbench-page" aria-label={`${node.title} workbench`}>
    <header className="story-node-editor-header window-drag-handle">
      <WorkbenchBreadcrumb label={node.title} onClose={onClose} />
      <div className="playable-workbench-header-actions">
        {headerActions}
        <WorkbenchOverflowMenu onOpenSource={onOpenSource} />
      </div>
    </header>
    <NodeWorkbenchLayout className="playable-node-workbench" preview={previewPane} inspector={inspector} timeline={null} />
  </section>;
}

export function WorkbenchOverflowMenu({ onOpenSource }: { onOpenSource: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number }>();

  useLayoutEffect(() => {
    if (position) menu.current?.focus();
  }, [position]);

  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(undefined);
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as globalThis.Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close();
    };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", close);
    };
  }, [position]);

  return <>
    <button
      ref={button}
      className="playable-workbench-more"
      type="button"
      title="More"
      aria-label="More actions"
      aria-haspopup="menu"
      aria-expanded={Boolean(position)}
      onClick={() => {
        if (position) return setPosition(undefined);
        const bounds = button.current?.getBoundingClientRect();
        if (bounds) setPosition({ top: bounds.bottom + 4, right: window.innerWidth - bounds.right });
      }}
    ><MoreHorizontal size={15} /></button>
    {position ? createPortal(<div
      ref={menu}
      className="story-canvas-context-menu playable-workbench-menu"
      role="menu"
      aria-label="More actions"
      tabIndex={-1}
      style={{ top: position.top, right: position.right }}
    >
      <button type="button" role="menuitem" onClick={() => { setPosition(undefined); onOpenSource(); }}><FileCode2 size={15} /><span>Open code</span></button>
    </div>, document.body) : null}
  </>;
}

export function PreviewStateEditor({ initialState, previewState, onChange }: {
  initialState: JsonObject;
  previewState: JsonObject;
  onChange: (state: JsonObject) => void;
}) {
  const keys = Object.keys(initialState);
  return <div className="playable-workbench-state" aria-label="Start with">
    <header>
      <strong>Start with…</strong>
      <span>Variables this run starts with, instead of their usual starting values.</span>
      <button type="button" disabled={!Object.keys(previewState).length} onClick={() => onChange({})}>Clear</button>
    </header>
    {keys.length ? <div className="playable-workbench-state-rows">
      {keys.map((key) => <PreviewStateRow
        key={key}
        name={key}
        initial={initialState[key]!}
        value={Object.hasOwn(previewState, key) ? previewState[key]! : initialState[key]!}
        overridden={Object.hasOwn(previewState, key)}
        onChange={(value) => {
          const next = { ...previewState };
          if (JSON.stringify(value) === JSON.stringify(initialState[key])) delete next[key];
          else next[key] = value;
          onChange(next);
        }}
      />)}
    </div> : <p className="story-media-empty">The project has no Variables yet. Ask the AI to add one.</p>}
  </div>;
}

export function PreviewStateRow({ name, initial, value, overridden, onChange }: {
  name: string;
  initial: JsonValue;
  value: JsonValue;
  overridden: boolean;
  onChange: (value: JsonValue) => void;
}) {
  const [draft, setDraft] = useState(formatPreviewStateInput(value));
  const [error, setError] = useState<string>();
  useEffect(() => { setDraft(formatPreviewStateInput(value)); setError(undefined); }, [JSON.stringify(value)]);

  const commit = (text: string) => {
    const parsed = parsePreviewStateInput(text, initial);
    if ("error" in parsed) return setError(parsed.error);
    setError(undefined);
    if (JSON.stringify(parsed.value) !== JSON.stringify(value)) onChange(parsed.value);
  };

  return <label className={`playable-workbench-state-row${overridden ? " is-overridden" : ""}${error ? " is-invalid" : ""}`}>
    <span title={name}>{name}</span>
    {typeof initial === "boolean" ? <select value={String(value)} onChange={(event) => commit(event.target.value)}>
      <option value="false">false</option>
      <option value="true">true</option>
    </select> : <input
      value={draft}
      type={typeof initial === "number" ? "number" : "text"}
      spellCheck={false}
      title={error}
      aria-invalid={Boolean(error)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); }}
    />}
  </label>;
}

export function PointAtButton({ picking, disabled, onToggle }: { picking: boolean; disabled: boolean; onToggle: () => void }) {
  return <button type="button" className={`playable-workbench-tool${picking ? " is-active" : ""}`} title="Point at something to tell the AI" aria-pressed={picking} disabled={disabled} onClick={onToggle}>
    <MousePointer2 size={13} /><span>{picking ? "Click something…" : "Point at…"}</span>
  </button>;
}

export function PickedElement({ pick, onClear }: { pick: PlayablePickResult; onClear: () => void }) {
  const reference = `${pick.nodeId} ${pick.source ?? pick.cssPath}`;
  return <div className="playable-workbench-pick">
    <MousePointer2 size={12} />
    <span title={pick.cssPath}><code>&lt;{pick.tag}&gt;</code>{pick.text ? ` "${pick.text}"` : ""}</span>
    <small title={reference}>{pick.source ?? pick.cssPath}</small>
    <button type="button" title="Copy reference" aria-label="Copy element reference" onClick={() => void navigator.clipboard?.writeText(reference)}><Clipboard size={12} /></button>
    <button type="button" title="Clear" aria-label="Clear picked element" onClick={onClear}><X size={12} /></button>
  </div>;
}

type ActivityItem =
  | { kind: "report"; at: string; text: string; targetNodeId?: string }
  | { kind: "unconnected"; at: string; surfaceId: string; signal: string; label: string; sourceTitle: string }
  | { kind: "error"; at: string; text: string };

/**
 * What the preview did instead of navigating: the Exits taken, the ones that
 * go nowhere yet (with a way to connect them), and errors.
 */
export function PreviewActivity({ graph, snapshot, diagnostics, buildError, onOpenNode, onSignalTarget, onAskAgent }: {
  graph: NodeGraph;
  snapshot?: NodeRuntimeSnapshot;
  diagnostics: readonly { message: string; at: string }[];
  buildError?: string;
  onOpenNode: (nodeId: string) => void;
  onSignalTarget?: PlayableSignalEdits["onSignalTarget"];
  onAskAgent?: (text: string) => void;
}) {
  const titleOf = (nodeId?: string) => nodeId === PLAYABLE_SHELL_ID
    ? "Overlay"
    : graph.nodes.find((candidate) => candidate.id === nodeId)?.title ?? nodeId;
  const items: ActivityItem[] = [
    ...(snapshot?.reports ?? []).map((report): ActivityItem => {
      if (report.kind === "signal") {
        const label = playableSignalsOf(graph, report.nodeId)?.find((signal) => signal.id === report.signal)?.label ?? report.signal;
        if (!report.targetNodeId) {
          return { kind: "unconnected", at: report.at, surfaceId: report.nodeId, signal: report.signal, label, sourceTitle: titleOf(report.nodeId) ?? report.nodeId };
        }
        return {
          kind: "report",
          at: report.at,
          text: `"${label}" → ${titleOf(report.targetNodeId)}${report.mode === "push" ? " · can go back" : ""}`,
          targetNodeId: report.targetNodeId,
        };
      }
      if (report.kind === "back") return { kind: "report", at: report.at, text: report.targetNodeId ? `Back → ${titleOf(report.targetNodeId)}` : "Back, but there is nowhere to go back to", targetNodeId: report.targetNodeId };
      return { kind: "report", at: report.at, text: `${report.kind === "restart" ? "Replay" : "Continue"} → ${titleOf(report.targetNodeId)}`, targetNodeId: report.targetNodeId };
    }),
    ...(snapshot?.errors ?? []).map((error): ActivityItem => ({ kind: "error", at: error.at, text: error.nodeId ? `${titleOf(error.nodeId)}: ${error.message}` : error.message })),
    ...diagnostics.map((diagnostic): ActivityItem => ({ kind: "error", at: diagnostic.at, text: diagnostic.message })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT);
  // Diagnostics can repeat a runtime error, and a player can press one
  // unconnected Exit many times; show each once.
  const connected = (item: Extract<ActivityItem, { kind: "unconnected" }>) => graph.edges.some((edge) =>
    edge.source.nodeId === item.surfaceId && edge.source.signal === item.signal);
  const seen = new Set<string>();
  // An Exit connected since it was used no longer needs a warning.
  const unique = items.filter((item) => {
    if (item.kind === "unconnected" && connected(item)) return false;
    const key = item.kind === "unconnected" ? `unconnected:${item.surfaceId}:${item.signal}` : `${item.kind}:${item.text}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });

  return <div className="playable-workbench-activity" aria-label="What happened in the preview" aria-live="polite">
    {buildError ? <p className="is-error" role="alert"><InfoCircle size={12} /><span>{buildError}</span></p> : null}
    {unique.map((item, index) => {
      if (item.kind === "unconnected") {
        return <p key={`${item.at}:${index}`} className="is-warning">
          <InfoCircle size={12} />
          <span title={`"${item.label}" in ${item.sourceTitle}`}>"{item.label}" doesn't go anywhere yet</span>
          {onSignalTarget ? <select aria-label={`Connect "${item.label}" to a Scene`} value="" onChange={(event) => { if (event.target.value) onSignalTarget(item.surfaceId, item.signal, event.target.value); }}>
            <option value="">Connect…</option>
            {graph.nodes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
          </select> : null}
          {onAskAgent ? <button type="button" title="Ask the AI to create the Scene this exit should open" onClick={() => onAskAgent(askToCreateTarget(item.label, item.sourceTitle))}><Sparkles size={11} /><span>Ask AI to create it</span></button> : null}
        </p>;
      }
      return <p key={`${item.at}:${index}`} className={item.kind === "error" ? "is-error" : undefined}>
        {item.kind === "error" ? <InfoCircle size={12} /> : <ArrowRight size={12} />}
        <span title={item.text}>{item.text}</span>
        {item.kind === "report" && item.targetNodeId ? <button type="button" onClick={() => onOpenNode(item.targetNodeId!)}>Open</button> : null}
      </p>;
    })}
    {!buildError && !unique.length ? <p className="is-empty"><span>Try the preview. Exits you use show up here instead of changing the Scene.</span></p> : null}
  </div>;
}

/** The chat request behind "Ask AI to create it". */
export function askToCreateTarget(label: string, sourceTitle: string): string {
  return `"${label}" in ${sourceTitle} doesn't go anywhere yet. Create the Scene it should open and connect it.`;
}

/**
 * Builds the project's current sources for a Workbench preview. A rebuild
 * with identical output keeps the running preview.
 */
export function usePlayablePreviewRuntime(projectId: string, revision: number): PreviewRuntime {
  const [runtime, setRuntime] = useState<PreviewRuntime>({});
  const runtimeKey = useRef<string | undefined>(undefined);
  const assetCache = useRef(new Map<string, Blob>());

  useEffect(() => {
    let disposed = false;
    void getNodeRuntime(projectId).then(async (result) => {
      if (!result.available) throw new Error("This project has no graph.json.");
      const key = playableRuntimeKey(result.definition);
      if (key === runtimeKey.current) {
        if (!disposed) setRuntime((current) => ({ ...current, error: undefined }));
        return;
      }
      const assets = await loadPlayableAssets(projectId, result.definition.graph, assetCache.current);
      if (disposed) return;
      runtimeKey.current = key;
      setRuntime({ definition: result.definition, assets });
    }).catch((cause) => {
      if (!disposed) setRuntime((current) => ({ ...current, error: errorMessage(cause) }));
    });
    return () => { disposed = true; };
  }, [projectId, revision]);

  return runtime;
}

/**
 * The Exits of a Node or the Shell: what each is called, which Scene it
 * opens, and whether the player can come back.
 */
export function PlayableExitsSection({ surfaceId, signals, graph, emptyText, onOpenNode, onSignalLabel, onSignalTarget }: {
  surfaceId: string;
  signals: readonly PlayableSignal[];
  graph: NodeGraph;
  emptyText: string;
  onOpenNode: (nodeId: string) => void;
} & Pick<PlayableSignalEdits, "onSignalLabel" | "onSignalTarget">) {
  const technical = useTechnicalDetails();
  return <section className="story-open-ui-inspector-section playable-workbench-section">
    <h3>Exits</h3>
    {signals.length ? <div className="playable-workbench-signals">
      {signals.map((signal) => {
        const edge = graph.edges.find((candidate) => candidate.source.nodeId === surfaceId && candidate.source.signal === signal.id);
        return <div className={`playable-workbench-signal${edge ? "" : " is-unconnected"}`} key={signal.id}>
          <div className="playable-workbench-signal-label">
            <CommitInput value={signal.label} ariaLabel={`Name of exit ${signal.label || signal.id}`} maxLength={120} onCommit={(label) => onSignalLabel(surfaceId, signal.id, label)} />
            {technical ? <code title="Signal ID">{signal.id}</code> : null}
          </div>
          <div className="playable-workbench-signal-target">
            <ArrowRight size={12} aria-hidden="true" />
            <select aria-label={`Scene that ${signal.label || signal.id} opens`} value={edge?.targetNodeId ?? ""} onChange={(event) => onSignalTarget(surfaceId, signal.id, event.target.value || undefined)}>
              <option value="">Goes nowhere yet</option>
              {graph.nodes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
            </select>
            <button type="button" title="Open that Scene" aria-label={`Open the Scene ${signal.label || signal.id} opens`} disabled={!edge} onClick={() => { if (edge) onOpenNode(edge.targetNodeId); }}><ArrowRight size={13} /></button>
          </div>
          {edge ? <label className="playable-workbench-signal-back" title="The player can return here with Back">
            <input type="checkbox" checked={edge.mode === "push"} onChange={(event) => onSignalTarget(surfaceId, signal.id, edge.targetNodeId, event.target.checked ? "push" : "replace")} />
            <span>Allow Back</span>
          </label> : null}
        </div>;
      })}
    </div> : <p className="story-media-empty">{emptyText}</p>}
  </section>;
}

export function PlayableAssetsSection({ projectId, assetIds, graph, issues, emptyText, onAddAsset, onRemoveAsset }: {
  projectId: string;
  assetIds: readonly string[];
  graph: NodeGraph;
  issues: readonly PlayableProjectValidationIssue[];
  emptyText: string;
  onAddAsset: (asset: PlayableAssetRequest) => void;
  onRemoveAsset: (assetId: string) => void;
}) {
  const [library, setLibrary] = useState<LibraryAsset[]>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let disposed = false;
    void loadLibraryAssets().then((assets) => { if (!disposed) setLibrary(assets); }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  const add = (asset: LibraryAsset) => {
    const type = playableAssetType(asset.mediaType);
    if (!type) return setError("Scenes can use images, video, and audio.");
    setError(undefined);
    onAddAsset({ name: asset.name, type, source: { kind: "library", assetId: asset.id } });
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError(undefined);
    try {
      const asset = await uploadLibraryFile(file);
      setLibrary((current) => current ? [asset, ...current] : current);
      add(asset);
    } catch (cause) {
      setError(`Could not upload asset: ${errorMessage(cause)}`);
    } finally {
      setUploading(false);
    }
  };

  return <section className="story-open-ui-inspector-section playable-workbench-section">
    <h3>Assets</h3>
    {assetIds.length ? <div className="story-media-list">
      {assetIds.map((assetId) => {
        const definition = graph.assets[assetId];
        const missing = !definition
          ? "Missing"
          : definition.source.kind === "library"
            ? library && !library.some((asset) => asset.id === (definition.source as { assetId: string }).assetId) ? "Missing from Library" : undefined
            : issues.find((issue) => issue.path.startsWith(`/assets/${escapePointer(assetId)}/`))?.message;
        return <PlayableAssetRow key={assetId} projectId={projectId} assetId={assetId} definition={definition} missing={missing} onRemove={() => onRemoveAsset(assetId)} />;
      })}
    </div> : <p className="story-media-empty">{emptyText}</p>}
    <div className="story-media-actions">
      <button className="story-field-add" type="button" disabled={!library} onClick={() => setPickerOpen(true)}><Folder size={13} /><span>From Library</span></button>
      <button className="story-field-add" type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>
        {uploading ? <LoaderCircle className="spin" size={13} /> : <Upload size={13} />}<span>{uploading ? "Uploading" : "Upload"}</span>
      </button>
      <input ref={fileInput} type="file" accept={ASSET_UPLOAD_ACCEPT} hidden onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void upload(file);
      }} />
    </div>
    {error ? <p className="story-media-error" role="alert">{error}</p> : null}
    {pickerOpen && library ? <LibraryAssetPicker
      title="Add from Library"
      assets={library.filter((asset) => playableAssetType(asset.mediaType))}
      onClose={() => setPickerOpen(false)}
      onSelect={(asset) => { setPickerOpen(false); add(asset); }}
    /> : null}
  </section>;
}

function PlayableAssetRow({ projectId, assetId, definition, missing, onRemove }: {
  projectId: string;
  assetId: string;
  definition?: PlayableAssetDefinition;
  missing?: string;
  onRemove: () => void;
}) {
  const image = definition?.type === "image" && !missing;
  const source = definition?.source;
  const thumbnail = useWorkspaceAssetUrl(
    image && source?.kind === "workspace" ? projectId : undefined,
    source?.kind === "workspace" ? source.path : "",
    0,
    image && source?.kind === "library" ? source.assetId : undefined,
  );
  const Icon = definition?.type === "video" ? Film : definition?.type === "audio" ? Music2 : ImageIcon;
  return <div className={`story-media-row playable-workbench-asset${missing ? " is-missing" : ""}`}>
    <span>{thumbnail.url ? <img src={thumbnail.url} alt="" /> : <Icon size={15} />}</span>
    <div>
      <strong title={assetId}>{assetId}</strong>
      <small title={missing}>{missing ?? (source?.kind === "workspace" ? source.path : `${definition?.type ?? "asset"} · Library`)}</small>
    </div>
    <button type="button" title="Remove" aria-label={`Remove ${assetId}`} onClick={onRemove}><Trash2 size={13} /></button>
  </div>;
}

function PlayableStateUsedSection({ nodeId, snapshot }: { nodeId: string; snapshot?: NodeRuntimeSnapshot }) {
  const access = snapshot?.stateAccess[nodeId];
  const readsAll = Boolean(access?.read.includes("*"));
  const explicit = [...new Set([...(access?.read ?? []), ...(access?.wrote ?? [])])].filter((key) => key !== "*");
  const keys = explicit.length || !readsAll ? explicit : Object.keys(snapshot?.state ?? {});
  return <section className="story-open-ui-inspector-section playable-workbench-section">
    <h3>Variables used</h3>
    {readsAll ? <p className="story-media-empty">This Scene reads every Variable.</p> : null}
    {keys.length ? <dl className="playable-workbench-state-used">
      {keys.map((key) => <div key={key}>
        <dt>
          <code>{key}</code>
          {access?.read.includes(key) ? <b>reads</b> : null}
          {access?.wrote.includes(key) ? <b className="is-write">changes</b> : null}
        </dt>
        <dd title={JSON.stringify(snapshot?.state[key] ?? null, null, 2)}>{JSON.stringify(snapshot?.state[key] ?? null)}</dd>
      </div>)}
    </dl> : !readsAll ? <p className="story-media-empty">No Variables used in this preview yet.</p> : null}
  </section>;
}

export function CommitInput({ value, ariaLabel, maxLength, onCommit }: {
  value: string;
  ariaLabel: string;
  maxLength: number;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };
  return <input
    aria-label={ariaLabel}
    value={draft}
    maxLength={maxLength}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") { setDraft(value); event.currentTarget.blur(); }
    }}
  />;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
