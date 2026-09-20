import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clapperboard,
  Clipboard,
  Code2,
  Copy,
  Download,
  FileText,
  Flag,
  Film,
  Folder,
  Image as ImageIcon,
  GitBranch,
  GripVertical,
  Hand,
  LoaderCircle,
  Layers3,
  Maximize,
  Minus,
  Monitor,
  Music2,
  MousePointer2,
  Pause,
  PanelToggle,
  Play,
  Plus,
  Search,
  Share2,
  Trash2,
  Upload,
  Undo2,
  Redo2,
  UserRound,
  Volume2,
  VolumeX,
  Wrench,
  X,
  type IconComponent,
} from "./icons.js";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type ReactNode, type SyntheticEvent } from "react";
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
import { findCanvasAlignmentGuides, STORY_CANVAS_GRID_SIZE, type CanvasAlignmentGuides, type CanvasAlignmentNode } from "./story-canvas-alignment.js";
import { duplicateStoryNode, snapStoryCanvasPosition } from "./story-canvas-clipboard.js";
import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODEL,
  VIDEO_RESOLUTIONS,
  type ImageAspectRatio,
  type AgentModel,
  type AgentModelRef,
  type CreateLibraryImageRequest,
  type ImageModel,
  type ImageModelRef,
  type ImageResolution,
  type LibraryUploadMediaType,
  type PromptImage,
  type ProjectState,
  type RunImageToolRequest,
  type RunVideoToolRequest,
  type StoryAction,
  type StoryChoiceTimeout,
  type StoryChoiceOption,
  type StoryDocument,
  type StoryEditorLayout,
  type StoryInteractionBehavior,
  type StorySurfaceFiles,
  type StoryAssetReference,
  type StoryNode,
  type StoryNodePresentation,
  type StoryNodeType,
  type StoryPlayerConfig,
  type StoryOpenUiAction,
  type StoryOpenUiContent,
  type StoryInteractionOutcome,
  type StorySceneMedia,
  type StorySceneSurface,
  type StoryTextReference,
  type StoryVariable,
  type StoryVariableCondition,
  type StoryVariableType,
  type StoryVariableValue,
  type VideoAspectRatio,
  type VideoGenerationReference,
  type VideoResolution,
} from "../shared/contracts.js";
import { combineStoryPrompt, DEFAULT_CHOICE_SURFACE_FILES, DEFAULT_ENDING_SURFACE_FILES, DEFAULT_OPEN_UI_CODE, DEFAULT_OPEN_UI_CONTENT, DEFAULT_SCENE_SURFACE_FILES, DEFAULT_STORY_PLAYER_CONFIG, defaultStoryNodeSource, isStoryDocument, matchesStoryCondition, normalizeStoryVariableReferences, openUiRuntimeContent, openUiSurfaceFiles, replaceOutgoingEdge, resolveStoryAssetId, resolveStoryImageAssetId, storyInteractionNodeOutcomes, storyNodePresentation, validatePlayableChapter, type StoryPlayIssue } from "../shared/story.js";
import { buildInteractiveDrama, createLibraryImage, generateStoryText, getLibraryAsset, getStory, listImageModels, runTool, updateStory, uploadLibraryAsset } from "./api.js";
import { loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { useAgentModels, type AgentModelCatalogStatus } from "./model-selector.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { playtestHash } from "./routes.js";
import { prepareVideoReferenceFile, readMediaFileDuration, validateVideoReferenceCounts, validateVideoReferenceDurations, validVideoReferenceCombination, VIDEO_REFERENCE_ACCEPT, VIDEO_REFERENCE_LIMITS } from "./video-reference-files.js";
import { PublishDialog, type PublishDetails } from "./publish-dialog.js";
import { createStoryInteractionFiles } from "../shared/story-interaction-code.js";
import { StoryInteractionSurface } from "./story-interaction-surface.js";
import { StoryScreenSurface } from "./story-screen-surface.js";
import { StorySceneSurface as SceneCodeSurface, type StoryNodeSurfaceAction } from "./story-scene-surface.js";
import { WorkspaceCodeView } from "./coding-workspace.js";
import { HighlightedCode } from "./highlighted-code.js";
import { storyViewportRatio } from "../shared/story-formats.js";
import { StoryCanvasSettingsDialog } from "./story-canvas-settings-dialog.js";
import "@xyflow/react/dist/style.css";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const STORY_EDGE_COLOR = "var(--story-edge-color)";
const STORY_EDGE_WIDTH = 1.5;
const STORY_EDGE_OPTIONS = {
  style: { stroke: STORY_EDGE_COLOR, strokeWidth: STORY_EDGE_WIDTH },
  markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: STORY_EDGE_COLOR },
};
const ASSET_EDGE_PREFIX = "asset:";
const OUTPUT_HANDLE = "out";
const STORY_CANVAS_SNAP_GRID: [number, number] = [STORY_CANVAS_GRID_SIZE, STORY_CANVAS_GRID_SIZE];
const STORY_ASSET_ACCEPT = "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,.mov,.mp3,.wav";
const MEDIA_NODE_MAX_WIDTH = 440;
const MEDIA_NODE_MIN_WIDTH = 300;
const MEDIA_NODE_MAX_HEIGHT = 360;
const MEDIA_NODE_MIN_HEIGHT = 200;
const IMAGE_REFERENCE_LIMIT = 14;
type InteractionMode = "pointer" | "pan";
type StoryWorkspaceView = "canvas" | "code";
type InteractionTemplate = "blank" | StoryInteractionBehavior["type"];
type CanvasNodeCreationAction =
  | { kind: "node"; type: Exclude<StoryNodeType, "asset"> }
  | { kind: "interaction"; template: InteractionTemplate };
interface CanvasNodeCreationLeaf {
  label: string;
  description: string;
  icon: IconComponent;
  action: CanvasNodeCreationAction;
}
interface CanvasNodeCreationBranch {
  label: string;
  description: string;
  icon: IconComponent;
  children: CanvasNodeCreationLeaf[];
}
type CanvasNodeCreationItem = CanvasNodeCreationLeaf | CanvasNodeCreationBranch;
interface CanvasNodeCreationGroup {
  label: string;
  items: CanvasNodeCreationItem[];
}
type CanvasContextMenuState = {
  kind: "pane" | "node";
  screenPosition: { x: number; y: number };
  flowPosition: { x: number; y: number };
  nodeId?: string;
};

const CANVAS_NODE_CREATION_GROUPS: CanvasNodeCreationGroup[] = [
  {
    label: "Story Flow",
    items: [
      { label: "Start", description: "Set the story entry point", icon: Flag, action: { kind: "node", type: "start" } },
      { label: "Open UI", description: "Add a coded player interface", icon: PanelToggle, action: { kind: "node", type: "open-ui" } },
      { label: "Scene", description: "Ordered image or video media", icon: Clapperboard, action: { kind: "node", type: "scene" } },
      { label: "Interaction", description: "Wait for player input", icon: MousePointer2, children: [
        { label: "Continue", description: "Wait for the player to continue", icon: Play, action: { kind: "interaction", template: "continue" } },
        { label: "QTE", description: "Timed button or keyboard input", icon: Code2, action: { kind: "interaction", template: "qte" } },
        { label: "Hotspot", description: "Timed clickable area", icon: MousePointer2, action: { kind: "interaction", template: "hotspot" } },
        { label: "Custom", description: "Start from HTML, CSS, and JavaScript", icon: Code2, action: { kind: "interaction", template: "blank" } },
      ] },
      { label: "Choice", description: "Branch into player options", icon: GitBranch, action: { kind: "node", type: "choice" } },
      { label: "Project State", description: "Apply state changes in the flow", icon: Wrench, action: { kind: "node", type: "project-state" } },
      { label: "Ending", description: "Finish this story path", icon: CircleStop, action: { kind: "node", type: "ending" } },
    ],
  },
  {
    label: "Assets",
    items: [
      { label: "Text", description: "Write a reusable prompt", icon: FileText, action: { kind: "node", type: "text" } },
      { label: "Image", description: "Generate an image on canvas", icon: ImageIcon, action: { kind: "node", type: "image" } },
      { label: "Video", description: "Generate a video on canvas", icon: Film, action: { kind: "node", type: "video" } },
    ],
  },
];

function isCanvasNodeCreationLeaf(item: CanvasNodeCreationItem): item is CanvasNodeCreationLeaf {
  return "action" in item;
}

interface SceneCanvasPreviewData {
  assetId?: string;
  totalDurationMs: number;
  segments: Array<{ assetId?: string; durationMs: number }>;
}

interface InheritedScenePreviewData {
  assetId?: string;
  mediaType?: "image" | "video";
}

type StoryFlowData = {
  title?: string;
  description?: string;
  prompt?: string;
  promptSource?: StoryTextReference;
  text?: string;
  instruction?: string;
  textModel?: AgentModelRef;
  model?: ImageModelRef;
  resolution?: ImageResolution;
  aspectRatio?: ImageAspectRatio;
  videoModel?: typeof VIDEO_MODEL;
  videoResolution?: VideoResolution;
  videoAspectRatio?: VideoAspectRatio;
  duration?: number;
  images?: StoryAssetReference[];
  references?: StoryAssetReference[];
  assetId?: string;
  mediaType?: "image" | "video" | "audio";
  contentType?: string;
  assetDuration?: number;
  name?: string;
  options?: StoryChoiceOption[];
  timeout?: StoryChoiceTimeout;
  presentation?: StoryNodePresentation;
  behavior?: StoryInteractionBehavior;
  actions?: StoryAction[];
  content?: StoryOpenUiContent;
  scenePreview?: SceneCanvasPreviewData;
  inheritedScenePreview?: InheritedScenePreviewData;
  playerConfig?: StoryPlayerConfig;
  openUiPreview?: { assetId?: string; mediaType?: "image" | "video"; durationMs: number };
  variables?: StoryVariable[];
  previewValues?: Record<string, StoryVariableValue>;
  imageRuntime?: ImageNodeRuntime;
  videoRuntime?: VideoNodeRuntime;
  textRuntime?: TextNodeRuntime;
};
type StoryFlowNode = Node<StoryFlowData, StoryNodeType>;
type StoryCanvasNode = StoryFlowNode;

interface MediaNodeRuntime {
  generating: boolean;
  busy: boolean;
  error?: string;
  onChange: (data: StoryFlowData) => void;
  onGenerate: () => void;
  linkedPrompt?: string;
  onDisconnectPrompt: () => void;
}

interface TextNodeRuntime {
  models: AgentModel[];
  modelStatus: AgentModelCatalogStatus;
  defaultModel?: AgentModelRef;
  generating: boolean;
  busy: boolean;
  error?: string;
  onChange: (data: StoryFlowData) => void;
  onGenerate: () => void;
}

interface ReferenceMediaNodeRuntime extends MediaNodeRuntime {
  references: MediaReferenceView[];
  maxReferences: number;
  uploading: boolean;
  accept: string;
  addLabel: string;
  onRemoveReference: (index: number) => void;
  onUploadReferences: (files: File[]) => void;
}

interface ImageNodeRuntime extends ReferenceMediaNodeRuntime {
  models: ImageModel[];
}

type VideoNodeRuntime = ReferenceMediaNodeRuntime;

interface MediaReferenceView {
  assetId?: string;
  key: string;
  linked: boolean;
  name: string;
  label: string;
  type: VideoGenerationReference["type"];
  duration?: number;
}

const STORY_NODE_TYPES: NodeTypes = {
  "open-ui": OpenUiNode,
  start: StartNode,
  "project-state": ProjectStateNode,
  scene: SceneNode,
  interaction: InteractionNode,
  choice: ChoiceNode,
  ending: EndingNode,
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
  asset: AssetNode,
};

