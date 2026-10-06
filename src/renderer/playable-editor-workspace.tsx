import {
  Clapperboard,
  Code2,
  FileText,
  House,
  LoaderCircle,
  PanelToggle,
  Play,
  Share2,
} from "./icons.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
} from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { snapCanvasPosition } from "./canvas-alignment.js";
import { EditorCanvas, isTextEntry, undoShortcut, type CanvasContextMenuState } from "./editor-canvas.js";
import type { ProjectState, PromptContext } from "../shared/contracts.js";
import type { NodeCodebase, NodeCodebaseUpdate, NodeEditorLayout } from "../shared/playable-codebase.js";
import {
  type NodeGraph,
  type PlayableNavigationMode,
  type PlayableNode,
} from "../shared/playable-nodes.js";
import type { NodePlayerDefinition, PlayableTextEdit } from "../shared/playable-player-protocol.js";
import { parsePlayableSourceLocation, replacePlayableElementText } from "../shared/playable-text-edit.js";
import { clearPlayableBackdrop, playableBackdrop, setPlayableBackdrop } from "../shared/playable-backdrop.js";
import {
  addPlayableNodeAsset,
  playableEdgeId,
  setPlayableSignalLabel,
  setPlayableSignalRole,
  playableThumbnailHash,
  type PlayablePresetSummary,
  type PlayableProjectValidationIssue,
  type PlayableThumbnailManifest,
} from "../shared/playable-editor.js";
import { viewportRatio } from "../shared/canvas-formats.js";
import {
  addPlayableNode,
  buildInteractiveStory,
  getNodeCodebase,
  getPlayableValidation,
  getWorkspaceFile,
  listPlayablePresets,
  listPlayableThumbnails,
  updateNodeCodebase,
} from "./api.js";
import { CanvasSettingsDialog } from "./canvas-settings-dialog.js";
import { PublishDialog, type PublishDetails } from "./publish-dialog.js";
import { WorkspaceCodeView } from "./coding-workspace.js";
import { playtestHash } from "./routes.js";
import { PlayableNodeWorkbench, type PlayableAssetRequest, type PlaytestStart } from "./playable-node-workbench.js";
import { PlayableVariablesPanel } from "./playable-project-panels.js";
import { requestPlaytestStart } from "./playable-playtest.js";
import { setTechnicalDetails, useTechnicalDetails } from "./playable-details.js";
import type { PlayableChatState } from "./playable-chat.js";
import { buildCodebase, createFlowNode, nodeIdForIssuePath, nodeSourcePaths, toFlowEdge, toFlowNode, toPlayableEdge, uniqueNodeId, type GraphMeta, type PlayableFlowData, type PlayableFlowNode } from "./playable-flow.js";
import { PLAYABLE_NODE_TYPES, PlayableCanvasContext } from "./playable-node-card.js";
import { PlayableAddControl, PlayableCanvasContextMenu, PlayableEdgeInspector, PlayableProjectMenu } from "./playable-canvas-menus.js";
import { WorkspaceTabs, type WorkspaceTabOption } from "./workspace-tabs.js";

const DEFAULT_CANVAS_VIEWPORT = { x: 64, y: 32, zoom: 1 };
const GameDesignWorkspace = lazy(() => import("./game-design-workspace.js").then((module) => ({ default: module.GameDesignWorkspace })));

const HISTORY_LIMIT = 50;

/** A step to undo or redo: the codebase, and the source files as they were, when the step wrote any. */
interface HistoryEntry {
  codebase: NodeCodebase;
  sources?: Record<string, string>;
}

interface CopiedPlayableNode {
  node: PlayableNode;
  /** Workspace-relative path to file contents, so a copy is a real copy. */
  sources: Record<string, string>;
}

/**
 * The editor for a Playable Nodes project: one canvas of Nodes, one edge per
 * Signal.
 * It speaks the editor's words (Scene, Exit, Variables); code and
 * graph.json keep the engine's (Node, Signal, State).
 */
