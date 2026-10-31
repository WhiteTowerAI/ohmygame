import { workspaceVersion } from "./workspace-version.js";
import {
  LoaderCircle,
  Settings,
} from "./icons.js";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
import type { ProjectState, PromptContext } from "../shared/contracts.js";
import { PLAYABLE_CARD_TITLE_HEIGHT, playableCanvasStageSize, rebasePlayableCodebase, samePlayableGraph, type NodeCodebase, type NodeCodebaseUpdate, type NodeEditorLayout } from "../shared/playable-codebase.js";
import {
  type NodeGraph,
  type PlayableNode,
} from "../shared/playable-nodes.js";
import { setPlayableElementTranslate } from "../shared/playable-move.js";
import type { NodePlayerDefinition, PlayableMove, PlayableTextEdit } from "../shared/playable-player-protocol.js";
import { parsePlayableSourceLocation, replacePlayableElementText, replacePlayableLineText } from "../shared/playable-text-edit.js";
import { clearPlayableBackdrop, playableBackdrop, setPlayableBackdrop, setPlayableBackdropClip, type PlayableBackdropDetails } from "../shared/playable-backdrop.js";
import type { PlayableVideoClip } from "../shared/playable-video-clip.js";
import {
  addPlayableNodeAsset,
  playableEdgeId,
  setPlayableSignalLabel,
  playableThumbnailHash,
  type PlayablePresetSummary,
  type PlayableProjectValidationIssue,
  type PlayableThumbnailManifest,
} from "../shared/playable-editor.js";
import {
  addPlayableNode,
  ApiError,
  getNodeCodebase,
  getPlayableValidation,
  getStoryUpgrade,
  getWorkspaceFile,
  listPlayablePresets,
  listPlayableThumbnails,
  updateNodeCodebase,
  copyStoryLibraryMedia,
  upgradeStory,
} from "./api.js";
import { CanvasNotice } from "./canvas-notice.js";
import type { StoryUpgradeStatus } from "../shared/story-web.js";
import { PublishDialog, type PublishDetails } from "./publish-dialog.js";
import { WorkspaceAssetsView, WorkspaceCodeView } from "./coding-workspace.js";
import { playtestHash } from "./routes.js";
import { PlayableNodeWorkbench, type PlayableAssetRequest } from "./playable-node-workbench.js";
import { PlayableProjectSettingsDialog } from "./playable-project-settings-dialog.js";
import { PlaytestControls, requestPlaytest, type PlaytestRequest } from "./playable-playtest.js";
import type { PlayableChatState } from "./playable-chat.js";
import { buildCodebase, createFlowNode, nodeIdForIssuePath, nodeSourcePaths, toFlowEdge, toFlowNode, uniqueNodeId, type GraphMeta, type PlayableFlowData, type PlayableFlowNode } from "./playable-flow.js";
import { PLAYABLE_NODE_TYPES, PlayableCanvasContext } from "./playable-node-card.js";
import { PlayableAddControl, PlayableCanvasContextMenu } from "./playable-canvas-menus.js";
import { useDesktopSave } from "./desktop-close-guard.js";
import type { PanelNodes } from "./panel-layout.js";
import { useCanvasDocuments } from "./use-canvas-documents.js";
import { t } from "./i18n.js";

const DEFAULT_CANVAS_VIEWPORT = { x: 64, y: 32, zoom: 1 };
const CanvasWorkspace = lazy(() => import("./canvas-workspace.js").then((module) => ({ default: module.CanvasWorkspace })));
const DesignDocumentPanel = lazy(() => import("./design-document-panel.js").then((module) => ({ default: module.DesignDocumentPanel })));

/** The story editor's views, each a panel of its own. */
export type StoryView = "story" | "design" | "canvas" | "code" | "assets";

export interface StoryPanels {
  /** Where each view renders: its panel's body and its controls in the tab strip. */
  nodes: Record<StoryView, PanelNodes>;
  /** The views the person can see now. */
  visible: ReadonlySet<StoryView>;
  /** Brings a view forward, opening its panel if it was closed. */
  onShow: (view: StoryView) => void;
}

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
 * The editor for a Playable Nodes project: one canvas of Nodes, one edge per
 * Signal.
 * It speaks the editor's words (Scene, Exit, Variables); code and
 * graph.json keep the engine's (Node, Signal, State).
 */