export function InteractiveDramaWorkspace({ project, agentBusy, publishing, workspaceRevision = 0, onPublish }: {
  project: ProjectState;
  agentBusy: boolean;
  publishing: boolean;
  workspaceRevision?: number;
  onPublish: (details: PublishDetails) => Promise<boolean>;
}) {
  const projectId = project.id;
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string>();
  const [chapter, setChapter] = useState<{ id: string; title: string }>();
  const [variables, setVariables] = useState<StoryVariable[]>([]);
  const [player, setPlayer] = useState<StoryPlayerConfig>(() => structuredClone(DEFAULT_STORY_PLAYER_CONFIG));
  const [nodes, setNodes] = useState<StoryFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [openedNodeId, setOpenedNodeId] = useState<string>();
  const [workspaceView, setWorkspaceView] = useState<StoryWorkspaceView>("canvas");
  const [editorLayout, setEditorLayout] = useState<StoryEditorLayout>({
    version: 1,
    nodes: {},
    viewport: { x: 64, y: 32, zoom: 1 },
    view: "canvas",
  });
  const [codeRevision, setCodeRevision] = useState(0);
  const [selectedAssetEdgeId, setSelectedAssetEdgeId] = useState<string>();
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("pointer");
  const [alignmentGuides, setAlignmentGuides] = useState<CanvasAlignmentGuides>();
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState>();
  const [copiedNode, setCopiedNode] = useState<StoryNode>();
  const [playIssue, setPlayIssue] = useState<StoryPlayIssue>();
  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([]);
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const textModelCatalog = useAgentModels();
  const defaultTextModel = textModelCatalog.defaultModel ?? textModelCatalog.models[0];
  const [generatingNodeId, setGeneratingNodeId] = useState<string>();
  const [generatingTextNodeId, setGeneratingTextNodeId] = useState<string>();
  const [uploadingNodeId, setUploadingNodeId] = useState<string>();
  const [importingAssets, setImportingAssets] = useState(false);
  const [building, setBuilding] = useState(false);
  const [canvasSettingsOpen, setCanvasSettingsOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [generationError, setGenerationError] = useState<{ nodeId: string; message: string }>();
  const canvas = useRef<HTMLDivElement>(null);
  const reactFlow = useRef<ReactFlowInstance<StoryCanvasNode>>(null);
  const latestStory = useRef<StoryDocument | undefined>(undefined);
  const queuedStory = useRef<string | undefined>(undefined);
  const saveChain = useRef(Promise.resolve());
  const nodeClickTimer = useRef<number | undefined>(undefined);
  const editorUndoHistory = useRef<StoryDocument[]>([]);
  const editorRedoHistory = useRef<StoryDocument[]>([]);
  const historyObserved = useRef<StoryDocument | undefined>(undefined);
  const historyObservedJson = useRef<string | undefined>(undefined);
  const historyPendingBase = useRef<StoryDocument | undefined>(undefined);
  const historyTimer = useRef<number | undefined>(undefined);
  const historyGestureBase = useRef<StoryDocument | undefined>(undefined);
  const [, setHistoryRevision] = useState(0);

  useEffect(() => {
    let disposed = false;
    setPhase("loading");
    window.clearTimeout(historyTimer.current);
    editorUndoHistory.current = [];
    editorRedoHistory.current = [];
    historyObserved.current = undefined;
    historyObservedJson.current = undefined;
    historyPendingBase.current = undefined;
    historyGestureBase.current = undefined;
    setCanvasContextMenu(undefined);
    setCopiedNode(undefined);
    void Promise.all([getStory(projectId), loadLibraryAssets(), listImageModels().catch(() => [])]).then(([story, assets, models]) => {
      if (disposed) return;
      const loadedChapter = story.chapter;
      setChapter({ id: loadedChapter.id, title: loadedChapter.title });
      setVariables(story.variables);
      setPlayer(story.player);
      setNodes(loadedChapter.nodes.map((node) => toFlowNode(node, models)));
      const loadedLayout = story.editorLayout ?? { version: 1 as const, nodes: {}, viewport: { x: 64, y: 32, zoom: 1 }, view: "canvas" as const };
      const normalizedLayout = loadedLayout;
      setEditorLayout(normalizedLayout);
      setWorkspaceView(normalizedLayout.view === "code" ? "code" : "canvas");
      setEdges(loadedChapter.edges);
      queuedStory.current = JSON.stringify(story);
      setLibraryAssets(assets);
      setImageModels(models);
      setPhase("ready");
    }).catch((error) => {
      if (disposed) return;
      setNotice(errorMessage(error));
      setPhase("error");
    });
    return () => { disposed = true; };
  }, [projectId, workspaceRevision]);

  const document = useMemo(
    () => chapter ? storyDocument(player, variables, chapter, nodes, edges, {
      ...editorLayout,
      nodes: {
        ...Object.fromEntries(nodes.map((node) => [node.id, node.position])),
      },
      view: workspaceView,
    }) : undefined,
    [chapter, edges, editorLayout, nodes, player, variables, workspaceView],
  );
  latestStory.current = document;

  function updateHistoryControls(): void {
    setHistoryRevision((revision) => revision + 1);
  }

  function pushUndoSnapshot(snapshot: StoryDocument): void {
    editorUndoHistory.current.push(structuredClone(snapshot));
    if (editorUndoHistory.current.length > 50) editorUndoHistory.current.shift();
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

  function observeHistoryDocument(next: StoryDocument): void {
    historyObserved.current = structuredClone(next);
    historyObservedJson.current = JSON.stringify(next);
  }

  function undoEditorChange(): boolean {
    if (!document) return false;
    window.clearTimeout(historyTimer.current);
    historyTimer.current = undefined;
    const pending = historyPendingBase.current;
    const next = pending ?? editorUndoHistory.current.pop();
    if (!next) return false;
    historyPendingBase.current = undefined;
    editorRedoHistory.current.push(structuredClone(document));
    observeHistoryDocument(next);
    applyEditorStory(next);
    updateHistoryControls();
    return true;
  }

  function redoEditorChange(): boolean {
    if (!document || historyPendingBase.current) return false;
    const next = editorRedoHistory.current.pop();
    if (!next) return false;
    pushUndoSnapshot(document);
    observeHistoryDocument(next);
    applyEditorStory(next);
    updateHistoryControls();
    return true;
  }

  function beginHistoryGesture(): void {
    if (!document) return;
    commitPendingHistory();
    historyGestureBase.current = structuredClone(document);
  }

  function finishHistoryGesture(): void {
    window.setTimeout(() => {
      const base = historyGestureBase.current;
      const current = latestStory.current;
      historyGestureBase.current = undefined;
      if (!base || !current || JSON.stringify(base) === JSON.stringify(current)) return;
      pushUndoSnapshot(base);
      editorRedoHistory.current = [];
      observeHistoryDocument(current);
      updateHistoryControls();
    }, 0);
  }

  useEffect(() => {
    if (phase !== "ready" || !document) return;
    const serialized = JSON.stringify(document);
    if (!historyObserved.current || historyObservedJson.current === undefined) {
      observeHistoryDocument(document);
      updateHistoryControls();
      return;
    }
    if (serialized === historyObservedJson.current) return;
    if (historyGestureBase.current) {
      observeHistoryDocument(document);
      return;
    }
    if (!historyPendingBase.current) historyPendingBase.current = structuredClone(historyObserved.current);
    editorRedoHistory.current = [];
    observeHistoryDocument(document);
    window.clearTimeout(historyTimer.current);
    historyTimer.current = window.setTimeout(commitPendingHistory, 450);
    updateHistoryControls();
  }, [document, phase]);

  useEffect(() => () => window.clearTimeout(historyTimer.current), []);

  useEffect(() => {
    if (workspaceView === "code") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const undo = (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "z";
      const redo = (event.metaKey || event.ctrlKey) && ((event.shiftKey && key === "z") || (!event.metaKey && key === "y"));
      if (event.altKey || (!undo && !redo)) return;
      event.preventDefault();
      if (redo) redoEditorChange();
      else undoEditorChange();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [document, workspaceView]);
  const assetEdges = useMemo(() => nodes.flatMap((node): Edge[] => {
    const derived: Edge[] = [];
    if (node.type === "image") derived.push(...(node.data.images ?? []).flatMap((image) => image.type === "node" ? [{
      id: assetEdgeId("image", node.id, image.nodeId),
      source: image.nodeId,
      target: node.id,
      sourceHandle: OUTPUT_HANDLE,
      className: "story-asset-edge",
      selected: selectedAssetEdgeId === assetEdgeId("image", node.id, image.nodeId),
      data: { relation: "media-image", referenceId: image.nodeId },
    }] : []));
    if (node.type === "video") derived.push(...(node.data.references ?? []).flatMap((reference) => reference.type === "node" ? [{
      id: assetEdgeId("reference", node.id, reference.nodeId),
      source: reference.nodeId,
      target: node.id,
      sourceHandle: OUTPUT_HANDLE,
      className: "story-asset-edge",
      selected: selectedAssetEdgeId === assetEdgeId("reference", node.id, reference.nodeId),
      data: { relation: "video-reference", referenceId: reference.nodeId },
    }] : []));
    if ((node.type === "image" || node.type === "video") && node.data.promptSource) derived.push({
      id: assetEdgeId("prompt", node.id, node.data.promptSource.nodeId),
      source: node.data.promptSource.nodeId,
      target: node.id,
      sourceHandle: OUTPUT_HANDLE,
      className: "story-asset-edge",
      selected: selectedAssetEdgeId === assetEdgeId("prompt", node.id, node.data.promptSource.nodeId),
      data: { relation: "media-prompt", referenceId: node.data.promptSource.nodeId },
    });
    if (isVisiblePresentationFlowNode(node)) {
      const media = node.data.presentation?.media;
      if (media?.mode === "own") derived.push(...media.items.flatMap((item) => item.source.type === "node" ? [{
        id: assetEdgeId("presentation", node.id, item.id),
        source: item.source.nodeId,
        target: node.id,
        sourceHandle: OUTPUT_HANDLE,
        className: "story-asset-edge",
        selected: selectedAssetEdgeId === assetEdgeId("presentation", node.id, item.id),
        data: { relation: "presentation-media", referenceId: item.id },
      }] : []));
    }
    return derived;
  }), [nodes, selectedAssetEdgeId]);

  const save = useCallback((story: StoryDocument): Promise<void> => {
    const serialized = JSON.stringify(story);
    if (serialized === queuedStory.current) return saveChain.current;
    queuedStory.current = serialized;
    const operation = saveChain.current
      .catch(() => undefined)
      .then(() => updateStory(projectId, story));
    saveChain.current = operation;
    void operation.then(
      () => { setNotice(undefined); setCodeRevision((value) => value + 1); },
      (error) => {
        if (queuedStory.current === serialized) queuedStory.current = undefined;
        setNotice(`Could not save story: ${errorMessage(error)}`);
      },
    );
    return operation;
  }, [projectId]);

  useEffect(() => {
    if (phase !== "ready" || !document) return;
    const timeout = window.setTimeout(() => { void save(document).catch(() => {}); }, 350);
    return () => window.clearTimeout(timeout);
  }, [document, phase, save]);

  useEffect(() => () => {
    const story = latestStory.current;
    if (story) void save(story).catch(() => {});
  }, [save]);

  const onNodesChange = useCallback((changes: NodeChange<StoryCanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);
  function onEdgesChange(changes: EdgeChange[]): void {
    const assetEdgeIds = new Set(assetEdges.map((edge) => edge.id));
    for (const change of changes) {
      if (change.type === "add") continue;
      if (!assetEdgeIds.has(change.id)) continue;
      if (change.type === "select") setSelectedAssetEdgeId(change.selected ? change.id : undefined);
      if (change.type === "remove") {
        const edge = assetEdges.find((candidate) => candidate.id === change.id);
        const relation = edge?.data?.relation;
        const referenceId = edge?.data?.referenceId;
        if (edge && typeof referenceId === "string") setNodes((current) => current.map((node) => {
          if (relation === "media-image" && node.id === edge.target && node.type === "image") {
            return { ...node, data: { ...node.data, images: (node.data.images ?? []).filter((image) => image.type !== "node" || image.nodeId !== referenceId) } };
          }
          if (relation === "video-reference" && node.id === edge.target && node.type === "video") {
            return { ...node, data: { ...node.data, references: (node.data.references ?? []).filter((reference) => reference.type !== "node" || reference.nodeId !== referenceId) } };
          }
          if (relation === "media-prompt" && node.id === edge.target && (node.type === "image" || node.type === "video")) {
            return { ...node, data: { ...node.data, promptSource: undefined } };
          }
          if (relation === "presentation-media" && node.id === edge.target && isVisiblePresentationFlowNode(node)) {
            const presentation = flowNodePresentation(node);
            if (presentation.media.mode !== "own") return node;
            return { ...node, data: { ...node.data, presentation: { ...presentation, media: { mode: "own", items: presentation.media.items.filter((item) => item.id !== referenceId) } } } };
          }
          return node;
        }));
        setSelectedAssetEdgeId(undefined);
      }
    }
    const storyChanges = changes.filter((change) => change.type === "add" || (!assetEdgeIds.has(change.id) && !change.id.startsWith("reference:")));
    if (storyChanges.length) setEdges((current) => applyEdgeChanges(storyChanges, current));
  }

  function onConnect(connection: Connection): void {
    if (!connection.source || !connection.target) return;
    const target = nodes.find((node) => node.id === connection.target);
    const source = nodes.find((node) => node.id === connection.source);
    if (!source || !target) return;
    const relation = connectionRelation(source, target, nodes, libraryAssets, imageModels);
    if (relation === "image-reference" && target.type === "image") {
      setNodes((current) => current.map((node) => node.id === target.id && node.type === "image"
        ? { ...node, data: { ...node.data, images: [...(node.data.images ?? []), { type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if (relation === "video-reference" && target.type === "video") {
      setNodes((current) => current.map((node) => node.id === target.id && node.type === "video"
        ? { ...node, data: { ...node.data, references: [...(node.data.references ?? []), { type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if (relation === "prompt" && (target.type === "image" || target.type === "video")) {
      setNodes((current) => current.map((node) => node.id === target.id
        ? { ...node, data: { ...node.data, promptSource: { type: "node", nodeId: source.id } } }
        : node));
      return;
    }
    if (relation === "presentation-media" && isVisiblePresentationFlowNode(target)) {
      const mediaType = presentationMediaType(source);
      if (!mediaType) return;
      setNodes((current) => current.map((node) => node.id === target.id && isVisiblePresentationFlowNode(node)
        ? withOwnedPresentationMedia(node, [
            ...(node.type === "scene" ? ownedPresentationItems(node) : []),
            { id: crypto.randomUUID(), type: mediaType, source: { type: "node", nodeId: source.id } },
          ])
        : node));
      return;
    }
    if (relation !== "story") return;
    setPlayIssue(undefined);
    setEdges((current) => replaceOutgoingEdge(current, {
      id: crypto.randomUUID(),
      source: connection.source!,
      target: connection.target!,
      ...(connection.sourceHandle ? { sourceHandle: connection.sourceHandle } : {}),
    }));
  }

  const selectedNode = nodes.find((node) => node.id === selectedId);
  const contextMenuNode = canvasContextMenu?.kind === "node" ? nodes.find((node) => node.id === canvasContextMenu.nodeId) : undefined;
  const contextMenuNodeMissing = canvasContextMenu?.kind === "node" && !contextMenuNode;
  const canInsertCopiedNode = Boolean(copiedNode && (copiedNode.type !== "start" || !nodes.some((node) => node.type === "start")));
  const canUndo = Boolean(historyPendingBase.current || editorUndoHistory.current.length);
  const canRedo = !historyPendingBase.current && editorRedoHistory.current.length > 0;
  const activeChapter = document?.chapter;
  const playerViewport = player.viewport;
  const playerViewportAspect = playerViewport.width / playerViewport.height;
  const canvasStageWidth = 440 * Math.min(1, playerViewportAspect);
  const canvasStageHeight = 440 / Math.max(1, playerViewportAspect);

  function addNode(type: Exclude<StoryNodeType, "asset">, position: { x: number; y: number }): void {
    if (type === "start" && nodes.some((node) => node.type === "start")) return;
    const node = { ...createFlowNode(type, position, imageModels, player.viewport, defaultTextModel), selected: true };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
    setSelectedId(node.id);
  }

  function addAssetNode(asset: Pick<LibraryAsset, "id" | "name" | "mediaType" | "contentType" | "duration">, position: { x: number; y: number }): void {
    if (asset.mediaType !== "image" && asset.mediaType !== "video" && asset.mediaType !== "audio") return;
    const node: StoryFlowNode = {
      id: crypto.randomUUID(),
      type: "asset",
      position,
      selected: true,
      deletable: true,
      data: { assetId: asset.id, mediaType: asset.mediaType, contentType: asset.contentType, assetDuration: asset.duration, name: asset.name },
    };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
    setSelectedId(node.id);
  }

  async function importAssetFile(file: File, position: { x: number; y: number }): Promise<void> {
    if (importingAssets) return;
    setImportingAssets(true);
    setNotice(undefined);
    try {
      const mediaType = libraryUploadMediaType(file);
      if (!mediaType) throw new Error("Upload a PNG, JPEG, WebP, MP4, MOV, WebM, MP3, or WAV file.");
      if (file.size > 200 * 1024 * 1024) throw new Error("The upload must be no larger than 200 MB.");
      const kind = mediaType.startsWith("video/") ? "video" : mediaType.startsWith("audio/") ? "audio" : undefined;
      const duration = kind ? await readMediaFileDuration(file, kind) : undefined;
      const uploaded = await uploadLibraryAsset(file, mediaType, duration);
      const asset: LibraryAsset = { ...uploaded, assetId: uploaded.id, path: uploaded.name };
      setLibraryAssets((current) => [asset, ...current]);
      addAssetNode(asset, position);
    } catch (error) {
      setNotice(`Could not upload asset: ${errorMessage(error)}`);
    } finally {
      setImportingAssets(false);
    }
  }

  function updateSelected(data: StoryFlowData, removedHandle?: string | string[]): void {
    if (!selectedId) return;
    setNodes((current) => current.map((node) => node.id === selectedId ? { ...node, data } : node));
    if (removedHandle) {
      const removed = new Set(Array.isArray(removedHandle) ? removedHandle : [removedHandle]);
      setEdges((current) => current.filter((edge) => edge.source !== selectedId || !removed.has(edge.sourceHandle ?? OUTPUT_HANDLE)));
    }
  }

  function updateVariables(next: StoryVariable[]): void {
    const names = next.map((variable) => variable.name.trim());
    if (names.some((name) => !name) || new Set(names).size !== names.length) {
      setNotice("Variable names must be non-empty and unique.");
      return;
    }
    const definitions = new Map(next.map((variable) => [variable.id, variable]));
    const normalizeNode = <T extends StoryFlowNode | StoryNode>(node: T): T => {
      if (node.type === "choice") return { ...node, data: { ...node.data, options: normalizeStoryVariableReferences(node.data.options ?? [], definitions) } } as T;
      if (node.type === "interaction") return { ...node, data: { ...node.data, behavior: normalizeBehaviorVariableReferences(node.data.behavior, definitions) } } as T;
      return node;
    };
    setNotice(undefined);
    setVariables(next.map((variable) => ({ ...variable, name: variable.name.trim() })));
    setNodes((current) => current.map(normalizeNode));
  }

  function addInteraction(position: { x: number; y: number }, template: InteractionTemplate = "blank"): void {
    const name = nextInteractionName(nodes);
    const draft = createInteractionFromTemplate(template);
    const node: StoryFlowNode = {
      id: crypto.randomUUID(),
      type: "interaction",
      position,
      selected: true,
      deletable: true,
      data: { title: name, behavior: draft.behavior, presentation: { media: { mode: "inherit" }, surface: { files: draft.files } } },
    };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
    setSelectedId(node.id);
  }

  function addCanvasNode(item: CanvasNodeCreationLeaf, position: { x: number; y: number }): void {
    if (item.action.kind === "interaction") addInteraction(position, item.action.template);
    else addNode(item.action.type, position);
  }

  function insertNodeCopy(source: StoryNode, position: { x: number; y: number }): void {
    if (source.type === "start" && nodes.some((node) => node.type === "start")) return;
    const duplicate = { ...toFlowNode(duplicateStoryNode(source, position), imageModels), selected: true };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), duplicate]);
    setSelectedAssetEdgeId(undefined);
    setSelectedId(duplicate.id);
  }

  function copyCanvasNode(nodeId: string): void {
    const source = nodes.find((node) => node.id === nodeId);
    if (!source) return;
    setCopiedNode(structuredClone(toStoryNode(source)));
  }

  function duplicateCanvasNode(nodeId: string): void {
    const source = nodes.find((node) => node.id === nodeId);
    if (!source) return;
    const canonical = toStoryNode(source);
    if (canonical.type === "start" && nodes.some((node) => node.type === "start")) return;
    insertNodeCopy(canonical, { x: source.position.x + STORY_CANVAS_GRID_SIZE * 2, y: source.position.y + STORY_CANVAS_GRID_SIZE * 2 });
  }

  function removeCanvasNodes(requestedIds: ReadonlySet<string>): void {
    const removedIds = new Set(nodes.filter((node) => requestedIds.has(node.id)).map((node) => node.id));
    if (!removedIds.size) return;
    const removedOutputs = interactionOutputsRemovedWithNodes(nodes, removedIds);
    setNodes((current) => removeNodesAndReferences(current, removedIds));
    setEdges((current) => current.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target) && !removedOutputs.has(interactionOutputKey(edge.source, edge.sourceHandle ?? OUTPUT_HANDLE))));
    if (removedIds.has(selectedId ?? "")) setSelectedId(undefined);
  }

  function deleteSelected(): void {
    if (selectedNode) removeCanvasNodes(new Set([selectedNode.id]));
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
    setSelectedAssetEdgeId(undefined);
    setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
  }

  async function generateImage(node: StoryFlowNode): Promise<void> {
    if (node.type !== "image" || generatingNodeId) return;
    const prompt = resolveNodePrompt(node, nodes).trim();
    if (!prompt) { setGenerationError({ nodeId: node.id, message: "Add a prompt before generating." }); return; }
    if (!node.data.model) { setGenerationError({ nodeId: node.id, message: "Select an image model before generating." }); return; }
    try {
      const images = await resolveReferenceImages(node);
      await generateMedia(node, "generate-image", {
        prompt,
        imageModel: node.data.model,
        resolution: node.data.resolution ?? "1K",
        aspectRatio: node.data.aspectRatio ?? "1:1",
        outputs: 1,
        ...(images.length ? { images } : {}),
      }, "Image");
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    }
  }

  async function generateTextNode(node: StoryFlowNode): Promise<void> {
    if (node.type !== "text" || generatingTextNodeId || generatingNodeId) return;
    const instruction = node.data.instruction?.trim();
    if (!instruction) {
      setGenerationError({ nodeId: node.id, message: "Add an instruction before generating." });
      return;
    }
    setGeneratingTextNodeId(node.id);
    setGenerationError(undefined);
    try {
      const model = node.data.textModel ?? defaultTextModel;
      if (!model) {
        setGenerationError({ nodeId: node.id, message: "No language model is available." });
        return;
      }
      const result = await generateStoryText(projectId, { instruction, model });
      setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, text: result.text, textModel: result.model } }
        : candidate));
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      setGeneratingTextNodeId(undefined);
    }
  }

  async function generateVideo(node: StoryFlowNode): Promise<void> {
    if (node.type !== "video" || generatingNodeId) return;
    const prompt = resolveNodePrompt(node, nodes).trim();
    if (!prompt) { setGenerationError({ nodeId: node.id, message: "Add a prompt before generating." }); return; }
    try {
      const references = resolveVideoReferences(node);
      await generateMedia(node, "generate-video", {
        prompt,
        ...(references.length ? { references } : {}),
        duration: node.data.duration ?? 6,
        aspectRatio: node.data.videoAspectRatio ?? "adaptive",
        resolution: node.data.videoResolution ?? "720p",
      }, "Video");
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    }
  }

  function resolveVideoReferences(node: StoryFlowNode): VideoGenerationReference[] {
    if (node.type !== "video" || !activeChapter) return [];
    const references = (node.data.references ?? []).map((reference) => {
      const assetId = resolveStoryAssetId(activeChapter, reference);
      if (!assetId) throw new Error("Generate every connected media node before running this node.");
      const asset = libraryAssets.find((candidate) => candidate.id === assetId);
      if (!asset || (asset.mediaType !== "image" && asset.mediaType !== "video" && asset.mediaType !== "audio")) {
        throw new Error("A connected reference is missing from Library.");
      }
      return { type: asset.mediaType, assetId, duration: asset.duration };
    });
    validateVideoReferenceCounts(references.map((reference) => reference.type));
    validateVideoReferenceDurations([], references);
    if (!validVideoReferenceCombination(references)) throw new Error("Add an image or video to use an audio reference.");
    return references.map(({ type, assetId }) => ({ type, assetId }));
  }

  async function resolveReferenceImages(node: StoryFlowNode): Promise<PromptImage[]> {
    if (node.type !== "image" || !activeChapter) return [];
    return Promise.all((node.data.images ?? []).map(async (reference) => {
      const assetId = resolveStoryImageAssetId(activeChapter, reference);
      if (!assetId) throw new Error("Generate every connected image before running this node.");
      return promptImage(await getLibraryAsset(assetId));
    }));
  }

  async function uploadReferenceImages(node: StoryFlowNode, files: File[]): Promise<void> {
    if (node.type !== "image" || files.length === 0 || generatingNodeId || uploadingNodeId) return;
    const available = imageReferenceLimit(node, imageModels) - (node.data.images?.length ?? 0);
    if (available <= 0) {
      setGenerationError({ nodeId: node.id, message: "This node cannot accept more reference images." });
      return;
    }
    if (files.length > available) {
      setGenerationError({ nodeId: node.id, message: `Add up to ${available} more ${available === 1 ? "image" : "images"}.` });
      return;
    }
    setUploadingNodeId(node.id);
    setGenerationError(undefined);
    try {
      const images = await Promise.all(files.map(readUploadImage));
      const assets = await Promise.all(images.map(({ name, image }) => createLibraryImage({ name, image })));
      setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "image"
        ? {
            ...candidate,
            data: {
              ...candidate.data,
              images: [...(candidate.data.images ?? []), ...assets.map((asset): StoryAssetReference => ({ type: "library", assetId: asset.id }))],
            },
          }
        : candidate));
      setLibraryAssets(await loadLibraryAssets());
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      setUploadingNodeId(undefined);
    }
  }

  async function uploadVideoReferences(node: StoryFlowNode, files: File[]): Promise<void> {
    if (node.type !== "video" || files.length === 0 || generatingNodeId || uploadingNodeId) return;
    setUploadingNodeId(node.id);
    setGenerationError(undefined);
    try {
      const uploads = await Promise.all(files.map(prepareVideoReferenceFile));
      const existing = videoReferenceViews(node, nodes, libraryAssets);
      validateVideoReferenceCounts([...existing.map((reference) => reference.type), ...uploads.map((upload) => upload.type)]);
      validateVideoReferenceDurations(existing, uploads);
      for (const upload of uploads) {
        const asset = await uploadLibraryAsset(upload.file, upload.mediaType, upload.duration);
        setLibraryAssets((current) => [{ ...asset, assetId: asset.id, path: asset.name }, ...current.filter((candidate) => candidate.id !== asset.id)]);
        setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "video"
          ? { ...candidate, data: { ...candidate.data, references: [...(candidate.data.references ?? []), { type: "library", assetId: asset.id }] } }
          : candidate));
      }
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      setUploadingNodeId(undefined);
    }
  }

  async function generateMedia(node: StoryFlowNode, toolId: "generate-image" | "generate-video", input: RunImageToolRequest | RunVideoToolRequest, label: string): Promise<void> {
    setGeneratingNodeId(node.id);
    setGenerationError(undefined);
    try {
      const run = await runTool(toolId, input);
      const file = run.files[0];
      if (!file?.assetId) throw new Error(`${label} generation completed without a Library asset.`);
      setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, assetId: file.assetId } }
        : candidate));
      setLibraryAssets(await loadLibraryAssets());
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      setGeneratingNodeId(undefined);
    }
  }

  const renderedNodes = nodes.map((node) => {
    if (node.type === "scene") {
      const media = node.data.presentation?.media;
      const segments = sceneTimelineSegments(media?.mode === "own" ? media.items : [], nodes, libraryAssets);
      const previewAssetId = segments.find((segment) => segment.assetId)?.assetId;
      return {
        ...node,
        data: {
          ...node.data,
          variables,
          previewValues: Object.fromEntries(variables.map((variable) => [variable.id, variable.initialValue])),
          scenePreview: {
            ...(previewAssetId ? { assetId: previewAssetId } : {}),
            totalDurationMs: segments.reduce((total, segment) => total + segment.durationMs, 0),
            segments: segments.map((segment) => ({ ...(segment.assetId ? { assetId: segment.assetId } : {}), durationMs: segment.durationMs })),
          },
        },
      };
    }
    if (node.type === "project-state") return {
      ...node,
      data: { ...node.data, variables },
    };
    if (node.type === "open-ui") {
      const item = node.data.presentation?.media.mode === "own" ? node.data.presentation.media.items[0] : undefined;
      const assetId = item ? resolveStoryAssetId(activeChapter ?? { id: "", title: "", nodes: [], edges: [] }, item.source) : undefined;
      const asset = libraryAssets.find((candidate) => candidate.id === assetId);
      const mediaType: "image" | "video" | undefined = asset?.mediaType === "video" ? "video" : asset?.mediaType === "image" ? "image" : undefined;
      return { ...node, data: { ...node.data, playerConfig: player, openUiPreview: { assetId, mediaType, durationMs: Math.max(0, Math.round((asset?.duration ?? 0) * 1_000)) } } };
    }
    if (node.type === "choice" || node.type === "interaction" || node.type === "ending") return {
      ...node,
      data: {
        ...node.data,
        variables,
        previewValues: Object.fromEntries(variables.map((variable) => [variable.id, variable.initialValue])),
        inheritedScenePreview: resolvedPresentationPreview(node, nodes, edges, libraryAssets),
      },
    };
    if (node.type === "asset") return {
      ...node,
      data: (() => {
        const asset = libraryAssets.find((candidate) => candidate.id === node.data.assetId);
        return {
          ...node.data,
          name: asset?.name ?? "Missing asset",
          contentType: asset?.contentType,
          assetDuration: asset?.duration,
        };
      })(),
    };
    if (node.type === "text") return {
      ...node,
      data: {
          ...node.data,
        textRuntime: {
          models: textModelCatalog.models,
          modelStatus: textModelCatalog.status,
          ...(defaultTextModel ? { defaultModel: defaultTextModel } : {}),
          generating: generatingTextNodeId === node.id,
          busy: Boolean(generatingNodeId || generatingTextNodeId),
          ...(generationError?.nodeId === node.id ? { error: generationError.message } : {}),
          onChange: (data: StoryFlowData) => {
            setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
            setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
          },
          onGenerate: () => void generateTextNode(node),
        },
      },
    };
    if (!isMediaNodeType(node.type)) return node;
    const linkedPrompt = resolveLinkedPrompt(node, nodes);
    const runtime: MediaNodeRuntime = {
      generating: generatingNodeId === node.id,
      busy: Boolean(generatingNodeId || uploadingNodeId),
      ...(generationError?.nodeId === node.id ? { error: generationError.message } : {}),
      onChange: (data) => {
        setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
        setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
      },
      onGenerate: node.type === "image" ? () => void generateImage(node) : () => void generateVideo(node),
      ...(linkedPrompt !== undefined ? { linkedPrompt } : {}),
      onDisconnectPrompt: () => {
        setSelectedAssetEdgeId(undefined);
        setNodes((current) => current.map((candidate) => candidate.id === node.id
          ? { ...candidate, data: { ...candidate.data, promptSource: undefined } }
        : candidate));
      },
    };
    const referenceRuntime: ReferenceMediaNodeRuntime = {
      ...runtime,
      references: node.type === "image" ? imageReferenceViews(node, nodes, libraryAssets) : videoReferenceViews(node, nodes, libraryAssets),
      maxReferences: node.type === "image" ? imageReferenceLimit(node, imageModels) : 15,
      uploading: uploadingNodeId === node.id,
      accept: node.type === "image" ? "image/png,image/jpeg,image/webp" : VIDEO_REFERENCE_ACCEPT,
      addLabel: node.type === "image" ? "Upload reference images" : "Upload image, video, or audio references",
      onRemoveReference: (index) => {
        setSelectedAssetEdgeId(undefined);
        setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "image"
          ? { ...candidate, data: { ...candidate.data, images: (candidate.data.images ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
          : candidate.id === node.id && candidate.type === "video"
            ? { ...candidate, data: { ...candidate.data, references: (candidate.data.references ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
          : candidate));
      },
      onUploadReferences: (files) => node.type === "image" ? void uploadReferenceImages(node, files) : void uploadVideoReferences(node, files),
    };
    return {
      ...node,
      data: node.type === "image"
        ? { ...node.data, imageRuntime: { ...referenceRuntime, models: imageModels } satisfies ImageNodeRuntime }
        : { ...node.data, videoRuntime: referenceRuntime },
    };
  });

  async function startPlaytest(): Promise<void> {
    if (!activeChapter || !document) return;
    const issue = validatePlayableChapter(activeChapter);
    if (issue) {
      setPlayIssue(issue);
      if (issue.nodeId) {
        setSelectedId(issue.nodeId);
        setNodes((current) => current.map((node) => ({ ...node, selected: node.id === issue.nodeId })));
      }
      return;
    }
    clearSelection();
    setPlayIssue(undefined);
    try {
      const assetIssue = validatePlayableChapter(activeChapter, {
        availableAssets: new Map(libraryAssets.flatMap((asset) => asset.mediaType === "model" ? [] : [[asset.id, asset.mediaType] as const])),
      });
      if (assetIssue) {
        setPlayIssue(assetIssue);
        if (assetIssue.nodeId) {
          setSelectedId(assetIssue.nodeId);
          setNodes((current) => current.map((node) => ({ ...node, selected: node.id === assetIssue.nodeId })));
        }
        return;
      }
      await save(document);
      if (window.ohMyGameDesktop) {
        await window.ohMyGameDesktop.openPlaytest(projectId, activeChapter.id);
      } else {
        window.open(new URL(playtestHash(projectId, activeChapter.id), window.location.href).href, "ohmygame-playtest");
      }
    } catch (error) {
      setPlayIssue({ nodeId: "", message: errorMessage(error) });
    }
  }

  async function buildGame(): Promise<void> {
    if (!document || building) return;
    setBuilding(true);
    setPlayIssue(undefined);
    try {
      await save(document);
      const artifact = await buildInteractiveDrama(projectId);
      const url = URL.createObjectURL(artifact);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = `${project.name}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setPlayIssue({ nodeId: "", message: errorMessage(cause) });
    } finally {
      setBuilding(false);
    }
  }

  async function publishGame(details: PublishDetails): Promise<boolean> {
    if (!document) return false;
    await save(document);
    return onPublish(details);
  }

  function applyEditorStory(next: StoryDocument): void {
    if (!isStoryDocument(next)) throw new Error("The editor change did not produce a valid Interactive Drama story");
    const nextChapter = next.chapter;
    observeHistoryDocument(next);
    setChapter({ id: nextChapter.id, title: nextChapter.title });
    setVariables(next.variables ?? []);
    setPlayer(next.player);
    setNodes(nextChapter.nodes.map((node) => toFlowNode(node, imageModels)));
    setEdges(nextChapter.edges);
    if (next.editorLayout) {
      setEditorLayout(next.editorLayout);
      setWorkspaceView(next.editorLayout.view === "code" ? "code" : "canvas");
    }
    setSelectedId((current) => current && nextChapter.nodes.some((node) => node.id === current) ? current : undefined);
  }

  return (
    <section className={`viewer-pane interactive-drama-workspace${openedNodeId ? " is-node-editor-open" : ""}`} aria-label="Interactive Drama workspace" style={{ "--story-viewport-ratio": `${playerViewport.width} / ${playerViewport.height}`, "--story-viewport-aspect": playerViewportAspect, "--story-canvas-stage-width": `${canvasStageWidth}px`, "--story-canvas-stage-height": `${canvasStageHeight}px` } as CSSProperties}>
      <header className="interactive-drama-header window-drag-handle">
        <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
        <button className="interactive-drama-canvas-format" type="button" title="Canvas format" onClick={() => setCanvasSettingsOpen(true)}>
          <Monitor size={14} />
          <span>{storyViewportRatio(playerViewport)}</span>
        </button>
        <nav className="interactive-drama-workspace-switch" aria-label="Workspace mode">
          <button type="button" className={workspaceView === "canvas" ? "is-active" : undefined} aria-current={workspaceView === "canvas" ? "page" : undefined} onClick={() => setWorkspaceView("canvas")}><Clapperboard size={12} />Canvas</button>
          <button type="button" className={workspaceView === "code" ? "is-active" : undefined} aria-current={workspaceView === "code" ? "page" : undefined} onClick={() => { clearSelection(); setOpenedNodeId(undefined); setWorkspaceView("code"); }}><Code2 size={12} />Code</button>
        </nav>
        <div className="interactive-drama-header-actions">
          <button className="interactive-drama-action" type="button" title="Playtest" onClick={() => void startPlaytest()}>
            <Play size={14} fill="currentColor" />
            <span>Playtest</span>
          </button>
          <button className="interactive-drama-action" type="button" title="Publish" disabled={agentBusy || publishing || building} onClick={() => setPublishOpen(true)}>
            {publishing ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
            <span>Publish</span>
          </button>
          <button className="interactive-drama-action interactive-drama-action-primary" type="button" title="Build game" disabled={agentBusy || publishing || building} onClick={() => void buildGame()}>
            {building ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
            <span>{building ? "Building" : "Build game"}</span>
          </button>
        </div>
      </header>
      {workspaceView !== "code" ? <div className="interactive-drama-body">
        <div className="interactive-drama-canvas" ref={canvas}>
          {phase === "loading" ? <div className="story-canvas-state">Loading story...</div> : null}
          {phase === "error" ? <div className="story-canvas-state story-canvas-state-error">{notice}</div> : null}
          {phase === "ready" ? (
            <ReactFlow<StoryCanvasNode>
              className={`story-canvas story-canvas-${interactionMode}`}
              nodes={renderedNodes}
              edges={[...edges.map((edge) => ({ ...edge, ...storyEdgeStateLabel(edge, nodes, variables) })), ...assetEdges]}
              nodeTypes={STORY_NODE_TYPES}
              onInit={(instance) => { reactFlow.current = instance; }}
              defaultEdgeOptions={STORY_EDGE_OPTIONS}
              connectionLineStyle={STORY_EDGE_OPTIONS.style}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              snapToGrid
              snapGrid={STORY_CANVAS_SNAP_GRID}
              nodesDraggable={interactionMode === "pointer"}
              elementsSelectable={interactionMode === "pointer"}
              selectionOnDrag={interactionMode === "pointer"}
              panOnDrag={interactionMode === "pan" ? true : [1, 2]}
              panOnScroll
              zoomOnScroll={false}
              zoomOnPinch
              zoomOnDoubleClick={false}
              deleteKeyCode={openedNodeId ? null : ["Backspace", "Delete"]}
              onNodesChange={onNodesChange}
              onNodeDragStart={() => { setCanvasContextMenu(undefined); setAlignmentGuides(undefined); beginHistoryGesture(); }}
              onNodeDrag={(_event, node) => {
                const [active, ...candidates] = alignmentNodesFromDom([
                  node,
                  ...renderedNodes,
                ]);
                setAlignmentGuides(active ? findCanvasAlignmentGuides(active, candidates) : undefined);
              }}
              onNodeDragStop={() => { setAlignmentGuides(undefined); finishHistoryGesture(); }}
              onMoveStart={() => setCanvasContextMenu(undefined)}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onMoveEnd={(_event, viewport) => setEditorLayout((current) => ({ ...current, viewport }))}
              onEdgeClick={(_event, edge) => {
                setSelectedAssetEdgeId(edge.id.startsWith(ASSET_EDGE_PREFIX) ? edge.id : undefined);
                setSelectedId(undefined);
              }}
              onNodeClick={(_event, node) => {
                setCanvasContextMenu(undefined);
                window.clearTimeout(nodeClickTimer.current);
                nodeClickTimer.current = window.setTimeout(() => {
                  setSelectedAssetEdgeId(undefined);
                  setSelectedId(node.id);
                }, 180);
              }}
              onNodeDoubleClick={(_event, node) => {
                setCanvasContextMenu(undefined);
                window.clearTimeout(nodeClickTimer.current);
                setSelectedAssetEdgeId(undefined);
                setSelectedId(node.id);
                if (hasNodeEditor(node)) setOpenedNodeId(node.id);
              }}
              onPaneClick={() => { setCanvasContextMenu(undefined); window.clearTimeout(nodeClickTimer.current); clearSelection(); }}
              onPaneContextMenu={(event) => openCanvasContextMenu(event, "pane")}
              onNodeContextMenu={(event, node) => {
                window.clearTimeout(nodeClickTimer.current);
                setSelectedAssetEdgeId(undefined);
                setSelectedId(node.id);
                setNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
                openCanvasContextMenu(event, "node", node.id);
              }}
              onNodesDelete={(deleted) => {
                removeCanvasNodes(new Set(deleted.map((node) => node.id)));
              }}
              isValidConnection={(connection) => {
                const target = nodes.find((node) => node.id === connection.target);
                const source = nodes.find((node) => node.id === connection.source);
                return Boolean(source && target && connectionRelation(source, target, nodes, libraryAssets, imageModels));
              }}
              proOptions={{ hideAttribution: true }}
              defaultViewport={editorLayout.viewport}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--interactive-drama-grid)" />
              <StoryCanvasAlignmentGuides guides={alignmentGuides} />
              <ZoomControls />
              <CanvasToolbar
                mode={interactionMode}
                canvas={canvas}
                hasStart={nodes.some((node) => node.type === "start")}
                libraryAssets={libraryAssets.filter((asset) => asset.mediaType === "image" || asset.mediaType === "video" || asset.mediaType === "audio")}
                importing={importingAssets}
                reserveInspector={false}
                onAdd={addNode}
                onAddInteraction={addInteraction}
                onAddAsset={addAssetNode}
                onUpload={(file, position) => void importAssetFile(file, position)}
                onModeChange={setInteractionMode}
              />
            </ReactFlow>
          ) : null}
          {canvasContextMenu ? <StoryCanvasContextMenu
            menu={canvasContextMenu}
            canUndo={canUndo}
            canRedo={canRedo}
            canPaste={canInsertCopiedNode}
            canDuplicate={Boolean(contextMenuNode && (contextMenuNode.type !== "start" || !nodes.some((node) => node.type === "start")))}
            hasStart={nodes.some((node) => node.type === "start")}
            nodeActionsDisabled={Boolean(contextMenuNodeMissing)}
            importing={importingAssets}
            onClose={() => setCanvasContextMenu(undefined)}
            onUndo={undoEditorChange}
            onRedo={redoEditorChange}
            onPaste={() => { if (copiedNode) insertNodeCopy(copiedNode, canvasContextMenu.flowPosition); }}
            onAdd={(item) => addCanvasNode(item, canvasContextMenu.flowPosition)}
            onUpload={(file) => void importAssetFile(file, canvasContextMenu.flowPosition)}
            onCopy={() => { if (canvasContextMenu.nodeId) copyCanvasNode(canvasContextMenu.nodeId); }}
            onDuplicate={() => { if (canvasContextMenu.nodeId) duplicateCanvasNode(canvasContextMenu.nodeId); }}
            onDelete={() => { if (canvasContextMenu.nodeId) removeCanvasNodes(new Set([canvasContextMenu.nodeId])); }}
          /> : null}
          {notice && phase === "ready" ? <div className="story-save-notice" role="alert">{notice}</div> : null}
          {playIssue && phase === "ready" ? (
            <div className="story-play-issue" role="alert">
              <div><strong>Story needs attention</strong><span>{playIssue.message}</span></div>
              <button type="button" aria-label="Dismiss story issue" onClick={() => setPlayIssue(undefined)}><X size={14} /></button>
            </div>
          ) : null}
        </div>
      </div> : <main className="story-code-view" aria-label="Interactive Drama code"><WorkspaceCodeView projectId={projectId} revision={workspaceRevision + codeRevision} /></main>}
      {openedNodeId ? <NodeEditorPage
        node={renderedNodes.find((candidate) => candidate.id === openedNodeId)}
        config={player ?? { ...DEFAULT_STORY_PLAYER_CONFIG, title: chapter?.title ?? DEFAULT_STORY_PLAYER_CONFIG.title }}
        nodes={nodes}
        edges={edges}
        libraryAssets={libraryAssets}
        variables={variables}
        onVariablesChange={updateVariables}
        onNodeChange={updateSelected}
        onPlaytest={() => void startPlaytest()}
        onClose={() => setOpenedNodeId(undefined)}
      /> : null}
      {canvasSettingsOpen ? <StoryCanvasSettingsDialog viewport={player.viewport} hasContent={nodes.length > 0} onClose={() => setCanvasSettingsOpen(false)} onChange={(viewport) => setPlayer((current) => ({ ...current, viewport }))} /> : null}
      {publishOpen ? <PublishDialog project={project} publishing={publishing} onClose={() => setPublishOpen(false)} onPublish={publishGame} /> : null}
    </section>
  );
}

function StateEditorPage({ node, variables, onVariablesChange, onNodeChange }: { node: StoryFlowNode; variables: StoryVariable[]; onVariablesChange: (variables: StoryVariable[]) => void; onNodeChange: (data: StoryFlowData) => void }) {
  return <main className="story-state-editor-content"><div className="story-inspector-content">
    <InspectorField label="Title"><input maxLength={120} value={node.data.title ?? ""} onChange={(event) => onNodeChange({ ...node.data, title: event.target.value })} /></InspectorField>
    <ChoiceActionsEditor variables={variables} value={node.data.actions ?? []} onChange={(actions) => onNodeChange({ ...node.data, actions })} />
    <StateInspector variables={variables} onChange={onVariablesChange} hideHeader />
  </div></main>;
}

function StateInspector({ variables, onChange, hideHeader = false }: { variables: StoryVariable[]; onChange: (variables: StoryVariable[]) => void; hideHeader?: boolean }) {
  function addVariable(): void {
    const used = new Set(variables.map((variable) => variable.name));
    let index = variables.length + 1;
    while (used.has(`variable${index}`)) index += 1;
    onChange([...variables, { id: crypto.randomUUID(), name: `variable${index}`, type: "text", initialValue: "" }]);
  }

  return <aside className="story-inspector story-state-inspector" aria-label="Initial State inspector">
    {!hideHeader ? <header><div><span>State</span><strong>Initial State</strong></div></header> : null}
    <div className="story-inspector-content">
      <p className="story-inspector-help">Values start from these defaults on a new game and persist automatically when the player continues.</p>
      <section className="story-state-fields">
        <span>Variables</span>
        {variables.map((variable) => <div className="story-state-variable" key={variable.id}>
          <input aria-label={`${variable.name || "Variable"} name`} value={variable.name} placeholder="Variable name" onChange={(event) => onChange(variables.map((candidate) => candidate.id === variable.id ? { ...candidate, name: event.target.value } : candidate))} />
          <select aria-label={`${variable.name || "Variable"} type`} value={variable.type} onChange={(event) => {
            const type = event.target.value as StoryVariableType;
            onChange(variables.map((candidate) => candidate.id === variable.id ? { ...candidate, type, initialValue: defaultVariableValue(type) } : candidate));
          }}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option></select>
          <VariableValueInput variable={variable} value={variable.initialValue} label={`${variable.name || "Variable"} initial value`} onChange={(initialValue) => onChange(variables.map((candidate) => candidate.id === variable.id ? { ...candidate, initialValue } : candidate))} />
          <button type="button" title="Delete variable" aria-label={`Delete ${variable.name || "variable"}`} onClick={() => { if (window.confirm(`Delete variable "${variable.name || "Unnamed variable"}"? References will need to be repaired.`)) onChange(variables.filter((candidate) => candidate.id !== variable.id)); }}><X size={13} /></button>
        </div>)}
        {!variables.length ? <p>No variables defined</p> : null}
        <button className="story-field-add" type="button" onClick={addVariable}><Plus size={14} />Add variable</button>
      </section>
    </div>
  </aside>;
}

function OpenUiNode({ data, selected }: NodeProps<StoryCanvasNode>) {
  const config = data.playerConfig ?? DEFAULT_STORY_PLAYER_CONFIG;
  const preview = data.openUiPreview;
  const assetId = preview?.assetId;
  const mediaType = preview?.mediaType;
  const totalMs = Math.max(1, preview?.durationMs ?? 0);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentMs, setCurrentMs] = useState(0);
  const mediaStyle = { "--story-media-width": "var(--story-canvas-stage-width, 440px)", "--story-media-height": "var(--story-canvas-stage-height, 248px)" } as CSSProperties;
  const asset = useWorkspaceAssetUrl(undefined, "", 0, assetId);

  useEffect(() => {
    setPlaying(false);
    setCurrentMs(0);
  }, [assetId]);
  useEffect(() => {
    if (playing) void video.current?.play().catch(() => setPlaying(false));
    else video.current?.pause();
  }, [asset.url, playing]);

  return <div className={`story-node story-media-node story-node-scene story-node-open-ui${selected ? " is-selected" : ""}`} style={mediaStyle}>
    <Handle className="story-media-input-handle" type="target" position={Position.Left} />
    <div className="story-media-node-label story-scene-node-label">
      <PanelToggle size={14} />
      <span><b>Open UI</b><strong>{data.title || "Untitled Story"}</strong></span>
      {assetId && preview?.durationMs ? <time>{formatCompactDuration(preview.durationMs)}</time> : null}
    </div>
    <div data-alignment-frame className="story-media-stage story-open-ui-node-preview">
      {asset.url && mediaType === "image" ? <img src={asset.url} alt="" /> : null}
      {asset.url && mediaType === "video" ? <video ref={video} src={asset.url} muted={muted} playsInline onTimeUpdate={(event) => setCurrentMs(Math.round(event.currentTarget.currentTime * 1_000))} onEnded={() => { setCurrentMs(totalMs); setPlaying(false); }} /> : null}
      <OpenUiCanvasSurface data={data} viewport={config.viewport} transparent={Boolean(asset.url)} />
      {assetId && mediaType === "video" ? <InlineVideoControls
        label="Open UI preview"
        playing={playing}
        currentMs={currentMs}
        totalMs={totalMs}
        muted={muted}
        onToggle={() => {
          const next = !playing;
          const timeMs = currentMs >= totalMs ? 0 : currentMs;
          setPlaying(next);
          if (timeMs !== currentMs) setCurrentMs(timeMs);
          if (video.current && timeMs !== currentMs) video.current.currentTime = timeMs / 1_000;
        }}
        onSeek={(timeMs) => { setCurrentMs(timeMs); if (video.current) video.current.currentTime = timeMs / 1_000; }}
        onToggleMuted={() => setMuted((current) => !current)}
      /> : null}
    </div>
    <footer className="story-scene-node-meta"><span>{mediaType === "video" ? "Video" : mediaType === "image" ? "Image" : "No media"}</span><i /><span>Code</span></footer>
    <Handle className="story-media-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
  </div>;
}

function OpenUiCanvasSurface({ data, viewport, transparent, runtime = false, onAction }: { data: StoryFlowData; viewport: StoryPlayerConfig["viewport"]; transparent: boolean; runtime?: boolean; onAction?: (action: StoryOpenUiAction) => void }) {
  const presentation = data.presentation ?? { media: { mode: "own" as const, items: [] }, surface: { files: structuredClone(DEFAULT_OPEN_UI_CODE) } };
  const files = openUiSurfaceFiles(presentation, transparent);
  const content = openUiRuntimeContent(data.content ?? DEFAULT_OPEN_UI_CONTENT, false);
  return <StoryScreenSurface files={files} content={content} mode={runtime ? "runtime" : "preview"} title="Open UI preview" className="story-open-ui-node-surface" designViewport={viewport} onAction={onAction} />;
}

function ProjectStateNode({ data, selected }: Pick<NodeProps<StoryFlowNode>, "data" | "selected">) {
  const variables = data.variables ?? [];
  return <div data-alignment-frame className={`story-node story-node-initial-state${selected ? " is-selected" : ""}`}>
    <Handle type="target" position={Position.Left} />
    <header><span><Wrench size={14} />{data.title || "Project State"}</span><small>{data.actions?.length ?? 0} actions</small></header>
    <div className="story-state-resource-list">{(data.actions ?? []).slice(0, 3).map((action, index) => <span key={`${action.type}:${action.variableId}:${index}`}><b>{variables.find((variable) => variable.id === action.variableId)?.name || "Variable"}</b><small>{action.type === "set-variable" ? `= ${String(action.value)}` : `${action.amount >= 0 ? "+" : ""}${action.amount}`}</small></span>)}{(data.actions?.length ?? 0) > 3 ? <em>+{data.actions!.length - 3} more</em> : null}{!data.actions?.length ? <em>No actions</em> : null}</div>
    <Handle id={OUTPUT_HANDLE} type="source" position={Position.Right} />
  </div>;
}

function StartNode({ selected }: NodeProps<StoryFlowNode>) {
  return (
    <div data-alignment-frame className={`story-node story-node-start${selected ? " is-selected" : ""}`}>
      <Flag size={15} />
      <span>Start</span>
      <Handle id={OUTPUT_HANDLE} type="source" position={Position.Right} />
    </div>
  );
}

function SceneNode({ id, data, selected }: NodeProps<StoryFlowNode>) {
  const mediaCount = data.presentation?.media.mode === "own" ? data.presentation.media.items.length : 0;
  const preview = data.scenePreview;
  const totalDurationMs = Math.max(1, preview?.totalDurationMs ?? 0);
  const mediaStyle = { "--story-media-width": "var(--story-canvas-stage-width, 440px)", "--story-media-height": "var(--story-canvas-stage-height, 248px)" } as CSSProperties;
  return (
    <div className={`story-node story-media-node story-node-scene${selected ? " is-selected" : ""}`} style={mediaStyle}>
      <Handle className="story-media-input-handle" type="target" position={Position.Left} />
      <div className="story-media-node-label story-scene-node-label">
        <Clapperboard size={14} />
        <span><b>Scene</b><strong>{data.title || "Untitled scene"}</strong></span>
        {preview?.totalDurationMs ? <time>{formatCompactDuration(preview.totalDurationMs)}</time> : null}
      </div>
      <SceneNodePoster sceneId={id} preview={preview} surfaceFiles={data.presentation?.surface.files ?? DEFAULT_SCENE_SURFACE_FILES} variables={data.variables ?? []} title={data.title || "Untitled scene"} empty={!mediaCount} />
      <footer className="story-scene-node-meta">{mediaCount ? <span>{mediaCount} {mediaCount === 1 ? "media item" : "media items"}</span> : <span className="is-placeholder">Add media</span>}</footer>
      <Handle className="story-media-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
    </div>
  );
}

function InteractionNode({ data, selected }: NodeProps<StoryFlowNode>) {
  const behavior = data.behavior;
  const outcomes = behavior ? storyInteractionNodeOutcomes(behavior) : [];
  const label = behavior?.type === "qte" ? "QTE" : behavior?.type === "hotspot" ? "Hotspot" : behavior?.type === "continue" ? "Continue" : "Action";
  return <div className={`story-node story-media-node story-node-interaction-flow${selected ? " is-selected" : ""}`}>
    <Handle className="story-media-input-handle" type="target" position={Position.Left} />
    <div className="story-media-node-label story-interaction-resource-label"><Code2 size={14} /><span><b>{label}</b><strong>{data.title || "Untitled interaction"}</strong></span></div>
    <InheritedScenePoster preview={data.inheritedScenePreview} className="story-interaction-flow-preview">
      {behavior ? <StoryInteractionSurface files={data.presentation?.surface.files ?? DEFAULT_SCENE_SURFACE_FILES} mode="preview" title={`${data.title || "Interaction"} preview`} /> : <span>Interaction</span>}
    </InheritedScenePoster>
    <div className="story-interaction-flow-outcomes">{outcomes.map((outcome) => <span key={outcome}>{outcome}</span>)}</div>
    <footer className="story-scene-node-meta"><span>{behavior?.type === "qte" || behavior?.type === "hotspot" ? `${Math.round(behavior.durationMs / 1000)}s` : "Waits for input"}</span><i /><span>{outcomes.length} {outcomes.length === 1 ? "outcome" : "outcomes"}</span></footer>
    {outcomes.map((outcome, index) => <Handle key={outcome} className="story-choice-output-handle" id={outcome} type="source" position={Position.Right} style={{ top: `${42 + (index + 1) * (48 / (outcomes.length + 1))}%` }} />)}
  </div>;
}

function SceneNodePoster({ sceneId, preview, surfaceFiles, variables, title, empty }: {
  sceneId: string;
  preview?: SceneCanvasPreviewData;
  surfaceFiles: StorySurfaceFiles;
  variables: StoryVariable[];
  title: string;
  empty: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [poster, setPoster] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const segments = preview?.segments ?? [];
  const totalMs = Math.max(1, preview?.totalDurationMs ?? 0);
  const matchingIndex = segments.findIndex((_, index) => currentMs < segments.slice(0, index + 1).reduce((total, segment) => total + segment.durationMs, 0));
  const activeIndex = matchingIndex < 0 ? Math.max(0, segments.length - 1) : matchingIndex;
  const activeSegment = segments[activeIndex];
  const segmentStartMs = segments.slice(0, activeIndex).reduce((total, segment) => total + segment.durationMs, 0);
  const localTimeMs = Math.max(0, currentMs - segmentStartMs);
  const surfaceVariables = Object.fromEntries(variables.flatMap((variable) => [[variable.id, variable.initialValue], [variable.name, variable.initialValue]]));
  const posterAsset = useWorkspaceAssetUrl(undefined, "", 0, visible ? preview?.assetId : undefined);
  const activeAsset = useWorkspaceAssetUrl(undefined, "", 0, visible ? activeSegment?.assetId : undefined);
  useEffect(() => {
    const element = container.current;
    if (!element || visible) return;
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    let disposed = false;
    setPoster(undefined);
    if (!posterAsset.url) return;
    void getTimelineFrames(posterAsset.url, 1).then((frames) => { if (!disposed) setPoster(frames[0]); }).catch(() => {});
    return () => { disposed = true; };
  }, [posterAsset.url]);
  useEffect(() => {
    const element = video.current;
    if (!element || !activeAsset.url) return;
    if (playing) void element.play().catch(() => setPlaying(false));
    else element.pause();
  }, [activeAsset.url, playing]);
  function seek(nextMs: number): void {
    const bounded = Math.max(0, Math.min(totalMs, nextMs));
    setCurrentMs(bounded);
    const matchedIndex = segments.findIndex((_, index) => bounded < segments.slice(0, index + 1).reduce((total, segment) => total + segment.durationMs, 0));
    const nextIndex = matchedIndex < 0 ? Math.max(0, segments.length - 1) : matchedIndex;
    if (nextIndex === activeIndex && video.current) video.current.currentTime = Math.max(0, (bounded - segmentStartMs) / 1_000);
  }
  function togglePlayback(): void {
    if (!activeSegment?.assetId) return;
    if (currentMs >= totalMs) seek(0);
    setPlaying((current) => !current);
  }
  return <div ref={container} data-alignment-frame className={`story-media-stage story-scene-node-poster${poster ? " has-poster" : ""}`}>
    {poster ? <img src={poster} alt="" /> : <div className="story-scene-node-empty"><Film size={22} /><span>{empty ? "Add video" : preview?.assetId ? "Loading preview" : title}</span></div>}
    {activeAsset.url && (playing || currentMs > 0) ? <video
      ref={video}
      src={activeAsset.url}
      muted={muted}
      playsInline
      onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, (currentMs - segmentStartMs) / 1_000); if (playing) void event.currentTarget.play(); }}
      onTimeUpdate={(event) => setCurrentMs(Math.min(totalMs, segmentStartMs + event.currentTarget.currentTime * 1_000))}
      onEnded={() => {
        const nextStartMs = segmentStartMs + (activeSegment?.durationMs ?? 0);
        if (activeIndex < segments.length - 1) setCurrentMs(nextStartMs);
        else { setCurrentMs(totalMs); setPlaying(false); }
      }}
    /> : null}
    {visible ? <SceneCodeSurface
      key={sceneId}
      files={surfaceFiles}
      context={{
        scene: {
          id: sceneId,
          title,
          mediaIndex: segments.length ? activeIndex : -1,
          mediaCount: segments.length,
          timeMs: localTimeMs,
          durationMs: totalMs,
          playing,
        },
        variables: surfaceVariables,
      }}
      mode="preview"
      title={`${title} code preview`}
      className="story-scene-code-surface"
    /> : null}
    {!empty ? <InlineVideoControls
      label="Scene preview"
      playing={playing}
      currentMs={currentMs}
      totalMs={totalMs}
      muted={muted}
      disabled={!activeSegment?.assetId}
      onToggle={togglePlayback}
      onSeek={seek}
      onToggleMuted={() => setMuted((current) => !current)}
    /> : null}
  </div>;
}

function ChoiceNode({ data, selected }: NodeProps<StoryFlowNode>) {
  const options = data.options ?? [];
  const mediaStyle = { "--story-media-width": "var(--story-canvas-stage-width, 440px)", "--story-media-height": "var(--story-canvas-stage-height, 248px)" } as CSSProperties;
  return <div className={`story-node story-media-node story-node-choice-player${selected ? " is-selected" : ""}`} style={mediaStyle}>
    <Handle className="story-media-input-handle" type="target" position={Position.Left} />
    <div className="story-media-node-label story-scene-node-label">
      <GitBranch size={14} />
      <span><b>Choice</b><strong>{data.title || "Make a choice"}</strong></span>
      {data.timeout?.durationMs ? <time>{formatCompactDuration(data.timeout.durationMs)}</time> : null}
    </div>
    <InheritedScenePoster preview={data.inheritedScenePreview}>
      <StoryPresentationSurfacePreview nodeType="choice" data={data} />
    </InheritedScenePoster>
    <footer className="story-scene-node-meta">
      <span>{options.length} {options.length === 1 ? "option" : "options"}</span>
      {data.timeout?.durationMs ? <><i /><span>Timed</span></> : null}
    </footer>
    {options.map((option, index) => <Handle
      className="story-choice-output-handle"
      id={option.id}
      key={option.id}
      type="source"
      position={Position.Right}
      style={{ top: `${Math.min(88, 42 + (index + 1) * (48 / (options.length + 1)))}%` }}
    />)}
  </div>;
}

function EndingNode({ data, selected }: NodeProps<StoryFlowNode>) {
  const mediaStyle = { "--story-media-width": "var(--story-canvas-stage-width, 440px)", "--story-media-height": "var(--story-canvas-stage-height, 248px)" } as CSSProperties;
  return <div className={`story-node story-media-node story-node-ending-player${selected ? " is-selected" : ""}`} style={mediaStyle}>
    <Handle className="story-media-input-handle" type="target" position={Position.Left} />
    <div className="story-media-node-label story-scene-node-label">
      <CircleStop size={14} />
      <span><b>Ending</b><strong>{data.title || "Untitled ending"}</strong></span>
    </div>
    <InheritedScenePoster preview={data.inheritedScenePreview}>
      <StoryPresentationSurfacePreview nodeType="ending" data={data} />
    </InheritedScenePoster>
    <footer className="story-scene-node-meta"><span>Final ending</span></footer>
  </div>;
}

function StoryPresentationSurfacePreview({ nodeType, data, onAction }: { nodeType: "choice" | "ending"; data: StoryFlowData; onAction?: (action: StoryNodeSurfaceAction) => void }) {
  const variables = Object.fromEntries((data.variables ?? []).flatMap((variable) => [[variable.id, data.previewValues?.[variable.id] ?? variable.initialValue], [variable.name, data.previewValues?.[variable.id] ?? variable.initialValue]]));
  const files = data.presentation?.surface.files ?? (nodeType === "choice" ? DEFAULT_CHOICE_SURFACE_FILES : DEFAULT_ENDING_SURFACE_FILES);
  return <SceneCodeSurface
    files={files}
    context={{
      node: {
        type: nodeType,
        title: data.title ?? "",
        ...(nodeType === "choice" ? { options: (data.options ?? []).map(({ id, label }) => ({ id, label })), ...(data.timeout ? { remainingMs: data.timeout.durationMs, durationMs: data.timeout.durationMs } : {}) } : { description: data.description ?? "" }),
      },
      variables,
    }}
    mode="preview"
    title={`${data.title || nodeType} code preview`}
    className="story-scene-code-surface"
    onAction={onAction}
  />;
}

function InheritedScenePoster({ preview, children, className = "" }: { preview?: InheritedScenePreviewData; children: React.ReactNode; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [poster, setPoster] = useState<string>();
  const asset = useWorkspaceAssetUrl(undefined, "", 0, visible ? preview?.assetId : undefined);
  useEffect(() => {
    const element = container.current;
    if (!element || visible) return;
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    let disposed = false;
    setPoster(undefined);
    if (!asset.url || preview?.mediaType === "image") return;
    void getVideoEndFrame(asset.url).then((frame) => { if (!disposed) setPoster(frame); }).catch(() => {});
    return () => { disposed = true; };
  }, [asset.url, preview?.mediaType]);
  const image = preview?.mediaType === "image" ? asset.url : poster;
  return <div ref={container} data-alignment-frame className={`story-media-stage story-inherited-scene-poster${image ? " has-poster" : ""}${className ? ` ${className}` : ""}`}>
    {image ? <img src={image} alt="" /> : null}
    <div className="story-inherited-scene-scrim" />
    {children}
  </div>;
}

function TextNode({ data, selected }: Pick<NodeProps<StoryFlowNode>, "data" | "selected">) {
  const runtime = data.textRuntime;
  const effectiveModel = data.textModel ?? runtime?.defaultModel;
  const selectedModel = runtime?.models.find((model) => sameAgentModel(model, effectiveModel));
  const modelStateLabel = runtime?.modelStatus === "loading" ? "Loading models..."
    : runtime?.modelStatus === "error" ? "Could not load models"
    : "No language model";
  return (
    <div className={`story-node story-text-node${selected ? " is-selected" : ""}`}>
      <div data-alignment-frame className="story-text-output">
        <div className="story-media-node-label"><FileText size={14} /><span>Text</span></div>
        <textarea
          className="nodrag nowheel"
          aria-label="Text output"
          rows={5}
          value={data.text ?? ""}
          disabled={runtime?.busy}
          readOnly={!selected}
          placeholder="Generated or manually written text"
          onChange={(event) => runtime?.onChange({ ...data, textRuntime: undefined, text: event.target.value })}
        />
      </div>
      {selected ? (
        <div className="story-text-composer nodrag nowheel">
          <textarea
            aria-label="Text generation instruction"
            rows={3}
            value={data.instruction ?? ""}
            disabled={runtime?.busy}
            placeholder="Describe the text you want to generate"
            onChange={(event) => runtime?.onChange({ ...data, textRuntime: undefined, instruction: event.target.value })}
          />
          {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
          <div>
            <select
              aria-label="Text model"
              value={selectedModel ? agentModelKey(selectedModel) : ""}
              disabled={runtime?.busy || !selectedModel}
              onChange={(event) => {
                const model = runtime?.models.find((candidate) => agentModelKey(candidate) === event.target.value);
                if (model) runtime?.onChange({ ...data, textRuntime: undefined, textModel: { provider: model.provider, id: model.id } });
              }}
            >
              {!selectedModel ? <option value="">{modelStateLabel}</option> : null}
              {runtime?.models.map((model) => <option key={agentModelKey(model)} value={agentModelKey(model)}>{model.name}</option>)}
            </select>
            <button type="button" title="Generate text" aria-label="Generate text" disabled={runtime?.busy || !data.instruction?.trim() || !selectedModel} onClick={() => runtime?.onGenerate()}>
              {runtime?.generating ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
            </button>
          </div>
        </div>
      ) : null}
      <Handle className="story-text-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
    </div>
  );
}

function ImageNode({ data, selected }: Pick<NodeProps<StoryFlowNode>, "data" | "selected">) {
  const runtime = data.imageRuntime;
  const selectedModel = runtime?.models.find((model) => sameImageModel(model, data.model));
  const modelOptions = selectedModel?.generationOptions ?? [];
  const resolutions = [...new Set(modelOptions.map((option) => option.resolution))];
  const aspectRatios = [...new Set(modelOptions
    .filter((option) => option.resolution === data.resolution)
    .map((option) => option.aspectRatio))];

  function selectModel(key: string): void {
    const model = runtime?.models.find((candidate) => imageModelKey(candidate) === key);
    const option = preferredImageOption(model);
    if (!model || !option || !runtime) return;
    runtime.onChange({ ...data, imageRuntime: undefined, model: { provider: model.provider, id: model.id }, resolution: option.resolution, aspectRatio: option.aspectRatio });
  }

  function selectResolution(resolution: ImageResolution): void {
    const option = selectedModel?.generationOptions.find((candidate) => candidate.resolution === resolution && candidate.aspectRatio === data.aspectRatio)
      ?? selectedModel?.generationOptions.find((candidate) => candidate.resolution === resolution);
    if (!option || !runtime) return;
    runtime.onChange({ ...data, imageRuntime: undefined, resolution: option.resolution, aspectRatio: option.aspectRatio });
  }

  return (
    <MediaNodeShell kind="image" selected={selected} assetId={data.assetId} aspectRatio={data.aspectRatio} inputCount={data.images?.length} runtime={runtime}>
      <MediaReferenceStrip runtime={runtime} />
      <MediaPrompt
        kind="image"
        value={data.prompt ?? ""}
        runtime={runtime}
        onChange={(prompt) => runtime?.onChange({ ...data, imageRuntime: undefined, prompt })}
      />
      {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
      <div className="story-media-controls">
        <select aria-label="Image model" value={data.model ? imageModelKey(data.model) : ""} disabled={runtime?.busy} onChange={(event) => selectModel(event.target.value)}>
          {!selectedModel && data.model ? <option value={imageModelKey(data.model)}>Unavailable model</option> : null}
          {!data.model ? <option value="">{runtime?.models.length ? "Select model" : "No image model"}</option> : null}
          {runtime?.models.map((model) => <option key={imageModelKey(model)} value={imageModelKey(model)}>{model.name}</option>)}
        </select>
        <select aria-label="Image aspect ratio" value={data.aspectRatio} disabled={!selectedModel || runtime?.busy} onChange={(event) => runtime?.onChange({ ...data, imageRuntime: undefined, aspectRatio: event.target.value as ImageAspectRatio })}>
          {aspectRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
        </select>
        <select aria-label="Image resolution" value={data.resolution} disabled={!selectedModel || runtime?.busy} onChange={(event) => selectResolution(event.target.value as ImageResolution)}>
          {resolutions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
        </select>
        <GenerateMediaButton kind="image" assetId={data.assetId} runtime={runtime} disabled={!effectivePrompt(data, runtime).trim() || !selectedModel} />
      </div>
    </MediaNodeShell>
  );
}

function VideoNode({ data, selected }: Pick<NodeProps<StoryFlowNode>, "data" | "selected">) {
  const runtime = data.videoRuntime;
  const referenceError = runtime?.references.some((reference) => reference.type === "audio") && !validVideoReferenceCombination(runtime.references)
    ? "Add an image or video to use an audio reference."
    : undefined;
  return (
    <MediaNodeShell kind="video" selected={selected} assetId={data.assetId} aspectRatio={data.videoAspectRatio} inputCount={data.references?.length} runtime={runtime}>
      <MediaReferenceStrip runtime={runtime} />
      <MediaPrompt
        kind="video"
        value={data.prompt ?? ""}
        runtime={runtime}
        onChange={(prompt) => runtime?.onChange({ ...data, videoRuntime: undefined, prompt })}
      />
      {runtime?.error || referenceError ? <p role="alert">{runtime?.error ?? referenceError}</p> : null}
      <div className="story-media-controls">
        <select aria-label="Video model" value={data.videoModel ?? VIDEO_MODEL} disabled={runtime?.busy} onChange={() => undefined}>
          <option value={VIDEO_MODEL}>Seedance 2.0</option>
        </select>
        <select aria-label="Video aspect ratio" value={data.videoAspectRatio ?? "adaptive"} disabled={runtime?.busy} onChange={(event) => runtime?.onChange({ ...data, videoRuntime: undefined, videoAspectRatio: event.target.value as VideoAspectRatio })}>
          {VIDEO_ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
        </select>
        <select aria-label="Video resolution" value={data.videoResolution ?? "720p"} disabled={runtime?.busy} onChange={(event) => runtime?.onChange({ ...data, videoRuntime: undefined, videoResolution: event.target.value as VideoResolution })}>
          {VIDEO_RESOLUTIONS.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
        </select>
        <select aria-label="Video duration" value={data.duration ?? 6} disabled={runtime?.busy} onChange={(event) => runtime?.onChange({ ...data, videoRuntime: undefined, duration: Number(event.target.value) })}>
          {Array.from({ length: 12 }, (_, index) => index + 4).map((duration) => <option key={duration} value={duration}>{duration}s</option>)}
        </select>
        <GenerateMediaButton kind="video" assetId={data.assetId} runtime={runtime} disabled={!effectivePrompt(data, runtime).trim() || Boolean(referenceError)} />
      </div>
    </MediaNodeShell>
  );
}

function AssetNode({ data, selected }: Pick<NodeProps<StoryFlowNode>, "data" | "selected">) {
  const kind = data.mediaType ?? "image";
  const preview = useWorkspaceAssetUrl(undefined, "", 0, kind === "audio" ? undefined : data.assetId);
  const Icon = kind === "video" ? Film : kind === "audio" ? Music2 : ImageIcon;
  const mediaLayout = useMediaNodeLayout(kind === "audio" ? undefined : preview.url);
  const style = kind === "audio" ? { "--story-media-width": "300px", "--story-media-height": "92px" } as CSSProperties : mediaLayout.style;
  return (
    <div className={`story-node story-media-node story-library-asset-node story-library-${kind}-node${selected ? " is-selected" : ""}`} style={style}>
      <div className="story-media-node-label"><Icon size={14} /><span>{data.name || titleCase(kind)}</span><small>Library</small></div>
      <div data-alignment-frame className="story-media-stage">
        {preview.url && kind === "image" ? <img src={preview.url} alt={data.name || "Library image"} onLoad={mediaLayout.onImageLoad} /> : null}
        {preview.url && kind === "video" ? <CanvasVideo src={preview.url} onLoadedMetadata={mediaLayout.onVideoMetadata} /> : null}
        {kind === "audio" ? <div className="story-audio-asset"><Music2 size={25} /><strong>{preview.error ? "Asset unavailable" : "Audio"}</strong>{data.assetDuration ? <span>{formatMediaTime(data.assetDuration)}</span> : null}</div> : null}
        {!preview.url && kind !== "audio" ? <div className="story-media-empty"><Icon size={34} /><strong>{preview.error ? "Asset unavailable" : "Loading asset..."}</strong></div> : null}
      </div>
      <Handle className="story-media-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
    </div>
  );
}

function MediaPrompt({ kind, value, runtime, onChange }: {
  kind: "image" | "video";
  value: string;
  runtime?: MediaNodeRuntime;
  onChange: (prompt: string) => void;
}) {
  return (
    <textarea
      aria-label={`${kind === "image" ? "Image" : "Video"} prompt`}
      rows={3}
      value={value}
      disabled={runtime?.busy}
      placeholder={`Describe the ${kind} you want to create`}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function MediaReferenceStrip({ runtime }: { runtime?: ReferenceMediaNodeRuntime }) {
  const input = useRef<HTMLInputElement>(null);
  const references = runtime?.references ?? [];
  if (!runtime || (runtime.linkedPrompt === undefined && references.length === 0 && runtime.maxReferences === 0)) return null;
  return (
    <div className="story-media-references" aria-label="References">
      {runtime?.linkedPrompt !== undefined ? <TextReferenceThumbnail runtime={runtime} /> : null}
      {references.map((reference, index) => (
        <MediaReferenceThumbnail
          key={reference.key}
          reference={reference}
          disabled={runtime?.busy}
          onRemove={() => runtime?.onRemoveReference(index)}
        />
      ))}
      {references.length < (runtime?.maxReferences ?? 0) ? (
        <>
          <button
            className="story-media-reference-add"
            type="button"
            title={runtime.addLabel}
            aria-label={runtime.addLabel}
            disabled={runtime?.busy}
            onClick={() => input.current?.click()}
          >
            {runtime?.uploading ? <LoaderCircle className="spin" size={16} /> : <Plus size={18} />}
          </button>
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            accept={runtime.accept}
            multiple
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              runtime?.onUploadReferences(files);
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function TextReferenceThumbnail({ runtime }: { runtime: MediaNodeRuntime }) {
  const text = runtime.linkedPrompt?.trim() ?? "";
  return (
    <div className="story-media-reference story-text-reference is-linked" title={text || "Connected Text node is empty"}>
      <FileText size={19} />
      <span className="story-media-reference-link" aria-label="Connected Text node" />
      <button type="button" title="Disconnect text" aria-label="Disconnect text" disabled={runtime.busy} onClick={runtime.onDisconnectPrompt}><X size={11} /></button>
    </div>
  );
}

function MediaReferenceThumbnail({ reference, disabled, onRemove }: {
  reference: MediaReferenceView;
  disabled?: boolean;
  onRemove: () => void;
}) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, reference.type === "audio" ? undefined : reference.assetId);
  return (
    <div className={`story-media-reference${reference.linked ? " is-linked" : ""}`} title={`${reference.label}: ${reference.name}`}>
      {preview.url && reference.type === "image" ? <img src={preview.url} alt={reference.name} /> : null}
      {preview.url && reference.type === "video" ? <video src={preview.url} muted playsInline preload="metadata" /> : null}
      {reference.type === "audio" || !preview.url ? reference.type === "audio" ? <Music2 size={18} /> : reference.type === "video" ? <Film size={18} /> : <ImageIcon size={18} /> : null}
      <small>{{ image: "I", video: "V", audio: "A" }[reference.type]}{reference.label.split(" ")[1]}</small>
      {reference.linked ? <span className="story-media-reference-link" aria-label={`Connected ${reference.type} node`} /> : null}
      <button type="button" title={`Remove ${reference.name}`} aria-label={`Remove ${reference.name}`} disabled={disabled} onClick={onRemove}>
        <X size={11} />
      </button>
    </div>
  );
}

function MediaNodeShell({ kind, selected, assetId, aspectRatio, inputCount = 0, runtime, children }: {
  kind: "image" | "video";
  selected: boolean;
  assetId?: string;
  aspectRatio?: ImageAspectRatio | VideoAspectRatio;
  inputCount?: number;
  runtime?: MediaNodeRuntime;
  children: React.ReactNode;
}) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, assetId);
  const Icon = kind === "image" ? ImageIcon : Film;
  const label = kind === "image" ? "Image" : "Video";
  const mediaLayout = useMediaNodeLayout(preview.url, aspectRatio);
  return (
    <div className={`story-node story-media-node${selected ? " is-selected" : ""}`} style={mediaLayout.style}>
      <div className="story-media-node-label"><Icon size={14} /><span>{label}{inputCount ? ` · ${inputCount} ${kind === "video" ? "references" : inputCount === 1 ? "image" : "images"}` : ""}</span></div>
      <div data-alignment-frame className="story-media-stage">
        {preview.url && kind === "image" ? <img src={preview.url} alt="Generated image" onLoad={mediaLayout.onImageLoad} /> : null}
        {preview.url && kind === "video" ? <CanvasVideo src={preview.url} onLoadedMetadata={mediaLayout.onVideoMetadata} /> : null}
        {!preview.url ? (
          <div className="story-media-empty">
            <Icon size={34} />
            <strong>{runtime?.generating ? `Generating ${kind}...` : `No ${kind} yet`}</strong>
            <span>{runtime?.generating ? "This can take a moment" : `Describe a ${kind} below, then generate`}</span>
          </div>
        ) : null}
        {runtime?.generating && preview.url ? <div className="story-media-running"><span className="spin"><LoaderCircle size={18} /></span>Generating...</div> : null}
      </div>
      <Handle className="story-media-input-handle" type="target" position={Position.Left} />
      <Handle className="story-media-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
      {selected ? <div className="story-media-composer nodrag nowheel">{children}</div> : null}
    </div>
  );
}

function CanvasVideo({ src, onLoadedMetadata }: {
  src: string;
  onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  function updateDuration(element: HTMLVideoElement): void {
    setDuration(Number.isFinite(element.duration) ? element.duration : 0);
  }

  function togglePlayback(): void {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play();
    else element.pause();
  }

  return (
    <>
      <video
        ref={video}
        className="story-canvas-video"
        src={src}
        draggable={false}
        muted={muted}
        playsInline
        preload="metadata"
        onDurationChange={(event) => updateDuration(event.currentTarget)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(event) => {
          updateDuration(event.currentTarget);
          onLoadedMetadata(event);
        }}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
      />
      <InlineVideoControls
        label="Video"
        playing={playing}
        currentMs={currentTime * 1_000}
        totalMs={duration * 1_000}
        muted={muted}
        disabled={!duration}
        onToggle={togglePlayback}
        onSeek={(nextMs) => {
          const nextTime = nextMs / 1_000;
          if (video.current) video.current.currentTime = nextTime;
          setCurrentTime(nextTime);
        }}
        onToggleMuted={() => setMuted((current) => !current)}
      />
    </>
  );
}

function InlineVideoControls({ label, playing, currentMs, totalMs, muted, disabled = false, markers = [], onToggle, onSeek, onToggleMuted }: {
  label: string;
  playing: boolean;
  currentMs: number;
  totalMs: number;
  muted: boolean;
  disabled?: boolean;
  markers?: Array<{ id: string; timeMs: number; blocking?: boolean }>;
  onToggle: () => void;
  onSeek: (timeMs: number) => void;
  onToggleMuted: () => void;
}) {
  const duration = Math.max(0, totalMs);
  const current = Math.max(0, Math.min(currentMs, duration));
  const progress = duration ? current / duration * 100 : 0;
  return <div className="story-inline-video-controls nodrag nowheel" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <button type="button" title={playing ? `Pause ${label}` : `Play ${label}`} aria-label={playing ? `Pause ${label}` : `Play ${label}`} disabled={disabled} onClick={onToggle}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
    <time>{formatPreviewTime(current)}</time>
    <div className="story-inline-video-scrubber">
      {markers.length ? <div className="story-inline-video-markers" aria-hidden="true">{markers.map((marker) => <i key={marker.id} className={marker.blocking ? "is-blocking" : ""} style={{ left: `${duration ? Math.max(0, Math.min(100, marker.timeMs / duration * 100)) : 0}%` }} />)}</div> : null}
      <input aria-label={`${label} position`} type="range" min={0} max={duration} step={40} value={current} disabled={disabled} style={{ "--video-progress": `${progress}%` } as CSSProperties} onChange={(event) => onSeek(Number(event.target.value))} />
    </div>
    <time>{formatPreviewTime(duration)}</time>
    <button type="button" title={muted ? `Unmute ${label}` : `Mute ${label}`} aria-label={muted ? `Unmute ${label}` : `Mute ${label}`} disabled={disabled} onClick={onToggleMuted}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
  </div>;
}

function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function useMediaNodeLayout(source?: string, fallbackAspectRatio?: ImageAspectRatio | VideoAspectRatio): {
  style: CSSProperties;
  onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
  onVideoMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
} {
  const [intrinsic, setIntrinsic] = useState<{ source?: string; ratio: number }>();
  const fallback = parseAspectRatio(fallbackAspectRatio);
  const size = fitMediaNode(intrinsic && intrinsic.source === source ? intrinsic.ratio : fallback);

  function remember(width: number, height: number): void {
    if (width > 0 && height > 0) setIntrinsic({ source, ratio: width / height });
  }

  return {
    style: {
      "--story-media-width": `${size.width}px`,
      "--story-media-height": `${size.height}px`,
    } as CSSProperties,
    onImageLoad: (event) => remember(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight),
    onVideoMetadata: (event) => remember(event.currentTarget.videoWidth, event.currentTarget.videoHeight),
  };
}

function parseAspectRatio(value?: ImageAspectRatio | VideoAspectRatio): number | undefined {
  if (!value || value === "adaptive") return undefined;
  const [width, height] = value.split(":").map(Number);
  return width && height ? width / height : undefined;
}

function fitMediaNode(aspectRatio = 16 / 10): { width: number; height: number } {
  const widthAtMaxHeight = MEDIA_NODE_MAX_HEIGHT * aspectRatio;
  const width = Math.min(MEDIA_NODE_MAX_WIDTH, Math.max(MEDIA_NODE_MIN_WIDTH, widthAtMaxHeight));
  const height = Math.min(MEDIA_NODE_MAX_HEIGHT, Math.max(MEDIA_NODE_MIN_HEIGHT, width / aspectRatio));
  return { width: Math.round(width), height: Math.round(height) };
}

function GenerateMediaButton({ kind, assetId, runtime, disabled }: {
  kind: "image" | "video";
  assetId?: string;
  runtime?: MediaNodeRuntime;
  disabled: boolean;
}) {
  const label = assetId ? `Generate ${kind} again` : `Generate ${kind}`;
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled || runtime?.busy} onClick={() => runtime?.onGenerate()}>
      {runtime?.generating ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
    </button>
  );
}

function StoryNodeHeading({ icon, type, title }: { icon: React.ReactNode; type: string; title: string }) {
  return <div className="story-node-heading"><span>{icon}{type}</span><strong>{title}</strong></div>;
}

function ChoiceConditionRule({ variables, value, onChange, label = "Show when", emptyLabel = "Always" }: { variables: StoryVariable[]; value?: StoryVariableCondition; onChange: (value?: StoryVariableCondition) => void; label?: string; emptyLabel?: string }) {
  const variable = variables.find((candidate) => candidate.id === value?.variableId);
  return <div className="story-choice-rule"><span>{label}</span><select value={variable?.id ?? ""} onChange={(event) => {
    const next = variables.find((candidate) => candidate.id === event.target.value);
    onChange(next ? { variableId: next.id, operator: "equals", value: defaultVariableValue(next.type) } : undefined);
  }}><option value="">{emptyLabel}</option>{variables.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name || "Unnamed variable"}</option>)}</select>{variable && value ? <><select value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as StoryVariableCondition["operator"] })}>
    <option value="equals">is</option><option value="not-equals">is not</option>{variable.type === "number" ? <><option value="greater-than">is greater than</option><option value="less-than">is less than</option></> : null}
  </select><VariableValueInput variable={variable} value={value.value} label="Condition value" onChange={(next) => onChange({ ...value, value: next })} /></> : null}</div>;
}

function ChoiceActionsEditor({ variables, value, onChange }: { variables: StoryVariable[]; value: StoryAction[]; onChange: (value: StoryAction[]) => void }) {
  const numberVariables = variables.filter((variable) => variable.type === "number");
  return <div className="story-choice-actions">
    <span>Actions</span>
    {value.map((action, index) => {
      const availableVariables = action.type === "increment-variable" ? numberVariables : variables;
      const variable = availableVariables.find((candidate) => candidate.id === action.variableId);
      return <div className="story-choice-action" key={`${action.type}:${action.variableId}:${index}`}>
        <select aria-label={`Action ${index + 1} type`} value={action.type} onChange={(event) => {
          const type = event.target.value as StoryAction["type"];
          const nextVariable = type === "increment-variable" ? numberVariables[0] : variables[0];
          const next: StoryAction | undefined = type === "increment-variable"
              ? nextVariable ? { type, variableId: nextVariable.id, amount: 1 } : undefined
              : nextVariable ? { type, variableId: nextVariable.id, value: defaultVariableValue(nextVariable.type) } : undefined;
          if (!next) return;
          onChange(value.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate));
        }}>
          <option value="set-variable">Set</option>
          <option value="increment-variable" disabled={!numberVariables.length}>Change by</option>
        </select>
        <select aria-label={`Action ${index + 1} variable`} value={variable?.id ?? ""} onChange={(event) => {
          const nextVariable = availableVariables.find((candidate) => candidate.id === event.target.value);
          if (!nextVariable) return;
          const next: StoryAction = action.type === "increment-variable"
            ? { ...action, variableId: nextVariable.id }
            : { ...action, variableId: nextVariable.id, value: defaultVariableValue(nextVariable.type) };
          onChange(value.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate));
        }}>
          {availableVariables.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name || "Unnamed variable"}</option>)}
        </select>
        {variable && action.type === "set-variable" ? <VariableValueInput variable={variable} value={action.value} label={`Action ${index + 1} value`} onChange={(next) => onChange(value.map((candidate, candidateIndex) => candidateIndex === index ? { ...action, value: next } : candidate))} /> : null}
        {variable && action.type === "increment-variable" ? <input aria-label={`Action ${index + 1} amount`} type="number" value={action.amount} onChange={(event) => onChange(value.map((candidate, candidateIndex) => candidateIndex === index ? { ...action, amount: Number(event.target.value) } : candidate))} /> : null}
        <button type="button" title="Remove action" aria-label={`Remove action ${index + 1}`} onClick={() => onChange(value.filter((_, candidateIndex) => candidateIndex !== index))}><X size={13} /></button>
      </div>;
    })}
    <button className="story-choice-add-action" type="button" disabled={!variables.length} onClick={() => {
      const variable = variables[0];
      if (variable) onChange([...value, { type: "set-variable", variableId: variable.id, value: defaultVariableValue(variable.type) }]);
    }}><Plus size={13} />Add action</button>
  </div>;
}

function VariableValueInput({ variable, value, label, onChange }: { variable: StoryVariable; value: StoryVariableValue; label: string; onChange: (value: StoryVariableValue) => void }) {
  if (variable.type === "boolean") return <select aria-label={label} value={value === true ? "true" : "false"} onChange={(event) => onChange(event.target.value === "true")}><option value="false">False</option><option value="true">True</option></select>;
  return <input aria-label={label} type={variable.type === "number" ? "number" : "text"} value={String(value)} onChange={(event) => onChange(variable.type === "number" ? Number(event.target.value) : event.target.value)} />;
}

function NodeEditorPage({ node, config, nodes, edges, libraryAssets, variables, onVariablesChange, onNodeChange, onPlaytest, onClose }: {
  node?: StoryFlowNode;
  config: StoryPlayerConfig;
  nodes: StoryFlowNode[];
  edges: Edge[];
  libraryAssets: LibraryAsset[];
  variables: StoryVariable[];
  onVariablesChange: (variables: StoryVariable[]) => void;
  onNodeChange: (data: StoryFlowData, removedHandle?: string | string[]) => void;
  onPlaytest: () => void;
  onClose: () => void;
}) {
  const [sceneMode, setSceneMode] = useState<"design" | "code">("design");
  const isOpenUi = node?.type === "open-ui";
  const title = node?.data.title || node?.data.name || (node ? titleCase(node.type) : "Untitled node");
  useEffect(() => { setSceneMode("design"); }, [node?.id]);
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => { if (event.data?.type === "ohmygame:start-story") onPlaytest(); };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onPlaytest]);
  return <section className="story-node-editor-page" aria-label={`${title} editor`}>
    <header className="story-node-editor-header">
      <StoryEditorBreadcrumb label={isOpenUi ? "Open UI" : title} onClose={onClose} />
      {(isOpenUi || Boolean(node && ["scene", "interaction", "choice", "ending"].includes(node.type))) ? <div className="story-node-editor-mode" role="group" aria-label={isOpenUi ? "Open UI editor section" : "Node editor mode"}>
        <button type="button" className={sceneMode === "design" ? "is-active" : ""} aria-pressed={sceneMode === "design"} onClick={() => setSceneMode("design")}>Design</button>
        <button type="button" className={sceneMode === "code" ? "is-active" : ""} aria-pressed={sceneMode === "code"} onClick={() => setSceneMode("code")}>Code</button>
      </div> : null}
    </header>
    {node?.type === "open-ui" ? <OpenUiWorkbench mode={sceneMode} node={node} config={config} libraryAssets={libraryAssets} onChange={onNodeChange} onPlaytest={onPlaytest} />
      : node && sceneMode === "code" && (node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending") ? <StoryPresentationCodeWorkbench node={node} />
      : node?.type === "project-state" ? <StateEditorPage node={node} variables={variables} onVariablesChange={onVariablesChange} onNodeChange={onNodeChange} />
      : node?.type === "scene" ? <SceneWorkbench mode="design" node={node} nodes={nodes} viewport={config.viewport} videoFit={config.videoFit} libraryAssets={libraryAssets} variables={variables} onChange={onNodeChange} />
      : node?.type === "interaction" ? <InteractionWorkbench node={node} nodes={nodes} edges={edges} libraryAssets={libraryAssets} variables={variables} onChange={onNodeChange} />
      : node?.type === "choice" ? <ChoiceWorkbench node={node} nodes={nodes} edges={edges} libraryAssets={libraryAssets} variables={variables} onChange={onNodeChange} />
      : node?.type === "ending" ? <EndingWorkbench node={node} nodes={nodes} edges={edges} libraryAssets={libraryAssets} variables={variables} onChange={onNodeChange} onPlaytest={onPlaytest} />
      : <div className="story-node-editor-content"><div className="story-node-editor-main"><div className="story-node-editor-preview"><span>{node?.type ?? "Node"}</span><h1>{title}</h1><p>Node editor preview</p></div></div></div>}
  </section>;
}

function StoryEditorBreadcrumb({ label, onClose }: { label: string; onClose: () => void }) {
  return <nav className="story-node-editor-breadcrumb" aria-label="Breadcrumb"><button type="button" onClick={onClose}>Canvas</button><ChevronRight size={12} aria-hidden="true" /><strong>{label}</strong></nav>;
}

function NodeWorkbenchLayout({ className, preview, inspector, timeline }: {
  className: string;
  preview: React.ReactNode;
  inspector: React.ReactNode;
  timeline: React.ReactNode;
}) {
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(340);
  const workbench = useRef<HTMLDivElement>(null);
  const resize = useRef<{ pointerId: number } | undefined>(undefined);

  function constrainedInspectorWidth(clientX: number): number {
    const bounds = workbench.current?.getBoundingClientRect();
    if (!bounds) return inspectorWidth;
    const maximum = Math.max(280, Math.min(480, bounds.width - 420));
    return Math.round(Math.max(280, Math.min(maximum, bounds.right - clientX - 5)));
  }

  function finishResize(target: HTMLDivElement, pointerId: number, clientX: number): void {
    if (resize.current?.pointerId !== pointerId) return;
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    const width = constrainedInspectorWidth(clientX);
    workbench.current?.style.setProperty("--story-workbench-inspector-width", `${width}px`);
    workbench.current?.classList.remove("is-resizing-inspector");
    resize.current = undefined;
    setInspectorWidth(width);
  }

  return <div
    ref={workbench}
    className={`story-node-workbench ${className}${inspectorOpen ? " has-inspector" : " is-inspector-collapsed"}${timeline ? " has-timeline" : ""}`}
    style={{ "--story-workbench-inspector-width": `${inspectorWidth}px` } as CSSProperties}
  >
    <div className="story-node-workbench-stage">
      <div className="story-node-workbench-preview">{preview}</div>
      {inspectorOpen ? <div
        className="story-node-workbench-resizer"
        role="separator"
        aria-label="Resize inspector"
        aria-orientation="vertical"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = Math.max(280, Math.min(480, inspectorWidth + (event.key === "ArrowLeft" ? 16 : -16)));
          setInspectorWidth(next);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          resize.current = { pointerId: event.pointerId };
          workbench.current?.classList.add("is-resizing-inspector");
        }}
        onPointerMove={(event) => {
          if (resize.current?.pointerId !== event.pointerId) return;
          workbench.current?.style.setProperty("--story-workbench-inspector-width", `${constrainedInspectorWidth(event.clientX)}px`);
        }}
        onPointerUp={(event) => finishResize(event.currentTarget, event.pointerId, event.clientX)}
        onPointerCancel={(event) => finishResize(event.currentTarget, event.pointerId, event.clientX)}
        onLostPointerCapture={() => {
          workbench.current?.classList.remove("is-resizing-inspector");
          resize.current = undefined;
        }}
      /> : null}
      {inspectorOpen ? <div className="story-node-workbench-inspector">{inspector}</div> : null}
      <button
        className="story-node-workbench-inspector-toggle"
        type="button"
        title={inspectorOpen ? "Hide inspector" : "Show inspector"}
        aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
        aria-expanded={inspectorOpen}
        onClick={() => setInspectorOpen((open) => !open)}
      ><PanelToggle size={15} /></button>
    </div>
    {timeline ? <div className="story-node-workbench-timeline">{timeline}</div> : null}
  </div>;
}

function InteractionWorkbench({ node, nodes, edges, libraryAssets, variables, onChange }: {
  node: StoryFlowNode;
  nodes: StoryFlowNode[];
  edges: Edge[];
  libraryAssets: LibraryAsset[];
  variables: StoryVariable[];
  onChange: (data: StoryFlowData, removedHandle?: string | string[]) => void;
}) {
  const preview = resolvedPresentationPreview(node, nodes, edges, libraryAssets);
  const files = node.data.presentation?.surface.files ?? DEFAULT_SCENE_SURFACE_FILES;
  const design = <section className="story-choice-ending-preview" aria-label="Interaction live preview">
    <div className="story-choice-ending-frame">
      <InheritedScenePoster preview={preview} className="story-choice-ending-stage">
        <StoryInteractionSurface files={files} mode="preview" title={`${node.data.title || "Interaction"} preview`} className="story-interaction-workbench-surface" />
      </InheritedScenePoster>
    </div>
  </section>;
  const inspector = <StoryInspector libraryAssets={libraryAssets} nodes={nodes} node={node} variables={variables} hideHeader hideDelete onChange={onChange} onClose={() => {}} onDelete={() => {}} />;
  return <NodeWorkbenchLayout className="story-interaction-workbench" preview={design} inspector={inspector} timeline={null} />;
}

function ChoiceWorkbench({ node, nodes, edges, libraryAssets, variables, onChange }: {
  node: StoryFlowNode;
  nodes: StoryFlowNode[];
  edges: Edge[];
  libraryAssets: LibraryAsset[];
  variables: StoryVariable[];
  onChange: (data: StoryFlowData, removedHandle?: string | string[]) => void;
}) {
  const options = node.data.options ?? [];
  const [selectedOptionId, setSelectedOptionId] = useState(options[0]?.id);
  const selectedOption = options.find((option) => option.id === selectedOptionId) ?? options[0];
  const inheritedPreview = resolvedPresentationPreview(node, nodes, edges, libraryAssets);
  const previewValues = Object.fromEntries(variables.map((variable) => [variable.id, variable.initialValue]));

  useEffect(() => {
    if (!options.some((option) => option.id === selectedOptionId)) setSelectedOptionId(options[0]?.id);
  }, [options, selectedOptionId]);

  const preview = <section className="story-choice-ending-preview" aria-label="Choice live preview">
    <div className="story-choice-ending-frame">
      <InheritedScenePoster preview={inheritedPreview} className="story-choice-ending-stage">
        <StoryPresentationSurfacePreview nodeType="choice" data={{ ...node.data, variables, previewValues }} onAction={(action) => { if (action.type === "choose") setSelectedOptionId(action.optionId); }} />
      </InheritedScenePoster>
    </div>
  </section>;

  const inspector = <StoryInspector libraryAssets={libraryAssets} nodes={nodes} node={node} variables={variables} selectedChoiceOptionId={selectedOption?.id} hideHeader hideDelete onSelectChoiceOption={setSelectedOptionId} onChange={onChange} onClose={() => {}} onDelete={() => {}} />;
  return <NodeWorkbenchLayout className="story-choice-workbench" preview={preview} inspector={inspector} timeline={null} />;
}

function EndingWorkbench({ node, nodes, edges, libraryAssets, variables, onChange, onPlaytest }: {
  node: StoryFlowNode;
  nodes: StoryFlowNode[];
  edges: Edge[];
  libraryAssets: LibraryAsset[];
  variables: StoryVariable[];
  onChange: (data: StoryFlowData, removedHandle?: string | string[]) => void;
  onPlaytest: () => void;
}) {
  const inheritedPreview = resolvedPresentationPreview(node, nodes, edges, libraryAssets);
  const previewValues = Object.fromEntries(variables.map((variable) => [variable.id, variable.initialValue]));
  const preview = <section className="story-choice-ending-preview" aria-label="Ending live preview">
    <header><strong>Live Preview</strong><button type="button" onClick={onPlaytest}><Play size={12} fill="currentColor" />Playtest</button></header>
    <div className="story-choice-ending-frame">
      <InheritedScenePoster preview={inheritedPreview} className="story-choice-ending-stage">
        <StoryPresentationSurfacePreview nodeType="ending" data={{ ...node.data, variables, previewValues }} />
      </InheritedScenePoster>
    </div>
  </section>;
  const inspector = <StoryInspector libraryAssets={libraryAssets} nodes={nodes} node={node} variables={variables} hideHeader hideDelete onChange={onChange} onClose={() => {}} onDelete={() => {}} />;
  return <NodeWorkbenchLayout className="story-ending-workbench" preview={preview} inspector={inspector} timeline={null} />;
}

function StoryWorkbenchPreview({ label = "Live Preview", ariaLabel, viewport, hasMedia = false, stageClassName, children }: {
  label?: string;
  ariaLabel: string;
  viewport: StoryPlayerConfig["viewport"];
  hasMedia?: boolean;
  stageClassName?: string;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>();

  useLayoutEffect(() => {
    const container = frame.current;
    if (!container) return;
    const update = () => {
      const scale = Math.min(container.clientWidth / viewport.width, container.clientHeight / viewport.height);
      setStageSize({ width: Math.max(1, viewport.width * scale), height: Math.max(1, viewport.height * scale) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [viewport.height, viewport.width]);

  return <section className="story-workbench-preview" aria-label={ariaLabel}>
    <header><strong>{label}</strong><span>{viewport.width} x {viewport.height}</span></header>
    <div ref={frame} className="story-workbench-preview-frame">
      <div className={`story-workbench-preview-stage${hasMedia ? " has-media" : ""}${stageClassName ? ` ${stageClassName}` : ""}`} style={stageSize}>
        {children}
      </div>
    </div>
  </section>;
}

function OpenUiWorkbench({ mode, node, config, libraryAssets, onChange, onPlaytest }: {
  mode: "design" | "code";
  node: StoryFlowNode;
  config: StoryPlayerConfig;
  libraryAssets: LibraryAsset[];
  onChange: (data: StoryFlowData) => void;
  onPlaytest: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentMs, setCurrentMs] = useState(0);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const presentation = node.data.presentation ?? { media: { mode: "own" as const, items: [] }, surface: { files: structuredClone(DEFAULT_OPEN_UI_CODE) } };
  const mediaItem = presentation.media.mode === "own" ? presentation.media.items[0] : undefined;
  const mediaAssetId = mediaItem?.source.type === "library" ? mediaItem.source.assetId : undefined;
  const selectedVideo = libraryAssets.find((asset) => asset.id === mediaAssetId && asset.mediaType === "video");
  const selectedImage = libraryAssets.find((asset) => asset.id === mediaAssetId && asset.mediaType === "image");
  const selectedBackground = selectedVideo ?? selectedImage;
  const totalMs = Math.max(1_000, Math.round((selectedVideo?.duration ?? 10) * 1_000));
  const previewAsset = useWorkspaceAssetUrl(undefined, "", 0, selectedBackground?.id);

  useEffect(() => {
    setPlaying(false);
    setCurrentMs(0);
  }, [selectedVideo?.id]);
  useEffect(() => {
    if (playing) void previewVideo.current?.play().catch(() => setPlaying(false));
    else previewVideo.current?.pause();
  }, [playing, previewAsset.url]);
  function seek(timeMs: number): void {
    const next = Math.max(0, Math.min(totalMs, timeMs));
    setCurrentMs(next);
    if (previewVideo.current) previewVideo.current.currentTime = next / 1_000;
  }

  function togglePlayback(): void {
    const nextPlaying = !playing;
    if (currentMs >= totalMs) seek(0);
    setPlaying(nextPlaying);
  }

  if (mode === "code") return <StoryPresentationCodeWorkbench node={node} />;

  const preview = <StoryWorkbenchPreview ariaLabel="Open UI live preview" viewport={config.viewport} hasMedia={Boolean(selectedBackground)} stageClassName="story-open-ui-stage">
          {previewAsset.url && selectedImage ? <img src={previewAsset.url} alt="" /> : null}
          {previewAsset.url && selectedVideo ? <video ref={previewVideo} src={previewAsset.url} muted={muted} playsInline preload="auto" onTimeUpdate={(event) => setCurrentMs(Math.round(event.currentTarget.currentTime * 1_000))} onEnded={() => { setCurrentMs(totalMs); setPlaying(false); }} /> : null}
          <OpenUiCanvasSurface data={node.data} viewport={config.viewport} transparent={Boolean(previewAsset.url)} onAction={(action) => { if (action === "enter-game") onPlaytest(); }} />
          {selectedVideo ? <InlineVideoControls
            label="Open UI preview"
            playing={playing}
            currentMs={currentMs}
            totalMs={totalMs}
            muted={muted}
            onToggle={togglePlayback}
            onSeek={seek}
            onToggleMuted={() => setMuted((current) => !current)}
          /> : null}
    </StoryWorkbenchPreview>;
  const inspector = <aside className="story-open-ui-inspector story-inspector" aria-label="Open UI inspector">
        <div className="story-inspector-content">
          <section className="story-open-ui-inspector-section">
            <InspectorField label="Title"><input maxLength={120} value={node.data.content?.title ?? node.data.title ?? ""} onChange={(event) => onChange({ ...node.data, title: event.target.value, content: { ...(node.data.content ?? DEFAULT_OPEN_UI_CONTENT), title: event.target.value } })} /></InspectorField>
          </section>
          <section className="story-open-ui-inspector-section story-open-ui-background">
            <h3>Background</h3>
            {selectedBackground ? <div className="story-open-ui-background-row"><span>{selectedVideo ? <Film size={15} /> : <ImageIcon size={15} />}</span><div><strong>{selectedBackground.name}</strong><small>{selectedVideo ? "Video" : "Image"} · Library</small></div><button type="button" title="Remove background" aria-label="Remove background" onClick={() => onChange({ ...node.data, presentation: { ...presentation, media: { mode: "own", items: [] } } })}><X size={13} /></button></div> : <p>No background selected</p>}
            {!selectedBackground ? <button className="story-field-add" type="button" onClick={() => setPickerOpen(true)}><Plus size={14} />Add background</button> : null}
          </section>
        </div>
        {pickerOpen ? <StoryAssetPicker title="Choose background" assets={libraryAssets.filter((asset) => asset.mediaType === "image" || asset.mediaType === "video")} onClose={() => setPickerOpen(false)} onSelect={(asset) => {
          if (asset.mediaType === "image" || asset.mediaType === "video") onChange({ ...node.data, presentation: { ...presentation, media: { mode: "own", items: [{ id: crypto.randomUUID(), type: asset.mediaType, source: { type: "library", assetId: asset.id } }] } } });
          setPickerOpen(false);
        }} /> : null}
      </aside>;
  return <NodeWorkbenchLayout
    className="story-open-ui-workbench"
    preview={preview}
    inspector={inspector}
    timeline={null}
  />;
}

interface SceneTimelineSegment {
  item: StorySceneMedia;
  index: number;
  assetId?: string;
  name: string;
  startMs: number;
  durationMs: number;
}

function sceneTimelineSegments(items: readonly StorySceneMedia[], nodes: readonly StoryFlowNode[], libraryAssets: readonly LibraryAsset[]): SceneTimelineSegment[] {
  let offsetMs = 0;
  return items.map((item, index) => {
    const source = item.source;
    const sourceNode = source.type === "node" ? nodes.find((candidate) => candidate.id === source.nodeId) : undefined;
    const assetId = source.type === "library" ? source.assetId : sourceNode?.data.assetId;
    const asset = libraryAssets.find((candidate) => candidate.id === assetId);
    const durationMs = Math.max(1_000, Math.round((asset?.duration ?? sourceNode?.data.duration ?? 6) * 1_000));
    const segment: SceneTimelineSegment = {
      item,
      index,
      ...(assetId ? { assetId } : {}),
      name: asset?.name ?? `${item.type === "image" ? "Image" : "Video"} ${index + 1}`,
      startMs: offsetMs,
      durationMs,
    };
    offsetMs += durationMs;
    return segment;
  });
}

function resolvedPresentationPreview(node: StoryFlowNode, nodes: readonly StoryFlowNode[], edges: readonly Edge[], libraryAssets: readonly LibraryAsset[]): InheritedScenePreviewData {
  const presentation = flowNodePresentation(node);
  if (presentation.media.mode === "none") return {};
  if (presentation.media.mode === "own") return presentationItemPreview(presentation.media.items.at(-1), nodes, libraryAssets);
  return inheritedPresentationPreview(node.id, nodes, edges, libraryAssets);
}

function inheritedPresentationPreview(nodeId: string, nodes: readonly StoryFlowNode[], edges: readonly Edge[], libraryAssets: readonly LibraryAsset[]): InheritedScenePreviewData {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];
  while (frontier.length) {
    const next: string[] = [];
    for (const targetId of frontier) {
      for (const edge of edges) {
        if (edge.target !== targetId || visited.has(edge.source)) continue;
        visited.add(edge.source);
        const source = nodeById.get(edge.source);
        if (!source || !isVisiblePresentationFlowNode(source)) continue;
        const media = flowNodePresentation(source).media;
        if (media.mode === "own") {
          const preview = presentationItemPreview(media.items.at(-1), nodes, libraryAssets);
          if (preview.assetId) return preview;
          continue;
        }
        if (media.mode === "inherit") next.push(source.id);
      }
    }
    frontier = next;
  }
  return {};
}

function presentationItemPreview(item: StorySceneMedia | undefined, nodes: readonly StoryFlowNode[], libraryAssets: readonly LibraryAsset[]): InheritedScenePreviewData {
  if (!item) return {};
  const source = item.source;
  const assetId = source.type === "library"
    ? source.assetId
    : nodes.find((candidate) => candidate.id === source.nodeId)?.data.assetId;
  return assetId && libraryAssets.some((asset) => asset.id === assetId)
    ? { assetId, mediaType: item.type }
    : { mediaType: item.type };
}

function SceneWorkbench({ mode, node, nodes, viewport, videoFit, libraryAssets, variables, onChange }: {
  mode: "design" | "code";
  node: StoryFlowNode;
  nodes: StoryFlowNode[];
  viewport: StoryPlayerConfig["viewport"];
  videoFit: StoryPlayerConfig["videoFit"];
  libraryAssets: LibraryAsset[];
  variables: StoryVariable[];
  onChange: (data: StoryFlowData, removedHandle?: string | string[]) => void;
}) {
  const presentationMedia = node.data.presentation?.media;
  const items = presentationMedia?.mode === "own" ? presentationMedia.items : [];
  const segments = useMemo(() => sceneTimelineSegments(items, nodes, libraryAssets), [items, libraryAssets, nodes]);
  const totalMs = Math.max(1_000, segments.reduce((total, segment) => total + segment.durationMs, 0));
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const active = segments.find((segment) => currentMs >= segment.startMs && currentMs < segment.startMs + segment.durationMs) ?? segments.at(-1);
  const localTimeMs = active ? Math.max(0, currentMs - active.startMs) : 0;
  const surfaceVariables = Object.fromEntries(variables.flatMap((variable) => [[variable.id, variable.initialValue], [variable.name, variable.initialValue]]));
  useEffect(() => { setCurrentMs((current) => Math.min(current, totalMs)); }, [totalMs]);

  function changePlaying(nextPlaying: boolean): void {
    if (currentMs >= totalMs) {
      setCurrentMs(0);
    }
    setPlaying(nextPlaying);
  }

  const preview = <SceneWorkbenchVideo assetId={active?.assetId} sceneId={node.id} title={active?.name ?? node.data.title ?? "Scene"} sceneTitle={node.data.title ?? "Scene"} viewport={viewport} videoFit={videoFit} mediaIndex={active?.index ?? -1} mediaCount={items.length} surfaceFiles={node.data.presentation?.surface.files ?? DEFAULT_SCENE_SURFACE_FILES} surfaceVariables={surfaceVariables} localTimeMs={localTimeMs} playing={playing} currentMs={currentMs} totalMs={totalMs} onPlayingChange={changePlaying} onSeek={setCurrentMs} onTime={(timeMs) => {
        setCurrentMs(Math.min(totalMs, (active?.startMs ?? 0) + timeMs));
      }} onEnded={() => {
        const next = active ? segments[active.index + 1] : undefined;
        if (next) setCurrentMs(next.startMs);
        else { setCurrentMs(totalMs); setPlaying(false); }
      }} />;
  const inspector = <StoryInspector libraryAssets={libraryAssets} nodes={nodes} node={node} variables={variables} hideHeader hideDelete onChange={onChange} onClose={() => {}} onDelete={() => {}} />;
  if (mode === "code") return <StoryPresentationCodeWorkbench node={node} />;
  return <NodeWorkbenchLayout className="story-scene-workbench" preview={preview} inspector={inspector} timeline={null} />;
}

function StoryPresentationCodeWorkbench({ node }: {
  node: StoryFlowNode;
}) {
  const [file, setFile] = useState<keyof StorySurfaceFiles>("html");
  const fallback = node.type === "open-ui" ? DEFAULT_OPEN_UI_CODE : node.type === "choice" ? DEFAULT_CHOICE_SURFACE_FILES : node.type === "ending" ? DEFAULT_ENDING_SURFACE_FILES : DEFAULT_SCENE_SURFACE_FILES;
  const files = node.data.presentation?.surface.files ?? fallback;
  const source = node.data.presentation?.surface.source ?? defaultStoryNodeSource(node.id);
  const paths: Record<keyof StorySurfaceFiles, string> = {
    html: source.html,
    css: source.css,
    javascript: source.javascript,
  };

  return <div className="story-scene-code-workbench code-view">
    <aside className="file-explorer" aria-label={`${node.type} files`}>
      <nav className="story-scene-file-tree">
        {(Object.keys(paths) as (keyof StorySurfaceFiles)[]).map((name) => {
          const path = paths[name];
          return <button key={name} type="button" className={file === name ? "is-active" : ""} aria-pressed={file === name} title={path} onClick={() => setFile(name)}>
            <FileText size={13} aria-hidden="true" />
            <span>{path.split("/").at(-1)}</span>
          </button>;
        })}
      </nav>
    </aside>
    <section className="file-content" aria-label={`${node.type} code`}>
      <div className="file-content-header">{paths[file]}</div>
      <HighlightedCode path={paths[file]} content={files[file]} />
    </section>
  </div>;
}

function SceneWorkbenchVideo({ assetId, sceneId, title, sceneTitle, viewport, videoFit, mediaIndex, mediaCount, surfaceFiles, surfaceVariables, localTimeMs, playing, currentMs, totalMs, onPlayingChange, onSeek, onTime, onEnded }: { assetId?: string; sceneId: string; title: string; sceneTitle: string; viewport: StoryPlayerConfig["viewport"]; videoFit: StoryPlayerConfig["videoFit"]; mediaIndex: number; mediaCount: number; surfaceFiles: StorySurfaceFiles; surfaceVariables: Record<string, StoryVariableValue>; localTimeMs: number; playing: boolean; currentMs: number; totalMs: number; onPlayingChange: (playing: boolean) => void; onSeek: (timeMs: number) => void; onTime: (timeMs: number) => void; onEnded: () => void }) {
  const asset = useWorkspaceAssetUrl(undefined, "", 0, assetId);
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  useEffect(() => { if (video.current && Math.abs(video.current.currentTime * 1_000 - localTimeMs) > 250) video.current.currentTime = localTimeMs / 1_000; }, [assetId, localTimeMs]);
  useEffect(() => { if (!video.current) return; if (playing) void video.current.play().catch(() => onPlayingChange(false)); else video.current.pause(); }, [asset.url, onPlayingChange, playing]);
  return <StoryWorkbenchPreview ariaLabel="Scene live preview" viewport={viewport} hasMedia={Boolean(assetId)} stageClassName="story-scene-media">
      {asset.url ? <video key={assetId} ref={video} src={asset.url} muted={muted} playsInline style={{ objectFit: videoFit }} onClick={() => onPlayingChange(!playing)} onTimeUpdate={(update) => onTime(Math.round(update.currentTarget.currentTime * 1_000))} onEnded={onEnded} /> : <div className="story-scene-empty"><Film size={28} /><strong>{title}</strong><span>{assetId ? "Loading media..." : "Add media to preview this scene"}</span></div>}
      <SceneCodeSurface key={sceneId} files={surfaceFiles} context={{ scene: { id: sceneId, title: sceneTitle, mediaIndex, mediaCount, timeMs: localTimeMs, durationMs: totalMs, playing }, variables: surfaceVariables }} mode="preview" title={`${sceneTitle} code`} className="story-scene-code-surface" />
      <InlineVideoControls
        label="Scene preview"
        playing={playing}
        currentMs={currentMs}
        totalMs={totalMs}
        muted={muted}
        disabled={!assetId}
        onToggle={() => onPlayingChange(!playing)}
        onSeek={onSeek}
        onToggleMuted={() => setMuted((current) => !current)}
      />
  </StoryWorkbenchPreview>;
}

const timelineFrameCache = new Map<string, Promise<string[]>>();
const videoEndFrameCache = new Map<string, Promise<string>>();

function getTimelineFrames(url: string, count: number): Promise<string[]> {
  const key = `${url}#${count}`;
  const cached = timelineFrameCache.get(key);
  if (cached) return cached;
  const pending = captureTimelineFrames(url, count).catch((error) => {
    timelineFrameCache.delete(key);
    throw error;
  });
  timelineFrameCache.set(key, pending);
  if (timelineFrameCache.size > 24) timelineFrameCache.delete(timelineFrameCache.keys().next().value!);
  return pending;
}

function getVideoEndFrame(url: string): Promise<string> {
  const cached = videoEndFrameCache.get(url);
  if (cached) return cached;
  const pending = captureVideoEndFrame(url).catch((error) => {
    videoEndFrameCache.delete(url);
    throw error;
  });
  videoEndFrameCache.set(url, pending);
  if (videoEndFrameCache.size > 24) videoEndFrameCache.delete(videoEndFrameCache.keys().next().value!);
  return pending;
}

async function captureVideoEndFrame(url: string): Promise<string> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitForVideoEvent(video, "loadedmetadata");
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("Video has no readable duration");
    video.currentTime = Math.max(0, video.duration - Math.min(0.05, video.duration / 2));
    await waitForVideoEvent(video, "seeked");
    const canvas = document.createElement("canvas");
    canvas.width = 440;
    canvas.height = 248;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create video preview canvas");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

async function captureTimelineFrames(url: string, count: number): Promise<string[]> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitForVideoEvent(video, "loadedmetadata");
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 135;
    const context = canvas.getContext("2d");
    if (!context || !Number.isFinite(video.duration) || video.duration <= 0) return [];
    const frames: string[] = [];
    for (let index = 0; index < count; index += 1) {
      video.currentTime = Math.min(Math.max(0, video.duration - 0.05), video.duration * (index + 0.5) / count);
      await waitForVideoEvent(video, "seeked");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.82));
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: "loadedmetadata" | "seeked"): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error(`Timed out waiting for video ${eventName}`)), 4_000);
    const onReady = () => finish();
    const onError = () => finish(new Error("Could not read video frames"));
    function finish(error?: Error): void {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener("error", onError);
      if (error) reject(error); else resolve();
    }
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function formatTimelineTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.floor(timeMs % 1_000 / 40);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

function formatCompactDuration(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.round(timeMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatPreviewTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1_000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function StoryInspector({
  libraryAssets,
  nodes,
  node,
  variables,
  selectedChoiceOptionId,
  hideHeader = false,
  hideDelete = false,
  onSelectChoiceOption,
  onChange,
  onClose,
  onDelete,
}: {
  libraryAssets: LibraryAsset[];
  nodes: StoryFlowNode[];
  node: StoryFlowNode;
  variables: StoryVariable[];
  selectedChoiceOptionId?: string;
  hideHeader?: boolean;
  hideDelete?: boolean;
  onSelectChoiceOption?: (optionId: string) => void;
  onChange: (data: StoryFlowData, removedHandle?: string | string[]) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const label = node.type[0]?.toUpperCase() + node.type.slice(1);
  const [choiceDrag, setChoiceDrag] = useState<{ sourceId: string; targetId?: string; before?: boolean }>();

  function dropChoiceOption(targetId: string): void {
    if (node.type !== "choice") return;
    const sourceId = choiceDrag?.sourceId;
    const options = node.data.options ?? [];
    if (!sourceId || sourceId === targetId) { setChoiceDrag(undefined); return; }
    const sourceIndex = options.findIndex((option) => option.id === sourceId);
    const targetIndex = options.findIndex((option) => option.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) { setChoiceDrag(undefined); return; }
    const next = [...options];
    const [source] = next.splice(sourceIndex, 1);
    if (!source) return;
    const adjustedTarget = next.findIndex((option) => option.id === targetId);
    next.splice(adjustedTarget + (choiceDrag?.before ? 0 : 1), 0, source);
    setChoiceDrag(undefined);
    onChange({ ...node.data, options: next });
  }

  return (
    <aside className="story-inspector" aria-label={`${label} inspector`}>
      {!hideHeader ? <header>
        <div><span>{label}</span><strong>{inspectorTitle(node)}</strong></div>
        <button type="button" title="Close inspector" aria-label="Close inspector" onClick={onClose}><X size={15} /></button>
      </header> : null}
      <div className="story-inspector-content">
        {node.type === "start" ? <p className="story-inspector-help">The first node in this chapter. Connect it to the opening scene.</p> : null}
        {node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending" ? <StoryPresentationMediaEditor node={node} nodes={nodes} libraryAssets={libraryAssets} onChange={onChange} /> : null}
        {node.type === "scene" ? (
          <>
            <InspectorField label="Title">
              <input value={node.data.title ?? ""} onChange={(event) => onChange({ ...node.data, title: event.target.value })} />
            </InspectorField>
          </>
        ) : null}
        {node.type === "interaction" ? (
          <>
            <InspectorField label="Title"><input value={node.data.title ?? ""} onChange={(event) => onChange({ ...node.data, title: event.target.value })} /></InspectorField>
            <div className="story-inspector-section"><span>Behavior</span><strong>{node.data.behavior?.type ?? "continue"}</strong></div>
          </>
        ) : null}
        {node.type === "ending" ? (
          <>
            <InspectorField label="Title">
              <input value={node.data.title ?? ""} onChange={(event) => onChange({ ...node.data, title: event.target.value })} />
            </InspectorField>
            <InspectorField label="Description">
              <textarea rows={6} value={node.data.description ?? ""} onChange={(event) => onChange({ ...node.data, description: event.target.value })} />
            </InspectorField>
          </>
        ) : null}
        {node.type === "choice" ? (
          <>
            <InspectorField label="Prompt">
              <input value={node.data.title ?? ""} onChange={(event) => onChange({ ...node.data, title: event.target.value })} />
            </InspectorField>
            <div className="story-inspector-options">
              <span>Options</span>
              {node.data.options?.map((option, index, options) => (
                <div
                  className={`story-choice-option-editor${selectedChoiceOptionId === option.id ? " is-selected" : ""}${choiceDrag?.sourceId === option.id ? " is-dragging" : ""}${choiceDrag?.targetId === option.id && choiceDrag.before ? " is-drop-before" : ""}${choiceDrag?.targetId === option.id && choiceDrag.before === false ? " is-drop-after" : ""}`}
                  key={option.id}
                  onDragOver={(event) => {
                    if (!choiceDrag?.sourceId || choiceDrag.sourceId === option.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setChoiceDrag({ sourceId: choiceDrag.sourceId, targetId: option.id, before: event.clientY < bounds.top + bounds.height / 2 });
                  }}
                  onDrop={(event) => { event.preventDefault(); dropChoiceOption(option.id); }}
                >
                  <div className="story-choice-option-label">
                    <button
                      type="button"
                      className="story-choice-option-drag"
                      draggable={options.length > 1}
                      disabled={options.length < 2}
                      title="Drag to reorder option"
                      aria-label={`Reorder option ${index + 1}`}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", option.id);
                        setChoiceDrag({ sourceId: option.id });
                      }}
                      onDragEnd={() => setChoiceDrag(undefined)}
                    ><GripVertical size={13} /></button>
                    <span>{index + 1}</span>
                    <input
                      aria-label={`Option ${index + 1}`}
                      value={option.label}
                      onFocus={() => onSelectChoiceOption?.(option.id)}
                      onChange={(event) => onChange({ ...node.data, options: updateChoiceOption(options, option.id, { ...option, label: event.target.value }) })}
                    />
                    <button
                      type="button"
                      title="Remove option"
                      aria-label={`Remove option ${index + 1}`}
                      disabled={options.length === 1}
                      onClick={() => onChange({
                        ...node.data,
                        options: options.filter((current) => current.id !== option.id),
                        ...(node.data.timeout?.defaultOptionId === option.id ? { timeout: undefined } : {}),
                      }, option.id)}
                    ><X size={14} /></button>
                  </div>
                  <div className="story-choice-option-summary">
                    <span><b>When</b>{storyConditionSummary(option.condition, variables)}</span>
                    <span><b>Then</b>{storyActionSummary(option.actions, variables) ?? "No state change"}</span>
                  </div>
                </div>
              ))}
              <button className="story-inspector-add-option" type="button" onClick={() => onChange({
                ...node.data,
                options: [...(node.data.options ?? []), { id: crypto.randomUUID(), label: `Option ${(node.data.options?.length ?? 0) + 1}` }],
              })}><Plus size={14} />Add option</button>
            </div>
            <div className="story-choice-timeout">
              <label><input type="checkbox" checked={Boolean(node.data.timeout)} onChange={(event) => {
                const firstOption = node.data.options?.[0];
                onChange({ ...node.data, timeout: event.target.checked && firstOption ? { durationMs: 8_000, defaultOptionId: firstOption.id } : undefined });
              }} /><span>Time limit</span></label>
              {node.data.timeout ? <div>
                <label><span>Seconds</span><input type="number" min={1} max={300} step={1} value={node.data.timeout.durationMs / 1_000} onChange={(event) => onChange({ ...node.data, timeout: { ...node.data.timeout!, durationMs: Math.round(Math.min(300, Math.max(1, Number(event.target.value) || 1)) * 1_000) } })} /></label>
                <label><span>Default</span><select value={node.data.timeout.defaultOptionId} onChange={(event) => onChange({ ...node.data, timeout: { ...node.data.timeout!, defaultOptionId: event.target.value } })}>{node.data.options?.map((option) => <option key={option.id} value={option.id}>{option.label || "Untitled option"}</option>)}</select></label>
              </div> : null}
            </div>
          </>
        ) : null}
      </div>
      {node.type !== "start" && !hideDelete ? (
        <footer><button type="button" onClick={onDelete}><Trash2 size={14} />Delete node</button></footer>
      ) : null}
    </aside>
  );
}

function StoryPresentationMediaEditor({ node, nodes, libraryAssets, onChange }: {
  node: StoryFlowNode;
  nodes: StoryFlowNode[];
  libraryAssets: LibraryAsset[];
  onChange: (data: StoryFlowData) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const presentation = flowNodePresentation(node);
  const media = presentation.media;
  const item = media.mode === "own" ? media.items.at(-1) : undefined;
  const source = item?.source;
  const sourceNode = source?.type === "node" ? nodes.find((candidate) => candidate.id === source.nodeId) : undefined;
  const assetId = source?.type === "library" ? source.assetId : sourceNode?.data.assetId;
  const asset = libraryAssets.find((candidate) => candidate.id === assetId);
  const setMode = (mode: StoryNodePresentation["media"]["mode"]) => {
    const nextMedia = mode === "own" ? { mode, items: media.mode === "own" ? media.items : [] } as const : { mode } as const;
    onChange({ ...node.data, presentation: { ...presentation, media: nextMedia } });
  };
  return <section className="story-inspector-section story-presentation-media-editor">
    <span>Media</span>
    <div className="story-presentation-media-mode" role="group" aria-label="Media strategy">
      {(["inherit", "own", "none"] as const).map((mode) => <button key={mode} type="button" className={media.mode === mode ? "is-active" : ""} aria-pressed={media.mode === mode} onClick={() => setMode(mode)}>{mode === "inherit" ? "Inherit" : mode === "own" ? "Own" : "None"}</button>)}
    </div>
    {media.mode === "inherit" ? <p>Uses the nearest upstream presentation media.</p> : null}
    {media.mode === "none" ? <p>Renders code without a media layer.</p> : null}
    {media.mode === "own" ? item ? <div className="story-open-ui-background-row">
      <span>{item.type === "video" ? <Film size={15} /> : <ImageIcon size={15} />}</span>
      <div><strong>{asset?.name ?? (sourceNode ? "Connected media" : "Missing media")}</strong><small>{item.type === "video" ? "Video" : "Image"}{item.source.type === "node" ? " · Connected node" : " · Library"}</small></div>
      <button type="button" title="Remove media" aria-label="Remove media" onClick={() => onChange({ ...node.data, presentation: { ...presentation, media: { mode: "own", items: [] } } })}><X size={13} /></button>
    </div> : <button className="story-field-add" type="button" onClick={() => setPickerOpen(true)}><Plus size={14} />Add media</button> : null}
    {pickerOpen ? <StoryAssetPicker title="Choose media" assets={libraryAssets.filter((candidate) => candidate.mediaType === "image" || candidate.mediaType === "video")} onClose={() => setPickerOpen(false)} onSelect={(selected) => {
      const type = selected.mediaType === "video" ? "video" : "image";
      onChange({ ...node.data, presentation: { ...presentation, media: { mode: "own", items: [{ id: crypto.randomUUID(), type, source: { type: "library", assetId: selected.id } }] } } });
      setPickerOpen(false);
    }} /> : null}
  </section>;
}

function StoryAssetPicker({ title, assets, onClose, onSelect }: {
  title: string;
  assets: LibraryAsset[];
  onClose: () => void;
  onSelect: (asset: LibraryAsset) => void;
}) {
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    dialog.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const visibleAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? assets.filter((asset) => `${asset.name} ${asset.prompt ?? ""}`.toLowerCase().includes(normalized))
      : assets;
  }, [query, assets]);

  return createPortal(
    <div className="story-video-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="story-video-picker" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="story-video-picker-title" tabIndex={-1}>
        <header><h2 id="story-video-picker-title">{title}</h2><button type="button" aria-label="Close Library picker" onClick={onClose}><X size={16} /></button></header>
        <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Library" /></label>
        <div className="story-video-picker-list">
          {visibleAssets.length === 0 ? <p>{assets.length ? "No assets match your search" : "No assets in Library"}</p> : null}
          {visibleAssets.map((asset) => {
            const Icon = asset.mediaType === "video" ? Film : asset.mediaType === "audio" ? Music2 : ImageIcon;
            return <button type="button" key={asset.id} onClick={() => onSelect(asset)}>
              <span><Icon size={17} /></span>
              <span><strong>{asset.prompt ?? asset.name}</strong><small>{asset.name}</small></span>
            </button>;
          })}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function createInteractionFromTemplate(template: InteractionTemplate): { behavior: StoryInteractionBehavior; files: StorySurfaceFiles } {
  const outcome: StoryInteractionOutcome = { actions: [] };
  const behavior: StoryInteractionBehavior = template === "actions" || template === "blank"
    ? { type: "actions", actions: [] }
    : template === "continue"
      ? { type: "continue", label: "Continue" }
      : template === "hotspot"
        ? { type: "hotspot", durationMs: 5_000, label: "Click area", region: { x: 0.35, y: 0.35, width: 0.3, height: 0.3 }, success: outcome, timeout: outcome }
        : { type: "qte", durationMs: 3_000, prompt: "Act now", key: "KeyE", success: outcome, timeout: outcome };
  return { behavior, files: createStoryInteractionFiles(behavior) };
}

function nextInteractionName(nodes: readonly StoryFlowNode[]): string {
  const interactions = nodes.filter((node) => node.type === "interaction");
  const used = new Set(interactions.map((node) => node.data.title));
  let number = interactions.length + 1;
  while (used.has(`Interaction ${number}`)) number += 1;
  return `Interaction ${number}`;
}

function InspectorField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="story-inspector-field"><span>{label}</span>{children}</label>;
}

function CanvasToolbar({
  mode,
  canvas,
  hasStart,
  libraryAssets,
  importing,
  reserveInspector,
  onAdd,
  onAddInteraction,
  onAddAsset,
  onUpload,
  onModeChange,
}: {
  mode: InteractionMode;
  canvas: React.RefObject<HTMLDivElement | null>;
  hasStart: boolean;
  libraryAssets: LibraryAsset[];
  importing: boolean;
  reserveInspector: boolean;
  onAdd: (type: Exclude<StoryNodeType, "asset">, position: { x: number; y: number }) => void;
  onAddInteraction: (position: { x: number; y: number }, template?: InteractionTemplate) => void;
  onAddAsset: (asset: LibraryAsset, position: { x: number; y: number }) => void;
  onUpload: (file: File, position: { x: number; y: number }) => void;
  onModeChange: (mode: InteractionMode) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [creationBranch, setCreationBranch] = useState<CanvasNodeCreationBranch>();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const addMenu = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const { fitView, getNodes, screenToFlowPosition, setViewport } = useReactFlow();

  useEffect(() => {
    if (!addOpen) return;

    const closeOutside = (event: PointerEvent) => {
      if (!addMenu.current?.contains(event.target as globalThis.Node)) setAddOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddOpen(false);
    };

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
    const availableWidth = Math.max(0, bounds.width - (reserveInspector ? 300 : 0));
    return screenToFlowPosition({ x: bounds.left + availableWidth / 2, y: bounds.top + bounds.height / 2 });
  }

  function addItem(item: CanvasNodeCreationLeaf): void {
    const position = placementPosition();
    if (!position) return;
    if (item.action.kind === "interaction") onAddInteraction(position, item.action.template);
    else onAdd(item.action.type, position);
    setAddOpen(false);
  }

  return (
    <Panel className="story-canvas-toolbar" position="bottom-center">
      <div ref={addMenu} className="story-add-node">
        {addOpen ? (
          <div className="story-add-node-menu" role="menu" aria-label="Add node">
            {creationBranch ? <>
              <button type="button" role="menuitem" onClick={() => setCreationBranch(undefined)}><ChevronLeft size={15} /><span><strong>{creationBranch.label}</strong><small>All node types</small></span></button>
              {creationBranch.children.map((child) => { const ChildIcon = child.icon; return <button type="button" role="menuitem" key={child.label} onClick={() => addItem(child)}><ChildIcon size={15} /><span><strong>{child.label}</strong><small>{child.description}</small></span></button>; })}
            </> : <>
              {CANVAS_NODE_CREATION_GROUPS.map((group) => <Fragment key={group.label}>
                <span className="story-add-node-menu-label">{group.label}</span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  if (!isCanvasNodeCreationLeaf(item)) return <button type="button" role="menuitem" key={item.label} aria-haspopup="menu" onClick={() => setCreationBranch(item)}><Icon size={15} /><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight className="story-add-node-submenu-arrow" size={13} /></button>;
                  const disabled = item.action.kind === "node" && item.action.type === "start" && hasStart;
                  const description = disabled ? "Only one Start node is allowed" : item.description;
                  return <button type="button" role="menuitem" key={item.label} disabled={disabled} title={disabled ? description : undefined} onClick={() => addItem(item)}><Icon size={15} /><span><strong>{item.label}</strong><small>{description}</small></span></button>;
                })}
              </Fragment>)}
              <button type="button" role="menuitem" disabled={importing} onClick={() => uploadInput.current?.click()}><Upload size={15} /><span><strong>{importing ? "Uploading..." : "Upload"}</strong><small>Add files from this device</small></span></button>
              <button type="button" role="menuitem" onClick={() => { setAddOpen(false); setLibraryOpen(true); }}><Folder size={15} /><span><strong>From Library</strong><small>Use an existing asset</small></span></button>
            </>}
          </div>
        ) : null}
        <input
          ref={uploadInput}
          hidden
          type="file"
          accept={STORY_ASSET_ACCEPT}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            const position = placementPosition();
            if (file && position) onUpload(file, position);
            setAddOpen(false);
          }}
        />
        <button className={addOpen ? "is-active" : undefined} type="button" title="Add node" aria-label="Add node" aria-expanded={addOpen} onClick={() => { setCreationBranch(undefined); setAddOpen((open) => !open); }}>
          <Plus size={18} />
        </button>
      </div>
      <button className={mode === "pointer" ? "is-active" : undefined} type="button" title="Select" aria-label="Select" aria-pressed={mode === "pointer"} onClick={() => onModeChange("pointer")}>
        <MousePointer2 size={18} />
      </button>
      <button className={mode === "pan" ? "is-active" : undefined} type="button" title="Pan canvas" aria-label="Pan canvas" aria-pressed={mode === "pan"} onClick={() => onModeChange("pan")}>
        <Hand size={18} />
      </button>
      <button type="button" title="Fit view" aria-label="Fit view" onClick={() => void fitCanvas()}><Maximize size={18} /></button>
      {libraryOpen ? <StoryAssetPicker title="Add from Library" assets={libraryAssets} onClose={() => setLibraryOpen(false)} onSelect={(asset) => {
        const position = placementPosition();
        if (position) onAddAsset(asset, position);
        setLibraryOpen(false);
      }} /> : null}
    </Panel>
  );
}

function StoryCanvasContextMenu({
  menu,
  canUndo,
  canRedo,
  canPaste,
  canDuplicate,
  hasStart,
  nodeActionsDisabled,
  importing,
  onClose,
  onUndo,
  onRedo,
  onPaste,
  onAdd,
  onUpload,
  onCopy,
  onDuplicate,
  onDelete,
}: {
  menu: CanvasContextMenuState;
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  canDuplicate: boolean;
  hasStart: boolean;
  nodeActionsDisabled: boolean;
  importing: boolean;
  onClose: () => void;
  onUndo: () => unknown;
  onRedo: () => unknown;
  onPaste: () => void;
  onAdd: (item: CanvasNodeCreationLeaf) => void;
  onUpload: (file: File) => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [creationBranch, setCreationBranch] = useState<CanvasNodeCreationBranch>();
  const [position, setPosition] = useState(menu.screenPosition);
  const opensLeft = menu.screenPosition.x > window.innerWidth - 430;
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
    const closeOnResize = () => onClose();
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [onClose]);

  const run = (action: () => unknown) => {
    action();
    onClose();
  };

  return createPortal(
    <div
      ref={root}
      className={`story-canvas-context-menu${opensLeft ? " opens-left" : ""}${opensUp ? " opens-up" : ""}`}
      role="menu"
      aria-label={menu.kind === "pane" ? "Canvas actions" : "Node actions"}
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.kind === "pane" ? <>
        <button type="button" role="menuitem" disabled={!canUndo} onClick={() => run(onUndo)}><Undo2 size={15} /><span>Undo</span></button>
        <button type="button" role="menuitem" disabled={!canRedo} onClick={() => run(onRedo)}><Redo2 size={15} /><span>Redo</span></button>
        <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onPaste)}><Clipboard size={15} /><span>Paste</span></button>
        <div className="story-canvas-context-submenu-root" onPointerEnter={() => setAddOpen(true)}>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={addOpen} onClick={() => setAddOpen(true)}><Plus size={15} /><span>Add node</span><ChevronRight size={13} /></button>
          {addOpen ? <div className="story-canvas-context-submenu" role="menu" aria-label="Add node">
            {creationBranch ? <>
              <button type="button" role="menuitem" onClick={() => setCreationBranch(undefined)}><ChevronLeft size={15} /><span>{creationBranch.label}</span></button>
              {creationBranch.children.map((child) => { const ChildIcon = child.icon; return <button type="button" role="menuitem" key={child.label} onClick={() => run(() => onAdd(child))}><ChildIcon size={15} /><span>{child.label}</span></button>; })}
            </> : CANVAS_NODE_CREATION_GROUPS.map((group) => <Fragment key={group.label}>
              <span className="story-canvas-context-menu-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                if (!isCanvasNodeCreationLeaf(item)) return <button type="button" role="menuitem" key={item.label} aria-haspopup="menu" onClick={() => setCreationBranch(item)}><Icon size={15} /><span>{item.label}</span><ChevronRight size={13} /></button>;
                const disabled = item.action.kind === "node" && item.action.type === "start" && hasStart;
                return <button type="button" role="menuitem" key={item.label} disabled={disabled} title={disabled ? "Only one Start node is allowed" : undefined} onClick={() => run(() => onAdd(item))}><Icon size={15} /><span>{item.label}</span></button>;
              })}
            </Fragment>)}
          </div> : null}
        </div>
        <button type="button" role="menuitem" disabled={importing} onClick={() => uploadInput.current?.click()}><Upload size={15} /><span>{importing ? "Uploading..." : "Upload"}</span></button>
        <input
          ref={uploadInput}
          hidden
          type="file"
          accept={STORY_ASSET_ACCEPT}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onUpload(file);
            onClose();
          }}
        />
      </> : <>
        <button type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onCopy)}><Copy size={15} /><span>Copy node</span></button>
        <button type="button" role="menuitem" disabled={nodeActionsDisabled || !canDuplicate} onClick={() => run(onDuplicate)}><Plus size={15} /><span>Duplicate</span></button>
        <button className="is-danger" type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onDelete)}><Trash2 size={15} /><span>Delete</span></button>
      </>}
    </div>,
    document.body,
  );
}

