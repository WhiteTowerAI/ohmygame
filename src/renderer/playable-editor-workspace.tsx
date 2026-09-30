import {
  ArrowRight,
  Box,
  ChevronDown,
  Clapperboard,
  Clipboard,
  Code2,
  Copy,
  Download,
  Flag,
  Hand,
  House,
  InfoCircle,
  LoaderCircle,
  Maximize,
  Minus,
  Monitor,
  MousePointer2,
  PanelToggle,
  Play,
  Plus,
  Redo2,
  Share2,
  Settings,
  Trash2,
  Undo2,
  X,
} from "./icons.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  findCanvasAlignmentGuides,
  STORY_CANVAS_GRID_SIZE,
  type CanvasAlignmentGuides,
  type CanvasAlignmentNode,
} from "./story-canvas-alignment.js";
import { snapStoryCanvasPosition } from "./story-canvas-clipboard.js";
import type { ProjectState, PromptContext } from "../shared/contracts.js";
import type { NodeCodebase, NodeCodebaseUpdate, NodeEditorLayout } from "../shared/playable-codebase.js";
import {
  type NodeGraph,
  type NodeSource,
  type PlayableEdge,
  type PlayableNavigationMode,
  type PlayableAssetDefinition,
  type PlayableNode,
  type PlayableSignal,
} from "../shared/playable-nodes.js";
import { playableNodeById } from "../shared/playable-graph.js";
import type { NodePlayerDefinition, PlayableTextEdit } from "../shared/playable-player-protocol.js";
import { parsePlayableSourceLocation, replacePlayableElementText } from "../shared/playable-text-edit.js";
import {
  addPlayableNodeAsset,
  playableEdgeId,
  setPlayableSignalLabel,
  setPlayableSignalRole,
  playableThumbnailHash,
  setPlayableSignalTarget,
  type PlayablePresetSummary,
  type PlayableProjectValidationIssue,
  type PlayableThumbnailManifest,
} from "../shared/playable-editor.js";
import { storyViewportRatio } from "../shared/story-formats.js";
import {
  addPlayableNode,
  buildInteractiveDrama,
  getNodeCodebase,
  getPlayableThumbnail,
  getPlayableValidation,
  getWorkspaceFile,
  listPlayablePresets,
  listPlayableThumbnails,
  updateNodeCodebase,
} from "./api.js";
import { StoryCanvasSettingsDialog } from "./story-canvas-settings-dialog.js";
import { PublishDialog, type PublishDetails } from "./publish-dialog.js";
import { WorkspaceCodeView } from "./coding-workspace.js";
import { playtestHash } from "./routes.js";
import { PlayableNodeWorkbench, type PlayableSignalEdits, type PlaytestStart } from "./playable-node-workbench.js";
import { requestPlaytestStart } from "./playable-playtest-drawer.js";
import { setTechnicalDetails, useTechnicalDetails } from "./playable-details.js";
import { PlayableStatePanel, type PlayableLiveState } from "./playable-project-panels.js";
import type { PlayableChatState } from "./playable-chat.js";
import { PlayableStateHistory } from "../shared/playable-debug.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const EDGE_COLOR = "var(--story-edge-color)";
const PLAYABLE_EDGE_OPTIONS = {
  style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: EDGE_COLOR },
};
const SNAP_GRID: [number, number] = [STORY_CANVAS_GRID_SIZE, STORY_CANVAS_GRID_SIZE];
const CARD_STYLE = {
  "--story-media-width": "var(--story-canvas-stage-width, 440px)",
  "--story-media-height": "var(--story-canvas-stage-height, 248px)",
} as CSSProperties;
const DEFAULT_CANVAS_VIEWPORT = { x: 64, y: 32, zoom: 1 };
const HISTORY_LIMIT = 50;
/** Playtest routes still carry a chapter segment; a graph project has one player. */
const PLAYTEST_CHAPTER_ID = "playable";

type InteractionMode = "pointer" | "pan";
export type GraphMeta = Omit<NodeGraph, "nodes" | "edges">;
/** Object type, not an interface, so React Flow accepts it as node data. */
export type PlayableFlowData = {
  node: PlayableNode;
  entry: boolean;
  /** Compiler and graph issues that belong to this Node. */
  issues: string[];
  /** Where each connected Signal leads: its edge, the target Scene's title, and whether the edge is selected. */
  connected: Record<string, { edgeId: string; target: string; selected: boolean }>;
  /** The Node does not compile; its card keeps its last good thumbnail, dimmed. */
  failed: boolean;
  /** The cached screenshot of the Node, and whether its source changed since. */
  thumbnail?: { capturedAt: string; stale: boolean };
  /** Shown instead of a thumbnail before the Node was ever previewed. */
  coverAsset?: PlayableAssetDefinition;
};
export type PlayableFlowNode = Node<PlayableFlowData, "playable">;
type CanvasContextMenuState = {
  kind: "pane" | "node";
  nodeId?: string;
  screenPosition: { x: number; y: number };
  flowPosition: { x: number; y: number };
};
interface CopiedPlayableNode {
  node: PlayableNode;
  /** Workspace-relative path to file contents, so a copy is a real copy. */
  sources: Record<string, string>;
}

const PlayableCanvasContext = createContext<{
  projectId: string;
  technical: boolean;
  onRenameNode: (nodeId: string, title: string) => void;
  /** Selects a connection whose line is not drawn, such as a navigation Exit's. */
  onSelectEdge: (edgeId: string) => void;
} | undefined>(undefined);
const PLAYABLE_NODE_TYPES: NodeTypes = { playable: PlayableNodeCard };

/**
 * The editor for a Playable Nodes project: one canvas of Nodes, one edge per
 * Signal. Opened instead of the story editor when the project has a graph.json.
 * It speaks the editor's words (Scene, Exit, Variables); code and
 * graph.json keep the engine's (Node, Signal, State).
 */