export function PlayableEditorWorkspace({ project, publishing, workspaceRevision = 0, openFileRequest, showStoryMap = false, onStoryMapShown, onPublish, publishDialog, onClosePublish, onChatContextChange, onAskAgent, onSendToAgent, onDesignSaveReady, onDesignContextChange, onProjectUpdated, referencedDocument, onReferenceDocument, onQuoteDocument, panels }: {
  project: ProjectState;
  onProjectUpdated?: (project: ProjectState) => void;
  agentBusy: boolean;
  publishing: boolean;
  workspaceRevision?: number;
  openFileRequest?: { path: string; id: number };
  /** A Playtest navigation request to show the Story map. */
  showStoryMap?: boolean;
  onStoryMapShown?: () => void;
  onPublish: (details: PublishDetails) => Promise<boolean>;
  publishDialog?: "open" | "success";
  onClosePublish: () => void;
  /** Receives what the open Workbench adds to the next chat message. */
  onChatContextChange?: (state: PlayableChatState | undefined) => void;
  /** Puts a request in the chat prompt. */
  onAskAgent?: (text: string) => void;
  onDesignSaveReady?: (save: (() => Promise<void>) | undefined) => void;
  onDesignContextChange?: (context: PromptContext | undefined) => void;
  /** Sends a request to the AI now, with the open Node as context. */
  onSendToAgent?: (text: string, contexts: PromptContext[]) => Promise<boolean>;
  /** The design document the next message references, by its workspace path. */
  referencedDocument?: string;
  /** References a design document in the next message, or stops referencing it. */
  onReferenceDocument?: (document: { id: string; title: string } | undefined) => void;
  /** Quotes text picked in the design document into the next message. */
  onQuoteDocument?: (text: string) => void;
  /**
   * The panels the views render into. Without them (in tests), the story
   * renders in place.
   */
  panels?: StoryPanels;
}) {
  const projectId = project.id;
  const visible = panels?.visible ?? new Set<StoryView>(["story"]);
  const shows = (view: StoryView) => visible.has(view);
  const onShow = useRef(panels?.onShow);
  onShow.current = panels?.onShow;
  const show = (view: StoryView) => onShow.current?.(view);
  // A view's body mounts the first time it shows and then stays, so a hidden
  // panel keeps its place (the story map, the design canvas, the open file).
  const opened = useRef(new Set<StoryView>());
  for (const view of visible) opened.current.add(view);
  // Code and Assets stay mounted while hidden, but the canvas and the design
  // document write files too, so each reloads when it shows again.
  const [reloads, setReloads] = useState({ code: 0, assets: 0 });
  const hiddenViews = useRef(new Set<"code" | "assets">());
  useEffect(() => {
    for (const view of ["code", "assets"] as const) {
      if (!shows(view)) { if (opened.current.has(view)) hiddenViews.current.add(view); }
      else if (hiddenViews.current.delete(view)) setReloads((current) => ({ ...current, [view]: current[view] + 1 }));
    }
  }, [shows("code"), shows("assets")]);
  const [designHeaderActions, setDesignHeaderActions] = useState<HTMLDivElement | null>(null);
  const [documentToolbar, setDocumentToolbar] = useState<HTMLDivElement | null>(null);
  // The design document and the canvas show the same documents, so they share
  // them. Loading creates the project's canvas, so it waits for either to open.
  const documentsOpened = opened.current.has("design") || opened.current.has("canvas");
  const documents = useCanvasDocuments(projectId, documentsOpened);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  // Saving the design saves the canvas, which saves the documents too, or the
  // documents alone while the canvas hasn't opened.
  const canvasSave = useRef<(() => Promise<void>) | undefined>(undefined);
  const registerCanvasSave = useCallback((save: (() => Promise<void>) | undefined) => { canvasSave.current = save; }, []);
  const saveDesign = useCallback(() => canvasSave.current ? canvasSave.current() : documentsRef.current.flush(), []);
  useEffect(() => {
    if (!documentsOpened) return;
    onDesignSaveReady?.(saveDesign);
    return () => onDesignSaveReady?.(undefined);
  }, [documentsOpened, onDesignSaveReady, saveDesign]);
  const [writeVersion] = useState(() => workspaceVersion(projectId));
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [upgrade, setUpgrade] = useState<StoryUpgradeStatus>();
  /** Why upgrading a story from before web stories failed, until it is tried again. */
  const [upgradeError, setUpgradeError] = useState<string>();
  /** The project the editor already upgraded, so a reload does not start it twice. */
  const upgrading = useRef<string | undefined>(undefined);
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
  // The panels decide what shows now; the view a story saved is kept as it was.
  const [savedView, setSavedView] = useState<"canvas" | "code">("canvas");
  const [codeRevision, setCodeRevision] = useState(0);
  const [fileRequest, setFileRequest] = useState(openFileRequest);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [openedNodeId, setOpenedNodeId] = useState<string>();
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState>();
  const [copiedNode, setCopiedNode] = useState<CopiedPlayableNode>();
  const [presets, setPresets] = useState<PlayablePresetSummary[]>([]);
  const [issues, setIssues] = useState<PlayableProjectValidationIssue[]>([]);
  const [builtDefinitionState, setBuiltDefinitionState] = useState<{
    projectId: string;
    workspaceRevision: number;
    codeRevision: number;
    definition: NodePlayerDefinition;
  }>();
  const builtDefinition = builtDefinitionState?.projectId === projectId
    && builtDefinitionState.workspaceRevision === workspaceRevision
    && builtDefinitionState.codeRevision === codeRevision
    ? builtDefinitionState.definition : undefined;
  const [thumbnails, setThumbnails] = useState<PlayableThumbnailManifest>();
  // Failed captures by Node, with the hash they ran. That version is not
  // captured again until the Node changes or the project is opened again.
  const [thumbnailFailures, setThumbnailFailures] = useState<Record<string, { hash: string; error: string }>>({});
  const thumbnailFailuresRef = useRef(thumbnailFailures);
  thumbnailFailuresRef.current = thumbnailFailures;
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [playtesting, setPlaytesting] = useState(false);
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
  const openedNode = shows("story") && phase === "ready"
    ? nodes.find((node) => node.id === openedNodeId)?.data.node
    : undefined;

  // A Playtest window asks the editor to open the Node it is showing.
  useEffect(() => window.ohMyGameDesktop?.onOpenPlayableNode?.((targetProjectId, nodeId) => {
    if (targetProjectId !== projectId) return;
    show("story");
    openNode(nodeId);
  }), [projectId]);

  // A Playtest window asks for the Story map: close the open Scene and bring the story forward.
  useEffect(() => {
    if (!showStoryMap) return;
    setOpenedNodeId(undefined);
    show("story");
    onStoryMapShown?.();
  }, [showStoryMap]);

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

  // A story from before web stories only plays once it is upgraded, so the
  // editor upgrades it as soon as it has it open.
  useEffect(() => {
    let disposed = false;
    void getStoryUpgrade(projectId).then((status) => { if (!disposed) setUpgrade(status); }).catch(() => {});
    return () => { disposed = true; };
  }, [projectId, workspaceRevision]);

  // The earliest stories' graph.json cannot even be read before the upgrade
  // fixes it, so a canvas that failed to load upgrades too.
  useEffect(() => {
    if (phase === "loading" || !upgrade || upgrade.web || upgrading.current === projectId) return;
    upgrading.current = projectId;
    void runUpgrade();
  }, [phase, upgrade, projectId]);

  async function runUpgrade(): Promise<void> {
    setUpgradeError(undefined);
    try {
      // Unsaved edits go first; the upgrade then reloads every editor.
      if (codebase) await save(codebase);
      await upgradeStory(projectId);
      setUpgrade(await getStoryUpgrade(projectId));
    } catch (cause) {
      setUpgradeError(errorMessage(cause));
    }
  }

  async function copyLibraryMedia(): Promise<void> {
    if (codebase) await save(codebase);
    await copyStoryLibraryMedia(projectId);
    setUpgrade(await getStoryUpgrade(projectId));
  }

  useEffect(() => {
    if (phase !== "ready") return;
    let disposed = false;
    void getPlayableValidation(projectId).then((result) => {
      if (disposed) return;
      setIssues(result.issues);
      setBuiltDefinitionState(result.definition
        ? { projectId, workspaceRevision, codeRevision, definition: result.definition }
        : undefined);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [phase, projectId, codeRevision, workspaceRevision]);

  useEffect(() => {
    setThumbnails(undefined);
    setThumbnailFailures({});
  }, [projectId]);

  // Submit every missing thumbnail; the desktop limits hidden windows, while
  // this effect owns the batch and publishes each completed capture. A new
  // build reads the cache again, including Nodes cancelled before they ran.
  useEffect(() => {
    const capture = window.ohMyGameDesktop?.captureNodeThumbnail;
    const batchId = crypto.randomUUID();
    const version = workspaceVersion(projectId);
    let disposed = false;
    let capturing = false;
    void (async () => {
      const manifest = await listPlayableThumbnails(projectId);
      if (disposed) return;
      setThumbnails(manifest);
      if (!capture || !builtDefinition) return;
      const pending = builtDefinition.graph.nodes.flatMap((node) => {
        const hash = playableThumbnailHash(builtDefinition, node.id);
        return hash && manifest[node.id]?.hash !== hash && thumbnailFailuresRef.current[node.id]?.hash !== hash
          ? [{ nodeId: node.id, hash }]
          : [];
      });
      if (!pending.length) return;
      capturing = true;
      if (window.ohMyGameDesktop?.prepareNodeThumbnails) {
        const status = await getStoryUpgrade(projectId);
        if (disposed) return;
        await window.ohMyGameDesktop.prepareNodeThumbnails(projectId, batchId, {
          definition: builtDefinition,
          version,
          ...(status.web ? { web: true } : {}),
        });
        if (disposed) {
          await window.ohMyGameDesktop.cancelNodeThumbnails?.(batchId);
          return;
        }
      }
      await Promise.all(pending.map(async ({ nodeId, hash }) => {
        const result = await capture(projectId, nodeId, builtDefinition.graph.viewport, batchId)
          .catch((cause: unknown) => ({ captured: false as const, error: errorMessage(cause) }));
        if (disposed) return;
        if (!result.captured) {
          const { error } = result;
          setThumbnailFailures((failures) => ({ ...failures, [nodeId]: { hash, error } }));
          return;
        }
        const updated = await listPlayableThumbnails(projectId);
        if (disposed || updated[nodeId]?.hash !== hash) return;
        setThumbnails((cached) => ({ ...cached, [nodeId]: updated[nodeId]! }));
      }));
    })().catch(() => {});
    return () => {
      disposed = true;
      if (capturing) void window.ohMyGameDesktop?.cancelNodeThumbnails?.(batchId).catch(() => {});
    };
  }, [projectId, builtDefinition]);

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
          // A trim is tied to the exact background the dialog opened. Never
          // rebase it onto a graph or source changed by another writer.
          if (outgoing.sourcePreconditions) throw new Error(t("sceneWorkbench.trim.changed"));
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
    if (!shows("story") || projectSettingsOpen) return;
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
  }, [codebase, shows("story"), projectSettingsOpen]);

  // A navigation Exit has no line for the canvas to delete, so a connection
  // selected from its Exit row is deleted here, as a drawn one is.
  const selectedNavigation = Boolean(selectedEdgeId && edges.some((edge) => edge.id === selectedEdgeId
    && nodes.find((node) => node.id === edge.source)?.data.node.signals.some((signal) => signal.id === edge.sourceHandle && signal.role === "navigation")));
  useEffect(() => {
    if (!selectedNavigation || openedNodeId || projectSettingsOpen || !shows("story")) return;
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
  }, [selectedNavigation, selectedEdgeId, openedNodeId, projectSettingsOpen, shows("story")]);

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
    const viewport = opened.current.has("story") ? canvas.current?.getViewport() : undefined;
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
  async function writeSources(graph: NodeGraph, sources: Record<string, string>, before: Record<string, string>, sourcePreconditions?: Record<string, string>): Promise<HistoryEntry | undefined> {
    if (!codebase) return undefined;
    commitPendingHistory();
    // The base stops the graph change from being recorded as a separate step.
    const base = structuredClone(codebase);
    historyGestureBase.current = base;
    const generation = diskGeneration.current;
    try {
      applyGraph(graph);
      await save({ graph, editorLayout: codebase.editorLayout, sources, ...(sourcePreconditions ? { sourcePreconditions } : {}) });
    } finally {
      if (historyGestureBase.current === base) historyGestureBase.current = undefined;
    }
    // The save loaded the Agent's changes; undoing to `base` would take them back.
    if (generation !== diskGeneration.current) return undefined;
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
    if (!graph || !location || !node) return false;
    // Text a Scene shows from a file of its own, such as a Visual Novel script line, changes in that file.
    const lineText = location.file !== node.source.html
      && location.file.startsWith(`${node.source.html.slice(0, node.source.html.lastIndexOf("/") + 1)}`)
      && location.file.endsWith(".txt");
    if (location.file !== node.source.html && !lineText) return false;
    const file = await getWorkspaceFile(projectId, location.file);
    const before = file.truncated ? undefined : file.content;
    const html = before === undefined ? undefined : lineText
      ? replacePlayableLineText(before, location, edit.before, edit.after)
      : replacePlayableElementText(before, location, edit.before, edit.after);
    if (before === undefined || html === undefined) return false;
    const signal = node.signals.find((candidate) => candidate.id === edit.pick.signal);
    const next = signal && signal.label.trim() === edit.before.trim()
      ? setPlayableSignalLabel(graph, node.id, signal.id, edit.after.trim())
      : graph;
    await writeSources(next, { [location.file]: html }, { [location.file]: before });
    return true;
  }

  /**
   * Writes a move from the preview back to the `style` of the element in the
   * surface HTML that holds it. False when it cannot be done in place.
   */
  async function writeMove(move: PlayableMove): Promise<boolean> {
    const graph = codebase?.graph;
    const location = move.pick.source ? parsePlayableSourceLocation(move.pick.source) : undefined;
    const node = graph?.nodes.find((candidate) => candidate.id === move.pick.nodeId);
    if (!graph || !location || !node || node.source.html !== location.file) return false;
    const file = await getWorkspaceFile(projectId, location.file);
    const before = file.truncated ? undefined : file.content;
    const html = before === undefined ? undefined : setPlayableElementTranslate(before, location, move.pick.tag, move.translate);
    if (before === undefined || html === undefined) return false;
    if (html !== before) await writeSources(graph, { [location.file]: html }, { [location.file]: before });
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

  async function writeVideoClip(nodeId: string, expected: PlayableBackdropDetails, source: string, clip?: PlayableVideoClip): Promise<void> {
    const graph = codebase?.graph;
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!graph || !node || JSON.stringify(graph.assets[expected.assetId]) !== source) throw new Error(t("sceneWorkbench.trim.changed"));
    const path = node.source.html;
    const file = await getWorkspaceFile(projectId, path);
    if (file.content === undefined || file.truncated) throw new Error(t("sceneWorkbench.trim.changed"));
    const before = file.content;
    const html = setPlayableBackdropClip(before, expected, clip);
    if (html === undefined) throw new Error(t("sceneWorkbench.trim.changed"));
    if (html !== before) await writeSources(graph, { [path]: html }, { [path]: before }, { [path]: before });
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

  /** Saves the project, sends any requested action, and opens or focuses Playtest. */
  async function startPlaytest(request?: PlaytestRequest): Promise<void> {
    if (!codebase || playtesting) return;
    // A story with no Scenes has nothing to play, so the editor says so instead of opening Playtest.
    if (!codebase.graph.nodes.length) {
      setNotice(t("storyEditor.playtestNeedsScene"));
      return;
    }
    setPlaytesting(true);
    if (request?.action !== "start") clearSelection();
    const desktop = window.ohMyGameDesktop;
    let playtest: Window | null = null;
    let openedBlankWindow = false;
    try {
      if (!desktop) {
        // Open during the click's user activation, before waiting for a save.
        playtest = window.open("", "ohmygame-playtest");
        if (!playtest) throw new Error(t("playtest.popupBlocked"));
        openedBlankWindow = playtest.location.href === "about:blank";
      }
      await save(codebase);
      if (playtest?.closed) return;
      requestPlaytest(projectId, request ?? { action: "open" });
      if (desktop) {
        await desktop.openPlaytest(projectId, codebase.graph.viewport);
      } else if (playtest) {
        const url = new URL(playtestHash(projectId), window.location.href).href;
        // Focusing an open Playtest must not reload it and lose a chosen start.
        if (playtest.location.href !== url) playtest.location.href = url;
        playtest.focus();
      }
    } catch (cause) {
      if (openedBlankWindow) playtest?.close();
      setNotice(errorMessage(cause));
    } finally {
      setPlaytesting(false);
    }
  }

  async function publishGame(details: PublishDetails): Promise<boolean> {
    if (!codebase) throw new Error(t("storyEditor.stillLoading"));
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
      if (issue.phase === "source") failed.add(owner);
    }
    return nodes.map((node): PlayableFlowNode => {
      const cached = thumbnails?.[node.id];
      // Without a successful build the current hash is unknown, so a cached
      // thumbnail is not called stale; a failing Node is dimmed instead.
      const hash = builtDefinition ? playableThumbnailHash(builtDefinition, node.id) : undefined;
      const thumbnailError = hash && thumbnailFailures[node.id]?.hash === hash ? thumbnailFailures[node.id]!.error : undefined;
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
          ...(cached ? { thumbnail: { capturedAt: cached.capturedAt, stale: Boolean(hash && hash !== cached.hash) } } : {}),
          ...(thumbnailError ? { thumbnailError } : {}),
          ...(coverAssetId ? { coverAsset: graphMeta!.assets[coverAssetId] } : {}),
        },
      };
    });
  }, [nodes, edges, selectedEdgeId, issues, graphMeta, codebase, thumbnails, thumbnailFailures, builtDefinition]);
  const canvasPlayer = useMemo(() => ({ projectId, onRenameNode: renameNode, onSelectEdge: selectEdge, onOpenNode: openNode }), [projectId]);
  const projectIssues = issues.filter((issue) => !issue.surfaceId && !nodeIdForIssuePath(issue.path, nodes));
  const views: Record<StoryView, { toolbar?: ReactNode; body: ReactNode }> = {
    story: {
      toolbar: <>
        <button className="icon-button pane-header-action" type="button" title={t("projectSettings.title")} aria-label={t("projectSettings.title")} aria-haspopup="dialog" disabled={phase !== "ready"} onClick={() => setProjectSettingsOpen(true)}>
          <Settings size={14} />
        </button>
        <PlaytestControls disabled={phase !== "ready"} busy={playtesting} onOpen={() => void startPlaytest()} onAction={(action) => void startPlaytest({ action })} />
      </>,
      body: <>
        <div className="interactive-story-body">
          <div className="interactive-story-canvas">
            {phase === "loading" ? <div className="story-canvas-state">{t("storyEditor.loadingScenes")}</div> : null}
            {phase === "error" ? <div className="story-canvas-state story-canvas-state-error">{notice}</div> : null}
            {phase !== "loading" && upgrade && !upgrade.web && upgradeError !== undefined ? <CanvasNotice
              className="story-upgrade-notice"
              tone="warning"
              message={t("storyEditor.upgradeFailed", { error: upgradeError })}
              detail={t("storyEditor.upgradeDetail")}
              actionLabel={t("storyEditor.upgrade")}
              onAction={runUpgrade}
            /> : null}
            {phase === "ready" && upgrade?.web && upgrade.libraryAssets?.length ? <CanvasNotice
              className="story-upgrade-notice"
              tone="warning"
              message={t("storyEditor.libraryMedia", { assets: upgrade.libraryAssets.join(", ") })}
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
                  deleteKeyCode={openedNode || projectSettingsOpen || !shows("story") ? null : ["Backspace", "Delete"]}
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
          onWriteMove={writeMove}
          onWriteVideoClip={(expected, source, clip) => writeVideoClip(openedNode.id, expected, source, clip)}
          onAddAsset={async (asset) => {
            const { graph, assetId } = addPlayableNodeAsset(codebase.graph, openedNode.id, asset);
            await writeGraph(graph);
            return assetId;
          }}
          onSetBackdrop={(asset) => writeBackdrop(openedNode.id, asset)}
          onRemoveBackdrop={() => removeBackdrop(openedNode.id)}
          {...(backdrop ? { backdrop } : {})}
          onPlayFromHere={(start) => void startPlaytest({ action: "start", start })}
          onPlaytestAction={(action) => void startPlaytest({ action })}
          playtestBusy={playtesting}
          onChatContextChange={onChatContextChange}
        /> : null}
        {openedNode && notice ? <div className="story-save-notice is-over-workbench" role="alert">{notice}</div> : null}
      </>,
    },
    design: {
      toolbar: <div className="viewer-publish design-doc-toolbar" ref={setDocumentToolbar} />,
      body: <Suspense fallback={<div className="design-loading"><LoaderCircle className="spin" size={18} /></div>}><DesignDocumentPanel
        project={project} documents={documents} toolbarTarget={documentToolbar} referenced={referencedDocument}
        onReference={(document) => onReferenceDocument?.(document)} onQuote={(text) => onQuoteDocument?.(text)} onAskAgent={onAskAgent}
      /></Suspense>,
    },
    canvas: {
      toolbar: <div className="viewer-publish design-header-actions" ref={setDesignHeaderActions} />,
      body: <Suspense fallback={<div className="design-loading"><LoaderCircle className="spin" size={18} /></div>}><CanvasWorkspace
        project={project} documents={documents} onProjectUpdated={onProjectUpdated} headerActionsTarget={designHeaderActions} onSaveReady={registerCanvasSave} onContextChange={onDesignContextChange}
      /></Suspense>,
    },
    code: {
      body: <main className="story-code-view" aria-label={t("storyEditor.code")}>
        <WorkspaceCodeView projectId={projectId} revision={workspaceRevision + codeRevision + reloads.code} openFileRequest={fileRequest} />
      </main>,
    },
    assets: {
      body: <main className="story-assets-view" aria-label={t("workspace.tab.assets")}>
        <WorkspaceAssetsView
          projectId={projectId}
          revision={workspaceRevision + codeRevision + reloads.assets}
          onShowInCode={(path) => {
            setFileRequest({ path, id: Date.now() });
            show("code");
          }}
        />
      </main>,
    },
  };

  // Each view keeps the editor's classes and sizes, so its styles hold inside any panel.
  const viewPane = (view: StoryView, body: ReactNode, header?: ReactNode) => (
    <section
      ref={view === "story" ? storyPane : undefined}
      className={`viewer-pane interactive-story-workspace playable-editor-workspace${view === "story" && openedNode ? " is-node-editor-open" : ""}`}
      data-active-tab={view}
      aria-label={t("storyEditor.workspace")}
      style={{
        "--story-viewport-ratio": `${playerViewport.width} / ${playerViewport.height}`,
        "--story-viewport-aspect": playerViewportAspect,
        "--story-canvas-stage-width": `${canvasStage.width}px`,
        "--story-canvas-stage-height": `${canvasStage.height}px`,
        "--story-card-title-height": `${PLAYABLE_CARD_TITLE_HEIGHT}px`,
      } as CSSProperties}
    >
      {header}
      {body}
    </section>
  );
  const placed = (Object.keys(views) as StoryView[]).map((view) => {
    const content = views[view];
    if (!panels) {
      // In place: only what shows, with its controls in a header.
      return shows(view) ? <Fragment key={view}>{viewPane(view, content.body, content.toolbar ? <header className="pane-header viewer-header interactive-story-header"><div className="viewer-publish">{content.toolbar}</div></header> : null)}</Fragment> : null;
    }
    if (!opened.current.has(view)) return null;
    const nodes = panels.nodes[view];
    return <Fragment key={view}>
      {content.toolbar ? createPortal(<div className="viewer-publish">{content.toolbar}</div>, nodes.toolbar) : null}
      {createPortal(viewPane(view, content.body), nodes.body)}
    </Fragment>;
  });

  return (
    <>
      {placed}
      {projectSettingsOpen && codebase ? <PlayableProjectSettingsDialog
        project={project}
        graph={codebase.graph}
        onSave={async (viewport) => {
          const graph = { ...codebase.graph, viewport };
          await save({ graph, editorLayout: codebase.editorLayout });
          applyGraph(graph);
        }}
        onClose={() => setProjectSettingsOpen(false)}
      /> : null}
      {publishDialog ? <PublishDialog project={project} publishing={publishing} justPublished={publishDialog === "success"} onClose={onClosePublish} onPublish={publishGame} /> : null}
    </>
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