function StoryCanvasAlignmentGuides({ guides }: { guides?: CanvasAlignmentGuides }) {
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

function toFlowNode(node: StoryNode, imageModels: ImageModel[]): StoryFlowNode {
  if (node.type === "project-state" || node.type === "open-ui") return { ...node, deletable: true };
  if (node.type === "asset") return { ...node, deletable: true };
  if (node.type === "scene") return { id: node.id, type: node.type, position: node.position, deletable: true, data: { title: node.data.title, presentation: node.data.presentation } };
  if (node.type === "interaction") return { id: node.id, type: node.type, position: node.position, deletable: true, data: { title: node.data.title, behavior: node.data.behavior, presentation: node.data.presentation } };
  if (node.type === "text") return {
    id: node.id,
    type: "text",
    position: node.position,
    deletable: true,
    data: {
      text: node.data.text,
      instruction: node.data.instruction,
      ...(node.data.model ? { textModel: node.data.model } : {}),
    },
  };
  if (node.type === "video") return {
    id: node.id,
    type: "video",
    position: node.position,
    deletable: true,
    data: {
      prompt: node.data.prompt,
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      videoModel: node.data.model,
      videoResolution: node.data.resolution,
      videoAspectRatio: node.data.aspectRatio,
      duration: node.data.duration,
      references: node.data.references,
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type !== "image" || node.data.model) return { ...node, deletable: true };
  const model = imageModels[0];
  const option = preferredImageOption(model);
  return {
    ...node,
    deletable: true,
    data: {
      ...node.data,
      ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
      ...(option ? { resolution: option.resolution, aspectRatio: option.aspectRatio } : {}),
    },
  };
}

function createFlowNode(type: Exclude<StoryNodeType, "asset">, position: { x: number; y: number }, imageModels: ImageModel[], viewport: StoryPlayerConfig["viewport"], defaultTextModel?: AgentModelRef): StoryFlowNode {
  const id = crypto.randomUUID();
  if (type === "start") return { id, type, position, data: {} };
  if (type === "project-state") return { id, type, position, data: { title: "Project State", actions: [] } };
  if (type === "open-ui") return { id, type, position, data: { title: "Open UI", content: structuredClone(DEFAULT_OPEN_UI_CONTENT), presentation: { media: { mode: "own", items: [] }, surface: { files: structuredClone(DEFAULT_OPEN_UI_CODE) } } } };
  if (type === "text") return { id, type, position, data: { text: "", instruction: "", ...(defaultTextModel ? { textModel: defaultTextModel } : {}) } };
  if (type === "choice") return {
    id,
    type,
    position,
    data: {
      title: "Make a choice",
      options: [
        { id: crypto.randomUUID(), label: "Option 1" },
        { id: crypto.randomUUID(), label: "Option 2" },
      ],
      presentation: { media: { mode: "inherit" }, surface: { files: structuredClone(DEFAULT_CHOICE_SURFACE_FILES) } },
    },
  };
  if (type === "scene") return { id, type, position, data: { title: "Untitled scene", presentation: { media: { mode: "own", items: [] }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } } } };
  if (type === "interaction") {
    const behavior: StoryInteractionBehavior = { type: "continue", label: "Continue" };
    return { id, type, position, data: { title: "Continue", behavior, presentation: { media: { mode: "inherit" }, surface: { files: createStoryInteractionFiles(behavior) } } } };
  }
  if (type === "image") {
    const model = imageModels[0];
    const option = preferredImageOption(model, storyViewportRatio(viewport));
    return {
      id,
      type,
      position,
      data: {
        prompt: "",
        ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
        resolution: option?.resolution ?? "1K",
        aspectRatio: option?.aspectRatio ?? "1:1",
        images: [],
      },
    };
  }
  if (type === "video") {
    const projectRatio = storyViewportRatio(viewport);
    const aspectRatio = VIDEO_ASPECT_RATIOS.find((ratio) => ratio === projectRatio) ?? "adaptive";
    return {
      id,
      type,
      position,
      data: {
        prompt: "",
        videoModel: VIDEO_MODEL,
        videoResolution: "720p",
        videoAspectRatio: aspectRatio,
        duration: 6,
        references: [],
      },
    };
  }
  return { id, type, position, data: { title: "Untitled ending", description: "", presentation: { media: { mode: "inherit" }, surface: { files: structuredClone(DEFAULT_ENDING_SURFACE_FILES) } } } };
}

function storyDocument(
  player: StoryPlayerConfig,
  variables: StoryVariable[],
  chapter: { id: string; title: string },
  nodes: StoryFlowNode[],
  edges: Edge[],
  editorLayout: StoryEditorLayout,
): StoryDocument {
  return {
    version: 1,
    editorLayout,
    player,
    variables,
    chapter: {
      ...chapter,
      nodes: nodes.map(toStoryNode),
      edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
    },
  };
}

function updateChoiceOption(options: StoryChoiceOption[], id: string, next: StoryChoiceOption): StoryChoiceOption[] {
  return options.map((option) => option.id === id ? next : option);
}

function defaultVariableValue(type: StoryVariableType): StoryVariableValue {
  return type === "boolean" ? false : type === "number" ? 0 : "";
}

function normalizeBehaviorVariableReferences(behavior: StoryInteractionBehavior | undefined, variables: ReadonlyMap<string, StoryVariable>): StoryInteractionBehavior {
  const current = behavior ?? { type: "continue" as const, label: "Continue" };
  const normalize = (actions: StoryAction[]) => actions.filter((action) => {
    const variable = variables.get(action.variableId);
    return Boolean(variable && (action.type !== "increment-variable" || variable.type === "number"));
  }).map((action) => action.type === "set-variable"
    ? { ...action, value: normalizeVariableValue(action.value, variables.get(action.variableId)?.type) }
    : action);
  if (current.type === "actions") return { ...current, actions: normalize(current.actions) };
  if (current.type === "hotspot" || current.type === "qte") return {
    ...current,
    success: { ...current.success, actions: normalize(current.success.actions) },
    timeout: { ...current.timeout, actions: normalize(current.timeout.actions) },
  };
  return current;
}

function normalizeVariableValue(value: StoryVariableValue, type: StoryVariableType | undefined): StoryVariableValue {
  if (type === "boolean") return typeof value === "boolean" ? value : false;
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? value : 0;
  return typeof value === "string" ? value : "";
}

function toStoryNode(node: StoryFlowNode): StoryNode {
  if (node.type === "start") return { id: node.id, type: "start", position: node.position, data: {} };
  if (node.type === "project-state") return { id: node.id, type: "project-state", position: node.position, data: { title: node.data.title ?? "Project State", actions: node.data.actions ?? [] } };
  if (node.type === "open-ui") return { id: node.id, type: "open-ui", position: node.position, data: { title: node.data.title ?? "Open UI", content: node.data.content ?? structuredClone(DEFAULT_OPEN_UI_CONTENT), presentation: node.data.presentation ?? { media: { mode: "own", items: [] }, surface: { files: structuredClone(DEFAULT_OPEN_UI_CODE) } } } };
  if (node.type === "asset") return {
    id: node.id,
    type: "asset",
    position: node.position,
    data: { assetId: node.data.assetId ?? "", mediaType: node.data.mediaType ?? "image" },
  };
  if (node.type === "choice") return {
    id: node.id,
    type: "choice",
    position: node.position,
    data: { title: node.data.title ?? "", options: node.data.options ?? [], ...(node.data.timeout ? { timeout: node.data.timeout } : {}), presentation: node.data.presentation ?? { media: { mode: "inherit" }, surface: { files: structuredClone(DEFAULT_CHOICE_SURFACE_FILES) } } },
  };
  if (node.type === "interaction") return {
    id: node.id,
    type: "interaction",
    position: node.position,
    data: {
      title: node.data.title ?? "",
      behavior: node.data.behavior ?? { type: "continue", label: "Continue" },
      presentation: node.data.presentation ?? { media: { mode: "inherit" }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } },
    },
  };
  if (node.type === "scene") return {
    id: node.id,
    type: "scene",
    position: node.position,
    data: {
      title: node.data.title ?? "",
      presentation: node.data.presentation ?? { media: { mode: "own", items: [] }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } },
    },
  };
  if (node.type === "text") return {
    id: node.id,
    type: "text",
    position: node.position,
    data: {
      text: node.data.text ?? "",
      instruction: node.data.instruction ?? "",
      ...(node.data.textModel ? { model: node.data.textModel } : {}),
    },
  };
  if (node.type === "image") return {
    id: node.id,
    type: "image",
    position: node.position,
    data: {
      prompt: node.data.prompt ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { model: node.data.model } : {}),
      resolution: node.data.resolution ?? "1K",
      aspectRatio: node.data.aspectRatio ?? "1:1",
      images: node.data.images ?? [],
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "video") return {
    id: node.id,
    type: "video",
    position: node.position,
    data: {
      prompt: node.data.prompt ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      model: node.data.videoModel ?? VIDEO_MODEL,
      resolution: node.data.videoResolution ?? "720p",
      aspectRatio: node.data.videoAspectRatio ?? "adaptive",
      duration: node.data.duration ?? 6,
      references: node.data.references ?? [],
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    data: { title: node.data.title ?? "", description: node.data.description ?? "", presentation: node.data.presentation ?? { media: { mode: "inherit" }, surface: { files: structuredClone(DEFAULT_ENDING_SURFACE_FILES) } } },
  };
}

