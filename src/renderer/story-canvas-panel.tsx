import { workspaceVersion } from "./workspace-version.js";
import { Sparkles } from "./icons.js";
import { Button } from "./ui/index.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { snapCanvasPosition } from "./canvas-alignment.js";
import { EditorCanvas, isTextEntry, ownsCanvasKeys, undoShortcut, type CanvasContextMenuState } from "./editor-canvas.js";
import type { ProjectState } from "../shared/contracts.js";
import { PLAYABLE_CARD_TITLE_HEIGHT, playableCanvasStageSize, rebasePlayableCodebase, samePlayableGraph, type NodeCodebase, type NodeCodebaseUpdate, type NodeEditorLayout } from "../shared/playable-codebase.js";
import type { PlayableNode } from "../shared/playable-nodes.js";
import {
  playableEdgeId,
  type PlayablePresetSummary,
  type PlayableProjectValidationIssue,
} from "../shared/playable-editor.js";
import {
  addPlayableNode,
  ApiError,
  getNodeCodebase,
  getPlayableValidation,
  getStoryStatus,
  getWorkspaceFile,
  listPlayablePresets,
  updateNodeCodebase,
  copyStoryLibraryMedia,
} from "./api.js";
import { CanvasNotice } from "./canvas-notice.js";
import type { StoryStatus } from "../shared/story-web.js";
import { buildCodebase, createFlowNode, nodeIdForIssuePath, nodeSourcePaths, toFlowEdge, toFlowNode, uniqueNodeId, type GraphMeta, type PlayableFlowData, type PlayableFlowNode } from "./playable-flow.js";
import { PLAYABLE_NODE_TYPES, PlayableCanvasContext } from "./playable-node-card.js";
import { PlayableAddControl, PlayableCanvasContextMenu } from "./playable-canvas-menus.js";
import { useDesktopSave } from "./desktop-close-guard.js";
import { t } from "./i18n.js";

const DEFAULT_CANVAS_VIEWPORT = { x: 64, y: 32, zoom: 1 };

const HISTORY_LIMIT = 50;
const SAVE_ATTEMPTS = 3;
/** Loading again while a workspace checkpoint or restore runs longer than the daemon waits for it. */
const WORKSPACE_BUSY_RETRIES = 5;
const WORKSPACE_BUSY_RETRY_MS = 3000;
const PROJECT_CHANGED = t("storyEditor.projectChanged");

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
 * The Story canvas of an Interactive Story: one card per Scene, one line per
 * Exit, read from and written to graph.json. A story is a web game, so the
 * project's other panels (the Game, Code and the rest) are a game's; a Scene
 * opens in Code. It speaks the editor's words (Scene, Exit); code and
 * graph.json keep the engine's (Node, Signal).
 */
