import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Box,
  Brush,
  Check,
  Clipboard,
  FileCode2,
  Folder,
  InfoCircle,
  LoaderCircle,
  MoreHorizontal,
  MousePointer2,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
  type IconComponent,
} from "./icons.js";
import {
  type JsonObject,
  type JsonValue,
  type NodeGraph,
  type PlayableAssetDefinition,
  type PlayableNavigationMode,
  type PlayableNode,
} from "../shared/playable-nodes.js";
import { playableNodeById } from "../shared/playable-graph.js";
import type { NodePlayerDefinition, PlayablePreviewOptions, PlayableTextEdit } from "../shared/playable-player-protocol.js";
import type { PlayablePickResult } from "../shared/playable-picker.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import type { PromptContext } from "../shared/contracts.js";
import { playableElementContext, playableTextEditRequest } from "../shared/playable-chat-context.js";
import {
  formatPreviewStateInput,
  parsePreviewStateInput,
  playableAssetType,
  playableRuntimeKey,
  type PlayableProjectValidationIssue,
} from "../shared/playable-editor.js";
import { getNodeRuntime } from "./api.js";
import { loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { LibraryAssetPicker, uploadLibraryFile, WorkbenchBreadcrumb, WorkbenchPreview } from "./node-workbench.js";
import { createMemoryStorage, NodePlayer } from "./playable-player.js";
import { loadPlayableAssets } from "./playable-assets.js";
import { playablePickKey, usePlayableChatReport, type PlayableChatState, type PlayableStroke } from "./playable-chat.js";

const ASSET_UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm";
const ACTIVITY_LIMIT = 6;
const PICK_LIMIT = 8;
const MEDIA_TAGS = new Set(["img", "video", "picture"]);

export interface PlayableAssetRequest extends PlayableAssetDefinition {
  name: string;
}

/** Graph edits the editor makes to a Node's Signals. */
export interface PlayableSignalEdits {
  onSignalLabel: (surfaceId: string, signalId: string, label: string) => void;
  /** `undefined` disconnects the Signal; `mode` defaults to the edge's current one. */
  onSignalTarget: (surfaceId: string, signalId: string, targetNodeId: string | undefined, mode?: PlayableNavigationMode) => void;
  /** Marks an Exit as navigation, like Home, or back to part of the story. */
  onSignalRole: (surfaceId: string, signalId: string, navigation: boolean) => void;
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
 * What the pointer does in the preview: play the game, pick elements for the
 * chat, edit text in place, or draw over it for the chat.
 */
export type PreviewTool = "play" | "select" | "text" | "draw";

/** A change made from the preview, shown with the preview's activity. */
interface PreviewNote {
  at: string;
  text: string;
  /** `asked` waits for the AI. */
  status: "saved" | "asked" | "failed";
}

/**
 * One Node's Workbench: a live preview that reports navigation instead of
 * leaving the Node, with tools to point at, edit, and draw on it. There is no
 * inspector; the AI changes the Node, and "Open code" is the way to read it.
 */
export function PlayableNodeWorkbench({
  projectId,
  node,
  graph,
  issues,
  revision,
  agentBusy = false,
  onClose,
  onOpenNode,
  onOpenSource,
  onRename,
  onSignalTarget,
  onAskAgent,
  onSendToAgent,
  onWriteText,
  onAddAsset,
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
  agentBusy?: boolean;
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
  onOpenSource: () => void;
  onRename: (title: string) => void;
  /** Sends a request to the AI now; resolves false when it could not be sent. */
  onSendToAgent?: (text: string, contexts: PromptContext[]) => Promise<boolean>;
  /** Writes a text edit back to surface HTML; resolves false when it cannot be made in place. */
  onWriteText: (edit: PlayableTextEdit) => Promise<boolean>;
  /** Declares an asset on the Scene and resolves with its ID once saved. */
  onAddAsset: (asset: PlayableAssetRequest) => Promise<string>;
  /** Opens a Playtest that starts at this Scene with the preview's values. */
  onPlayFromHere?: (start: PlaytestStart) => void;
  /** Receives the preview's Runtime snapshots; undefined when a new session starts. */
  onSnapshot?: (snapshot: NodeRuntimeSnapshot | undefined) => void;
  onChatContextChange?: (state: PlayableChatState | undefined) => void;
  /** Project tools shown in the header, such as the State panel toggle. */
  headerActions?: ReactNode;
} & Pick<PlayableSignalEdits, "onSignalTarget" | "onAskAgent">) {
  const runtime = usePlayablePreviewRuntime(projectId, revision);
  const [session, setSession] = useState(0);
  const [previewState, setPreviewState] = useState<JsonObject>({});
  const [stateOpen, setStateOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<NodeRuntimeSnapshot>();
  const [diagnostics, setDiagnostics] = useState<{ message: string; at: string }[]>([]);
  const [tool, setTool] = useState<PreviewTool>("play");
  const [picks, setPicks] = useState<PlayablePickResult[]>([]);
  const [strokes, setStrokes] = useState<PlayableStroke[]>([]);
  const [notes, setNotes] = useState<PreviewNote[]>([]);
  const [storage] = useState(createMemoryStorage);
  const page = useRef<HTMLElement>(null);

  // Any new session starts with a clean activity log.
  useEffect(() => {
    setSnapshot(undefined);
    setDiagnostics([]);
    onSnapshot?.(undefined);
  }, [runtime.definition, node.id, session, previewState]);

  useEffect(() => {
    setTool("play");
    setPicks([]);
    setStrokes([]);
    setNotes([]);
  }, [node.id]);

  // Esc puts the pointer back to playing. The preview frame reports its own Esc.
  useEffect(() => {
    if (tool === "play") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isTextEntry(event.target)) return;
      setTool("play");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tool]);

  const removePick = useCallback((key: string) => setPicks((current) => current.filter((pick) => playablePickKey(pick) !== key)), []);
  usePlayableChatReport({
    graph,
    nodeId: node.id,
    picks,
    strokes,
    onRemovePick: removePick,
    onClearPicks: () => setPicks([]),
    onClearDrawing: () => setStrokes([]),
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
  const onPick = useCallback((pick: PlayablePickResult, additive: boolean) => {
    const key = playablePickKey(pick);
    setPicks((current) => {
      const picked = current.some((candidate) => playablePickKey(candidate) === key);
      if (!additive) return [pick];
      return picked ? current.filter((candidate) => playablePickKey(candidate) !== key) : [...current, pick].slice(-PICK_LIMIT);
    });
  }, []);
  const onPickCancel = useCallback(() => setTool("play"), []);
  const note = useCallback((text: string, status: PreviewNote["status"]) => {
    setNotes((current) => [...current.slice(-9), { at: new Date().toISOString(), text, status }]);
  }, []);

  /** Asks the AI now, or puts the request in the chat prompt when it cannot be sent. */
  const askAgent = useCallback(async (text: string, contexts: PromptContext[], summary: string): Promise<void> => {
    if (onSendToAgent && await onSendToAgent(text, contexts)) return note(summary, "asked");
    if (onAskAgent) {
      onAskAgent(text);
      return note(`${summary} — in the chat, ready to send`, "saved");
    }
    note(`Could not ask the AI: ${summary}`, "failed");
  }, [note, onAskAgent, onSendToAgent]);

  const onTextEdit = useCallback((edit: PlayableTextEdit) => {
    if (edit.before === edit.after) return;
    void (async () => {
      if (edit.inPlace && await onWriteText(edit).catch(() => false)) return note(`Text changed to "${edit.after}"`, "saved");
      await askAgent(playableTextEditRequest(edit.before, edit.after), [playableElementContext(edit.pick)], `Changing "${edit.before}" to "${edit.after}"`);
    })();
  }, [askAgent, note, onWriteText]);

  const replaceMedia = useCallback(async (pick: PlayablePickResult, asset: PlayableAssetRequest) => {
    try {
      const assetId = await onAddAsset(asset);
      await askAgent(
        `Show the asset "${assetId}" in this <${pick.tag}> instead of what it shows now. The asset is declared on the Scene.`,
        [playableElementContext(pick)],
        `Replacing <${pick.tag}> with ${asset.name}`,
      );
    } catch (cause) {
      note(`Could not add ${asset.name}: ${errorMessage(cause)}`, "failed");
    }
  }, [askAgent, note, onAddAsset]);

  const preview: PlayablePreviewOptions = {
    policy: "report",
    startNodeId: node.id,
    ...(Object.keys(previewState).length ? { previewState } : {}),
  };
  const overrides = Object.keys(previewState).length;
  const nodeIssues = issues.filter((issue) => issue.surfaceId === node.id
    || issue.path.startsWith(`nodes/${node.id}/`)
    || Object.values(node.source).includes(issue.path));
  const ready = Boolean(runtime.definition && runtime.assets);

  const actions = <>
    <button type="button" className="playable-workbench-tool" title="Play this Scene again from the start" aria-label="Replay" disabled={!runtime.definition} onClick={() => setSession((current) => current + 1)}><RotateCcw size={13} /><span>Replay</span></button>
    <button type="button" className={`playable-workbench-tool${stateOpen ? " is-active" : ""}`} title="Choose the Variables this preview starts with" aria-pressed={stateOpen} onClick={() => setStateOpen((open) => !open)}><Box size={13} /><span>Start with…{overrides ? ` (${overrides})` : ""}</span></button>
    {onPlayFromHere ? <button type="button" className="playable-workbench-tool" title="Playtest the game from this Scene" aria-label="Play from here" onClick={() => onPlayFromHere({ nodeId: node.id, state: previewState })}><Play size={12} fill="currentColor" /><span>Play from here</span></button> : null}
  </>;

  const footer = <>
    {stateOpen ? <PreviewStateEditor initialState={graph.initialState} previewState={previewState} onChange={setPreviewState} /> : null}
    {picks.length ? <PickedElements
      picks={picks}
      onRemove={removePick}
      onClear={() => setPicks([])}
      onReplaceMedia={(pick, asset) => void replaceMedia(pick, asset)}
      {...(onAskAgent ? { onGenerateMedia: (pick: PlayablePickResult) => onAskAgent(askToGenerateMedia(pick)) } : {})}
    /> : null}
    <PreviewActivity
      graph={graph}
      node={node}
      issues={nodeIssues}
      snapshot={snapshot}
      diagnostics={diagnostics}
      notes={notes}
      agentBusy={agentBusy}
      buildError={runtime.error}
      onOpenNode={onOpenNode}
      onSignalTarget={onSignalTarget}
      onAskAgent={onAskAgent}
    />
  </>;

  const previewPane = <WorkbenchPreview
    ariaLabel={`${node.title} live preview`}
    viewport={graph.viewport}
    stageClassName={`playable-workbench-stage is-tool-${tool}`}
    actions={actions}
    overlay={<PreviewToolbar
      tool={tool}
      disabled={!ready}
      strokes={strokes.length}
      picks={picks.length}
      onTool={setTool}
      onUndoStroke={() => setStrokes((current) => current.slice(0, -1))}
      onClearStrokes={() => setStrokes([])}
    />}
    footer={footer}
  >
    {runtime.definition && runtime.assets ? <NodePlayer
      key={session}
      definition={runtime.definition}
      assets={runtime.assets}
      saveKey={`ohmygame:playable:preview:${projectId}`}
      storage={storage}
      preview={preview}
      {...(tool === "select" || tool === "text" ? { tool } : {})}
      onPick={onPick}
      onTextEdit={onTextEdit}
      onPickCancel={onPickCancel}
      onSnapshot={reportSnapshot}
      onDiagnostic={onDiagnostic}
    /> : <div className={`playable-workbench-stage-state${runtime.error ? " is-error" : ""}`} role={runtime.error ? "alert" : undefined}>
      {runtime.error ?? "Loading preview..."}
    </div>}
    {tool === "draw" || strokes.length ? <DrawingLayer
      viewport={graph.viewport}
      strokes={strokes}
      drawing={tool === "draw"}
      onStroke={(stroke) => setStrokes((current) => [...current, stroke])}
    /> : null}
  </WorkbenchPreview>;

  return <section ref={page} className="story-node-editor-page playable-workbench-page" aria-label={`${node.title} workbench`}>
    <header className="story-node-editor-header window-drag-handle">
      <WorkbenchBreadcrumb label={node.title} onClose={onClose} onRename={onRename} />
      <div className="playable-workbench-header-actions">
        {headerActions}
        <WorkbenchOverflowMenu onOpenSource={onOpenSource} />
      </div>
    </header>
    <div className="story-node-workbench playable-node-workbench">
      <div className="story-node-workbench-stage">
        <div className="story-node-workbench-preview">{previewPane}</div>
      </div>
    </div>
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

const TOOLS: { tool: PreviewTool; label: string; title: string; icon: IconComponent }[] = [
  { tool: "play", label: "Play", title: "Play the preview", icon: Play },
  { tool: "select", label: "Select", title: "Pick things to talk about with the AI. Shift-click to pick more.", icon: MousePointer2 },
  { tool: "text", label: "Text", title: "Click text to change it", icon: Type },
  { tool: "draw", label: "Draw", title: "Draw on the preview to show the AI what you mean", icon: Brush },
];

const TOOL_HINTS: Record<Exclude<PreviewTool, "play">, string> = {
  select: "Click to pick · Shift-click for more · Esc to play",
  text: "Click text to change it · Enter to keep · Esc to play",
  draw: "Draw, then say what you want in the chat · Esc to play",
};

/** Floats over the bottom of the preview. */
export function PreviewToolbar({ tool, disabled, strokes, picks, onTool, onUndoStroke, onClearStrokes }: {
  tool: PreviewTool;
  disabled: boolean;
  strokes: number;
  picks: number;
  onTool: (tool: PreviewTool) => void;
  onUndoStroke: () => void;
  onClearStrokes: () => void;
}) {
  return <div className="playable-preview-toolbar">
    {tool !== "play" ? <p className="playable-preview-toolbar-hint">{TOOL_HINTS[tool]}{tool === "select" && picks ? ` · ${picks} picked` : ""}</p> : null}
    <div role="toolbar" aria-label="Preview tools">
      {TOOLS.map(({ tool: value, label, title, icon: Icon }) => <button
        key={value}
        type="button"
        className={tool === value ? "is-active" : undefined}
        title={title}
        aria-pressed={tool === value}
        disabled={disabled && value !== "play"}
        onClick={() => onTool(value)}
      ><Icon size={14} /><span>{label}</span></button>)}
      {strokes ? <>
        <span className="playable-preview-toolbar-divider" aria-hidden="true" />
        <button type="button" title="Undo the last stroke" aria-label="Undo stroke" onClick={onUndoStroke}><Undo2 size={14} /></button>
        <button type="button" title="Clear the drawing" aria-label="Clear drawing" onClick={onClearStrokes}><Trash2 size={14} /></button>
      </> : null}
    </div>
  </div>;
}

/**
 * Freehand strokes over the preview, in project viewport pixels. Strokes stay
 * visible after drawing ends, until the chat message that carries them.
 */
export function DrawingLayer({ viewport, strokes, drawing, onStroke }: {
  viewport: { width: number; height: number };
  strokes: readonly PlayableStroke[];
  drawing: boolean;
  onStroke: (stroke: PlayableStroke) => void;
}) {
  const [current, setCurrent] = useState<{ pointerId: number; points: { x: number; y: number }[] }>();
  const point = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - bounds.left) / bounds.width) * viewport.width),
      y: Math.round(((event.clientY - bounds.top) / bounds.height) * viewport.height),
    };
  };
  const finish = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (current?.pointerId !== event.pointerId) return;
    onStroke(current.points);
    setCurrent(undefined);
  };
  const width = Math.max(3, Math.round(viewport.width / 240));
  return <svg
    className={`playable-drawing-layer${drawing ? " is-drawing" : ""}`}
    viewBox={`0 0 ${viewport.width} ${viewport.height}`}
    preserveAspectRatio="none"
    aria-label={drawing ? "Drawing" : undefined}
    aria-hidden={drawing ? undefined : true}
    onPointerDown={(event) => {
      if (!drawing || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setCurrent({ pointerId: event.pointerId, points: [point(event)] });
    }}
    onPointerMove={(event) => {
      if (current?.pointerId !== event.pointerId) return;
      const next = point(event);
      const last = current.points.at(-1)!;
      if (Math.abs(next.x - last.x) + Math.abs(next.y - last.y) < 2) return;
      setCurrent({ ...current, points: [...current.points, next] });
    }}
    onPointerUp={finish}
    onPointerCancel={finish}
  >
    {[...strokes, ...(current ? [current.points] : [])].map((stroke, index) => stroke.length === 1
      ? <circle key={index} cx={stroke[0]!.x} cy={stroke[0]!.y} r={width / 2} />
      : <polyline key={index} points={stroke.map(({ x, y }) => `${x},${y}`).join(" ")} strokeWidth={width} />)}
  </svg>;
}