function inspectorTitle(node: StoryFlowNode): string {
  if (node.type === "start") return "Chapter entry";
  return node.data.title || (node.type === "choice" ? "Make a choice" : `Untitled ${node.type}`);
}

function imageModelKey(model: ImageModelRef): string {
  return `${model.provider}:${model.id}`;
}

function agentModelKey(model: AgentModelRef): string {
  return `${model.provider}\n${model.id}`;
}

function sameAgentModel(left: AgentModelRef, right?: AgentModelRef): boolean {
  return Boolean(right && left.provider === right.provider && left.id === right.id);
}

function sameImageModel(left: ImageModelRef, right?: ImageModelRef): boolean {
  return Boolean(right && left.provider === right.provider && left.id === right.id);
}

function imageReferenceViews(node: StoryFlowNode, nodes: StoryFlowNode[], libraryAssets: LibraryAsset[]): MediaReferenceView[] {
  if (node.type !== "image") return [];
  return (node.data.images ?? []).map((reference, index) => {
    if (reference.type === "library") {
      const asset = libraryAssets.find((candidate) => candidate.id === reference.assetId);
      return { assetId: reference.assetId, key: `library:${reference.assetId}:${index}`, linked: false, name: asset?.name ?? "Missing image", label: `Image ${index + 1}`, type: "image" };
    }
    const source = nodes.find((candidate) => candidate.id === reference.nodeId && isImageFlowSource(candidate));
    const assetId = source?.data.assetId;
    const asset = libraryAssets.find((candidate) => candidate.id === assetId);
    return {
      ...(assetId ? { assetId } : {}),
      key: `node:${reference.nodeId}`,
      linked: true,
      type: "image",
      label: `Image ${index + 1}`,
      name: source?.type === "image"
        ? source.data.prompt?.trim() || "Connected image"
        : asset?.name ?? (source ? "Connected image" : "Missing image node"),
    };
  });
}