export function PlayableEditorWorkspace({ project, agentBusy, publishing, workspaceRevision = 0, openFileRequest, onPublish, publishDialog, onOpenPublish, onClosePublish, chatOnRight = false, chatCollapsed = false, onHome, onToggleChat, onChatContextChange, onAskAgent, onSendToAgent, designOpen = false, onDesignOpenChange, onDesignSaveReady }: {
  project: ProjectState;
  agentBusy: boolean;
  publishing: boolean;
  workspaceRevision?: number;
  openFileRequest?: { path: string; id: number };
  onPublish: (details: PublishDetails) => Promise<boolean>;
  publishDialog?: "open" | "success";
  onOpenPublish: () => void;
  onClosePublish: () => void;
  chatOnRight?: boolean;
  chatCollapsed?: boolean;
  onHome?: () => void;
  onToggleChat?: () => void;
  designOpen?: boolean;
  onDesignOpenChange?: (open: boolean) => void;
  /** Receives what the open Workbench adds to the next chat message. */
  onChatContextChange?: (state: PlayableChatState | undefined) => void;
  /** Puts a request in the chat prompt. */
  onAskAgent?: (text: string) => void;
  onDesignSaveReady?: (save: (() => Promise<void>) | undefined) => void;
  /** Sends a request to the AI now, with the open Node as context. */
  onSendToAgent?: (text: string, contexts: PromptContext[]) => Promise<boolean>;
}) {
  const projectId = project.id;
  const technical = useTechnicalDetails();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string>();
  const [graphMeta, setGraphMeta] = useState<GraphMeta>();
  const [nodes, setNodes] = useState<PlayableFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [editorLayout, setEditorLayout] = useState<NodeEditorLayout>({
    version: 1,
    nodes: {},
    viewport: DEFAULT_CANVAS_VIEWPORT,
    view: "canvas",
  });
  const [workspaceView, setWorkspaceView] = useState<"canvas" | "code">("canvas");
  const [codeRevision, setCodeRevision] = useState(0);
  const [fileRequest, setFileRequest] = useState(openFileRequest);
  const [designHeaderActions, setDesignHeaderActions] = useState<HTMLDivElement | null>(null);
  const designLeave = useRef<((action: () => void) => void) | undefined>(undefined);
  const registerDesignLeave = useCallback((leave: ((action: () => void) => void) | undefined) => { designLeave.current = leave; }, []);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [openedNodeId, setOpenedNodeId] = useState<string>();
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState>();
  const [copiedNode, setCopiedNode] = useState<CopiedPlayableNode>();
  const [presets, setPresets] = useState<PlayablePresetSummary[]>([]);
  const [issues, setIssues] = useState<PlayableProjectValidationIssue[]>([]);
  const [builtDefinition, setBuiltDefinition] = useState<NodePlayerDefinition>();
  const [thumbnails, setThumbnails] = useState<PlayableThumbnailManifest>();
  const [thumbnailRevision, setThumbnailRevision] = useState(0);
  const [canvasSettingsOpen, setCanvasSettingsOpen] = useState(false);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const [playtesting, setPlaytesting] = useState(false);
  const [writing, setWriting] = useState(false);
  const latestCodebase = useRef<NodeCodebase | undefined>(undefined);
  const queuedCodebase = useRef<string | undefined>(undefined);
  const saveChain = useRef(Promise.resolve());
  const undoHistory = useRef<HistoryEntry[]>([]);
  const redoHistory = useRef<HistoryEntry[]>([]);
  /** What the editor last wrote to each source file it changed, for undo to swap back. */
  const writtenSources = useRef<Record<string, string>>({});
  const historyObserved = useRef<NodeCodebase | undefined>(undefined);
  const historyObservedJson = useRef<string | undefined>(undefined);
  const historyPendingBase = useRef<NodeCodebase | undefined>(undefined);
  const historyTimer = useRef<number | undefined>(undefined);
  const historyGestureBase = useRef<NodeCodebase | undefined>(undefined);
  const [, setHistoryRevision] = useState(0);
  /** The build of each Node the canvas last tried to capture, so a failure is not retried. */
  const thumbnailAttempts = useRef(new Map<string, string>());

  const codebase = useMemo(
    () => graphMeta ? buildCodebase(graphMeta, nodes, edges, editorLayout, workspaceView) : undefined,
    [graphMeta, nodes, edges, editorLayout, workspaceView],
  );
  latestCodebase.current = codebase;
  const playerViewport = graphMeta?.viewport ?? { width: 1280, height: 720 };
  const playerViewportAspect = playerViewport.width / playerViewport.height;
  const canvasStageWidth = 440 * Math.min(1, playerViewportAspect);
  const canvasStageHeight = 440 / Math.max(1, playerViewportAspect);
  const canUndo = Boolean(historyPendingBase.current || undoHistory.current.length);
  const canRedo = !historyPendingBase.current && redoHistory.current.length > 0;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const openedNode = !designOpen && workspaceView === "canvas" && phase === "ready"
    ? nodes.find((node) => node.id === openedNodeId)?.data.node
    : undefined;

  // A Playtest window asks the editor to open the Node it is showing.
  useEffect(() => window.ohMyGameDesktop?.onOpenPlayableNode?.((targetProjectId, nodeId) => {
    if (targetProjectId !== projectId) return;
    setWorkspaceView("canvas");
    openNode(nodeId);
  }), [projectId]);

  // Whether the open Scene has a background the editor can set, and whether it shows anything yet.
  const [backdrop, setBackdrop] = useState<"missing" | "set">();
  const openedHtml = openedNode?.source.html;
  useEffect(() => {
    setBackdrop(undefined);
    if (!openedHtml) return;
    let disposed = false;
    void getWorkspaceFile(projectId, openedHtml).then((file) => {
      if (!disposed) setBackdrop(file.content !== undefined && !file.truncated ? playableBackdrop(file.content) : undefined);
    }, () => undefined);
    return () => { disposed = true; };
  }, [projectId, openedHtml, workspaceRevision, codeRevision]);

  // An undo or an Agent edit can remove the open Node; go back to the canvas.
  useEffect(() => {
    if (phase === "ready" && openedNodeId && !nodes.some((node) => node.id === openedNodeId)) setOpenedNodeId(undefined);
  }, [phase, nodes, openedNodeId]);

  useEffect(() => {
    if (openFileRequest) setFileRequest(openFileRequest);
  }, [openFileRequest?.id]);

  useEffect(() => {
    if (!openFileRequest) return;
    setOpenedNodeId(undefined);
    setWorkspaceView("code");
  }, [openFileRequest?.id]);

  useEffect(() => {
    let disposed = false;
    setPhase("loading");
    window.clearTimeout(historyTimer.current);
    undoHistory.current = [];
    redoHistory.current = [];
    writtenSources.current = {};
    historyObserved.current = undefined;
    historyObservedJson.current = undefined;
    historyPendingBase.current = undefined;
    historyGestureBase.current = undefined;
    setCanvasContextMenu(undefined);
    setCopiedNode(undefined);
    void Promise.all([
      getNodeCodebase(projectId),
      listPlayablePresets().catch(() => ({ presets: [] as PlayablePresetSummary[] })),
    ]).then(([loaded, catalog]) => {
      if (disposed) return;
      applyCodebase(loaded, { fromDisk: true });
      setPresets(catalog.presets);
      setPhase("ready");
    }).catch((error) => {
      if (disposed) return;
      setNotice(errorMessage(error));
      setPhase("error");
    });
    return () => { disposed = true; };
  }, [projectId, workspaceRevision]);

  useEffect(() => {
    if (phase !== "ready") return;
    let disposed = false;
    void getPlayableValidation(projectId).then((result) => {
      if (disposed) return;
      setIssues(result.issues);
      setBuiltDefinition(result.definition);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [phase, projectId, codeRevision, workspaceRevision]);

  useEffect(() => {
    setThumbnails(undefined);
    thumbnailAttempts.current.clear();
  }, [projectId]);

  useEffect(() => {
    let disposed = false;
    void listPlayableThumbnails(projectId).then((manifest) => {
      if (!disposed) setThumbnails(manifest);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [projectId, workspaceRevision, thumbnailRevision]);

  // Nodes with no thumbnail, or one of an older build, are captured in the
  // background, one hidden window at a time.
  useEffect(() => {
    const capture = window.ohMyGameDesktop?.captureNodeThumbnail;
    if (!capture || !builtDefinition || !thumbnails) return;
    const pending = builtDefinition.graph.nodes.flatMap((node) => {
      const hash = playableThumbnailHash(builtDefinition, node.id);
      return hash && thumbnails[node.id]?.hash !== hash
        && thumbnailAttempts.current.get(node.id) !== hash ? [{ nodeId: node.id, hash }] : [];
    });
    if (!pending.length) return;
    let disposed = false;
    void (async () => {
      for (const { nodeId, hash } of pending) {
        if (disposed) return;
        thumbnailAttempts.current.set(nodeId, hash);
        const captured = await capture(projectId, nodeId, builtDefinition.graph.viewport).catch(() => false);
        if (captured) setThumbnailRevision((current) => current + 1);
      }
    })();
    return () => { disposed = true; };
  }, [projectId, builtDefinition, thumbnails]);

  /**
   * Adopts a whole codebase into the editor. `fromDisk` makes the serialized
   * form the save baseline, so opening a project does not write it straight
   * back; an undo has to save, so it passes nothing.
   */
  function applyCodebase(loaded: NodeCodebase, options: { fromDisk?: boolean } = {}): void {
    const { nodes: graphNodes, edges: graphEdges, ...meta } = loaded.graph;
    const view = loaded.editorLayout.view === "code" ? "code" : "canvas";
    const flowNodes = graphNodes.map((node) => toFlowNode(node, loaded.editorLayout));
    const flowEdges = graphEdges.map(toFlowEdge);
    setGraphMeta(meta);
    setNodes(flowNodes);
    setEdges(flowEdges);
    setEditorLayout(loaded.editorLayout);
    setWorkspaceView(view);
    const applied = buildCodebase(meta, flowNodes, flowEdges, loaded.editorLayout, view);
    if (options.fromDisk) queuedCodebase.current = JSON.stringify(applied);
    observeHistory(applied);
    setSelectedEdgeId(undefined);
  }

  function updateHistoryControls(): void {
    setHistoryRevision((revision) => revision + 1);
  }

  function observeHistory(next: NodeCodebase): void {
    historyObserved.current = structuredClone(next);
    historyObservedJson.current = JSON.stringify(next);
  }

  function pushUndoSnapshot(snapshot: NodeCodebase, sources?: Record<string, string>): HistoryEntry {
    const entry: HistoryEntry = { codebase: structuredClone(snapshot), ...(sources ? { sources } : {}) };
    undoHistory.current.push(entry);
    if (undoHistory.current.length > HISTORY_LIMIT) undoHistory.current.shift();
    return entry;
  }

  function commitPendingHistory(): void {
    window.clearTimeout(historyTimer.current);
    historyTimer.current = undefined;
    const pending = historyPendingBase.current;
    if (!pending) return;
    pushUndoSnapshot(pending);
    historyPendingBase.current = undefined;
    updateHistoryControls();
  }

  /**
   * Puts the editor back to a history entry, and the source files it names
   * back to what they held then. The entry for the other stack keeps what
   * the files hold now, so the step can be taken again.
   */
  function restoreHistory(entry: HistoryEntry, current: NodeCodebase): { entry: HistoryEntry; saved: Promise<void> } {
    const sources = entry.sources;
    const reverse: HistoryEntry = { codebase: structuredClone(current) };
    if (sources) {
      reverse.sources = Object.fromEntries(Object.keys(sources).map((path) => [path, writtenSources.current[path] ?? ""]));
      writtenSources.current = { ...writtenSources.current, ...sources };
    }
    applyCodebase(entry.codebase);
    const saved = sources ? save({ ...entry.codebase, sources }) : Promise.resolve();
    updateHistoryControls();
    return { entry: reverse, saved };
  }

  function undoEditorChange(): Promise<void> | undefined {
    if (!codebase) return undefined;
    window.clearTimeout(historyTimer.current);
    historyTimer.current = undefined;
    const pending = historyPendingBase.current;
    const next = pending ? { codebase: pending } : undoHistory.current.pop();
    if (!next) return undefined;
    historyPendingBase.current = undefined;
    const restored = restoreHistory(next, codebase);
    redoHistory.current.push(restored.entry);
    return restored.saved;
  }

  function redoEditorChange(): Promise<void> | undefined {
    if (!codebase || historyPendingBase.current) return undefined;
    const next = redoHistory.current.pop();
    if (!next) return undefined;
    const restored = restoreHistory(next, codebase);
    undoHistory.current.push(restored.entry);
    return restored.saved;
  }

  function beginHistoryGesture(): void {
    if (!codebase) return;
    commitPendingHistory();
    historyGestureBase.current = structuredClone(codebase);
  }

  function finishHistoryGesture(): void {
    window.setTimeout(() => {
      const base = historyGestureBase.current;
      const current = latestCodebase.current;
      historyGestureBase.current = undefined;
      if (!base || !current || JSON.stringify(base) === JSON.stringify(current)) return;
      pushUndoSnapshot(base);
      redoHistory.current = [];
      observeHistory(current);
      updateHistoryControls();
    }, 0);
  }

  useEffect(() => {
    if (phase !== "ready" || !codebase) return;
    const serialized = JSON.stringify(codebase);
    if (!historyObserved.current || historyObservedJson.current === undefined) {
      observeHistory(codebase);
      updateHistoryControls();
      return;
    }
    if (serialized === historyObservedJson.current) return;
    if (historyGestureBase.current) {
      observeHistory(codebase);
      return;
    }
    if (!historyPendingBase.current) historyPendingBase.current = structuredClone(historyObserved.current);
    redoHistory.current = [];
    observeHistory(codebase);
    window.clearTimeout(historyTimer.current);
    historyTimer.current = window.setTimeout(commitPendingHistory, 450);
    updateHistoryControls();
  }, [codebase, phase]);

  useEffect(() => () => window.clearTimeout(historyTimer.current), []);

  useEffect(() => {
    if (workspaceView === "code") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const step = undoShortcut(event);
      if (!step || isTextEntry(event.target)) return;
      event.preventDefault();
      void (step === "redo" ? redoEditorChange() : undoEditorChange())?.catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [codebase, workspaceView]);

  const save = useCallback((next: NodeCodebaseUpdate): Promise<void> => {
    const serialized = JSON.stringify(next);
    if (serialized === queuedCodebase.current) return saveChain.current;
    queuedCodebase.current = serialized;
    const operation = saveChain.current
      .catch(() => undefined)
      .then(() => updateNodeCodebase(projectId, next));
    saveChain.current = operation;
    void operation.then(
      () => { setNotice(undefined); setCodeRevision((revision) => revision + 1); },
      (error) => {
        if (queuedCodebase.current === serialized) queuedCodebase.current = undefined;
        setNotice(`Could not save your changes: ${errorMessage(error)}`);
      },
    );
    return operation;
  }, [projectId]);

  useEffect(() => {
    if (phase !== "ready" || !codebase) return;
    const timeout = window.setTimeout(() => { void save(codebase).catch(() => {}); }, 350);
    return () => window.clearTimeout(timeout);
  }, [codebase, phase, save]);

  useEffect(() => () => {
    const pending = latestCodebase.current;
    if (pending) void save(pending).catch(() => {});
  }, [save]);

  const onNodesChange = useCallback((changes: NodeChange<PlayableFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  /** One Signal leads to one Node, so a new edge replaces the Signal's old one. */
  function onConnect(connection: Connection): void {
    const { source, target, sourceHandle } = connection;
    if (!source || !target || !sourceHandle) return;
    setEdges((current) => {
      const kept = current.filter((edge) => edge.source !== source || edge.sourceHandle !== sourceHandle);
      return [...kept, toFlowEdge({
        id: playableEdgeId(kept, source, sourceHandle),
        source: { nodeId: source, signal: sourceHandle },
        targetNodeId: target,
        mode: "replace",
      })];
    });
  }

  function setEdgeMode(edgeId: string, mode: PlayableNavigationMode): void {
    setEdges((current) => current.map((edge) => edge.id === edgeId
      ? { ...toFlowEdge({ ...toPlayableEdge(edge)!, mode }), selected: edge.selected }
      : edge));
  }

  /** Selects a connection, as clicking its line does. */
  function selectEdge(edgeId: string): void {
    setCanvasContextMenu(undefined);
    setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
    setSelectedEdgeId(edgeId);
  }

  function renameNode(nodeId: string, title: string): void {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, node: { ...node.data.node, title } } }
      : node));
  }

  /**
   * Adopts a graph edited as a whole (by the Workbench inspector) while
   * keeping canvas positions and selection.
   */
  function applyGraph(next: NodeGraph): void {
    const { nodes: graphNodes, edges: graphEdges, ...meta } = next;
    setGraphMeta(meta);
    setNodes((current) => current.map((node) => {
      const updated = graphNodes.find((candidate) => candidate.id === node.id);
      return updated ? { ...node, data: { ...node.data, node: updated } } : node;
    }));
    setEdges((current) => graphEdges.map((edge) => {
      const flow = toFlowEdge(edge);
      return current.find((candidate) => candidate.id === edge.id)?.selected ? { ...flow, selected: true } : flow;
    }));
  }

  /** Adopts a graph and saves it now, instead of on the next autosave. */
  async function writeGraph(graph: NodeGraph): Promise<void> {
    if (!codebase) return;
    applyGraph(graph);
    await save({ graph, editorLayout: codebase.editorLayout });
  }

  /**
   * Adopts a graph and writes source files with it as one undoable step.
   * `before` holds what the files held, for undo to put back.
   */
  async function writeSources(graph: NodeGraph, sources: Record<string, string>, before: Record<string, string>): Promise<HistoryEntry | undefined> {
    if (!codebase) return undefined;
    commitPendingHistory();
    // The base stops the graph change from being recorded as a separate step.
    const base = structuredClone(codebase);
    historyGestureBase.current = base;
    try {
      applyGraph(graph);
      await save({ graph, editorLayout: codebase.editorLayout, sources });
    } finally {
      if (historyGestureBase.current === base) historyGestureBase.current = undefined;
    }
    writtenSources.current = { ...writtenSources.current, ...sources };
    const entry = pushUndoSnapshot(base, before);
    redoHistory.current = [];
    if (latestCodebase.current) observeHistory(latestCodebase.current);
    updateHistoryControls();
    return entry;
  }

  /**
   * Writes a text edit from the preview back to the surface HTML that holds
   * it, and renames the Exit it labels. False when it cannot be done in place.
   */
  async function writeText(edit: PlayableTextEdit): Promise<boolean> {
    const graph = codebase?.graph;
    const location = edit.pick.source ? parsePlayableSourceLocation(edit.pick.source) : undefined;
    const node = graph?.nodes.find((candidate) => candidate.id === edit.pick.nodeId);
    if (!graph || !location || !node || node.source.html !== location.file) return false;
    const file = await getWorkspaceFile(projectId, location.file);
    const before = file.truncated ? undefined : file.content;
    const html = before === undefined ? undefined : replacePlayableElementText(before, location, edit.before, edit.after);
    if (before === undefined || html === undefined) return false;
    const signal = node.signals.find((candidate) => candidate.id === edit.pick.signal);
    const next = signal && signal.label.trim() === edit.before.trim()
      ? setPlayableSignalLabel(graph, node.id, signal.id, edit.after.trim())
      : graph;
    await writeSources(next, { [location.file]: html }, { [location.file]: before });
    return true;
  }

  /**
   * Declares a video or image and shows it as the Node's background. The
   * Asset it replaces stays declared, since other code may still use it.
   * Resolves with a way to put the background back, or undefined when the
   * Node's HTML has no single background to set.
   */
  async function writeBackdrop(nodeId: string, asset: PlayableAssetRequest): Promise<boolean> {
    const graph = codebase?.graph;
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!graph || !node || (asset.type !== "image" && asset.type !== "video")) return false;
    const path = node.source.html;
    const file = await getWorkspaceFile(projectId, path);
    if (file.content === undefined || file.truncated) return false;
    const before = file.content;
    const declared = addPlayableNodeAsset(graph, nodeId, asset);
    const html = setPlayableBackdrop(before, declared.assetId, asset.type);
    if (html === undefined) return false;
    await writeSources(declared.graph, { [path]: html }, { [path]: before });
    return true;
  }

  /**
   * Takes the Asset off the Node's background. The Asset stays declared,
   * since other code may still use it. Resolves false when the Node's HTML
   * has no single background to clear.
   */
  async function removeBackdrop(nodeId: string): Promise<boolean> {
    const graph = codebase?.graph;
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!graph || !node) return false;
    const path = node.source.html;
    const file = await getWorkspaceFile(projectId, path);
    if (file.content === undefined || file.truncated) return false;
    const before = file.content;
    const html = clearPlayableBackdrop(before);
    if (html === undefined) return false;
    if (html !== before) await writeSources(graph, { [path]: html }, { [path]: before });
    return true;
  }

  function openNode(nodeId: string): void {
    setCanvasContextMenu(undefined);
    setSelectedEdgeId(undefined);
    setOpenedNodeId(nodeId);
  }

  function setEntryNode(nodeId: string): void {
    setGraphMeta((current) => current ? { ...current, entryNodeId: nodeId } : current);
  }

  /**
   * Drops the Node and its edges from the graph. The Node's files stay on disk
   * so an undo brings the Node back complete. When the Start is removed,
   * buildCodebase makes the first remaining Node the Start; removing the last
   * Node leaves an empty project.
   */
  function removeNodes(removed: ReadonlySet<string>): void {
    if (!removed.size) return;
    setNodes((current) => current.filter((node) => !removed.has(node.id)));
    setEdges((current) => current.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)));
    setSelectedEdgeId(undefined);
  }

  function clearSelection(): void {
    setSelectedEdgeId(undefined);
    setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
  }

  /**
   * Creates a Node through the same endpoint the Agent uses, so a Node added
   * here and a Node added in chat are identical, then reloads the written files.
   */
  async function addNodeFromPreset(presetId: string, position: { x: number; y: number }): Promise<void> {
    if (!codebase || writing) return;
    setWriting(true);
    try {
      commitPendingHistory();
      await save(codebase);
      pushUndoSnapshot(codebase);
      redoHistory.current = [];
      await addPlayableNode(projectId, {
        preset: presetId,
        id: uniqueNodeId(presetId, new Set(nodes.map((node) => node.id))),
        position: snapCanvasPosition(position),
      });
      applyCodebase(await getNodeCodebase(projectId), { fromDisk: true });
      setCodeRevision((revision) => revision + 1);
      updateHistoryControls();
    } catch (cause) {
      undoHistory.current.pop();
      setNotice(errorMessage(cause));
    } finally {
      setWriting(false);
    }
  }

  async function copyNode(nodeId: string): Promise<void> {
    const node = nodes.find((candidate) => candidate.id === nodeId)?.data.node;
    if (!node) return;
    try {
      setCopiedNode({ node: structuredClone(node), sources: await readNodeSources(projectId, node) });
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }

  /** A copy is a real copy: the source files are written under the new Node ID. */
  async function insertNodeCopy(copy: CopiedPlayableNode, position: { x: number; y: number }): Promise<void> {
    if (!graphMeta || !codebase || writing) return;
    setWriting(true);
    try {
      commitPendingHistory();
      pushUndoSnapshot(codebase);
      redoHistory.current = [];
      const id = uniqueNodeId(copy.node.id, new Set(nodes.map((node) => node.id)));
      const source = nodeSourcePaths(id);
      const nextNodes = [
        ...nodes.map((node) => node.selected ? { ...node, selected: false } : node),
        createFlowNode({ ...structuredClone(copy.node), id, source }, snapCanvasPosition(position)),
      ];
      const next = buildCodebase(graphMeta, nextNodes, edges, editorLayout, workspaceView);
      queuedCodebase.current = JSON.stringify(next);
      await updateNodeCodebase(projectId, {
        ...next,
        sources: {
          [source.html]: copy.sources[copy.node.source.html] ?? "",
          [source.css]: copy.sources[copy.node.source.css] ?? "",
          [source.javascript]: copy.sources[copy.node.source.javascript] ?? "",
        },
      });
      setNodes(nextNodes);
      observeHistory(next);
      setCodeRevision((revision) => revision + 1);
      updateHistoryControls();
    } catch (cause) {
      undoHistory.current.pop();
      queuedCodebase.current = undefined;
      setNotice(errorMessage(cause));
    } finally {
      setWriting(false);
    }
  }

  async function duplicateNode(nodeId: string): Promise<void> {
    const flowNode = nodes.find((candidate) => candidate.id === nodeId);
    if (!flowNode) return;
    const node = flowNode.data.node;
    try {
      const sources = await readNodeSources(projectId, node);
      await insertNodeCopy({ node, sources }, { x: flowNode.position.x + 60, y: flowNode.position.y + 60 });
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }

  /** Opens the Playtest window; `start` plays from a Scene instead of the saved game. */
  async function startPlaytest(start?: PlaytestStart): Promise<void> {
    if (!codebase || building || playtesting) return;
    setPlaytesting(true);
    if (!start) clearSelection();
    try {
      await save(codebase);
      if (start) requestPlaytestStart(projectId, start);
      if (window.ohMyGameDesktop) {
        await window.ohMyGameDesktop.openPlaytest(projectId, codebase.graph.viewport);
      } else {
        window.open(new URL(playtestHash(projectId), window.location.href).href, "ohmygame-playtest");
      }
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setPlaytesting(false);
    }
  }

  async function exportGame(): Promise<void> {
    if (!codebase || building) return;
    setBuilding(true);
    try {
      await save(codebase);
      const artifact = await buildInteractiveStory(projectId);
      const url = URL.createObjectURL(artifact);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = `${project.name}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setBuilding(false);
    }
  }

  async function publishGame(details: PublishDetails): Promise<boolean> {
    if (!codebase) throw new Error("The game is still loading. Try publishing again when it is ready.");
    await save(codebase);
    return onPublish(details);
  }

  // A navigation Exit's line is hidden; its Exit row names the target.
  const renderedEdges = useMemo(() => {
    const navigation = new Set(nodes.flatMap((node) => node.data.node.signals
      .filter((signal) => signal.role === "navigation")
      .map((signal) => `${node.id}\u0000${signal.id}`)));
    return edges.map((edge) => navigation.has(`${edge.source}\u0000${edge.sourceHandle}`) ? { ...edge, hidden: true } : edge);
  }, [nodes, edges]);
  const renderedNodes = useMemo(() => {
    const titles = new Map(nodes.map((node) => [node.id, node.data.node.title]));
    const connected = new Map<string, PlayableFlowData["connected"]>();
    for (const edge of edges) {
      if (!edge.sourceHandle) continue;
      connected.set(edge.source, {
        ...connected.get(edge.source),
        [edge.sourceHandle]: { edgeId: edge.id, target: titles.get(edge.target) ?? edge.target, selected: edge.id === selectedEdgeId },
      });
    }
    const nodeIssues = new Map<string, string[]>();
    const failed = new Set<string>();
    for (const issue of issues) {
      const owner = issue.surfaceId ?? nodeIdForIssuePath(issue.path, nodes);
      if (!owner) continue;
      nodeIssues.set(owner, [...nodeIssues.get(owner) ?? [], issue.message]);
      if (issue.phase === "compiler") failed.add(owner);
    }
    return nodes.map((node): PlayableFlowNode => {
      const cached = thumbnails?.[node.id];
      // Without a successful build the current hash is unknown, so a cached
      // thumbnail is not called stale; a failing Node is dimmed instead.
      const hash = builtDefinition ? playableThumbnailHash(builtDefinition, node.id) : undefined;
      const coverAssetId = node.data.node.assets.find((id) => graphMeta?.assets[id]?.type === "image");
      return {
        ...node,
        data: {
          node: node.data.node,
          entry: codebase?.graph.entryNodeId === node.id,
          issues: nodeIssues.get(node.id) ?? [],
          connected: connected.get(node.id) ?? {},
          failed: failed.has(node.id),
          ...(cached ? { thumbnail: { capturedAt: cached.capturedAt, stale: Boolean(hash && hash !== cached.hash) } } : {}),
          ...(coverAssetId ? { coverAsset: graphMeta!.assets[coverAssetId] } : {}),
        },
      };
    });
  }, [nodes, edges, selectedEdgeId, issues, graphMeta, codebase, thumbnails, builtDefinition]);
  const canvasPlayer = useMemo(() => ({ projectId, technical, onRenameNode: renameNode, onSelectEdge: selectEdge }), [projectId, technical]);
  const projectIssues = issues.filter((issue) => !issue.surfaceId && !nodeIdForIssuePath(issue.path, nodes));
  const showCodeTab = technical || workspaceView === "code";
  const tabs: WorkspaceTabOption<"canvas" | "design" | "code">[] = [
    { id: "canvas", label: "Canvas", icon: Clapperboard },
    ...(onDesignOpenChange ? [{ id: "design" as const, label: "Design", icon: FileText }] : []),
    ...(showCodeTab ? [{ id: "code" as const, label: "Code", icon: Code2 }] : []),
  ];
  const renderNavigation = () => <div className={`viewer-navigation${chatOnRight ? " is-chat-right" : ""}`}>
    {chatOnRight && onHome ? (
      <button className="icon-button pane-header-action workspace-home-button" type="button" onClick={onHome} title="Home" aria-label="Home"><House size={14} /></button>
    ) : null}
    <WorkspaceTabs
      tabs={tabs} active={designOpen ? "design" : workspaceView} label="Workspace mode"
      onChange={(tab) => {
        const navigate = () => {
          if (tab !== "design") {
            if (tab === "code") clearSelection();
            setWorkspaceView(tab);
          }
          onDesignOpenChange?.(tab === "design");
        };
        if (designOpen && designLeave.current) designLeave.current(navigate);
        else navigate();
      }}
    />
  </div>;

  return (
    <section
      className={`viewer-pane interactive-story-workspace playable-editor-workspace${openedNode ? " is-node-editor-open" : ""}`}
      aria-label="Playable Nodes workspace"
      style={{
        "--story-viewport-ratio": `${playerViewport.width} / ${playerViewport.height}`,
        "--story-viewport-aspect": playerViewportAspect,
        "--story-canvas-stage-width": `${canvasStageWidth}px`,
        "--story-canvas-stage-height": `${canvasStageHeight}px`,
      } as CSSProperties}
    >
      <header className="pane-header viewer-header interactive-story-header window-drag-handle">
        <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
        {renderNavigation()}
        <div className="viewer-controls-slot">
          {!designOpen ? <PlayableProjectMenu
            disabled={phase !== "ready"}
            screenSize={viewportRatio(playerViewport)}
            exporting={building}
            canExport={!agentBusy && !publishing && !building}
            technical={technical}
            variablesOpen={variablesOpen}
            onScreenSize={() => setCanvasSettingsOpen(true)}
            onVariables={() => setVariablesOpen((open) => !open)}
            onExport={() => void exportGame()}
            onTechnicalChange={(on) => {
              setTechnicalDetails(on);
              if (!on && workspaceView === "code") setWorkspaceView("canvas");
            }}
          /> : null}
        </div>
        <div className={`viewer-publish${designOpen ? " design-header-actions" : ""}`} ref={setDesignHeaderActions}>
          {!designOpen ? <><button className="icon-button pane-header-action" type="button" data-tooltip={playtesting ? "Opening playtest..." : "Playtest in a new window"} aria-label="Playtest" disabled={phase !== "ready" || building || playtesting} onClick={() => void startPlaytest()}>
            {playtesting ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
          </button>
          <button className="publish-button workspace-publish-button" type="button" title="Publish" aria-label="Publish" disabled={agentBusy || publishing || building} onClick={onOpenPublish}>
            {publishing ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
            <span>Publish</span>
          </button>
          {chatOnRight && chatCollapsed && onToggleChat ? (
            <button className="icon-button pane-header-action" type="button" title="Show chat" aria-label="Show chat" onClick={onToggleChat}>
              <PanelToggle size={14} />
            </button>
          ) : null}
          </> : null}
        </div>
      </header>
      {designOpen ? <Suspense fallback={<div className="design-loading"><LoaderCircle className="spin" size={18} /></div>}><GameDesignWorkspace
        project={project} headerActionsTarget={designHeaderActions} onLeaveReady={registerDesignLeave} onSaveReady={onDesignSaveReady}
      /></Suspense> : workspaceView !== "code" ? <div className="interactive-story-body">
        <div className="interactive-story-canvas">
          {phase === "loading" ? <div className="story-canvas-state">Loading Scenes...</div> : null}
          {phase === "error" ? <div className="story-canvas-state story-canvas-state-error">{notice}</div> : null}
          {phase === "ready" ? (
            <PlayableCanvasContext.Provider value={canvasPlayer}>
              <EditorCanvas<PlayableFlowNode>
                nodes={renderedNodes}
                edges={renderedEdges}
                nodeTypes={PLAYABLE_NODE_TYPES}
                addControl={<PlayableAddControl
                  presets={presets}
                  busy={writing}
                  onAdd={(presetId, position) => void addNodeFromPreset(presetId, position)}
                />}
                onOpenMenu={setCanvasContextMenu}
                deleteKeyCode={openedNode ? null : ["Backspace", "Delete"]}
                onNodesChange={onNodesChange}
                onNodeDragStart={() => { setCanvasContextMenu(undefined); beginHistoryGesture(); }}
                onNodeDragStop={finishHistoryGesture}
                onMoveStart={() => setCanvasContextMenu(undefined)}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onMoveEnd={(_event, viewport) => setEditorLayout((current) => ({ ...current, viewport }))}
                onEdgeClick={(_event, edge) => setSelectedEdgeId(edge.id)}
                onNodeClick={() => { setCanvasContextMenu(undefined); setSelectedEdgeId(undefined); }}
                onNodeDoubleClick={(_event, node) => openNode(node.id)}
                onPaneClick={() => { setCanvasContextMenu(undefined); clearSelection(); }}
                onNodeContextMenu={(_event, node) => {
                  setSelectedEdgeId(undefined);
                  setNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
                }}
                onNodesDelete={(deleted) => removeNodes(new Set(deleted.map((node) => node.id)))}
                isValidConnection={(connection) => Boolean(connection.source && connection.target && connection.sourceHandle)}
                defaultViewport={editorLayout.viewport}
              />
            </PlayableCanvasContext.Provider>
          ) : null}
          {selectedEdge && phase === "ready" && codebase ? <PlayableEdgeInspector
            edge={selectedEdge}
            graph={codebase.graph}
            onChangeMode={(mode) => setEdgeMode(selectedEdge.id, mode)}
            onChangeNavigation={(navigation) => { if (selectedEdge.sourceHandle) if (codebase) applyGraph(setPlayableSignalRole(codebase.graph, selectedEdge.source, selectedEdge.sourceHandle, navigation)); }}
            onDelete={() => { setEdges((current) => current.filter((edge) => edge.id !== selectedEdge.id)); setSelectedEdgeId(undefined); }}
            onClose={() => setSelectedEdgeId(undefined)}
          /> : null}
          {canvasContextMenu ? <PlayableCanvasContextMenu
            menu={canvasContextMenu}
            presets={presets}
            canUndo={canUndo}
            canRedo={canRedo}
            canPaste={Boolean(copiedNode) && !writing}
            busy={writing}
            isEntry={canvasContextMenu.nodeId === codebase?.graph.entryNodeId}
            onClose={() => setCanvasContextMenu(undefined)}
            onUndo={() => void undoEditorChange()?.catch(() => {})}
            onRedo={() => void redoEditorChange()?.catch(() => {})}
            onPaste={() => { if (copiedNode) void insertNodeCopy(copiedNode, canvasContextMenu.flowPosition); }}
            onAdd={(presetId) => void addNodeFromPreset(presetId, canvasContextMenu.flowPosition)}
            onOpen={() => { if (canvasContextMenu.nodeId) openNode(canvasContextMenu.nodeId); }}
            onCopy={() => { if (canvasContextMenu.nodeId) void copyNode(canvasContextMenu.nodeId); }}
            onDuplicate={() => { if (canvasContextMenu.nodeId) void duplicateNode(canvasContextMenu.nodeId); }}
            onSetEntry={() => { if (canvasContextMenu.nodeId) setEntryNode(canvasContextMenu.nodeId); }}
            onDelete={() => { if (canvasContextMenu.nodeId) removeNodes(new Set([canvasContextMenu.nodeId])); }}
          /> : null}
          {notice && phase === "ready" ? <div className="story-save-notice" role="alert">{notice}</div> : null}
          {projectIssues.length && phase === "ready" ? (
            <div className="story-play-issue" role="alert">
              <div><strong>The project does not compile</strong><span>{projectIssues[0]!.message}</span></div>
            </div>
          ) : null}
        </div>
      </div> : <main className="story-code-view" aria-label="Playable Nodes code">
        <WorkspaceCodeView projectId={projectId} revision={workspaceRevision + codeRevision} openFileRequest={fileRequest} />
      </main>}
      {openedNode && codebase ? <PlayableNodeWorkbench
        projectId={projectId}
        node={openedNode}
        graph={codebase.graph}
        issues={issues}
        revision={workspaceRevision + codeRevision}
        onClose={() => setOpenedNodeId(undefined)}
        onOpenNode={openNode}
        onRename={(title) => renameNode(openedNode.id, title)}
        {...(onAskAgent ? { onAskAgent } : {})}
        {...(onSendToAgent ? { onSendToAgent } : {})}
        onWriteText={writeText}
        onAddAsset={async (asset) => {
          const { graph, assetId } = addPlayableNodeAsset(codebase.graph, openedNode.id, asset);
          await writeGraph(graph);
          return assetId;
        }}
        onSetBackdrop={(asset) => writeBackdrop(openedNode.id, asset)}
        onRemoveBackdrop={() => removeBackdrop(openedNode.id)}
        {...(backdrop ? { backdrop } : {})}
        onPlayFromHere={(start) => void startPlaytest(start)}
        onChatContextChange={onChatContextChange}
      /> : null}
      {openedNode && notice ? <div className="story-save-notice is-over-workbench" role="alert">{notice}</div> : null}
      {!designOpen && variablesOpen && graphMeta && workspaceView === "canvas" && !openedNodeId ? <PlayableVariablesPanel
        initialState={graphMeta.initialState}
        descriptions={graphMeta.variables}
        onClose={() => setVariablesOpen(false)}
      /> : null}
      {!designOpen && canvasSettingsOpen ? <CanvasSettingsDialog
        viewport={playerViewport}
        hasContent={nodes.length > 0}
        onClose={() => setCanvasSettingsOpen(false)}
        onChange={(viewport) => setGraphMeta((current) => current ? { ...current, viewport } : current)}
      /> : null}
      {publishDialog ? <PublishDialog project={project} publishing={publishing} justPublished={publishDialog === "success"} onClose={onClosePublish} onPublish={publishGame} /> : null}
    </section>
  );
}

async function readNodeSources(projectId: string, node: PlayableNode): Promise<Record<string, string>> {
  const paths = [node.source.html, node.source.css, node.source.javascript];
  const files = await Promise.all(paths.map((path) => getWorkspaceFile(projectId, path)));
  return Object.fromEntries(paths.map((path, index) => [path, files[index]?.content ?? ""]));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