/** The elements the next chat message is about. Images and video can be replaced. */
export function PickedElements({ picks, onRemove, onClear, onReplaceMedia, onGenerateMedia }: {
  picks: readonly PlayablePickResult[];
  onRemove: (key: string) => void;
  onClear: () => void;
  onReplaceMedia: (pick: PlayablePickResult, asset: PlayableAssetRequest) => void;
  onGenerateMedia?: (pick: PlayablePickResult) => void;
}) {
  return <div className="playable-workbench-picks" aria-label="Picked for the chat">
    <header>
      <strong>{picks.length === 1 ? "1 thing picked" : `${picks.length} things picked`}</strong>
      <span>Say what to change in the chat.</span>
      {picks.length > 1 ? <button type="button" onClick={onClear}>Clear</button> : null}
    </header>
    {picks.map((pick) => {
      const key = playablePickKey(pick);
      return <PickedElement key={key} pick={pick} onClear={() => onRemove(key)}>
        {MEDIA_TAGS.has(pick.tag) ? <MediaReplaceActions pick={pick} onReplace={(asset) => onReplaceMedia(pick, asset)} onGenerate={onGenerateMedia ? () => onGenerateMedia(pick) : undefined} /> : null}
      </PickedElement>;
    })}
  </div>;
}

export function PickedElement({ pick, onClear, children }: { pick: PlayablePickResult; onClear: () => void; children?: ReactNode }) {
  const reference = `${pick.nodeId} ${pick.source ?? pick.cssPath}`;
  return <div className="playable-workbench-pick">
    <MousePointer2 size={12} />
    <span title={pick.cssPath}><code>&lt;{pick.tag}&gt;</code>{pick.text ? ` "${pick.text}"` : ""}</span>
    {children ?? <small title={reference}>{pick.source ?? pick.cssPath}</small>}
    <button type="button" title="Copy reference" aria-label="Copy element reference" onClick={() => void navigator.clipboard?.writeText(reference)}><Clipboard size={12} /></button>
    <button type="button" title="Remove" aria-label="Remove picked element" onClick={onClear}><X size={12} /></button>
  </div>;
}