function videoReferenceViews(node: StoryFlowNode, nodes: StoryFlowNode[], libraryAssets: LibraryAsset[]): MediaReferenceView[] {
  if (node.type !== "video") return [];
  const counts = { image: 0, video: 0, audio: 0 };
  return (node.data.references ?? []).map((reference, index) => {
    const source = reference.type === "node" ? nodes.find((candidate) => candidate.id === reference.nodeId) : undefined;
    const assetId = reference.type === "library" ? reference.assetId : source?.data.assetId;
    const asset = libraryAssets.find((candidate) => candidate.id === assetId);
    const type = asset?.mediaType === "image" || asset?.mediaType === "video" || asset?.mediaType === "audio"
      ? asset.mediaType
      : videoReferenceType(source, libraryAssets) ?? "image";
    counts[type] += 1;
    return {
      ...(assetId ? { assetId } : {}),
      key: reference.type === "library" ? `library:${reference.assetId}:${index}` : `node:${reference.nodeId}`,
      linked: reference.type === "node",
      name: asset?.name ?? (source?.type === "image" || source?.type === "video" ? source.data.prompt?.trim() || `Connected ${type}` : source ? `Connected ${type}` : `Missing ${type} node`),
      label: `${titleCase(type)} ${counts[type]}`,
      type,
      ...(asset?.duration !== undefined ? { duration: asset.duration } : {}),
    };
  });
}