export function PlayableEditorWorkspace({ project, agentBusy, publishing, workspaceRevision = 0, openFileRequest, onPublish, chatOnRight = false, chatCollapsed = false, onHome, onToggleChat, onChatContextChange, onAskAgent, onSendToAgent }: {
  project: ProjectState;
  agentBusy: boolean;
  publishing: boolean;
  workspaceRevision?: number;
  openFileRequest?: { path: string; id: number };
  onPublish: (details: PublishDetails) => Promise<boolean>;
  chatOnRight?: boolean;
  chatCollapsed?: boolean;
  onHome?: () => void;
  onToggleChat?: () => void;
  /** Receives what the open Workbench adds to the next chat message. */
  onChatContextChange?: (state: PlayableChatState | undefined) => void;
  /** Puts a request in the chat prompt. */
  onAskAgent?: (text: string) => void;
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
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [openedNodeId, setOpenedNodeId] = useState<string>();
  const [projectPanel, setProjectPanel] = useState<"state">();
  const [liveState, setLiveState] = useState<PlayableLiveState>();
  const stateHistory = useRef(new PlayableStateHistory());
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("pointer");
  const [alignmentGuides, setAlignmentGuides] = useState<CanvasAlignmentGuides>();
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState>();
  const [copiedNode, setCopiedNode] = useState<CopiedPlayableNode>();
  const [presets, setPresets] = useState<PlayablePresetSummary[]>([]);
  const [issues, setIssues] = useState<PlayableProjectValidationIssue[]>([]);
  const [builtDefinition, setBuiltDefinition] = useState<NodePlayerDefinition>();
  const [thumbnails, setThumbnails] = useState<PlayableThumbnailManifest>();
  const [thumbnailRevision, setThumbnailRevision] = useState(0);
  const [canvasSettingsOpen, setCanvasSettingsOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const [writing, setWriting] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const reactFlow = useRef<ReactFlowInstance<PlayableFlowNode>>(null);
  const latestCodebase = useRef<NodeCodebase | undefined>(undefined);
  const queuedCodebase = useRef<string | undefined>(undefined);
  const saveChain = useRef(Promise.resolve());
  const undoHistory = useRef<NodeCodebase[]>([]);
  const redoHistory = useRef<NodeCodebase[]>([]);
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
  const openedNode = workspaceView === "canvas" && phase === "ready"
    ? nodes.find((node) => node.id === openedNodeId)?.data.node
    : undefined;
  const liveSource = openedNode?.title;

  /** Keeps the State panel's live values in step with the open Workbench preview. */
  const onPreviewSnapshot = useCallback((snapshot: NodeRuntimeSnapshot | undefined) => {
    if (!snapshot) {
      stateHistory.current.reset();
      setLiveState(undefined);
      return;
    }
    stateHistory.current.record(snapshot);
    setLiveState((current) => current?.state === snapshot.state && current.changes === stateHistory.current.changes
      ? current
      : { state: snapshot.state, changes: stateHistory.current.changes, source: "" });
  }, []);

  // A Playtest window asks the editor to open the Node it is showing.
  useEffect(() => window.ohMyGameDesktop?.onOpenPlayableNode?.((targetProjectId, nodeId) => {
    if (targetProjectId !== projectId) return;
    setWorkspaceView("canvas");
    openNode(nodeId);
  }), [projectId]);

  // An undo or an Agent edit can remove the open Node; go back to the canvas.
  useEffect(() => {
    if (phase === "ready" && openedNodeId && !nodes.some((node) => node.id === openedNodeId)) setOpenedNodeId(undefined);
  }, [phase, nodes, openedNodeId]);

  useEffect(() => {
    if (!openedNode) setLiveState(undefined);
  }, [Boolean(openedNode)]);

  useEffect(() => {
    if (openFileRequest) setFileRequest(openFileRequest);
  }, [openFileRequest?.id]);

  useEffect(() => {
    if (!openFileRequest) return;
    setSelectedId(undefined);
    setOpenedNodeId(undefined);
    setWorkspaceView("code");
  }, [openFileRequest?.id]);

  useEffect(() => {
    let disposed = false;
    setPhase("loading");
    window.clearTimeout(historyTimer.current);
    undoHistory.current = [];
    redoHistory.current = [];
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
    setSelectedId((current) => current && graphNodes.some((node) => node.id === current) ? current : undefined);
  }

  function updateHistoryControls(): void {
    setHistoryRevision((revision) => revision + 1);
  }

  function observeHistory(next: NodeCodebase): void {
    historyObserved.current = structuredClone(next);
    historyObservedJson.current = JSON.stringify(next);
  }

  function pushUndoSnapshot(snapshot: NodeCodebase): void {
    undoHistory.current.push(structuredClone(snapshot));
    if (undoHistory.current.length > HISTORY_LIMIT) undoHistory.current.shift();
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

  function undoEditorChange(): boolean {
    if (!codebase) return false;
    window.clearTimeout(historyTimer.current);
    historyTimer.current = undefined;
    const next = historyPendingBase.current ?? undoHistory.current.pop();
    if (!next) return false;
    historyPendingBase.current = undefined;
    redoHistory.current.push(structuredClone(codebase));
    applyCodebase(next);
    updateHistoryControls();
    return true;
  }

  function redoEditorChange(): boolean {
    if (!codebase || historyPendingBase.current) return false;
    const next = redoHistory.current.pop();
    if (!next) return false;
    pushUndoSnapshot(codebase);
    applyCodebase(next);
    updateHistoryControls();
    return true;
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
      const key = event.key.toLowerCase();
      const undo = (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "z";
      const redo = (event.metaKey || event.ctrlKey) && ((event.shiftKey && key === "z") || (!event.metaKey && key === "y"));
      if (event.altKey || (!undo && !redo) || isTextEntry(event.target)) return;
      event.preventDefault();
      if (redo) redoEditorChange();
      else undoEditorChange();
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
        setNotice(`Could not save the graph: ${errorMessage(error)}`);
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

  /** Edits an Exit of a Node from its Workbench. */
  const signalEdits: PlayableSignalEdits = {
    onSignalLabel: (surfaceId, signalId, label) => { if (codebase) applyGraph(setPlayableSignalLabel(codebase.graph, surfaceId, signalId, label)); },
    onSignalTarget: (surfaceId, signalId, target, mode) => { if (codebase) applyGraph(setPlayableSignalTarget(codebase.graph, surfaceId, signalId, target, mode)); },
    onSignalRole: (surfaceId, signalId, navigation) => { if (codebase) applyGraph(setPlayableSignalRole(codebase.graph, surfaceId, signalId, navigation)); },
    ...(onAskAgent ? { onAskAgent } : {}),
  };

  function setEdgeMode(edgeId: string, mode: PlayableNavigationMode): void {
    setEdges((current) => current.map((edge) => edge.id === edgeId
      ? { ...toFlowEdge({ ...toPlayableEdge(edge)!, mode }), selected: edge.selected }
      : edge));
  }

  /** Selects a connection, as clicking its line does. */
  function selectEdge(edgeId: string): void {
    setCanvasContextMenu(undefined);
    setSelectedId(undefined);
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

  /** Adopts a graph and saves it now, with any sources, instead of on the next autosave. */
  async function writeGraph(graph: NodeGraph, sources?: Record<string, string>): Promise<void> {
    if (!codebase) return;
    applyGraph(graph);
    await save({ graph, editorLayout: codebase.editorLayout, ...(sources ? { sources } : {}) });
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
    const html = file.content === undefined || file.truncated ? undefined : replacePlayableElementText(file.content, location, edit.before, edit.after);
    if (html === undefined) return false;
    const signal = node.signals.find((candidate) => candidate.id === edit.pick.signal);
    const next = signal && signal.label.trim() === edit.before.trim()
      ? setPlayableSignalLabel(graph, node.id, signal.id, edit.after.trim())
      : graph;
    await writeGraph(next, { [location.file]: html });
    return true;
  }

  function openNode(nodeId: string): void {
    setCanvasContextMenu(undefined);
    setSelectedEdgeId(undefined);
    setSelectedId(nodeId);
    setOpenedNodeId(nodeId);
  }

  function setEntryNode(nodeId: string): void {
    setGraphMeta((current) => current ? { ...current, entryNodeId: nodeId } : current);
  }

  /**
   * Drops the Node and its edges from the graph. The Node's files stay on disk
   * so an undo brings the Node back complete. The Entry Node moves off the
   * removed Nodes, because a graph that points at a missing Node cannot be
   * saved at all.
   */
  function removeNodes(removed: ReadonlySet<string>): void {
    if (!removed.size) return;
    setGraphMeta((current) => {
      if (!current) return current;
      const remaining = nodes.filter((node) => !removed.has(node.id));
      return {
        ...current,
        entryNodeId: removed.has(current.entryNodeId)
          ? remaining[0]?.id ?? current.entryNodeId
          : current.entryNodeId,
      };
    });
    setNodes((current) => current.filter((node) => !removed.has(node.id)));
    setEdges((current) => current.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)));
    setSelectedId((current) => current && removed.has(current) ? undefined : current);
    setSelectedEdgeId(undefined);
  }

  function openCanvasContextMenu(event: { preventDefault: () => void; clientX: number; clientY: number }, kind: CanvasContextMenuState["kind"], nodeId?: string): void {
    event.preventDefault();
    const flowPosition = reactFlow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (!flowPosition) return;
    setCanvasContextMenu({
      kind,
      nodeId,
      screenPosition: { x: event.clientX, y: event.clientY },
      flowPosition: snapStoryCanvasPosition(flowPosition),
    });
  }

  function clearSelection(): void {
    setSelectedId(undefined);
    setSelectedEdgeId(undefined);
    setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
  }

  function openFile(path: string): void {
    setOpenedNodeId(undefined);
    setProjectPanel(undefined);
    setFileRequest({ path, id: Date.now() });
    setWorkspaceView("code");
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
      const added = await addPlayableNode(projectId, {
        preset: presetId,
        id: uniqueNodeId(presetId, new Set(nodes.map((node) => node.id))),
        position: snapStoryCanvasPosition(position),
      });
      applyCodebase(await getNodeCodebase(projectId), { fromDisk: true });
      setSelectedId(added.id);
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
        createFlowNode({ ...structuredClone(copy.node), id, source }, snapStoryCanvasPosition(position)),
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
      setSelectedId(id);
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
    if (!codebase) return;
    if (!start) clearSelection();
    try {
      await save(codebase);
      if (start) requestPlaytestStart(projectId, start);
      if (window.ohMyGameDesktop) {
        await window.ohMyGameDesktop.openPlaytest(projectId, PLAYTEST_CHAPTER_ID, codebase.graph.viewport);
      } else {
        window.open(new URL(playtestHash(projectId, PLAYTEST_CHAPTER_ID), window.location.href).href, "ohmygame-playtest");
      }
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }

  async function exportGame(): Promise<void> {
    if (!codebase || building) return;
    setBuilding(true);
    try {
      await save(codebase);
      const artifact = await buildInteractiveDrama(projectId);
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
    if (!codebase) return false;
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
          entry: graphMeta?.entryNodeId === node.id,
          issues: nodeIssues.get(node.id) ?? [],
          connected: connected.get(node.id) ?? {},
          failed: failed.has(node.id),
          ...(cached ? { thumbnail: { capturedAt: cached.capturedAt, stale: Boolean(hash && hash !== cached.hash) } } : {}),
          ...(coverAssetId ? { coverAsset: graphMeta!.assets[coverAssetId] } : {}),
        },
      };
    });
  }, [nodes, edges, selectedEdgeId, issues, graphMeta, thumbnails, builtDefinition]);
  const workbenchTools = <>
    <button type="button" className={`playable-workbench-header-tool${projectPanel === "state" ? " is-active" : ""}`} title="Variables" aria-pressed={projectPanel === "state"} onClick={() => setProjectPanel((current) => current === "state" ? undefined : "state")}><Box size={13} /><span>Variables</span></button>
  </>;
  const canvasPlayer = useMemo(() => ({ projectId, technical, onRenameNode: renameNode, onSelectEdge: selectEdge }), [projectId, technical]);
  const projectIssues = issues.filter((issue) => !issue.surfaceId && !nodeIdForIssuePath(issue.path, nodes));
  const showCodeTab = technical || workspaceView === "code";

  return (
    <section
      className={`viewer-pane interactive-drama-workspace playable-editor-workspace${openedNode ? " is-node-editor-open" : ""}`}
      aria-label="Playable Nodes workspace"
      style={{
        "--story-viewport-ratio": `${playerViewport.width} / ${playerViewport.height}`,
        "--story-viewport-aspect": playerViewportAspect,
        "--story-canvas-stage-width": `${canvasStageWidth}px`,
        "--story-canvas-stage-height": `${canvasStageHeight}px`,
      } as CSSProperties}
    >
      <header className="interactive-drama-header window-drag-handle">
        <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
        <div className="interactive-drama-project-tools">
          <PlayableProjectMenu
            disabled={phase !== "ready"}
            screenSize={storyViewportRatio(playerViewport)}
            panel={projectPanel}
            exporting={building}
            canExport={!agentBusy && !publishing && !building}
            technical={technical}
            onScreenSize={() => setCanvasSettingsOpen(true)}
            onPanel={(panel) => setProjectPanel((current) => current === panel ? undefined : panel)}
            onExport={() => void exportGame()}
            onTechnicalChange={(on) => {
              setTechnicalDetails(on);
              if (!on && workspaceView === "code") setWorkspaceView("canvas");
            }}
          />
          {chatOnRight && onHome ? (
            <button className="interactive-drama-home-button" type="button" onClick={onHome} title="Home" aria-label="Home"><House size={14} /></button>
          ) : null}
        </div>
        {showCodeTab ? <nav className="workspace-tabs interactive-drama-workspace-switch" data-active-tab={workspaceView} data-tab-count="2" aria-label="Workspace mode">
          <button type="button" className={`workspace-tab${workspaceView === "canvas" ? " workspace-tab-active" : ""}`} aria-pressed={workspaceView === "canvas"} title="Canvas" onClick={() => setWorkspaceView("canvas")}><Clapperboard size={14} /><span>Canvas</span></button>
          <button type="button" className={`workspace-tab${workspaceView === "code" ? " workspace-tab-active" : ""}`} aria-pressed={workspaceView === "code"} title="Code" onClick={() => { clearSelection(); setWorkspaceView("code"); }}><Code2 size={15} /><span>Code</span></button>
        </nav> : null}
        <div className="interactive-drama-header-actions">
          <button className="interactive-drama-action" type="button" title="Play the game in a new window" onClick={() => void startPlaytest()}>
            <Play size={14} fill="currentColor" />
            <span>Playtest</span>
          </button>
          {chatOnRight && chatCollapsed && onToggleChat ? (
            <button className="interactive-drama-action" type="button" title="Show chat" aria-label="Show chat" onClick={onToggleChat}>
              <PanelToggle size={14} />
            </button>
          ) : null}
          <button className="interactive-drama-action interactive-drama-action-primary" type="button" title="Publish" disabled={agentBusy || publishing || building} onClick={() => setPublishOpen(true)}>
            {publishing ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
            <span>Publish</span>
          </button>
        </div>
      </header>
      {workspaceView !== "code" ? <div className="interactive-drama-body">
        <div className="interactive-drama-canvas" ref={canvas}>
          {phase === "loading" ? <div className="story-canvas-state">Loading graph...</div> : null}
          {phase === "error" ? <div className="story-canvas-state story-canvas-state-error">{notice}</div> : null}
          {phase === "ready" ? (
            <PlayableCanvasContext.Provider value={canvasPlayer}>
              <ReactFlow<PlayableFlowNode>
                className={`story-canvas story-canvas-${interactionMode}`}
                nodes={renderedNodes}
                edges={renderedEdges}
                nodeTypes={PLAYABLE_NODE_TYPES}
                onInit={(instance) => { reactFlow.current = instance; }}
                defaultEdgeOptions={PLAYABLE_EDGE_OPTIONS}
                connectionLineStyle={PLAYABLE_EDGE_OPTIONS.style}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                snapToGrid
                snapGrid={SNAP_GRID}
                nodesDraggable={interactionMode === "pointer"}
                elementsSelectable={interactionMode === "pointer"}
                selectionOnDrag={interactionMode === "pointer"}
                panOnDrag={interactionMode === "pan" ? true : [1, 2]}
                panOnScroll
                zoomOnScroll={false}
                zoomOnPinch
                zoomOnDoubleClick={false}
                deleteKeyCode={["Backspace", "Delete"]}
                onNodesChange={onNodesChange}
                onNodeDragStart={() => { setCanvasContextMenu(undefined); setAlignmentGuides(undefined); beginHistoryGesture(); }}
                onNodeDrag={(_event, node) => {
                  const [active, ...candidates] = alignmentNodesFromDom([node, ...renderedNodes]);
                  setAlignmentGuides(active ? findCanvasAlignmentGuides(active, candidates) : undefined);
                }}
                onNodeDragStop={() => { setAlignmentGuides(undefined); finishHistoryGesture(); }}
                onMoveStart={() => setCanvasContextMenu(undefined)}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onMoveEnd={(_event, viewport) => setEditorLayout((current) => ({ ...current, viewport }))}
                onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedId(undefined); }}
                onNodeClick={(_event, node) => { setCanvasContextMenu(undefined); setSelectedEdgeId(undefined); setSelectedId(node.id); }}
                onNodeDoubleClick={(_event, node) => openNode(node.id)}
                onPaneClick={() => { setCanvasContextMenu(undefined); clearSelection(); }}
                onPaneContextMenu={(event) => openCanvasContextMenu(event, "pane")}
                onNodeContextMenu={(event, node) => {
                  setSelectedEdgeId(undefined);
                  setSelectedId(node.id);
                  setNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
                  openCanvasContextMenu(event, "node", node.id);
                }}
                onNodesDelete={(deleted) => removeNodes(new Set(deleted.map((node) => node.id)))}
                isValidConnection={(connection) => Boolean(connection.source && connection.target && connection.sourceHandle)}
                proOptions={{ hideAttribution: true }}
                defaultViewport={editorLayout.viewport}
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--interactive-drama-grid)" />
                <PlayableAlignmentGuides guides={alignmentGuides} />
                <ZoomControls />
                <PlayableCanvasToolbar
                  mode={interactionMode}
                  canvas={canvas}
                  presets={presets}
                  busy={writing}
                  onAdd={(presetId, position) => void addNodeFromPreset(presetId, position)}
                  onModeChange={setInteractionMode}
                />
              </ReactFlow>
            </PlayableCanvasContext.Provider>
          ) : null}
          {selectedEdge && phase === "ready" && codebase ? <PlayableEdgeInspector
            edge={selectedEdge}
            graph={codebase.graph}
            onChangeMode={(mode) => setEdgeMode(selectedEdge.id, mode)}
            onChangeNavigation={(navigation) => { if (selectedEdge.sourceHandle) signalEdits.onSignalRole(selectedEdge.source, selectedEdge.sourceHandle, navigation); }}
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
            isEntry={canvasContextMenu.nodeId === graphMeta?.entryNodeId}
            onClose={() => setCanvasContextMenu(undefined)}
            onUndo={undoEditorChange}
            onRedo={redoEditorChange}
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
        onOpenSource={() => openFile(openedNode.source.html)}
        agentBusy={agentBusy}
        onRename={(title) => renameNode(openedNode.id, title)}
        onSignalTarget={signalEdits.onSignalTarget}
        {...(onAskAgent ? { onAskAgent } : {})}
        {...(onSendToAgent ? { onSendToAgent } : {})}
        onWriteText={writeText}
        onAddAsset={async (asset) => {
          const { graph, assetId } = addPlayableNodeAsset(codebase.graph, openedNode.id, asset);
          await writeGraph(graph);
          return assetId;
        }}
        onPlayFromHere={(start) => void startPlaytest(start)}
        onSnapshot={onPreviewSnapshot}
        onChatContextChange={onChatContextChange}
        headerActions={workbenchTools}
      /> : null}
      {projectPanel === "state" && graphMeta ? <PlayableStatePanel
        initialState={graphMeta.initialState}
        live={liveState && liveSource ? { ...liveState, source: liveSource } : undefined}
        onChange={(initialState) => setGraphMeta((current) => current ? { ...current, initialState } : current)}
        onClose={() => setProjectPanel(undefined)}
      /> : null}
      {canvasSettingsOpen ? <StoryCanvasSettingsDialog
        viewport={playerViewport}
        hasContent={nodes.length > 0}
        onClose={() => setCanvasSettingsOpen(false)}
        onChange={(viewport) => setGraphMeta((current) => current ? { ...current, viewport } : current)}
      /> : null}
      {publishOpen ? <PublishDialog project={project} publishing={publishing} onClose={() => setPublishOpen(false)} onPublish={publishGame} /> : null}
    </section>
  );
}

function PlayableNodeCard({ id, data, selected }: NodeProps<PlayableFlowNode>) {
  const canvas = useContext(PlayableCanvasContext);
  const { node, entry, issues, connected, failed, thumbnail, coverAsset } = data;
  return <div className={`story-node story-media-node story-presentation-node-card playable-node-card${selected ? " is-selected" : ""}`} style={CARD_STYLE}>
    <Handle className="story-media-input-handle" type="target" position={Position.Left} />
    <div className="story-media-node-label story-scene-node-label">
      <Clapperboard size={14} />
      <span><b>Scene</b><InlinePlayableTitle nodeId={id} value={node.title} onRename={canvas?.onRenameNode} /></span>
      <div className="playable-node-badges">
        {entry ? <span className="playable-node-badge is-entry" title="The player starts here"><Flag size={11} /><span>Start</span></span> : null}
      </div>
    </div>
    <div data-alignment-frame className={`story-media-stage playable-node-stage${failed ? " is-failed" : ""}`}>
      <PlayableNodePicture projectId={canvas?.projectId} technical={Boolean(canvas?.technical)} node={node} thumbnail={thumbnail} coverAsset={coverAsset} />
      {thumbnail?.stale && !failed ? <span className="playable-node-stale" title="The Scene changed since this picture was taken.">Stale</span> : null}
      {issues.length ? <p className="playable-node-issue" role="alert"><InfoCircle size={13} /><span title={issues.join("\n")}>{issues[0]}</span></p> : null}
    </div>
    <PlayableSignalOutputs signals={node.signals} connected={connected} technical={Boolean(canvas?.technical)} onSelectEdge={canvas?.onSelectEdge} />
  </div>;
}

/**
 * What a Node card shows: the Node's last thumbnail, else its first image
 * Asset, else a neutral card with its title.
 */
function PlayableNodePicture({ projectId, technical, node, thumbnail, coverAsset }: {
  projectId?: string;
  technical: boolean;
  node: PlayableNode;
  thumbnail?: { capturedAt: string };
  coverAsset?: PlayableAssetDefinition;
}) {
  const captured = usePlayableThumbnailUrl(thumbnail ? projectId : undefined, node.id, thumbnail?.capturedAt);
  const source = coverAsset?.source;
  const cover = useWorkspaceAssetUrl(
    !captured && source?.kind === "workspace" ? projectId : undefined,
    source?.kind === "workspace" ? source.path : "",
    0,
    !captured && source?.kind === "library" ? source.assetId : undefined,
  );
  const url = captured ?? cover.url;
  if (url) return <img className={`playable-node-picture${captured ? "" : " is-asset"}`} src={url} alt="" draggable={false} />;
  return <div className="playable-node-summary">
    <strong>{node.title}</strong>
    {technical ? <small>{node.id}</small> : null}
  </div>;
}

/** Keeps showing the previous screenshot until a newer one has loaded. */
function usePlayableThumbnailUrl(projectId: string | undefined, nodeId: string, capturedAt: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  const current = useRef<string | undefined>(undefined);
  const show = useCallback((next: string | undefined) => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setUrl(next);
  }, []);
  useEffect(() => () => { if (current.current) URL.revokeObjectURL(current.current); }, []);
  useEffect(() => {
    if (!projectId || !capturedAt) {
      show(undefined);
      return;
    }
    let disposed = false;
    void getPlayableThumbnail(projectId, nodeId).then((blob) => {
      if (!disposed) show(blob ? URL.createObjectURL(blob) : undefined);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [projectId, nodeId, capturedAt, show]);
  return url;
}

/**
 * A Scene card's Exits, each with the port its connection leaves from. A
 * navigation Exit's line is not drawn; the row names its target instead, and
 * clicking the name selects the connection.
 */
function PlayableSignalOutputs({ signals, connected, technical, onSelectEdge }: {
  signals: readonly PlayableSignal[];
  connected: PlayableFlowData["connected"];
  technical: boolean;
  onSelectEdge?: (edgeId: string) => void;
}) {
  if (!signals.length) return <div className="story-node-outputs playable-node-outputs-empty"><span>No exits yet</span></div>;
  return <div className="story-node-outputs">{signals.map((signal) => {
    const route = connected[signal.id];
    const name = signal.label || signal.id;
    return <div className={`story-node-output${route ? "" : " is-unconnected"}`} key={signal.id}>
      <span className="story-node-output-label" title={route
        ? technical ? `${signal.label} (${signal.id})` : signal.label
        : `"${name}" doesn't go anywhere yet. Drag from here to a Scene.`}>{name}</span>
      <Handle className="story-node-output-handle" id={signal.id} type="source" position={Position.Right} />
      {route && signal.role === "navigation" ? <button
        type="button"
        className={`playable-node-output-target nodrag nopan${route.selected ? " is-selected" : ""}`}
        title={`"${name}" goes to ${route.target}`}
        onClick={(event) => {
          // The row is inside the card, so the click would also select the Scene.
          event.stopPropagation();
          onSelectEdge?.(route.edgeId);
        }}
      ><ArrowRight size={10} /><span>{route.target}</span></button> : null}
    </div>;
  })}</div>;
}

function InlinePlayableTitle({ nodeId, value, onRename }: {
  nodeId: string;
  value: string;
  onRename?: (nodeId: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  if (!editing || !onRename) return <strong onDoubleClick={(event) => {
    if (!onRename) return;
    event.stopPropagation();
    setDraft(value);
    setEditing(true);
  }}>{value}</strong>;

  const commit = () => {
    const next = draft.trim();
    if (next) onRename(nodeId, next);
    setEditing(false);
  };
  return <input
    ref={input}
    className="story-node-title-input"
    value={draft}
    maxLength={120}
    aria-label="Scene title"
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Enter") commit();
      if (event.key === "Escape") { setDraft(value); setEditing(false); }
    }}
  />;
}

/**
 * An Exit's connection carries one decision: whether the player can come back
 * (the engine's `push`) or the next Scene takes over (`replace`). It also
 * shows whether the Exit is navigation, whose line the canvas does not draw.
 */
function PlayableEdgeInspector({ edge, graph, onChangeMode, onChangeNavigation, onDelete, onClose }: {
  edge: Edge;
  graph: NodeGraph;
  onChangeMode: (mode: PlayableNavigationMode) => void;
  onChangeNavigation: (navigation: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const titleOf = (nodeId: string) => graph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId;
  const signal = playableNodeById(graph, edge.source)?.signals.find((candidate) => candidate.id === edge.sourceHandle);
  const mode: PlayableNavigationMode = edge.data?.mode === "push" ? "push" : "replace";
  return <aside className="playable-edge-inspector" aria-label="Exit">
    <header>
      <div>
        <strong>{signal?.label || edge.sourceHandle}</strong>
        <small>{titleOf(edge.source)} → {titleOf(edge.target)}</small>
      </div>
      <button type="button" aria-label="Close" onClick={onClose}><X size={14} /></button>
    </header>
    <label className="playable-edge-back">
      <input type="checkbox" checked={mode === "push"} onChange={(event) => onChangeMode(event.target.checked ? "push" : "replace")} />
      <span><strong>Allow Back</strong><small>The player can return to {titleOf(edge.source)} from {titleOf(edge.target)}.</small></span>
    </label>
    <label className="playable-edge-back">
      <input type="checkbox" checked={signal?.role === "navigation"} onChange={(event) => onChangeNavigation(event.target.checked)} />
      <span><strong>Navigation</strong><small>A way around the game, like Home. The canvas names {titleOf(edge.target)} on the Exit instead of drawing a line.</small></span>
    </label>
    <button className="playable-edge-delete" type="button" onClick={onDelete}><Trash2 size={13} /><span>Remove connection</span></button>
  </aside>;
}

/**
 * Project-wide things that are not on the canvas: screen size, Variables, Export, and whether engine details show.
 */
function PlayableProjectMenu({ disabled, screenSize, panel, exporting, canExport, technical, onScreenSize, onPanel, onExport, onTechnicalChange }: {
  disabled: boolean;
  screenSize: string;
  panel?: "state";
  exporting: boolean;
  canExport: boolean;
  technical: boolean;
  onScreenSize: () => void;
  onPanel: (panel: "state") => void;
  onExport: () => void;
  onTechnicalChange: (on: boolean) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();

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

  const run = (action: () => void) => { setPosition(undefined); action(); };

  return <>
    <button
      ref={button}
      type="button"
      className={panel || position ? "is-active" : undefined}
      title="Project settings"
      aria-haspopup="menu"
      aria-expanded={Boolean(position)}
      disabled={disabled}
      onClick={() => {
        if (position) return setPosition(undefined);
        const bounds = button.current?.getBoundingClientRect();
        if (bounds) setPosition({ top: bounds.bottom + 4, left: bounds.left });
      }}
    ><Settings size={14} /><span>Project</span><ChevronDown size={12} /></button>
    {position ? createPortal(<div
      ref={menu}
      className="story-canvas-context-menu playable-project-menu"
      role="menu"
      aria-label="Project"
      tabIndex={-1}
      style={{ top: position.top, left: position.left }}
    >
      <button type="button" role="menuitem" onClick={() => run(onScreenSize)}><Monitor size={15} /><span>Screen size</span><small>{screenSize}</small></button>
      <button type="button" role="menuitemcheckbox" aria-checked={panel === "state"} onClick={() => run(() => onPanel("state"))}><Box size={15} /><span>Variables</span></button>
      <div className="playable-project-menu-separator" role="separator" />
      <button type="button" role="menuitem" disabled={!canExport} onClick={() => run(onExport)}>
        {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}<span>{exporting ? "Exporting" : "Export"}</span>
      </button>
      <div className="playable-project-menu-separator" role="separator" />
      <button type="button" role="menuitemcheckbox" aria-checked={technical} title="Show IDs, file paths, types, and the Code view" onClick={() => onTechnicalChange(!technical)}>
        <Code2 size={15} /><span>Show technical details</span><small>{technical ? "✓" : ""}</small>
      </button>
    </div>, document.body) : null}
  </>;
}

function PlayableCanvasToolbar({ mode, canvas, presets, busy, onAdd, onModeChange }: {
  mode: InteractionMode;
  canvas: React.RefObject<HTMLDivElement | null>;
  presets: readonly PlayablePresetSummary[];
  busy: boolean;
  onAdd: (presetId: string, position: { x: number; y: number }) => void;
  onModeChange: (mode: InteractionMode) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const addMenu = useRef<HTMLDivElement>(null);
  const { fitView, getNodes, screenToFlowPosition, setViewport } = useReactFlow();

  useEffect(() => {
    if (!addOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!addMenu.current?.contains(event.target as globalThis.Node)) setAddOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setAddOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [addOpen]);

  async function fitCanvas(): Promise<void> {
    if (getNodes().length === 0) {
      await setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 });
      return;
    }
    await fitView({ padding: 0.2, duration: 200 });
  }

  function placementPosition(): { x: number; y: number } | undefined {
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds) return undefined;
    return screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
  }

  return (
    <Panel className="story-canvas-toolbar" position="bottom-center">
      <div ref={addMenu} className="story-add-node">
        {addOpen ? (
          <div className="story-add-node-menu-shell">
            <div className="story-add-node-menu" role="menu" aria-label="Add Scene">
              <span className="story-add-node-menu-label">Start from a template</span>
              {presets.map((preset) => <button
                type="button"
                role="menuitem"
                key={preset.id}
                disabled={busy}
                onClick={() => {
                  const position = placementPosition();
                  if (position) onAdd(preset.id, position);
                  setAddOpen(false);
                }}
              ><Clapperboard size={15} /><span><strong>{preset.label}</strong><small>{preset.brief}</small></span></button>)}
            </div>
          </div>
        ) : null}
        <button className={addOpen ? "is-active" : undefined} type="button" title="Add Scene" aria-label="Add Scene" aria-expanded={addOpen} onClick={() => setAddOpen((open) => !open)}>
          {busy ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
        </button>
      </div>
      <button className={mode === "pointer" ? "is-active" : undefined} type="button" title="Select" aria-label="Select" aria-pressed={mode === "pointer"} onClick={() => onModeChange("pointer")}>
        <MousePointer2 size={18} />
      </button>
      <button className={mode === "pan" ? "is-active" : undefined} type="button" title="Pan canvas" aria-label="Pan canvas" aria-pressed={mode === "pan"} onClick={() => onModeChange("pan")}>
        <Hand size={18} />
      </button>
      <button type="button" title="Fit view" aria-label="Fit view" onClick={() => void fitCanvas()}><Maximize size={18} /></button>
    </Panel>
  );
}

function PlayableCanvasContextMenu({ menu, presets, canUndo, canRedo, canPaste, busy, isEntry, onClose, onUndo, onRedo, onPaste, onAdd, onOpen, onCopy, onDuplicate, onSetEntry, onDelete }: {
  menu: CanvasContextMenuState;
  presets: readonly PlayablePresetSummary[];
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  busy: boolean;
  isEntry: boolean;
  onClose: () => void;
  onUndo: () => unknown;
  onRedo: () => unknown;
  onPaste: () => void;
  onAdd: (presetId: string) => void;
  onOpen: () => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onSetEntry: () => void;
  onDelete: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [position, setPosition] = useState(menu.screenPosition);
  const opensLeft = menu.screenPosition.x > window.innerWidth - 600;
  const opensUp = menu.screenPosition.y > window.innerHeight / 2;

  useLayoutEffect(() => {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({
      x: Math.max(6, Math.min(menu.screenPosition.x, window.innerWidth - bounds.width - 6)),
      y: Math.max(6, Math.min(menu.screenPosition.y, window.innerHeight - bounds.height - 6)),
    });
    root.current?.focus();
  }, [menu.screenPosition.x, menu.screenPosition.y]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as globalThis.Node)) onClose();
    };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const run = (action: () => unknown) => { action(); onClose(); };

  return createPortal(
    <div
      ref={root}
      className={`story-canvas-context-menu${opensLeft ? " opens-left" : ""}${opensUp ? " opens-up" : ""}`}
      role="menu"
      aria-label={menu.kind === "pane" ? "Canvas actions" : "Scene actions"}
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.kind === "pane" ? <>
        <button type="button" role="menuitem" disabled={!canUndo} onClick={() => run(onUndo)}><Undo2 size={15} /><span>Undo</span></button>
        <button type="button" role="menuitem" disabled={!canRedo} onClick={() => run(onRedo)}><Redo2 size={15} /><span>Redo</span></button>
        <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onPaste)}><Clipboard size={15} /><span>Paste</span></button>
        <div className="story-canvas-context-submenu-root" onPointerEnter={() => setAddOpen(true)}>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={addOpen} onClick={() => setAddOpen(true)}><Plus size={15} /><span>Add Scene</span></button>
          {addOpen ? <div className="story-canvas-context-add-menu">
            <div className="story-canvas-context-submenu" role="menu" aria-label="Add Scene">
              {presets.map((preset) => <button
                type="button"
                role="menuitem"
                key={preset.id}
                disabled={busy}
                title={preset.brief}
                onClick={() => run(() => onAdd(preset.id))}
              ><Clapperboard size={15} /><span>{preset.label}</span></button>)}
            </div>
          </div> : null}
        </div>
      </> : <>
        <button type="button" role="menuitem" onClick={() => run(onOpen)}><Maximize size={15} /><span>Open</span></button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => run(onCopy)}><Copy size={15} /><span>Copy Scene</span></button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => run(onDuplicate)}><Plus size={15} /><span>Duplicate</span></button>
        <button type="button" role="menuitem" disabled={isEntry} onClick={() => run(onSetEntry)}><Flag size={15} /><span>{isEntry ? "Start Scene" : "Set as Start"}</span></button>
        <button className="is-danger" type="button" role="menuitem" onClick={() => run(onDelete)}><Trash2 size={15} /><span>Delete</span></button>
      </>}
    </div>,
    document.body,
  );
}