function MediaReplaceActions({ pick, onReplace, onGenerate }: {
  pick: PlayablePickResult;
  onReplace: (asset: PlayableAssetRequest) => void;
  onGenerate?: () => void;
}) {
  const [library, setLibrary] = useState<LibraryAsset[]>();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const video = pick.tag === "video";

  const use = (asset: LibraryAsset) => {
    const type = playableAssetType(asset.mediaType);
    if (type !== "image" && type !== "video") return setError("Pick an image or a video.");
    setError(undefined);
    onReplace({ name: asset.name, type, source: { kind: "library", assetId: asset.id } });
  };

  return <div className="playable-workbench-pick-actions">
    <button type="button" title="Replace with something from the Library" onClick={() => {
      void loadLibraryAssets().then(setLibrary).catch((cause) => setError(errorMessage(cause)));
    }}><Folder size={11} /><span>Library</span></button>
    <button type="button" title="Replace with a file" disabled={uploading} onClick={() => fileInput.current?.click()}>
      {uploading ? <LoaderCircle className="spin" size={11} /> : <Upload size={11} />}<span>Upload</span>
    </button>
    {onGenerate ? <button type="button" title={`Describe a new ${video ? "video" : "image"} for the AI to make`} onClick={onGenerate}><Sparkles size={11} /><span>Generate</span></button> : null}
    {error ? <small className="is-error" title={error}>{error}</small> : null}
    <input ref={fileInput} type="file" accept={ASSET_UPLOAD_ACCEPT} hidden onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      setUploading(true);
      setError(undefined);
      void uploadLibraryFile(file).then(use, (cause) => setError(`Could not upload: ${errorMessage(cause)}`)).finally(() => setUploading(false));
    }} />
    {library ? <LibraryAssetPicker
      title={`Replace <${pick.tag}>`}
      assets={library.filter((asset) => {
        const type = playableAssetType(asset.mediaType);
        return type === "image" || type === "video";
      })}
      onClose={() => setLibrary(undefined)}
      onSelect={(asset) => { setLibrary(undefined); use(asset); }}
    /> : null}
  </div>;
}