function imageReferenceLimit(node: StoryFlowNode, imageModels: ImageModel[]): number {
  if (node.type !== "image") return 0;
  return imageModels.find((model) => sameImageModel(model, node.data.model))?.supportsReferenceImage ? IMAGE_REFERENCE_LIMIT : 0;
}

type ConnectionRelation = "image-reference" | "video-reference" | "prompt" | "presentation-media" | "story";

function connectionRelation(
  source: StoryFlowNode,
  target: StoryFlowNode,
  nodes: StoryFlowNode[],
  libraryAssets: LibraryAsset[],
  imageModels: ImageModel[],
): ConnectionRelation | undefined {
  if (source.id === target.id) return undefined;
  if (isSupportedImageReferenceSource(source, libraryAssets) && target.type === "image") {
    return (target.data.images?.length ?? 0) < imageReferenceLimit(target, imageModels) &&
      !(target.data.images ?? []).some((image) => image.type === "node" && image.nodeId === source.id)
      ? "image-reference"
      : undefined;
  }
  if (source.type === "text" && (target.type === "image" || target.type === "video")) {
    return target.data.promptSource?.nodeId === source.id ? undefined : "prompt";
  }
  if (target.type === "video") {
    return canAddVideoReference(target, source, nodes, libraryAssets) ? "video-reference" : undefined;
  }
  if (isVisiblePresentationFlowNode(target) && presentationMediaType(source)) {
    const media = target.data.presentation?.media;
    return media?.mode === "own" && media.items.some((item) => item.source.type === "node" && item.source.nodeId === source.id)
      ? undefined
      : "presentation-media";
  }
  return source.type !== "ending" && !isInlineNodeType(source.type) && target.type !== "start" && !isInlineNodeType(target.type)
    ? "story"
    : undefined;
}