export function StoryCanvasPanel({ project, workspaceRevision = 0, visible = true, onOpenFile, onAskAgent }: {
  project: ProjectState;
  workspaceRevision?: number;
  /** Whether the Story panel shows now; its keys are its own only then. */
  visible?: boolean;
  /** Opens a project file in the Code panel. */
  onOpenFile?: (path: string) => void;
  /** Puts a request in the chat prompt. */
  onAskAgent?: (text: string) => void;
}) {
  const projectId = project.id;
  const [writeVersion] = useState(() => workspaceVersion(projectId));
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [story, setStory] = useState<StoryStatus>();
  const [notice, setNotice] = useState<string>();
  /** The load error the author asked the AI to fix, so its button gives way to a note. */
  const [askedFix, setAskedFix] = useState<string>();
  const [graphMeta, setGraphMeta] = useState<GraphMeta>();
  const [nodes, setNodes] = useState<PlayableFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [editorLayout, setEditorLayout] = useState<NodeEditorLayout>({
    version: 1,
    nodes: {},
    viewport: DEFAULT_CANVAS_VIEWPORT,
    view: "canvas",
  });
  // The panels decide what shows now; the view a story saved is kept as it was.
  const [savedView, setSavedView] = useState<"canvas" | "code">("canvas");
  const [codeRevision, setCodeRevision] = useState(0);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState>();
  const [copiedNode, setCopiedNode] = useState<CopiedPlayableNode>();
  const [presets, setPresets] = useState<PlayablePresetSummary[]>([]);
  const [issues, setIssues] = useState<PlayableProjectValidationIssue[]>([]);
  const [writing, setWriting] = useState(false);
  const latestCodebase = useRef<NodeCodebase | undefined>(undefined);
  const canvas = useRef<ReactFlowInstance<PlayableFlowNode, Edge>>(null);
  const storyPane = useRef<HTMLElement>(null);
  /** What the editor last read from or wrote to disk, and the revision a save has to start from. */
  const diskCodebase = useRef<{ codebase: NodeCodebase; revision: string } | undefined>(undefined);
  /** Counts the versions loaded from disk, so a save queued before a load is not written over it. */
  const diskGeneration = useRef(0);
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

  const codebase = useMemo(
    () => graphMeta ? buildCodebase(graphMeta, nodes, edges, editorLayout, savedView) : undefined,
    [graphMeta, nodes, edges, editorLayout, savedView],
  );
  latestCodebase.current = codebase;
  const playerViewport = graphMeta?.viewport ?? { width: 1280, height: 720 };
  const playerViewportAspect = playerViewport.width / playerViewport.height;
  const canvasStage = playableCanvasStageSize(playerViewport);
  const canUndo = Boolean(historyPendingBase.current || undoHistory.current.length);
  const canRedo = !historyPendingBase.current && redoHistory.current.length > 0;
  useEffect(() => {
    let disposed = false;
    setPhase("loading");
    resetHistory();
    setCanvasContextMenu(undefined);
    setCopiedNode(undefined);
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => void Promise.all([
      getNodeCodebase(projectId),
      listPlayablePresets().catch(() => ({ presets: [] as PlayablePresetSummary[] })),
    ]).then(([loaded, catalog]) => {
      if (disposed) return;
      applyCodebase(loaded, { diskRevision: loaded.revision });
      setPresets(catalog.presets);
      setPhase("ready");
    }).catch((error) => {
      if (disposed) return;
      // A checkpoint or restore that outlasted the daemon's wait still finishes; load again after it.
      if (error instanceof ApiError && error.code === "workspace_busy" && attempt < WORKSPACE_BUSY_RETRIES) {
        retry = setTimeout(() => load(attempt + 1), WORKSPACE_BUSY_RETRY_MS);
        return;
      }
      setNotice(errorMessage(error));
      setPhase("error");
    });
    load(0);
    return () => {
      disposed = true;
      clearTimeout(retry);
    };
  }, [projectId, workspaceRevision]);

  // Whether the story plays as its own page, and the Library media it still uses.
  useEffect(() => {
    let disposed = false;
    void getStoryStatus(projectId).then((status) => { if (!disposed) setStory(status); }).catch(() => {});
    return () => { disposed = true; };
  }, [projectId, workspaceRevision]);

  async function copyLibraryMedia(): Promise<void> {
    if (codebase) await save(codebase);
    await copyStoryLibraryMedia(projectId);
    setStory(await getStoryStatus(projectId));
  }

  useEffect(() => {
    if (phase !== "ready") return;
    let disposed = false;
    void getPlayableValidation(projectId).then((result) => {
      if (disposed) return;
      setIssues(result.issues);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [phase, projectId, codeRevision, workspaceRevision]);

  /**
   * Adopts a whole codebase into the editor. `diskRevision` says it is what
   * the files hold, which makes the serialized form the save baseline, so
   * opening a project does not write it straight back; an undo has to save,
   * so it passes nothing.
   */
  function applyCodebase(loaded: NodeCodebase, options: { diskRevision?: string } = {}): NodeCodebase {
    const { nodes: graphNodes, edges: graphEdges, ...meta } = loaded.graph;
    const view = loaded.editorLayout.view === "code" ? "code" : "canvas";
    const flowNodes = graphNodes.map((node) => toFlowNode(node, loaded.editorLayout));
    const flowEdges = graphEdges.map(toFlowEdge);
    setGraphMeta(meta);
    setNodes(flowNodes);
    setEdges(flowEdges);
    setEditorLayout(loaded.editorLayout);
    setSavedView(view);
    const applied = buildCodebase(meta, flowNodes, flowEdges, loaded.editorLayout, view);
    latestCodebase.current = applied;
    if (options.diskRevision !== undefined) {
      queuedCodebase.current = JSON.stringify(applied);
      diskCodebase.current = { codebase: applied, revision: options.diskRevision };
      diskGeneration.current += 1;
    }
    observeHistory(applied);
    setSelectedEdgeId(undefined);
    return applied;
  }

  /** History steps are whole codebases, so none may outlive the version on disk they were taken from. */
  function resetHistory(): void {
    window.clearTimeout(historyTimer.current);
    undoHistory.current = [];
    redoHistory.current = [];
    writtenSources.current = {};
    historyObserved.current = undefined;
    historyObservedJson.current = undefined;
    historyPendingBase.current = undefined;
    historyGestureBase.current = undefined;
  }

  /** Loads a version that reached disk while the editor was open, as reopening the project would. */
  function adoptDiskCodebase(loaded: NodeCodebase, revision: string): void {
    resetHistory();
    applyCodebase(loaded, { diskRevision: revision });
    setCodeRevision((current) => current + 1);
    updateHistoryControls();
  }

  /**
   * Writes a codebase from the revision the editor last saw, and resolves
   * with whether it was written. graph.json and editor/layout.json are not
   * written over a version the editor has not seen: when the Agent changed
   * the graph since, moved Scenes, the viewport, and edited source files are
   * saved on its graph, and a change to the graph itself is given up for it.
   */
  async function writeCodebase(next: NodeCodebaseUpdate, queuedGeneration: number): Promise<boolean> {
    let generation = queuedGeneration;
    let outgoing = next;
    /** The save baseline while a carried layout is on its way, to drop if it does not arrive. */
    let carriedBaseline: string | undefined;
    try {
      for (let attempt = 1; ; attempt += 1) {
        const disk = diskCodebase.current;
        if (generation !== diskGeneration.current || !disk) {
          // A newer version was loaded since this save was queued. Its graph is
          // the one to keep; only a save that would not have changed it is let go quietly.
          if (!outgoing.sources && !outgoing.sourceDeletions && disk && samePlayableGraph(outgoing.graph, disk.codebase.graph)) return false;
          throw new Error(PROJECT_CHANGED);
        }
        try {
          const saved = await updateNodeCodebase(projectId, { ...outgoing, revision: disk.revision }, writeVersion);
          if (generation === diskGeneration.current) {
            diskCodebase.current = { codebase: { graph: outgoing.graph, editorLayout: outgoing.editorLayout }, revision: saved.revision };
          }
          return true;
        } catch (cause) {
          if (!(cause instanceof ApiError) || cause.status !== 409) throw cause;
          if (attempt === SAVE_ATTEMPTS) throw new Error(t("storyEditor.keepsChanging"));
        }
        const remote = await getNodeCodebase(projectId);
        if (generation !== diskGeneration.current) continue;
        if (samePlayableGraph(remote.graph, disk.codebase.graph)
          && JSON.stringify(remote.editorLayout) === JSON.stringify(disk.codebase.editorLayout)) {
          // Formatting changed, so retry without resetting the editor or its history.
          diskCodebase.current = { codebase: disk.codebase, revision: remote.revision };
          continue;
        }
        // Rebase the request first (a copy is not shown until its sources are saved),
        // then carry edits made on the canvas while it waited.
        const pending = rebasePlayableCodebase(disk.codebase, outgoing, remote);
        const carried = pending
          ? rebasePlayableCodebase(disk.codebase, latestCodebase.current ?? outgoing, pending)
          : undefined;
        adoptDiskCodebase(remote, remote.revision);
        if (!carried) throw new Error(PROJECT_CHANGED);
        // Shown before it is saved, so what the author does meanwhile is done to the graph from disk.
        const shown = applyCodebase(carried);
        carriedBaseline = JSON.stringify(shown);
        queuedCodebase.current = carriedBaseline;
        generation = diskGeneration.current;
        outgoing = { ...outgoing, ...shown };
      }
    } catch (cause) {
      // The carried layout is shown but not on disk; let the next change save it.
      if (carriedBaseline !== undefined && queuedCodebase.current === carriedBaseline) queuedCodebase.current = undefined;
      throw cause;
    }
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
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const step = undoShortcut(event);
      if (!step || isTextEntry(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      // With other panels beside the story, a shortcut typed in one of them, or after using another canvas, is theirs.
      if (event.target instanceof Element && event.target.closest(".dock-view") && !storyPane.current?.contains(event.target)) return;
      if (!ownsCanvasKeys(storyPane.current)) return;
      event.preventDefault();
      void (step === "redo" ? redoEditorChange() : undoEditorChange())?.catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [codebase, visible]);

  // A navigation Exit has no line for the canvas to delete, so a connection
  // selected from its Exit row is deleted here, as a drawn one is.
  const selectedNavigation = Boolean(selectedEdgeId && edges.some((edge) => edge.id === selectedEdgeId
    && nodes.find((node) => node.id === edge.source)?.data.node.signals.some((signal) => signal.id === edge.sourceHandle && signal.role === "navigation")));
  useEffect(() => {
    if (!selectedNavigation || !visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== "Delete" && event.key !== "Backspace") || isTextEntry(event.target)) return;
      // With other panels beside the story, a key typed in one of them, or after using another canvas, is theirs.
      if (event.target instanceof Element && event.target.closest(".dock-view") && !storyPane.current?.contains(event.target)) return;
      if (!ownsCanvasKeys(storyPane.current)) return;
      setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedNavigation, selectedEdgeId, visible]);

  const save = useCallback((next: NodeCodebaseUpdate): Promise<void> => {
    const serialized = JSON.stringify(next);
    if (serialized === queuedCodebase.current) return saveChain.current;
    queuedCodebase.current = serialized;
    const generation = diskGeneration.current;
    const written = saveChain.current
      .catch(() => undefined)
      .then(() => writeCodebase(next, generation));
    const operation = written.then(() => undefined);
    saveChain.current = operation;
    void written.then(
      (saved) => {
        // A save let go for a newer version on disk leaves that version's notice in place.
        if (!saved) return;
        setNotice(undefined);
        setCodeRevision((revision) => revision + 1);
      },
      (error) => {
        if (queuedCodebase.current === serialized) queuedCodebase.current = undefined;
        setNotice(t("storyEditor.saveFailed", { error: errorMessage(error) }));
      },
    );
    return operation;
  }, [projectId]);

  useDesktopSave(async () => {
    const pending = latestCodebase.current;
    if (!pending) return saveChain.current;
    // React Flow delays onMoveEnd while scrolling; read the displayed view on close.
    const viewport = canvas.current?.getViewport();
    await save(viewport ? { ...pending, editorLayout: { ...pending.editorLayout, viewport } } : pending);
  });

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

  /** A Scene is its files, so opening one opens its HTML in Code. */
  function openNode(nodeId: string): void {
    setCanvasContextMenu(undefined);
    setSelectedEdgeId(undefined);
    const node = nodes.find((candidate) => candidate.id === nodeId)?.data.node;
    if (node) onOpenFile?.(node.source.html);
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
      const generation = diskGeneration.current;
      await save(codebase);
      // After a save that loaded the Agent's changes, undoing to `codebase` would take them back.
      if (generation === diskGeneration.current) pushUndoSnapshot(codebase);
      redoHistory.current = [];
      await addPlayableNode(projectId, {
        preset: presetId,
        id: uniqueNodeId(presetId, new Set(nodes.map((node) => node.id))),
        position: snapCanvasPosition(position),
      }, writeVersion);
      const loaded = await getNodeCodebase(projectId);
      applyCodebase(loaded, { diskRevision: loaded.revision });
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
      const next = buildCodebase(graphMeta, nextNodes, edges, editorLayout, savedView);
      const update: NodeCodebaseUpdate = {
        ...next,
        sources: {
          [source.html]: copy.sources[copy.node.source.html] ?? "",
          [source.css]: copy.sources[copy.node.source.css] ?? "",
          [source.javascript]: copy.sources[copy.node.source.javascript] ?? "",
        },
      };
      await save(update);
      // The sources are written, so the canvas state alone is what autosave compares next;
      // unless an autosave of the canvas without the copy was queued meanwhile, which the next one has to put right.
      if (queuedCodebase.current === JSON.stringify(update)) queuedCodebase.current = JSON.stringify(next);
      setNodes(nextNodes);
      observeHistory(next);
      updateHistoryControls();
    } catch (cause) {
      undoHistory.current.pop();
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
      if (issue.phase === "source") failed.add(owner);
    }
    return nodes.map((node): PlayableFlowNode => {
      // A video-only Scene shows its video's first frame.
      const coverAssetId = node.data.node.assets.find((id) => graphMeta?.assets[id]?.type === "image")
        ?? node.data.node.assets.find((id) => graphMeta?.assets[id]?.type === "video");
      return {
        ...node,
        data: {
          node: node.data.node,
          entry: codebase?.graph.entryNodeId === node.id,
          issues: nodeIssues.get(node.id) ?? [],
          connected: connected.get(node.id) ?? {},
          failed: failed.has(node.id),
          ...(coverAssetId ? { coverAsset: graphMeta!.assets[coverAssetId] } : {}),
        },
      };
    });
  }, [nodes, edges, selectedEdgeId, issues, graphMeta, codebase]);
  const openNodeRef = useRef(openNode);
  openNodeRef.current = openNode;
  const canvasPlayer = useMemo(() => ({ projectId, onRenameNode: renameNode, onSelectEdge: selectEdge, onOpenNode: (nodeId: string) => openNodeRef.current(nodeId) }), [projectId]);
  const projectIssues = issues.filter((issue) => !issue.surfaceId && !nodeIdForIssuePath(issue.path, nodes));
  // The panel keeps the editor's classes and sizes, so its styles hold.
  return (
    <section
      ref={storyPane}
      className="viewer-pane interactive-story-workspace playable-editor-workspace"
      data-active-tab="story"
      aria-label={t("storyEditor.workspace")}
      style={{
        "--story-viewport-ratio": `${playerViewport.width} / ${playerViewport.height}`,
        "--story-viewport-aspect": playerViewportAspect,
        "--story-canvas-stage-width": `${canvasStage.width}px`,
        "--story-canvas-stage-height": `${canvasStage.height}px`,
        "--story-card-title-height": `${PLAYABLE_CARD_TITLE_HEIGHT}px`,
      } as CSSProperties}
    >
        <div className="interactive-story-body">
          <div className="interactive-story-canvas">
            {phase === "loading" ? <div className="story-canvas-state">{t("storyEditor.loadingScenes")}</div> : null}
            {phase === "error" ? <div className="story-canvas-state story-canvas-state-error">
              <div className="story-canvas-error">
                <p>{notice}</p>
                {onAskAgent && notice && story?.web !== false ? askedFix === notice
                  ? <span className="story-canvas-error-sent">{t("storyEditor.askedFix")}</span>
                  : <Button size="sm" icon={<Sparkles size={13} />} onClick={() => { onAskAgent(askToFixStoryLoad(notice)); setAskedFix(notice); }}>{t("storyEditor.askFix")}</Button> : null}
              </div>
            </div> : null}
            {phase !== "loading" && story && !story.web ? <CanvasNotice
              className="story-canvas-notice"
              tone="warning"
              message={t("storyEditor.tooOld")}
            /> : null}
            {phase === "ready" && story?.web && story.libraryAssets?.length ? <CanvasNotice
              className="story-canvas-notice"
              tone="warning"
              message={t("storyEditor.libraryMedia", { assets: story.libraryAssets.join(", ") })}
              actionLabel={t("storyEditor.copyLibraryMedia")}
              onAction={copyLibraryMedia}
            /> : null}
            {phase === "ready" ? (
              <PlayableCanvasContext.Provider value={canvasPlayer}>
                <EditorCanvas<PlayableFlowNode>
                  nodes={renderedNodes}
                  edges={renderedEdges}
                  onInit={(instance) => { canvas.current = instance; }}
                  nodeTypes={PLAYABLE_NODE_TYPES}
                  addControl={<PlayableAddControl
                    presets={presets}
                    busy={writing}
                    onAdd={(presetId, position) => void addNodeFromPreset(presetId, position)}
                  />}
                  onOpenMenu={setCanvasContextMenu}
                  deleteKeyCode={visible ? ["Backspace", "Delete"] : null}
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
                <div><strong>{t("storyEditor.noCompile")}</strong><span>{projectIssues[0]!.message}</span></div>
              </div>
            ) : null}
          </div>
        </div>
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

/** The chat request behind the Story canvas's "Ask AI to fix" when the story can't be opened. */
export function askToFixStoryLoad(error: string): string {
  return ["The Story editor can't open this story. Find the cause and fix it, keeping the story as it is.", "", "Error:", `- ${error}`].join("\n");
}
