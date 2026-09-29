import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "./icons.js";
import type { JsonObject, JsonValue, NodeGraph, PlayableAssetDefinition, PlayableNode } from "../shared/playable-nodes.js";
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
import { NodePlayer } from "./playable-player.js";
import { loadPlayableAssets } from "./playable-assets.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

const ASSET_UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.mp3,.wav";
const ACTIVITY_LIMIT = 6;

export interface PlayableAssetRequest extends PlayableAssetDefinition {
  name: string;
}

interface PreviewRuntime {
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
  onAddAsset,
  onRemoveAsset,
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
  onSignalLabel: (signalId: string, label: string) => void;
  onSignalTarget: (signalId: string, targetNodeId: string | undefined) => void;
  onAddAsset: (asset: PlayableAssetRequest) => void;
  onRemoveAsset: (assetId: string) => void;
}) {
  const [runtime, setRuntime] = useState<PreviewRuntime>({});
  const [session, setSession] = useState(0);
  const [previewState, setPreviewState] = useState<JsonObject>({});
  const [stateOpen, setStateOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<NodeRuntimeSnapshot>();
  const [diagnostics, setDiagnostics] = useState<{ message: string; at: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PlayablePickResult>();
  const [storage] = useState(createMemoryStorage);
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

  // Any new session starts with a clean activity log.
  useEffect(() => {
    setSnapshot(undefined);
    setDiagnostics([]);
  }, [runtime.definition, node.id, session, previewState]);

  useEffect(() => {
    setPicking(false);
    setPicked(undefined);
  }, [node.id]);

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
    <button type="button" className="playable-workbench-tool" title="Restart node" aria-label="Restart node" disabled={!runtime.definition} onClick={() => setSession((current) => current + 1)}><RotateCcw size={13} /><span>Restart</span></button>
    <button type="button" className={`playable-workbench-tool${stateOpen ? " is-active" : ""}`} title="Preview state" aria-pressed={stateOpen} onClick={() => setStateOpen((open) => !open)}><Box size={13} /><span>State{overrides ? ` (${overrides})` : ""}</span></button>
    <button type="button" className={`playable-workbench-tool${picking ? " is-active" : ""}`} title="Point at part of the preview" aria-pressed={picking} disabled={!runtime.definition} onClick={() => setPicking((current) => !current)}><MousePointer2 size={13} /><span>{picking ? "Picking..." : "Pick element"}</span></button>
  </>;

  const footer = <>
    {stateOpen ? <PreviewStateEditor initialState={graph.initialState} previewState={previewState} onChange={setPreviewState} /> : null}
    {picked ? <PickedElement pick={picked} onClear={() => setPicked(undefined)} /> : null}
    <PreviewActivity graph={graph} snapshot={snapshot} diagnostics={diagnostics} buildError={runtime.error} onOpenNode={onOpenNode} />
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
      onSnapshot={setSnapshot}
      onDiagnostic={onDiagnostic}
    /> : <div className={`playable-workbench-stage-state${runtime.error ? " is-error" : ""}`} role={runtime.error ? "alert" : undefined}>
      {runtime.error ?? "Loading preview..."}
    </div>}
  </WorkbenchPreview>;

  const inspector = <aside className="story-inspector playable-workbench-inspector" aria-label="Node inspector">
    <div className="story-inspector-content">
      <label className="story-inspector-field">
        <span>Title</span>
        <CommitInput value={node.title} ariaLabel="Node title" maxLength={120} onCommit={onRename} />
      </label>
      <p className="playable-workbench-meta">ID <code>{node.id}</code>{graph.entryNodeId === node.id ? <b>Entry</b> : null}</p>
      {nodeIssues.length ? <ul className="playable-workbench-issues" role="alert">
        {nodeIssues.map((issue, index) => <li key={`${index}:${issue.message}`}><InfoCircle size={12} /><span>{issue.message}</span></li>)}
      </ul> : null}
      <PlayableSignalsSection node={node} graph={graph} onOpenNode={onOpenNode} onSignalLabel={onSignalLabel} onSignalTarget={onSignalTarget} />
      <PlayableAssetsSection projectId={projectId} node={node} graph={graph} issues={issues} onAddAsset={onAddAsset} onRemoveAsset={onRemoveAsset} />
      <PlayableStateUsedSection nodeId={node.id} snapshot={snapshot} />
    </div>
  </aside>;

  return <section className="story-node-editor-page playable-workbench-page" aria-label={`${node.title} workbench`}>
    <header className="story-node-editor-header window-drag-handle">
      <WorkbenchBreadcrumb label={node.title} onClose={onClose} />
      <WorkbenchOverflowMenu onOpenSource={onOpenSource} />
    </header>
    <NodeWorkbenchLayout className="playable-node-workbench" preview={previewPane} inspector={inspector} timeline={null} />
  </section>;
}

function WorkbenchOverflowMenu({ onOpenSource }: { onOpenSource: () => void }) {
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
      aria-label="More node actions"
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
      aria-label="Node actions"
      tabIndex={-1}
      style={{ top: position.top, right: position.right }}
    >
      <button type="button" role="menuitem" onClick={() => { setPosition(undefined); onOpenSource(); }}><FileCode2 size={15} /><span>Open source</span></button>
    </div>, document.body) : null}
  </>;
}