function preferredImageOption(model?: ImageModel, preferredAspectRatio = "1:1"): ImageModel["generationOptions"][number] | undefined {
  return model?.generationOptions.find((option) => option.resolution === "1K" && option.aspectRatio === preferredAspectRatio)
    ?? model?.generationOptions.find((option) => option.aspectRatio === preferredAspectRatio)
    ?? model?.generationOptions.find((option) => option.resolution === "1K" && option.aspectRatio === "1:1")
    ?? model?.generationOptions[0];
}

function isMediaNodeType(type: StoryNodeType): type is "image" | "video" {
  return type === "image" || type === "video";
}

function storyNodeVariableIds(node: StoryFlowNode | StoryNode): Set<string> {
  const ids = new Set<string>();
  const collect = (actions: readonly StoryAction[] | undefined) => {
    for (const action of actions ?? []) if ("variableId" in action) ids.add(action.variableId);
  };
  const collectCondition = (condition?: StoryVariableCondition) => { if (condition) ids.add(condition.variableId); };
  if (node.type === "choice") for (const option of node.data.options ?? []) { collect(option.actions); collectCondition(option.condition); }
  if (node.type === "interaction") {
    const behavior = node.data.behavior;
    if (behavior?.type === "actions") collect(behavior.actions);
    if (behavior?.type === "hotspot" || behavior?.type === "qte") { collect(behavior.success.actions); collect(behavior.timeout.actions); }
  }
  return ids;
}