function PlayableAlignmentGuides({ guides }: { guides?: CanvasAlignmentGuides }) {
  const { zoom } = useViewport();
  if (!guides) return null;
  const lineWidth = 1 / zoom;
  return <ViewportPortal>
    {guides.vertical.map((guide) => <div
      key={`vertical:${guide.x}`}
      className="story-canvas-alignment-guide is-vertical"
      data-axis="vertical"
      style={{ left: guide.x - lineWidth / 2, top: guide.from, width: lineWidth, height: guide.to - guide.from }}
    />)}
    {guides.horizontal.map((guide) => <div
      key={`horizontal:${guide.y}`}
      className="story-canvas-alignment-guide is-horizontal"
      data-axis="horizontal"
      style={{ left: guide.from, top: guide.y - lineWidth / 2, width: guide.to - guide.from, height: lineWidth }}
    />)}
  </ViewportPortal>;
}

function alignmentNodesFromDom<T extends { id: string; position: { x: number; y: number } }>(nodes: readonly T[]): CanvasAlignmentNode[] {
  const zoom = canvasViewportZoom();
  const roots = new Map([...document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")]
    .map((element) => [element.dataset.id!, element] as const));
  return nodes.map((node) => {
    const root = roots.get(node.id);
    const frame = root?.querySelector<HTMLElement>("[data-alignment-frame]");
    if (!root || !frame) return node;
    const rootRect = root.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    return {
      ...node,
      alignmentFrame: {
        x: node.position.x + (frameRect.left - rootRect.left) / zoom,
        y: node.position.y + (frameRect.top - rootRect.top) / zoom,
        width: frameRect.width / zoom,
        height: frameRect.height / zoom,
      },
    };
  });
}

function canvasViewportZoom(): number {
  const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
  const transform = viewport ? getComputedStyle(viewport).transform : "none";
  if (transform === "none") return 1;
  try {
    const zoom = new DOMMatrixReadOnly(transform).a;
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  } catch {
    return 1;
  }
}

function ZoomControls() {
  const { zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel className="story-canvas-zoom" position="bottom-left">
      <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => void zoomOut()}><Minus size={14} /></button>
      <button className="story-canvas-zoom-value" type="button" title="Reset zoom" onClick={() => void zoomTo(1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => void zoomIn()}><Plus size={14} /></button>
    </Panel>
  );
}

/** The single place the editor turns canvas state back into files on disk. */
export function buildCodebase(
  meta: GraphMeta,
  nodes: readonly PlayableFlowNode[],
  edges: readonly Edge[],
  layout: NodeEditorLayout,
  view: "canvas" | "code",
): NodeCodebase {
  return {
    graph: {
      ...meta,
      nodes: nodes.map((node) => node.data.node),
      edges: edges.flatMap((edge) => toPlayableEdge(edge) ?? []),
    },
    editorLayout: {
      ...layout,
      view,
      nodes: Object.fromEntries(nodes.map((node) => [node.id, {
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
      }])),
    },
  };
}

function toFlowNode(node: PlayableNode, layout: NodeEditorLayout): PlayableFlowNode {
  return createFlowNode(node, layout.nodes[node.id] ?? { x: 80, y: 180 });
}

function createFlowNode(node: PlayableNode, position: { x: number; y: number }): PlayableFlowNode {
  return {
    id: node.id,
    type: "playable",
    position,
    deletable: true,
    data: { node, entry: false, issues: [], connected: {}, failed: false },
  };
}

export function toFlowEdge(edge: PlayableEdge): Edge {
  return {
    id: edge.id,
    source: edge.source.nodeId,
    sourceHandle: edge.source.signal,
    target: edge.targetNodeId,
    data: { mode: edge.mode },
    ...(edge.mode === "push" ? { label: "↩ Back", className: "playable-edge-push" } : {}),
  };
}

export function toPlayableEdge(edge: Edge): PlayableEdge | undefined {
  if (!edge.sourceHandle) return undefined;
  return {
    id: edge.id,
    source: { nodeId: edge.source, signal: edge.sourceHandle },
    targetNodeId: edge.target,
    mode: edge.data?.mode === "push" ? "push" : "replace",
  };
}

function nodeSourcePaths(id: string): NodeSource {
  return {
    html: `nodes/${id}/index.html`,
    css: `nodes/${id}/style.css`,
    javascript: `nodes/${id}/node.js`,
  };
}

export function uniqueNodeId(base: string, taken: ReadonlySet<string>): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || "node";
  if (!taken.has(slug)) return slug;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function readNodeSources(projectId: string, node: PlayableNode): Promise<Record<string, string>> {
  const paths = [node.source.html, node.source.css, node.source.javascript];
  const files = await Promise.all(paths.map((path) => getWorkspaceFile(projectId, path)));
  return Object.fromEntries(paths.map((path, index) => [path, files[index]?.content ?? ""]));
}

/** Compiler issues carry a file path; the owning Node is the one that wrote it. */
export function nodeIdForIssuePath(path: string, nodes: readonly PlayableFlowNode[]): string | undefined {
  return nodes.find((node) => path === node.data.node.source.html
    || path === node.data.node.source.css
    || path === node.data.node.source.javascript
    || path.startsWith(`nodes/${node.id}/`))?.id;
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== "checkbox" && target.type !== "radio"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