/** The chat request behind "Generate": the user describes what to make. */
export function askToGenerateMedia(pick: PlayablePickResult): string {
  return `Make a new ${pick.tag === "video" ? "video" : "image"} for the picked <${pick.tag}> and use it there instead: `;
}

type ActivityItem =
  | { kind: "report"; at: string; text: string; targetNodeId?: string }
  | { kind: "unconnected"; at: string; surfaceId: string; signal: string; label: string; sourceTitle: string }
  | { kind: "error"; at: string; text: string }
  | { kind: "note"; at: string; text: string; status: PreviewNote["status"] };

/**
 * Below the preview: the Scene's problems and Exits that go nowhere (with a
 * way to connect them), then what the preview did instead of navigating,
 * the changes made from the preview, and the Variables the Scene used.
 */
export function PreviewActivity({ graph, node, issues = [], snapshot, diagnostics, notes = [], agentBusy = false, buildError, onOpenNode, onSignalTarget, onAskAgent }: {
  graph: NodeGraph;
  node?: PlayableNode;
  issues?: readonly PlayableProjectValidationIssue[];
  snapshot?: NodeRuntimeSnapshot;
  diagnostics: readonly { message: string; at: string }[];
  notes?: readonly PreviewNote[];
  agentBusy?: boolean;
  buildError?: string;
  onOpenNode: (nodeId: string) => void;
  onSignalTarget?: PlayableSignalEdits["onSignalTarget"];
  onAskAgent?: (text: string) => void;
}) {
  const titleOf = (nodeId?: string) => graph.nodes.find((candidate) => candidate.id === nodeId)?.title ?? nodeId;
  const connected = (surfaceId: string, signal: string) => graph.edges.some((edge) =>
    edge.source.nodeId === surfaceId && edge.source.signal === signal);
  // The Scene's own Exits that go nowhere come first, used or not.
  const openExits: ActivityItem[] = (node?.signals ?? [])
    .filter((signal) => !connected(node!.id, signal.id))
    .map((signal) => ({ kind: "unconnected", at: "", surfaceId: node!.id, signal: signal.id, label: signal.label || signal.id, sourceTitle: node!.title }));
  const items: ActivityItem[] = [
    ...(snapshot?.reports ?? []).map((report): ActivityItem => {
      if (report.kind === "signal") {
        const label = playableNodeById(graph, report.nodeId)?.signals.find((signal) => signal.id === report.signal)?.label ?? report.signal;
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
    ...notes.map((item): ActivityItem => ({ kind: "note", ...item })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT);
  // Diagnostics can repeat a runtime error, and a player can press one
  // unconnected Exit many times; show each once. An Exit connected since it
  // was used no longer needs a warning.
  const seen = new Set<string>();
  const unique = [...openExits, ...items].filter((item) => {
    if (item.kind === "unconnected" && connected(item.surfaceId, item.signal)) return false;
    const key = item.kind === "unconnected" ? `unconnected:${item.surfaceId}:${item.signal}` : `${item.kind}:${item.at}:${item.text}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });

  return <div className="playable-workbench-activity" aria-label="What happened in the preview" aria-live="polite">
    {buildError ? <p className="is-error" role="alert"><InfoCircle size={12} /><span>{buildError}</span></p> : null}
    {issues.map((issue, index) => <p key={`issue:${index}:${issue.message}`} className="is-error" role="alert"><InfoCircle size={12} /><span title={issue.message}>{issue.message}</span></p>)}
    {unique.map((item, index) => {
      if (item.kind === "unconnected") {
        return <p key={`unconnected:${item.surfaceId}:${item.signal}`} className="is-warning">
          <InfoCircle size={12} />
          <span title={`"${item.label}" in ${item.sourceTitle}`}>"{item.label}" doesn't go anywhere yet</span>
          {onSignalTarget ? <select aria-label={`Connect "${item.label}" to a Scene`} value="" onChange={(event) => { if (event.target.value) onSignalTarget(item.surfaceId, item.signal, event.target.value); }}>
            <option value="">Connect…</option>
            {graph.nodes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
          </select> : null}
          {onAskAgent ? <button type="button" title="Ask the AI to create the Scene this exit should open" onClick={() => onAskAgent(askToCreateTarget(item.label, item.sourceTitle))}><Sparkles size={11} /><span>Ask AI to create it</span></button> : null}
        </p>;
      }
      if (item.kind === "note") {
        const working = item.status === "asked" && agentBusy;
        return <p key={`${item.at}:${index}`} className={`is-note${item.status === "failed" ? " is-error" : ""}`}>
          {working ? <LoaderCircle className="spin" size={12} /> : item.status === "failed" ? <InfoCircle size={12} /> : item.status === "asked" ? <Sparkles size={12} /> : <Check size={12} />}
          <span title={item.text}>{item.text}{working ? " — the AI is on it" : ""}</span>
        </p>;
      }
      return <p key={`${item.at}:${index}`} className={item.kind === "error" ? "is-error" : undefined}>
        {item.kind === "error" ? <InfoCircle size={12} /> : <ArrowRight size={12} />}
        <span title={item.text}>{item.text}</span>
        {item.kind === "report" && item.targetNodeId ? <button type="button" onClick={() => onOpenNode(item.targetNodeId!)}>Open</button> : null}
      </p>;
    })}
    {node ? <VariablesUsed nodeId={node.id} snapshot={snapshot} /> : null}
    {!buildError && !issues.length && !unique.length ? <p className="is-empty"><span>Try the preview. Exits you use show up here instead of changing the Scene.</span></p> : null}
  </div>;
}

/** The Variables this Scene read or changed in the preview, with their values now. */
function VariablesUsed({ nodeId, snapshot }: { nodeId: string; snapshot?: NodeRuntimeSnapshot }) {
  const access = snapshot?.stateAccess[nodeId];
  const readsAll = Boolean(access?.read.includes("*"));
  const explicit = [...new Set([...(access?.read ?? []), ...(access?.wrote ?? [])])].filter((key) => key !== "*");
  const keys = explicit.length || !readsAll ? explicit : Object.keys(snapshot?.state ?? {});
  if (!keys.length) return null;
  return <p className="playable-workbench-variables" aria-label="Variables used">
    <Box size={12} />
    <span>
      {readsAll ? "Reads every Variable: " : "Variables: "}
      {keys.map((key, index) => <span key={key} className={access?.wrote.includes(key) ? "is-write" : undefined} title={access?.wrote.includes(key) ? "Changed by this Scene" : "Read by this Scene"}>
        {index ? ", " : ""}<code>{key}</code> {JSON.stringify(snapshot?.state[key] ?? null)}
      </span>)}
    </span>
  </p>;
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

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type !== "checkbox" && target.type !== "radio"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