function storyNodeUsesVariable(node: StoryFlowNode | StoryNode, variableId: string): boolean {
  return storyNodeVariableIds(node).has(variableId);
}

function storyActionSummary(actions: readonly StoryAction[] | undefined, variables: readonly StoryVariable[]): string | undefined {
  const summary = (actions ?? []).map((action) => {
    if (action.type === "set-variable") return `${variables.find((variable) => variable.id === action.variableId)?.name || "variable"} = ${String(action.value)}`;
    if (action.type === "increment-variable") return `${variables.find((variable) => variable.id === action.variableId)?.name || "variable"} ${action.amount >= 0 ? "+" : ""}${action.amount}`;
    return "";
  });
  return summary.length ? summary.slice(0, 2).join(" · ") + (summary.length > 2 ? ` · +${summary.length - 2}` : "") : undefined;
}

function storyConditionSummary(condition: StoryVariableCondition | undefined, variables: readonly StoryVariable[]): string {
  if (!condition) return "Always";
  const name = variables.find((variable) => variable.id === condition.variableId)?.name || "Variable";
  const operator = condition.operator === "equals" ? "=" : condition.operator === "not-equals" ? "≠" : condition.operator === "greater-than" ? ">" : "<";
  return `${name} ${operator} ${String(condition.value)}`;
}

function storyEdgeStateLabel(edge: Edge, nodes: readonly StoryFlowNode[], variables: readonly StoryVariable[]): Partial<Edge> {
  const source = nodes.find((node) => node.id === edge.source);
  if (source?.type !== "choice" || !edge.sourceHandle) return {};
  const option = source.data.options?.find((candidate) => candidate.id === edge.sourceHandle);
  const label = storyActionSummary(option?.actions, variables);
  return label ? { label, labelShowBg: true, labelStyle: { fill: "#c7ccd2", fontSize: 9, fontWeight: 600 }, labelBgStyle: { fill: "#202327", fillOpacity: 0.96, stroke: "#3a3f45", strokeWidth: 1 }, labelBgPadding: [5, 4], labelBgBorderRadius: 4 } : {};
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

function hasNodeEditor(node: StoryFlowNode): boolean {
  return node.type === "open-ui"
    || node.type === "project-state"
    || node.type === "scene"
    || node.type === "interaction"
    || node.type === "choice"
    || node.type === "ending";
}

function isInlineNodeType(type: StoryNodeType): type is "text" | "image" | "video" | "asset" {
  return type === "text" || type === "asset" || isMediaNodeType(type);
}

function isVisiblePresentationFlowNode(node: StoryFlowNode): boolean {
  return node.type === "open-ui" || node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending";
}

function flowNodePresentation(node: StoryFlowNode): StoryNodePresentation {
  if (node.data.presentation) return node.data.presentation;
  if (node.type === "open-ui") return { media: { mode: "own", items: [] }, surface: { files: structuredClone(DEFAULT_OPEN_UI_CODE) } };
  if (node.type === "scene") return { media: { mode: "own", items: [] }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } };
  if (node.type === "interaction") return { media: { mode: "inherit" }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } };
  return {
    media: { mode: "inherit" },
    surface: { files: structuredClone(node.type === "choice" ? DEFAULT_CHOICE_SURFACE_FILES : DEFAULT_ENDING_SURFACE_FILES) },
  };
}

function presentationMediaType(node: StoryFlowNode): StorySceneMedia["type"] | undefined {
  if (node.type === "image" || node.type === "video") return node.type;
  return node.type === "asset" && (node.data.mediaType === "image" || node.data.mediaType === "video") ? node.data.mediaType : undefined;
}

function withOwnedPresentationMedia(node: StoryFlowNode, items: StorySceneMedia[]): StoryFlowNode {
  const presentation = flowNodePresentation(node);
  return { ...node, data: { ...node.data, presentation: { ...presentation, media: { mode: "own", items } } } };
}

function ownedPresentationItems(node: StoryFlowNode): StorySceneMedia[] {
  const media = flowNodePresentation(node).media;
  return media.mode === "own" ? media.items : [];
}

function isImageFlowSource(node: StoryFlowNode | undefined): boolean {
  return node?.type === "image" || (node?.type === "asset" && node.data.mediaType === "image");
}

function isSupportedImageReferenceSource(node: StoryFlowNode, libraryAssets: LibraryAsset[]): boolean {
  if (node.type === "image") return true;
  if (node.type !== "asset" || node.data.mediaType !== "image") return false;
  const contentType = libraryAssets.find((asset) => asset.id === node.data.assetId)?.contentType;
  return contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp";
}

function isVideoFlowSource(node: StoryFlowNode | undefined): boolean {
  return node?.type === "video" || (node?.type === "asset" && node.data.mediaType === "video");
}

function videoReferenceType(node: StoryFlowNode | undefined, libraryAssets: LibraryAsset[]): VideoGenerationReference["type"] | undefined {
  if (node?.type === "image") return "image";
  if (node?.type === "video") return "video";
  if (node?.type !== "asset") return undefined;
  const asset = libraryAssets.find((candidate) => candidate.id === node.data.assetId);
  if (node.data.mediaType === "image" && asset?.contentType !== "image/png" && asset?.contentType !== "image/jpeg" && asset?.contentType !== "image/webp") return undefined;
  if (node.data.mediaType === "video" && asset?.contentType !== "video/mp4" && asset?.contentType !== "video/quicktime") return undefined;
  if (node.data.mediaType === "audio" && asset?.contentType !== "audio/mpeg" && asset?.contentType !== "audio/wav") return undefined;
  return node.data.mediaType;
}

function canAddVideoReference(target: StoryFlowNode, source: StoryFlowNode, nodes: StoryFlowNode[], libraryAssets: LibraryAsset[]): boolean {
  if (target.type !== "video" || target.id === source.id || (target.data.references ?? []).some((reference) => reference.type === "node" && reference.nodeId === source.id)) return false;
  const type = videoReferenceType(source, libraryAssets);
  if (!type) return false;
  const references = videoReferenceViews(target, nodes, libraryAssets);
  if (references.filter((reference) => reference.type === type).length >= VIDEO_REFERENCE_LIMITS[type]) return false;
  const duration = source.type === "asset" || source.type === "video"
    ? libraryAssets.find((asset) => asset.id === source.data.assetId)?.duration
    : undefined;
  try {
    validateVideoReferenceDurations(references, [{ type, duration }]);
  } catch {
    return false;
  }
  return true;
}

function assetEdgeId(relation: "scene" | "image" | "reference" | "prompt" | "presentation", targetId: string, referenceId: string): string {
  return `${ASSET_EDGE_PREFIX}${relation}:${targetId}:${referenceId}`;
}

function removeNodesAndReferences(nodes: StoryFlowNode[], removedIds: ReadonlySet<string>): StoryFlowNode[] {
  return nodes
    .filter((node) => !removedIds.has(node.id))
    .map((node) => node.type === "image"
        ? {
            ...node,
            data: {
              ...node.data,
              images: (node.data.images ?? []).filter((image) => image.type !== "node" || !removedIds.has(image.nodeId)),
              ...(node.data.promptSource && removedIds.has(node.data.promptSource.nodeId) ? { promptSource: undefined } : {}),
            },
          }
      : node.type === "video"
        ? {
            ...node,
            data: {
              ...node.data,
              references: (node.data.references ?? []).filter((reference) => reference.type !== "node" || !removedIds.has(reference.nodeId)),
              ...(node.data.promptSource && removedIds.has(node.data.promptSource.nodeId) ? { promptSource: undefined } : {}),
            },
          }
      : isVisiblePresentationFlowNode(node) && node.data.presentation?.media.mode === "own"
        ? {
            ...node,
            data: {
              ...node.data,
              presentation: {
                ...node.data.presentation,
                media: { mode: "own", items: node.data.presentation.media.items.filter((item) => item.source.type !== "node" || !removedIds.has(item.source.nodeId)) },
              },
            },
          }
        : node);
}

function interactionOutputsRemovedWithNodes(nodes: readonly StoryFlowNode[], removedNodeIds: ReadonlySet<string>): Set<string> {
  void nodes;
  void removedNodeIds;
  return new Set();
}

function interactionOutputKey(nodeId: string, handle: string): string {
  return `${nodeId}\0${handle}`;
}

function resolveLinkedPrompt(node: StoryFlowNode, nodes: StoryFlowNode[]): string | undefined {
  if (!node.data.promptSource) return undefined;
  const source = nodes.find((candidate) => candidate.id === node.data.promptSource?.nodeId);
  return source?.type === "text" ? source.data.text ?? "" : undefined;
}

function resolveNodePrompt(node: StoryFlowNode, nodes: StoryFlowNode[]): string {
  return combineStoryPrompt(resolveLinkedPrompt(node, nodes), node.data.prompt ?? "");
}

function effectivePrompt(data: StoryFlowData, runtime?: MediaNodeRuntime): string {
  return combineStoryPrompt(runtime?.linkedPrompt, data.prompt ?? "");
}

async function promptImage(blob: Blob): Promise<CreateLibraryImageRequest["image"]> {
  if (blob.type !== "image/png" && blob.type !== "image/jpeg" && blob.type !== "image/webp") {
    throw new Error("Connected images must be PNG, JPEG, or WebP.");
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the connected image."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
  return { mediaType: blob.type, data: dataUrl.split(",", 2)[1] ?? "" };
}

async function readUploadImage(file: File): Promise<{ name: string; image: CreateLibraryImageRequest["image"] }> {
  if (file.type !== "image/png" && file.type !== "image/jpeg" && file.type !== "image/webp") {
    throw new Error("Use PNG, JPEG, or WebP reference images.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("Each reference image must be no larger than 10 MB.");
  return { name: file.name, image: await promptImage(file) };
}

function libraryUploadMediaType(file: File): LibraryUploadMediaType | undefined {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "mp4") return "video/mp4";
  if (extension === "mov") return "video/quicktime";
  if (extension === "webm") return "video/webm";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  return undefined;
}

function titleCase(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