function PreviewStateEditor({ initialState, previewState, onChange }: {
  initialState: JsonObject;
  previewState: JsonObject;
  onChange: (state: JsonObject) => void;
}) {
  const keys = Object.keys(initialState);
  return <div className="playable-workbench-state" aria-label="Preview state">
    <header>
      <strong>Preview State</strong>
      <span>Starts this preview with these Project State values.</span>
      <button type="button" disabled={!Object.keys(previewState).length} onClick={() => onChange({})}>Reset</button>
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
    </div> : <p className="story-media-empty">The project declares no State. Ask the Agent to add keys to initialState.</p>}
  </div>;
}

function PreviewStateRow({ name, initial, value, overridden, onChange }: {
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

function PickedElement({ pick, onClear }: { pick: PlayablePickResult; onClear: () => void }) {
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
  | { kind: "error"; at: string; text: string };

function PreviewActivity({ graph, snapshot, diagnostics, buildError, onOpenNode }: {
  graph: NodeGraph;
  snapshot?: NodeRuntimeSnapshot;
  diagnostics: readonly { message: string; at: string }[];
  buildError?: string;
  onOpenNode: (nodeId: string) => void;
}) {
  const titleOf = (nodeId?: string) => graph.nodes.find((candidate) => candidate.id === nodeId)?.title ?? nodeId;
  const items: ActivityItem[] = [
    ...(snapshot?.reports ?? []).map((report): ActivityItem => {
      if (report.kind === "signal") {
        const label = graph.nodes.find((candidate) => candidate.id === report.nodeId)?.signals.find((signal) => signal.id === report.signal)?.label ?? report.signal;
        return {
          kind: "report",
          at: report.at,
          text: report.targetNodeId
            ? `Signal "${label}" → ${titleOf(report.targetNodeId)}${report.mode === "push" ? " (push)" : ""}`
            : `Signal "${label}" is not connected`,
          targetNodeId: report.targetNodeId,
        };
      }
      if (report.kind === "back") return { kind: "report", at: report.at, text: report.targetNodeId ? `Back → ${titleOf(report.targetNodeId)}` : "Back with an empty back stack", targetNodeId: report.targetNodeId };
      if (report.kind === "destination") return { kind: "report", at: report.at, text: `Destination "${report.destination}" → ${titleOf(report.targetNodeId)}`, targetNodeId: report.targetNodeId };
      return { kind: "report", at: report.at, text: `${report.kind === "restart" ? "Restart" : "Continue"} → ${titleOf(report.targetNodeId)}`, targetNodeId: report.targetNodeId };
    }),
    ...(snapshot?.errors ?? []).map((error): ActivityItem => ({ kind: "error", at: error.at, text: error.nodeId ? `${titleOf(error.nodeId)}: ${error.message}` : error.message })),
    ...diagnostics.map((diagnostic): ActivityItem => ({ kind: "error", at: diagnostic.at, text: diagnostic.message })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT);
  // Diagnostics can repeat a runtime error; show each message once.
  const seen = new Set<string>();
  const unique = items.filter((item) => !seen.has(`${item.kind}:${item.text}`) && Boolean(seen.add(`${item.kind}:${item.text}`)));

  return <div className="playable-workbench-activity" aria-label="Recent Signals and errors" aria-live="polite">
    {buildError ? <p className="is-error" role="alert"><InfoCircle size={12} /><span>{buildError}</span></p> : null}
    {unique.map((item, index) => <p key={`${item.at}:${index}`} className={item.kind === "error" ? "is-error" : undefined}>
      {item.kind === "error" ? <InfoCircle size={12} /> : <ArrowRight size={12} />}
      <span title={item.text}>{item.text}</span>
      {item.kind === "report" && item.targetNodeId ? <button type="button" onClick={() => onOpenNode(item.targetNodeId!)}>Open</button> : null}
    </p>)}
    {!buildError && !unique.length ? <p className="is-empty"><span>Use the preview. Signals it sends show up here instead of navigating.</span></p> : null}
  </div>;
}

function PlayableSignalsSection({ node, graph, onOpenNode, onSignalLabel, onSignalTarget }: {
  node: PlayableNode;
  graph: NodeGraph;
  onOpenNode: (nodeId: string) => void;
  onSignalLabel: (signalId: string, label: string) => void;
  onSignalTarget: (signalId: string, targetNodeId: string | undefined) => void;
}) {
  return <section className="story-open-ui-inspector-section playable-workbench-section">
    <h3>Signals</h3>
    {node.signals.length ? <div className="playable-workbench-signals">
      {node.signals.map((signal) => {
        const edge = graph.edges.find((candidate) => candidate.source.nodeId === node.id && candidate.source.signal === signal.id);
        return <div className="playable-workbench-signal" key={signal.id}>
          <div className="playable-workbench-signal-label">
            <CommitInput value={signal.label} ariaLabel={`Label for Signal ${signal.id}`} maxLength={120} onCommit={(label) => onSignalLabel(signal.id, label)} />
            <code title="Signal ID">{signal.id}</code>
          </div>
          <div className="playable-workbench-signal-target">
            <ArrowRight size={12} aria-hidden="true" />
            <select aria-label={`Target for Signal ${signal.id}`} value={edge?.targetNodeId ?? ""} onChange={(event) => onSignalTarget(signal.id, event.target.value || undefined)}>
              <option value="">Not connected</option>
              {graph.nodes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
            </select>
            <button type="button" title="Open target node" aria-label={`Open target of ${signal.label}`} disabled={!edge} onClick={() => { if (edge) onOpenNode(edge.targetNodeId); }}><ArrowRight size={13} /></button>
          </div>
        </div>;
      })}
    </div> : <p className="story-media-empty">This Node sends no Signals yet. Ask the Agent to add one.</p>}
  </section>;
}

function PlayableAssetsSection({ projectId, node, graph, issues, onAddAsset, onRemoveAsset }: {
  projectId: string;
  node: PlayableNode;
  graph: NodeGraph;
  issues: readonly PlayableProjectValidationIssue[];
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
    if (!type) return setError("Nodes can use images, video, and audio.");
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
    {node.assets.length ? <div className="story-media-list">
      {node.assets.map((assetId) => {
        const definition = graph.assets[assetId];
        const missing = !definition
          ? "Not declared in graph.json"
          : definition.source.kind === "library"
            ? library && !library.some((asset) => asset.id === (definition.source as { assetId: string }).assetId) ? "Missing from Library" : undefined
            : issues.find((issue) => issue.path.startsWith(`/assets/${escapePointer(assetId)}/`))?.message;
        return <PlayableAssetRow key={assetId} projectId={projectId} assetId={assetId} definition={definition} missing={missing} onRemove={() => onRemoveAsset(assetId)} />;
      })}
    </div> : <p className="story-media-empty">No assets declared for this Node.</p>}
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
    <button type="button" title="Remove from Node" aria-label={`Remove ${assetId}`} onClick={onRemove}><Trash2 size={13} /></button>
  </div>;
}

function PlayableStateUsedSection({ nodeId, snapshot }: { nodeId: string; snapshot?: NodeRuntimeSnapshot }) {
  const access = snapshot?.stateAccess[nodeId];
  const readsAll = Boolean(access?.read.includes("*"));
  const explicit = [...new Set([...(access?.read ?? []), ...(access?.wrote ?? [])])].filter((key) => key !== "*");
  const keys = explicit.length || !readsAll ? explicit : Object.keys(snapshot?.state ?? {});
  return <section className="story-open-ui-inspector-section playable-workbench-section">
    <h3>State used</h3>
    {readsAll ? <p className="story-media-empty">This Node reads or subscribes to the whole State.</p> : null}
    {keys.length ? <dl className="playable-workbench-state-used">
      {keys.map((key) => <div key={key}>
        <dt>
          <code>{key}</code>
          {access?.read.includes(key) ? <b>read</b> : null}
          {access?.wrote.includes(key) ? <b className="is-write">wrote</b> : null}
        </dt>
        <dd title={JSON.stringify(snapshot?.state[key] ?? null, null, 2)}>{JSON.stringify(snapshot?.state[key] ?? null)}</dd>
      </div>)}
    </dl> : !readsAll ? <p className="story-media-empty">No State used in this preview yet.</p> : null}
  </section>;
}

function CommitInput({ value, ariaLabel, maxLength, onCommit }: {
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

/** Preview saves live in memory so a preview never touches the Playtest save. */
function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
