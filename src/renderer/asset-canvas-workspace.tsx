import { CanvasTableNode, type CanvasTables, type TableNodeRuntime } from "./canvas-table-node.js";
import {
  ArrowUp,
  Box,
  Check,
  ChevronRight,
  Clipboard,
  Copy,
  Download,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  LoaderCircle,
  Maximize,
  Music2,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  Upload,
  Undo2,
  WandSparkles,
  Redo2,
  Volume2,
  VolumeX,
  X,
  type IconComponent,
} from "./icons.js";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent, type ClipboardEvent, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  Handle,
  Position,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { CANVAS_GRID_SIZE, snapCanvasPosition } from "./canvas-alignment.js";
import { RESIZABLE_CANVAS_NODE_SIZES, canvasNodeLayout, isResizableCanvasNodeType } from "../shared/canvas-node-layout.js";
import { CanvasNodeResizer, CanvasNodeSizeActions, type CanvasNodeResizeRuntime } from "./canvas-node-resizer.js";
import { MAX_ASSET_CANVAS_NODES, MAX_TEXT_NODE_REFERENCES } from "../shared/asset-canvas-schema.js";
import { createCanvasClipboard, duplicateAssetCanvasNode, duplicateCanvasSelection, lastCanvasClipboard, parseCanvasClipboard, rememberCanvasClipboard, type CanvasClipboard } from "./asset-canvas-clipboard.js";
import { clipboardFiles, hasTransferredFiles, pasteNativeFiles, transferredFiles, type TransferredFile } from "./file-transfer.js";
import { CanvasContextMenu, EditorCanvas, isTextEntry, undoShortcut, useCanvasCenter, type CanvasContextMenuState } from "./editor-canvas.js";
import {
  IMAGE_MAX_REFERENCE_IMAGES,
  type AssetCanvasDocument,
  type AssetCanvasEditorLayout,
  type AssetCanvasNode,
  type AssetCanvasNodeType,
  type AssetCanvasReference,
  type AssetCanvasTextReference,
  type ImageAspectRatio,
  type AgentModel,
  type AgentModelRef,
  type AgentReasoningLevel,
  type CreateLibraryImageRequest,
  type ImageModel,
  type MediaProviderStatus,
  type ImageModelRef,
  type ModelRef,
  type ImageResolution,
  type LibraryUploadMediaType,
  type Model3DGenerationConfig,
  type Model3DOptions,
  type Model3DActionId,
  type Model3DOperation,
  type Model3DModel,
  type Model3DAnimationAction,
  type ProjectState,
  type ToolJob,
  type VideoAspectRatio,
  type VideoModel,
  type VideoModelRef,
  type VideoGenerationReference,
  type VideoResolution,
} from "../shared/contracts.js";
import { combineAssetCanvasPrompt, createAssetGenerationNode, isTextGenerationReferenceNode, preferredImageOption, validateAssetCanvasDocument } from "../shared/asset-canvas.js";
import { createLibraryImage, getLibraryAsset, getWorkspaceAsset, getProjectCover, getProjectCoverState, listImageModelCatalog, listModel3DAnimations, listModel3DOperations, listModel3DCatalog, listVideoModelCatalog, MODELS_CHANGED_EVENT, setProjectCover, uploadLibraryAsset } from "./api.js";
import { useAuth } from "./auth.js";
import { accountCloudState, canAffordCloudModel, CloudQuotaStatus } from "./cloud-quota.js";
import { downloadAssetBlob, loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { SendToProjectDialog } from "./send-to-project-dialog.js";
import { useAgentModels, type AgentModelCatalogStatus } from "./model-selector.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { CanvasChipSelect, type CanvasChipNote } from "./canvas-chip-select.js";
import { settingsHash } from "./routes.js";
import { useCanvasAssetSources, useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { canvasNodeTitle } from "../shared/canvas-assets.js";
import type { CanvasAssetCatalogEntry } from "../shared/canvas-assets.js";
import { prepareVideoReferenceFile, readMediaFileDuration } from "./video-reference-files.js";
import { findAssetCanvasCoverSource, type AssetCanvasCoverSource } from "../shared/asset-canvas-cover.js";
import { ModelPreview } from "./model-preview.js";
import { LibraryAssetPicker } from "./node-workbench.js";
import { AssetDialogShell, AssetMedia, type AssetMediaType } from "./asset-gallery.js";
import { DEFAULT_IMAGE_NODE_CONFIG, DEFAULT_MODEL_3D_CONFIG, DEFAULT_ANIMATION_ACTION_IDS, DEFAULT_CHARACTER_HEIGHT_METERS, DEFAULT_VIDEO_NODE_CONFIG, MAX_ANIMATION_ACTIONS, MODEL_3D_MAX_REFERENCE_IMAGES, normalizeModel3DConfig, resolveModel3D, resolveModel3DConnection } from "../shared/generation-config.js";
import { MODEL3D_CONNECTION_ID, remeshPolycount } from "../shared/model3d-operations.js";
import { mergeCanvasDocument } from "../shared/canvas-workspace.js";
import { CanvasDocumentNode, ExpandedCanvasDocument, type CanvasDocuments, type DocumentNodeRuntime } from "./canvas-document-node.js";
import { CanvasNodeLabel, type CanvasNodeDetails } from "./canvas-node-label.js";
import { exportCanvasAsset, generateCanvasText } from "./canvas-api.js";
import type { CanvasBoardStorage } from "./canvas-board-storage.js";
import { CanvasNotice } from "./canvas-notice.js";
import { useDesktopClosing } from "./desktop-close-guard.js";
import { isDesktopClosing } from "./desktop-save.js";
import { CanvasTextarea, CanvasTextComposer } from "./canvas-text-composer.js";
import { VideoReferencePrompt } from "./video-reference-prompt.js";
import { resolveVideoMentions, sameVideoReference, videoReferenceAliases, videoReferenceAspectRatios, videoReferenceLimit, videoReferenceMode } from "../shared/video-references.js";
import { CanvasNodeReferenceStrip, CanvasReferenceThumbnail, type CanvasNodeReferencesRuntime } from "./canvas-node-references.js";
import { t, tNodes } from "./i18n.js";

const ASSET_EDGE_PREFIX = "asset:";
const OUTPUT_HANDLE = "out";
const STORY_ASSET_ACCEPT = "image/png,image/jpeg,image/svg+xml,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,.svg,.mov,.mp3,.wav";
const MEDIA_NODE_MAX_WIDTH = 440;
const MEDIA_NODE_MIN_WIDTH = 300;
const MEDIA_NODE_MAX_HEIGHT = 360;
const MEDIA_NODE_MIN_HEIGHT = 200;
type CanvasNodeCreationAction = { kind: "node"; type: Exclude<AssetCanvasNodeType, "asset">; documentId?: string; tableId?: string };
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
interface OpenCanvasNodeCreationBranch {
  branch: CanvasNodeCreationBranch;
  top: number;
}
type CanvasNodeCreationItem = CanvasNodeCreationLeaf | CanvasNodeCreationBranch;
interface CanvasNodeCreationGroup {
  label: string;
  items: CanvasNodeCreationItem[];
}

const CANVAS_NODE_CREATION_GROUPS: CanvasNodeCreationGroup[] = [
  {
    label: t("assetCanvas.group.assets"),
    items: [
      { label: t("assetCanvas.node.text"), description: t("assetCanvas.node.textHint"), icon: FileText, action: { kind: "node", type: "text" } },
      { label: t("assetCanvas.node.image"), description: t("assetCanvas.node.imageHint"), icon: ImageIcon, action: { kind: "node", type: "image" } },
      { label: t("assetCanvas.node.video"), description: t("assetCanvas.node.videoHint"), icon: Film, action: { kind: "node", type: "video" } },
      { label: t("assetCanvas.node.model3d"), description: t("assetCanvas.node.model3dHint"), icon: Box, action: { kind: "node", type: "model-3d" } },
      { label: t("assetCanvas.node.animate3d"), description: t("assetCanvas.node.animate3dHint"), icon: WandSparkles, action: { kind: "node", type: "animate-3d" } },
    ],
  },
];

function isCanvasNodeCreationLeaf(item: CanvasNodeCreationItem): item is CanvasNodeCreationLeaf {
  return "action" in item;
}

function canvasCreationGroups(documents: CanvasDocuments, tables: CanvasTables): CanvasNodeCreationGroup[] {
  const items: CanvasNodeCreationItem[] = [{ label: t("assetCanvas.node.document"), description: t("assetCanvas.node.markdown"), icon: FileText, action: { kind: "node", type: "document" } }];
  if (documents.documents.length) items.push({ label: t("assetCanvas.node.existingDocument"), description: t("assetCanvas.node.existingDocumentHint"), icon: FileText, children: documents.documents.map((document) => ({ label: document.title || t("canvasDocs.untitled"), description: t("assetCanvas.node.markdown"), icon: FileText, action: { kind: "node", type: "document", documentId: document.id } })) });
  items.push({ label: t("assetCanvas.node.table"), description: t("assetCanvas.node.tableHint"), icon: FileText, action: { kind: "node", type: "table" } });
  const existingTables = [...tables.storage.sessions.values()].filter((session) => !session.issue);
  if (existingTables.length) items.push({ label: t("assetCanvas.node.existingTable"), description: t("assetCanvas.node.existingTableHint"), icon: FileText, children: existingTables.map(({ local: table }) => ({ label: table.title || t("canvasTable.untitled"), description: t("assetCanvas.node.sharedTable"), icon: FileText, action: { kind: "node", type: "table", tableId: table.id } })) });
  return [{ label: t("assetCanvas.group.documents"), items }, ...CANVAS_NODE_CREATION_GROUPS];
}

type AssetCanvasFlowData = {
  resizeRuntime?: CanvasNodeResizeRuntime;
  nodeDetails?: CanvasNodeDetails;
  panelOpen?: boolean;
  tableId?: string;
  tableRuntime?: TableNodeRuntime;
  documentId?: string;
  documentRuntime?: DocumentNodeRuntime;
  prompt?: string;
  promptSource?: AssetCanvasTextReference;
  text?: string;
  instruction?: string;
  textModel?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  model?: ImageModelRef;
  resolution?: ImageResolution;
  aspectRatio?: ImageAspectRatio;
  videoModel?: VideoModelRef;
  videoResolution?: VideoResolution;
  videoAspectRatio?: VideoAspectRatio;
  duration?: number;
  images?: AssetCanvasReference[];
  references?: AssetCanvasReference[];
  referenceMode?: "frame" | "reference";
  referenceMentions?: Record<string, AssetCanvasReference>;
  assetId?: string;
  mediaType?: "image" | "video" | "audio" | "model";
  model3DConfig?: Model3DGenerationConfig;
  heightMeters?: number;
  actionIds?: Model3DActionId[];
  animationModel?: ModelRef;
  model3DOperation?: Exclude<Model3DOperation, "animate">;
  model3DSource?: AssetCanvasReference;
  model3DOptions?: Model3DOptions;
  contentType?: string;
  assetDuration?: number;
  /** Width / height of the output media, known before it loads. */
  assetAspectRatio?: number;
  name?: string;
  assetOrigin?: "Project" | "Library";
  assetError?: string;
  imageRuntime?: ImageNodeRuntime;
  videoRuntime?: VideoNodeRuntime;
  model3DRuntime?: Model3DNodeRuntime;
  animateRuntime?: Animate3DNodeRuntime;
  textRuntime?: TextNodeRuntime;
};
type AssetCanvasFlowNode = Node<AssetCanvasFlowData, AssetCanvasNodeType> & { title?: string; description?: string };

interface MediaNodeRuntime {
  generating: boolean;
  busy: boolean;
  error?: string;
  onChange: (data: AssetCanvasFlowData, removedHandle?: string | string[]) => void;
  onGenerate: () => void;
  onCancel?: () => void;
  linkedPrompt?: string;
  onDisconnectPrompt?: () => void;
}

interface TextNodeRuntime extends CanvasNodeReferencesRuntime {
  models: AgentModel[];
  modelStatus: AgentModelCatalogStatus;
  defaultModel?: AgentModelRef;
  defaultReasoningLevel?: AgentReasoningLevel;
  generating: boolean;
  busy: boolean;
  error?: string;
  onChange: (data: AssetCanvasFlowData) => void;
  onGenerate: (model: AgentModelRef, reasoningLevel: AgentReasoningLevel) => void;
}

interface ReferenceMediaNodeRuntime extends MediaNodeRuntime {
  references: MediaReferenceView[];
  maxReferences: number;
  uploading: boolean;
  accept: string;
  addLabel: string;
  /** Names each reference position (e.g. 3D views); the strip then shows every position as a labelled slot. */
  slotLabels?: readonly string[];
  showEmptySlots?: boolean;
  onRemoveReference: (index: number) => void;
  /** Absent when references can only be connected, not uploaded. */
  onUploadReferences?: (files: File[]) => void;
  /** The Library images the + button offers next to Upload. */
  libraryImages?: LibraryAsset[];
  onAddLibraryReference?: (asset: LibraryAsset) => void;
}

type ReferenceStripRuntime = Omit<ReferenceMediaNodeRuntime, "generating" | "error" | "onChange" | "onGenerate" | "onCancel">;

interface ImageNodeRuntime extends ReferenceMediaNodeRuntime {
  models: ImageModel[];
  providers: MediaProviderStatus[];
}

interface VideoNodeRuntime extends ReferenceMediaNodeRuntime {
  models: VideoModel[];
  providers: MediaProviderStatus[];
}

interface Model3DNodeRuntime extends ReferenceMediaNodeRuntime {
  sourceRuntime?: ReferenceStripRuntime;
  models: Model3DModel[];
  providers: MediaProviderStatus[];
}

interface Animate3DNodeRuntime extends ReferenceMediaNodeRuntime {
  models: Model3DModel[];
}

interface MediaReferenceView {
  assetId?: string;
  key: string;
  name: string;
  label: string;
  type: VideoGenerationReference["type"] | "model";
  duration?: number;
}

const STORY_NODE_TYPES: NodeTypes = {
  table: CanvasTableNode,
  document: CanvasDocumentNode,
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
  "model-3d": Model3DNode,
  "animate-3d": Animate3DNode,
  asset: AssetNode,
};

export function CanvasBoardEditor({ project, initialNodeId, onInitialNodeHandled, hidden = false, storage, documents, tables, assets: localAssets, conflicted = false, overlay, onSaveReady, onSyncReady, onResolveReady, onStatusChange, onSelectionChange, expandedDocument }: {
  project: ProjectState;
  initialNodeId?: string;
  onInitialNodeHandled?: () => void;
  hidden?: boolean;
  storage: CanvasBoardStorage;
  documents: CanvasDocuments;
  tables: CanvasTables;
  assets: CanvasAssetCatalogEntry[];
  conflicted?: boolean;
  overlay?: ReactNode;
  onSaveReady?: (save: (() => Promise<void>) | undefined) => void;
  onSyncReady?: (sync: (() => Promise<void>) | undefined) => void;
  onResolveReady?: (resolve: ((version: "local" | "remote") => Promise<void>) | undefined) => void;
  onStatusChange?: (status: "loading" | "saved" | "saving" | "error" | "sync-error" | "load-error") => void;
  onSelectionChange?: (nodes: AssetCanvasNode[]) => void;
  expandedDocument?: { id: string; nodeId?: string; busy?: boolean; onClose(): void };
}) {
  const projectId = project.id;
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: "save" | "action"; message: string }>();
  const [loadError, setLoadError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const closing = useDesktopClosing();
  const syncFailed = useRef(false);
  const saveFailed = useRef(false);
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [transferError, setTransferError] = useState<string>();
  // The canvas file format still requires a viewport; nothing in Asset Canvas uses it, so it is only carried through saves.
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const [nodes, setNodes] = useState<AssetCanvasFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [editorLayout, setEditorLayout] = useState<AssetCanvasEditorLayout>({
    version: 1,
    nodes: {},
    viewport: { x: 64, y: 32, zoom: 1 },
    view: "canvas",
  });
  const finishInitialFit = useCallback((viewport: AssetCanvasEditorLayout["viewport"]) => {
    setEditorLayout(({ fitView: _fitView, ...current }) => ({ ...current, viewport }));
  }, []);
  const [selectedAssetEdgeId, setSelectedAssetEdgeId] = useState<string>();
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState>();
  const [expandedTextId, setExpandedTextId] = useState<string>();
  // A marquee arranges nodes; explicitly activating a node opens its panel.
  const [marqueeActive, setMarqueeActive] = useState(false);
  const [marqueeSelectedIds, setMarqueeSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [copiedSelection, setCopiedSelection] = useState(lastCanvasClipboard);
  const canvasElement = useRef<HTMLDivElement>(null);
  const flowInstance = useRef<ReactFlowInstance<AssetCanvasFlowNode, Edge>>(null);
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const pasteSequence = useRef({ text: "", count: 0 });
  const dragDepth = useRef(0);
  const [fileDropActive, setFileDropActive] = useState(false);
  const pendingImport = useRef<Promise<void> | undefined>(undefined);
  const [globalAssets, setLibraryAssets] = useState<LibraryAsset[]>([]);
  const libraryAssets = useMemo<LibraryAsset[]>(() => {
    const assets = new Map(globalAssets.map((asset) => [asset.id, asset]));
    for (const asset of localAssets) assets.set(asset.id, { ...assets.get(asset.libraryAssetId ?? asset.id), ...asset, assetId: asset.id });
    return [...assets.values()];
  }, [globalAssets, localAssets]);
  const assetPaths = useCanvasAssetSources();
  const [nodeDetails, setNodeDetails] = useState<{ id: string; title: string; description: string }>();
  const libraryImages = useMemo(() => libraryAssets.filter((asset) => asset.mediaType === "image"), [libraryAssets]);

  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [globalDefaultImageModel, setDefaultImageModel] = useState<ImageModelRef>();
  const [videoModels, setVideoModels] = useState<VideoModel[]>([]);
  const [imageProviders, setImageProviders] = useState<MediaProviderStatus[]>([]);
  const [videoProviders, setVideoProviders] = useState<MediaProviderStatus[]>([]);
  const [globalDefaultVideoModel, setDefaultVideoModel] = useState<ModelRef>();
  const [model3DModels, setModel3DModels] = useState<Model3DModel[]>([]);
  const [model3DProviders, setModel3DProviders] = useState<MediaProviderStatus[]>([]);
  const [globalDefaultModel3D, setDefaultModel3D] = useState<ModelRef>();
  const defaultImageModel = project.mediaModelDefaults?.image ?? globalDefaultImageModel;
  const defaultVideoModel = project.mediaModelDefaults?.video ?? globalDefaultVideoModel;
  const defaultModel3D = project.mediaModelDefaults?.["3d"] ?? globalDefaultModel3D;
  const [operationModels3D, setOperationModels3D] = useState<Model3DModel[]>([]);
  const textModelCatalog = useAgentModels();
  const defaultTextModel = textModelCatalog.defaultModel ?? textModelCatalog.models[0];
  const [canvasJobs, setCanvasJobs] = useState<Record<string, ToolJob>>({});
  // The last settings picked per node type, so a new node starts where the user left off.
  const rememberedSettings = useRef<RememberedSettings>({});
  const [viewedAsset, setViewedAsset] = useState<ViewableCanvasAsset>();
  const [sentAsset, setSentAsset] = useState<{ assetId: string; name: string }>();
  const [startingCanvasNodes, setStartingCanvasNodes] = useState<Set<string>>(() => new Set());
  const startingCanvasNodesRef = useRef(new Set<string>());
  const hydratedJobRuns = useRef(new Set<string>());
  const [generatingTextNodeId, setGeneratingTextNodeId] = useState<string>();
  const [uploadingNodeId, setUploadingNodeId] = useState<string>();
  const [importingAssets, setImportingAssets] = useState(false);
  const [generationError, setGenerationError] = useState<{ nodeId: string; message: string }>();
  const latestCanvas = useRef<AssetCanvasDocument | undefined>(undefined);
  const storageRef = useRef(storage);
  storageRef.current = storage;
  const queuedCanvas = useRef<string | undefined>(undefined);
  // Apply each result before the next operation reads the live canvas.
  const operationChain = useRef(Promise.resolve());
  // A failed background read must not turn an already successful save into a failure.
  const lastSave = useRef(Promise.resolve());
  const initialNodeRequest = useRef({ nodeId: initialNodeId, onHandled: onInitialNodeHandled });
  const editorUndoHistory = useRef<AssetCanvasDocument[]>([]);
  const editorRedoHistory = useRef<AssetCanvasDocument[]>([]);
  const historyObserved = useRef<AssetCanvasDocument | undefined>(undefined);
  const historyObservedJson = useRef<string | undefined>(undefined);
  const historyPendingBase = useRef<AssetCanvasDocument | undefined>(undefined);
  const historyTimer = useRef<number | undefined>(undefined);
  const historyGestureBase = useRef<AssetCanvasDocument | undefined>(undefined);
  const [, setHistoryRevision] = useState(0);
  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedNodeIdsJson = JSON.stringify(selectedNodes.map((node) => node.id));
  const selection = JSON.stringify(selectedNodes.map((node) => toAssetCanvasNode(node, model3DModels)));
  useEffect(() => { onSelectionChange?.(JSON.parse(selection) as AssetCanvasNode[]); }, [selection, onSelectionChange]);

  useEffect(() => {
    let disposed = false;
    setPhase("loading");
    setLoadError(undefined);
    onStatusChange?.("loading");
    resetHistory();
    setCanvasContextMenu(undefined);
    const emptyCatalog = { models: [], providers: [], defaultModel: undefined };
    void Promise.all([storage.load(), loadLibraryAssets().catch(() => []), listImageModelCatalog().catch(() => emptyCatalog), listVideoModelCatalog().catch(() => emptyCatalog), listModel3DCatalog().catch(() => emptyCatalog), listModel3DOperations().catch(() => [])]).then(([story, assets, imageCatalog, videoCatalog, model3DCatalog, operationModels]) => {
      const models = imageCatalog.models;
      const loadedVideoModels = videoCatalog.models;
      if (disposed) return;
      setViewport(story.viewport);
      const loadedNodes = story.nodes.map((node) => toFlowNode(node, models, loadedVideoModels));
      const request = initialNodeRequest.current;
      initialNodeRequest.current = { nodeId: undefined, onHandled: undefined };
      const initialNode = request.nodeId ? loadedNodes.find((node) => node.id === request.nodeId) : undefined;
      setNodes(loadedNodes.map((node) => ({ ...node, selected: node.id === initialNode?.id })));
      if (request.nodeId) {
        request.onHandled?.();
      }
      setEditorLayout(story.editorLayout);
      setEdges(story.edges);
      queuedCanvas.current = undefined;
      lastSave.current = Promise.resolve();
      syncFailed.current = false;
      saveFailed.current = false;
      setLibraryAssets(assets);
      setImageModels(models);
      setDefaultImageModel(imageCatalog.defaultModel);
      setVideoModels(loadedVideoModels);
      setImageProviders(imageCatalog.providers);
      setVideoProviders(videoCatalog.providers);
      setDefaultVideoModel(videoCatalog.defaultModel);
      setModel3DModels(model3DCatalog.models);
      setOperationModels3D(operationModels);
      setModel3DProviders(model3DCatalog.providers);
      setDefaultModel3D(model3DCatalog.defaultModel);
      setNotice(undefined);
      setPhase("ready");
      onStatusChange?.("saved");
    }).catch((error) => {
      if (disposed) return;
      setLoadError(errorMessage(error));
      setPhase("error");
      onStatusChange?.("load-error");
    });
    return () => { disposed = true; };
  }, [projectId, storage, loadAttempt]);

  useEffect(() => {
    if (closing) return;
    let active = true;
    let revision = 0;
    let model3DRevision = 0;
    const refresh3D = () => {
      const current = ++model3DRevision;
      void Promise.all([listModel3DCatalog(), listModel3DOperations()]).then(([catalog, operationModels]) => {
        if (!active || current !== model3DRevision) return;
        setOperationModels3D(operationModels);
        setModel3DModels(catalog.models); setModel3DProviders(catalog.providers); setDefaultModel3D(catalog.defaultModel);
      }).catch(() => undefined);
    };
    const refresh = () => {
      const current = ++revision;
      void listImageModelCatalog().then((catalog) => {
        if (!active || current !== revision) return;
        setImageModels(catalog.models);
        setDefaultImageModel(catalog.defaultModel);
        setImageProviders(catalog.providers);
      }).catch(() => undefined);
      void listVideoModelCatalog().then((catalog) => {
        if (!active || current !== revision) return;
        setVideoModels(catalog.models); setVideoProviders(catalog.providers); setDefaultVideoModel(catalog.defaultModel);
      }).catch(() => undefined);
      refresh3D();
    };
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    const timer = setInterval(refresh3D, 30_000);
    return () => { active = false; clearInterval(timer); window.removeEventListener(MODELS_CHANGED_EVENT, refresh); };
  }, [projectId, closing]);

  useEffect(() => {
    if (phase !== "ready" || closing) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const jobs = await storageRef.current.jobs();
        if (stopped) return;
        const latestJobs = new Map<string, ToolJob>();
        for (const job of jobs) {
          const nodeId = job.context?.nodeId;
          if (nodeId && !latestJobs.has(nodeId)) latestJobs.set(nodeId, job);
        }
        setCanvasJobs(Object.fromEntries(latestJobs));
        const completedAssetIds: string[] = [];
        let completedCover: AssetCanvasCoverSource | undefined;
        // Jobs arrive newest first; the daemon persists outputs to the current board.
        for (const job of latestJobs.values()) {
          const nodeId = job.context?.nodeId;
          const file = job.run?.files[0];
          if (job.status !== "succeeded" || !nodeId || !file?.assetId || hydratedJobRuns.current.has(job.id)) continue;
          hydratedJobRuns.current.add(job.id);
          completedAssetIds.push(file.assetId);
          if (!completedCover) {
            const mediaType = file.mediaType.startsWith("image/") ? "image" : file.mediaType.startsWith("video/") ? "video" : undefined;
            if (mediaType) completedCover = { assetId: file.assetId, mediaType };
          }
        }
        if (completedAssetIds.length) {
          const assets = await loadLibraryAssets();
          if (completedCover && !stopped && project.type === "asset-canvas") {
            try {
              if ((await getProjectCoverState(projectId)).mode === "auto") {
                const cover = await projectCoverBlob(completedCover, assets);
                if (!stopped && cover) await setProjectCover(projectId, cover, "auto");
              }
            } catch { /* Cover generation is best-effort. */ }
          }
          if (!stopped) setLibraryAssets(assets);
        }
      } catch { /* Job polling is best-effort; the node keeps its last state. */ }
      if (!stopped) timer = window.setTimeout(poll, 1_500);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [phase, projectId, project.type, closing]);

  const document = useMemo(
    () => assetCanvasDocument(viewport, nodes, edges, {
      ...editorLayout,
      nodes: {
        ...Object.fromEntries(nodes.map((node) => [node.id, canvasNodeLayout(node)])),
      },
      view: "canvas",
    }, model3DModels),
    [edges, editorLayout, nodes, viewport, model3DModels],
  );
  latestCanvas.current = document;

  useEffect(() => {
    if (project.type !== "asset-canvas" || phase !== "ready" || !document || libraryAssets.length === 0) return;
    let disposed = false;
    void (async () => {
      const source = findAssetCanvasCoverSource(document);
      if (!source || await getProjectCover(projectId)) return;
      const cover = await projectCoverBlob(source, libraryAssets, assetBlob);
      if (!disposed && cover && !(await getProjectCover(projectId))) await setProjectCover(projectId, cover, "auto");
    })().catch(() => {});
    return () => { disposed = true; };
  }, [document, libraryAssets, phase, projectId, project.type]);

  function updateHistoryControls(): void {
    setHistoryRevision((revision) => revision + 1);
  }

  // Whole-board snapshots must not restore a version from before an external edit.
  function resetHistory(): void {
    window.clearTimeout(historyTimer.current);
    editorUndoHistory.current = [];
    editorRedoHistory.current = [];
    historyObserved.current = undefined;
    historyObservedJson.current = undefined;
    historyPendingBase.current = undefined;
    historyGestureBase.current = undefined;
  }

  function pushUndoSnapshot(snapshot: AssetCanvasDocument): void {
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

  function observeHistoryDocument(next: AssetCanvasDocument): void {
    historyObserved.current = structuredClone(next);
    historyObservedJson.current = canvasHistoryKey(next);
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
    applyEditorCanvas(next);
    updateHistoryControls();
    return true;
  }

  function redoEditorChange(): boolean {
    if (!document || historyPendingBase.current) return false;
    const next = editorRedoHistory.current.pop();
    if (!next) return false;
    pushUndoSnapshot(document);
    observeHistoryDocument(next);
    applyEditorCanvas(next);
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
      const current = latestCanvas.current;
      historyGestureBase.current = undefined;
      if (!base || !current || canvasHistoryKey(base) === canvasHistoryKey(current)) return;
      pushUndoSnapshot(base);
      editorRedoHistory.current = [];
      observeHistoryDocument(current);
      updateHistoryControls();
    }, 0);
  }

  useEffect(() => {
    if (phase !== "ready" || !document) return;
    const serialized = canvasHistoryKey(document);
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || isTextEntry(event.target) || eventWithin(event, ".nokey") || !canvasElement.current?.contains(event.target as globalThis.Node)) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        const selected = nodes.filter((node) => node.selected).map((node) => toAssetCanvasNode(node, model3DModels));
        if (selected.length) pasteSelection(createCanvasClipboard(projectId, selected, document.edges), { x: Math.min(...selected.map((node) => node.position.x)) + 40, y: Math.min(...selected.map((node) => node.position.y)) + 40 });
        return;
      }
      const step = undoShortcut(event);
      if (!step) return;
      event.preventDefault();
      if (step === "redo") redoEditorChange();
      else undoEditorChange();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [document, model3DModels]);
  const assetEdges = useMemo(() => nodes.flatMap((node): Edge[] => {
    const derived: Edge[] = [];
    if (node.type === "image" || node.type === "model-3d" || node.type === "animate-3d") derived.push(...(node.data.images ?? []).flatMap((image) => image.type === "node" ? [{
      id: assetEdgeId("image", node.id, image.nodeId),
      source: image.nodeId,
      target: node.id,
      sourceHandle: OUTPUT_HANDLE,
      selected: selectedAssetEdgeId === assetEdgeId("image", node.id, image.nodeId),
      data: { relation: "media-image", referenceId: image.nodeId },
    }] : []));
    if (node.type === "model-3d" && node.data.model3DSource?.type === "node") derived.push({
      id: assetEdgeId("model", node.id, node.data.model3DSource.nodeId), source: node.data.model3DSource.nodeId, target: node.id,
      sourceHandle: OUTPUT_HANDLE, selected: selectedAssetEdgeId === assetEdgeId("model", node.id, node.data.model3DSource.nodeId),
      data: { relation: "media-model", referenceId: node.data.model3DSource.nodeId },
    });
    if (node.type === "video" || node.type === "text" || node.type === "document") derived.push(...(node.data.references ?? []).flatMap((reference) => reference.type === "node" ? [{
      id: assetEdgeId("reference", node.id, reference.nodeId),
      source: reference.nodeId,
      target: node.id,
      sourceHandle: OUTPUT_HANDLE,
      ...((node.type === "text" || node.type === "document") ? { targetHandle: "references" } : {}),
      selected: selectedAssetEdgeId === assetEdgeId("reference", node.id, reference.nodeId),
      data: { relation: node.type === "video" ? "video-reference" : "text-reference", referenceId: reference.nodeId },
    }] : []));
    if ((node.type === "image" || node.type === "video" || node.type === "model-3d") && node.data.promptSource) derived.push({
      id: assetEdgeId("prompt", node.id, node.data.promptSource.nodeId),
      source: node.data.promptSource.nodeId,
      target: node.id,
      sourceHandle: OUTPUT_HANDLE,
      selected: selectedAssetEdgeId === assetEdgeId("prompt", node.id, node.data.promptSource.nodeId),
      data: { relation: "media-prompt", referenceId: node.data.promptSource.nodeId },
    });
    return derived;
  }), [nodes, selectedAssetEdgeId]);

  const save = useCallback((story: AssetCanvasDocument): Promise<void> => {
    if (resolvingRef.current) return operationChain.current;
    const serialized = JSON.stringify(story);
    if (serialized === queuedCanvas.current) return lastSave.current;
    queuedCanvas.current = serialized;
    onStatusChange?.("saving");
    const operation = operationChain.current
      .catch(() => undefined)
      .then(async () => {
        const submitted = latestCanvas.current ?? story;
        const saved = await storage.save(submitted);
        if (mounted.current) reconcileCanvas(submitted, saved);
      });
    operationChain.current = operation;
    lastSave.current = operation;
    void operation.then(
      () => { if (mounted.current) { saveFailed.current = false; setNotice((current) => current?.kind === "save" ? undefined : current); onStatusChange?.(syncFailed.current ? "sync-error" : "saved"); } },
      (error) => {
        if (!mounted.current) return;
        saveFailed.current = true;
        if (queuedCanvas.current === serialized) queuedCanvas.current = undefined;
        setNotice({ kind: "save", message: t("assetCanvas.saveFailedDetail", { error: errorMessage(error) }) });
        onStatusChange?.("error");
      },
    );
    return operation;
  }, [storage, onStatusChange]);

  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  useEffect(() => {
    const selected = new Set<string>(JSON.parse(selectedNodeIdsJson));
    setMarqueeSelectedIds((current) => {
      if (!current.size) return current;
      const next = new Set([...current].filter((id) => selected.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [selectedNodeIdsJson]);
  const imageModelsRef = useRef(imageModels); imageModelsRef.current = imageModels;
  const videoModelsRef = useRef(videoModels); videoModelsRef.current = videoModels;
  function reconcileCanvas(submitted: AssetCanvasDocument, saved: AssetCanvasDocument) {
    const current = latestCanvas.current ?? submitted;
    const merged = storage.reconcile(submitted, current, saved);
    if (JSON.stringify(current) === JSON.stringify(merged)) return;
    if (canvasHistoryKey(current) !== canvasHistoryKey(merged)) resetHistory();
    if (historyGestureBase.current) historyGestureBase.current = mergeCanvasDocument(submitted, historyGestureBase.current, saved);
    const selected = new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
    latestCanvas.current = merged;
    observeHistoryDocument(merged);
    setNodes(merged.nodes.map((node) => ({ ...toFlowNode(node, imageModelsRef.current, videoModelsRef.current), selected: selected.has(node.id) })));
    setEdges(merged.edges); setViewport(merged.viewport); setEditorLayout(merged.editorLayout);
    updateHistoryControls();
  }
  const flush = useCallback(async () => {
    await pendingImport.current;
    await operationChain.current.catch(() => {});
    // A close can precede React Flow's delayed onMoveEnd callback.
    const current = latestCanvas.current;
    const viewport = flowInstance.current?.getViewport();
    if (current && viewport && phase === "ready") {
      const editorLayout = { ...current.editorLayout, viewport };
      latestCanvas.current = { ...current, editorLayout };
      setEditorLayout(editorLayout);
    }
    while (latestCanvas.current && phase === "ready") {
      const submitted = latestCanvas.current;
      await save(submitted);
      if (JSON.stringify(latestCanvas.current) === JSON.stringify(submitted)) break;
    }
  }, [save, phase]);
  useEffect(() => { onSaveReady?.(flush); return () => onSaveReady?.(undefined); }, [onSaveReady, flush]);
  const resolveConflict = useCallback(async (version: "local" | "remote") => {
    resolvingRef.current = true;
    setResolving(true);
    try {
      await operationChain.current.catch(() => {});
      const submitted = latestCanvas.current;
      if (!submitted) return;
      const operation = storage.resolveConflict(version, submitted);
      operationChain.current = operation.then(() => {}, () => {});
      const selected = await operation;
      if (version === "local") reconcileCanvas(submitted, selected);
      else {
        resetHistory();
        latestCanvas.current = selected; observeHistoryDocument(selected); applyEditorCanvas(selected); updateHistoryControls();
      }
      queuedCanvas.current = JSON.stringify(selected);
      lastSave.current = Promise.resolve();
      saveFailed.current = false;
      syncFailed.current = false;
      setNotice(undefined);
      onStatusChange?.("saved");
    } finally { resolvingRef.current = false; setResolving(false); }
  }, [storage, onStatusChange]);
  useEffect(() => { onResolveReady?.(phase === "ready" ? resolveConflict : undefined); return () => onResolveReady?.(undefined); }, [onResolveReady, resolveConflict, phase]);
  const sync = useCallback(() => {
    if (resolvingRef.current || isDesktopClosing()) return Promise.resolve();
    const operation = operationChain.current.catch(() => {}).then(async () => {
      if (!mounted.current || !latestCanvas.current || isDesktopClosing()) return;
      const submitted = latestCanvas.current;
      const wasSaved = queuedCanvas.current === JSON.stringify(submitted);
      const refreshed = await storage.refresh(submitted);
      if (!mounted.current) return;
      if (refreshed) {
        queuedCanvas.current = wasSaved ? JSON.stringify(refreshed) : undefined;
        reconcileCanvas(submitted, refreshed);
      }
      syncFailed.current = false;
      if (saveFailed.current) onStatusChange?.("error");
      else if (queuedCanvas.current === JSON.stringify(latestCanvas.current)) onStatusChange?.("saved");
    });
    operationChain.current = operation;
    void operation.catch((cause) => {
      if (!mounted.current || isDesktopClosing()) return;
      syncFailed.current = true;
      if (!saveFailed.current) onStatusChange?.("sync-error");
    });
    return operation;
  }, [storage, onStatusChange]);
  useEffect(() => { onSyncReady?.(sync); return () => onSyncReady?.(undefined); }, [onSyncReady, sync]);
  useEffect(() => {
    if (phase !== "ready" || conflicted || resolving || closing) return;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void sync().catch(() => {}).finally(() => { pending = false; });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [sync, phase, conflicted, resolving, closing]);

  useEffect(() => {
    if (phase !== "ready" || !document || resolving || closing) return;
    const timeout = window.setTimeout(() => { if (!isDesktopClosing()) void save(document).catch(() => {}); }, 350);
    return () => window.clearTimeout(timeout);
  }, [document, phase, save, resolving, closing]);

  useEffect(() => () => {
    const story = latestCanvas.current;
    if (story && phase === "ready") void save(story).catch(() => {});
  }, [save, phase]);

  const onNodesChange = useCallback((changes: NodeChange<AssetCanvasFlowNode>[]) => {
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
          if (relation === "media-image" && node.id === edge.target && (node.type === "image" || node.type === "model-3d" || node.type === "animate-3d")) {
            return { ...node, data: { ...node.data, images: (node.data.images ?? []).filter((image) => image.type !== "node" || image.nodeId !== referenceId) } };
          }
          if (node.id === edge.target && ((relation === "video-reference" && node.type === "video") || (relation === "text-reference" && (node.type === "text" || node.type === "document")))) {
            return { ...node, data: { ...node.data, references: (node.data.references ?? []).filter((reference) => reference.type !== "node" || reference.nodeId !== referenceId) } };
          }
          if (relation === "media-model" && node.id === edge.target && node.type === "model-3d") return { ...node, data: { ...node.data, model3DSource: undefined } };
          if (relation === "media-prompt" && node.id === edge.target && (node.type === "image" || node.type === "video" || node.type === "model-3d")) {
            return { ...node, data: { ...node.data, promptSource: undefined } };
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
    const relation = connectionRelation(source, target, connection.sourceHandle, nodes, libraryAssets, imageModels, model3DModels);
    if (relation === "image-reference" && (target.type === "image" || target.type === "model-3d")) {
      setNodes((current) => current.map((node) => node.id === target.id && (node.type === "image" || node.type === "model-3d")
        ? { ...node, data: { ...node.data, images: [...(node.data.images ?? []), { type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if (relation === "model-reference" && target.type === "model-3d") {
      setNodes((current) => current.map((node) => node.id === target.id ? { ...node, data: { ...node.data, model3DSource: { type: "node", nodeId: source.id } } } : node));
      return;
    }
    if (relation === "model-reference" && target.type === "animate-3d") {
      // An Animate node rigs one model, so a new connection replaces the previous one.
      setNodes((current) => current.map((node) => node.id === target.id
        ? { ...node, data: { ...node.data, assetId: undefined, images: [{ type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if ((relation === "video-reference" && target.type === "video") || (relation === "text-reference" && (target.type === "text" || target.type === "document"))) {
      setNodes((current) => current.map((node) => node.id === target.id
        ? { ...node, data: { ...node.data, references: [...(node.data.references ?? []), { type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if (relation === "prompt" && (target.type === "image" || target.type === "video" || target.type === "model-3d")) {
      setNodes((current) => current.map((node) => node.id === target.id
        ? { ...node, data: { ...node.data, promptSource: { type: "node", nodeId: source.id } } }
        : node));
      return;
    }
  }

  const contextMenuNode = canvasContextMenu?.kind === "node" ? nodes.find((node) => node.id === canvasContextMenu.nodeId) : undefined;
  const contextMenuNodeMissing = canvasContextMenu?.kind === "node" && !contextMenuNode;
  const canInsertCopiedNode = Boolean(copiedSelection);
  const canUndo = Boolean(historyPendingBase.current || editorUndoHistory.current.length);
  const canRedo = !historyPendingBase.current && editorRedoHistory.current.length > 0;

  function addNode(type: Exclude<AssetCanvasNodeType, "asset">, position: { x: number; y: number }, existingResourceId?: string): void {
    if (type === "document" || type === "table") {
      void (existingResourceId ? Promise.resolve(existingResourceId) : type === "document" ? documents.add() : tables.add()).then((id) => {
        if (!id || !mounted.current) return;
        setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), { id: crypto.randomUUID(), type, position, selected: true, data: type === "document" ? { documentId: id } : { tableId: id } }]);
      }).catch((cause) => setNotice({ kind: "action", message: errorMessage(cause) }));
      return;
    }
    const created = createFlowNode(type, position, imageModels, videoModels, defaultTextModel);
    const node = { ...applyRememberedSettings(created, rememberedSettings.current[type], { imageModels, defaultImageModel, videoModels, defaultVideoModel, model3DModels, defaultModel3D, textModels: textModelCatalog.models }), selected: true };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
  }

  function addAssetNode(asset: Pick<LibraryAsset, "id" | "name" | "mediaType" | "contentType" | "duration">, position: { x: number; y: number }): void {
    if (asset.mediaType !== "image" && asset.mediaType !== "video" && asset.mediaType !== "audio" && asset.mediaType !== "model") return;
    const node = assetFlowNode(asset, position);
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
  }

  function assetFlowNode(asset: Pick<LibraryAsset, "id" | "name" | "mediaType" | "contentType" | "duration">, position: { x: number; y: number }): AssetCanvasFlowNode {
    return {
      id: crypto.randomUUID(),
      type: "asset",
      position,
      selected: true,
      deletable: true,
      data: { assetId: asset.id, mediaType: asset.mediaType, contentType: asset.contentType, assetDuration: asset.duration, name: asset.name },
    };
  }

  async function uploadAssetFile(file: File): Promise<LibraryAsset> {
    const mediaType = libraryUploadMediaType(file);
    if (!mediaType) throw new Error(t("assetCanvas.uploadTypes"));
    if (file.size > 200 * 1024 * 1024) throw new Error(t("assetCanvas.uploadSize"));
    const kind = mediaType.startsWith("video/") ? "video" : mediaType.startsWith("audio/") ? "audio" : undefined;
    const duration = kind ? await readMediaFileDuration(file, kind) : undefined;
    const uploaded = await uploadLibraryAsset(file, mediaType, duration);
    const asset: LibraryAsset = { ...uploaded, assetId: uploaded.id, path: uploaded.name };
    setLibraryAssets((current) => [asset, ...current]);
    return asset;
  }

  async function importAssetFile(file: File, position: { x: number; y: number }): Promise<void> {
    await importCanvasFiles([{ file }], position);
  }

  function importCanvasFiles(source: TransferredFile[] | Promise<TransferredFile[]>, position: { x: number; y: number }): Promise<void> {
    if (pendingImport.current) {
      void Promise.resolve(source).catch(() => {});
      setTransferError(t("assetCanvas.importRunning")); return Promise.resolve();
    }
    const operation = performFileImport(source, position).finally(() => { pendingImport.current = undefined; });
    pendingImport.current = operation;
    return operation;
  }

  async function performFileImport(source: TransferredFile[] | Promise<TransferredFile[]>, position: { x: number; y: number }): Promise<void> {
    setImportingAssets(true);
    setTransferError(undefined);
    const failures: string[] = [];
    const imported: AssetCanvasFlowNode[] = [];
    try {
      const files = await source;
      if (files.length > 1_000) throw new Error(t("assetCanvas.importLimit"));
      if (nodesRef.current.length + files.length > MAX_ASSET_CANVAS_NODES) throw new Error(t("assetCanvas.nodeLimit"));
      for (const [index, { file }] of files.entries()) {
        const at = snapCanvasPosition({ x: position.x + (index % 3) * 480, y: position.y + Math.floor(index / 3) * 560 });
        try {
          if (/\.(?:md|markdown|txt)$/i.test(file.name)) {
            if (file.size > 1_000_000) throw new Error(t("assetCanvas.textTooLarge"));
            const text = await file.text();
            const id = await documents.add();
            if (!id) throw new Error(t("assetCanvas.documentCreateFailed"));
            documents.update(id, { title: file.name.replace(/\.[^.]+$/, "").slice(0, 200), markdown: text });
            imported.push({ id: crypto.randomUUID(), type: "document", position: at, selected: true, data: { documentId: id } });
          } else imported.push(assetFlowNode(await uploadAssetFile(file), at));
        } catch (cause) { failures.push(`${file.name}: ${errorMessage(cause)}`); }
      }
      if (nodesRef.current.length + imported.length > MAX_ASSET_CANVAS_NODES) throw new Error(t("assetCanvas.canvasFull"));
      const occupied = nodesRef.current.map((node) => ({ ...node.position, width: node.measured?.width ?? 440, height: node.measured?.height ?? 520 }));
      for (const node of imported) {
        // Keep imported files near the drop point while leaving space for selected node controls.
        let overlaps;
        do {
          overlaps = occupied.filter((rect) => node.position.x < rect.x + rect.width + 20 && node.position.x + 460 > rect.x && node.position.y < rect.y + rect.height + 20 && node.position.y + 540 > rect.y);
          if (overlaps.length) node.position.y = snapCanvasPosition({ x: node.position.x, y: Math.max(...overlaps.map((rect) => rect.y + rect.height)) + 40 }).y;
        } while (overlaps.length);
        occupied.push({ ...node.position, width: 440, height: 520 });
      }
      // Publish before a waiting board switch flushes the canvas.
      if (imported.length) flushSync(() => setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...imported]));
    } catch (cause) { failures.push(errorMessage(cause)); }
    finally {
      setImportingAssets(false);
      if (failures.length) setTransferError(failures.join("\n"));
    }
  }

  function transferPosition(): { x: number; y: number } {
    const bounds = canvasElement.current?.getBoundingClientRect();
    const screen = pointer.current ?? (bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : { x: 0, y: 0 });
    return flowInstance.current?.screenToFlowPosition(screen) ?? { x: 96, y: 96 };
  }

  function pasteSelection(value: CanvasClipboard, position: { x: number; y: number }): void {
    if (nodesRef.current.length + value.nodes.length > MAX_ASSET_CANVAS_NODES) {
      setTransferError(t("assetCanvas.nodeLimit")); return;
    }
    if (value.nodes.some((node) => (node.type === "document" || node.type === "table")) && value.projectId !== projectId) {
      setTransferError(t("assetCanvas.pasteProject")); return;
    }
    commitPendingHistory();
    setTransferError(undefined);
    const copied = duplicateCanvasSelection(value.nodes, value.edges, position);
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...copied.nodes.map((node) => ({ ...toFlowNode(node, imageModels, videoModels), selected: true }))]);
    setEdges((current) => [...current, ...copied.edges]);
    setSelectedAssetEdgeId(undefined);
  }

  function copySelection(event: ClipboardEvent<HTMLDivElement>, cut = false): void {
    if (isTextEntry(event.target) || eventWithin(event, ".nokey")) return;
    const selected = nodes.filter((node) => node.selected).map((node) => toAssetCanvasNode(node, model3DModels));
    if (!selected.length) return;
    const value = createCanvasClipboard(projectId, selected, document.edges);
    event.preventDefault(); event.clipboardData.setData("text/plain", JSON.stringify(value));
    rememberCanvasClipboard(value); setCopiedSelection(value); pasteSequence.current = { text: "", count: 0 };
    if (cut) removeCanvasNodes(new Set(selected.map((node) => node.id)));
  }

  function pasteFromClipboard(event: ClipboardEvent<HTMLDivElement>): void {
    if (isTextEntry(event.target) || eventWithin(event, ".nokey") || phase !== "ready") return;
    const files = clipboardFiles(event.clipboardData);
    if (files.length) { event.preventDefault(); void importCanvasFiles(files.map((file) => ({ file })), transferPosition()); return; }
    const text = event.clipboardData.getData("text/plain"), value = parseCanvasClipboard(text);
    if (!value) return;
    event.preventDefault();
    const count = pasteSequence.current.text === text ? pasteSequence.current.count + 1 : 0;
    pasteSequence.current = { text, count };
    const at = transferPosition();
    pasteSelection(value, { x: at.x + count * 40, y: at.y + count * 40 });
  }

  function addCanvasNode(item: CanvasNodeCreationLeaf, position: { x: number; y: number }): void {
    addNode(item.action.type, position, item.action.documentId ?? item.action.tableId);
  }

  function insertNodeCopy(source: AssetCanvasNode, position: { x: number; y: number }): void {
    const duplicate = { ...toFlowNode(duplicateAssetCanvasNode(source, position), imageModels, videoModels), selected: true };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), duplicate]);
    setSelectedAssetEdgeId(undefined);
  }

  function copyCanvasNode(nodeId: string): void {
    const source = nodes.find((node) => node.id === nodeId);
    if (!source) return;
    const value = createCanvasClipboard(projectId, [toAssetCanvasNode(source, model3DModels)], []);
    rememberCanvasClipboard(value); setCopiedSelection(value);
    void navigator.clipboard?.writeText(JSON.stringify(value)).catch(() => {});
  }

  function duplicateCanvasNode(nodeId: string): void {
    const source = nodes.find((node) => node.id === nodeId);
    if (!source) return;
    const canonical = toAssetCanvasNode(source, model3DModels);
    insertNodeCopy(canonical, { x: source.position.x + CANVAS_GRID_SIZE * 2, y: source.position.y + CANVAS_GRID_SIZE * 2 });
  }

  function removeCanvasNodes(requestedIds: ReadonlySet<string>): void {
    const removedIds = new Set(nodes.filter((node) => requestedIds.has(node.id)).map((node) => node.id));
    if (!removedIds.size) return;
    commitPendingHistory();
    setNodes((current) => removeNodesAndReferences(current, removedIds));
    setEdges((current) => current.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)));
    canvasElement.current?.focus({ preventScroll: true });
  }

  function openViewer(node: AssetCanvasFlowNode): void {
    const asset = viewableCanvasAsset(node);
    if (asset) setViewedAsset(asset);
  }

  function downloadAsset(assetId: string, fallbackName: string): void {
    const name = libraryAssets.find((candidate) => candidate.id === assetId)?.name ?? fallbackName;
    void assetBlob(assetId).then((blob) => downloadAssetBlob(blob, name)).catch((cause) => setNotice({ kind: "action", message: t("assetCanvas.downloadFailed", { error: errorMessage(cause) }) }));
  }

  function assetBlob(assetId: string): Promise<Blob> {
    const local = assetPaths.get(assetId);
    return local ? getWorkspaceAsset(local.projectId, local.path) : getLibraryAsset(assetId);
  }

  function sendAssetToProject(assetId: string, fallbackName: string): void {
    setViewedAsset(undefined);
    const name = libraryAssets.find((candidate) => candidate.id === assetId)?.name ?? fallbackName;
    void (assetPaths.has(assetId) ? exportCanvasAsset(projectId, assetId) : Promise.resolve({ assetId }))
      .then((asset) => setSentAsset({ assetId: asset.assetId, name }))
      .catch((cause) => setNotice({ kind: "action", message: t("assetCanvas.sendFailed", { error: errorMessage(cause) }) }));
  }

  function clearSelection(): void {
    setSelectedAssetEdgeId(undefined);
    setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
  }

  function activateNode(nodeId: string): void {
    setCanvasContextMenu(undefined);
    setSelectedAssetEdgeId(undefined);
    setMarqueeSelectedIds((current) => {
      if (!current.has(nodeId)) return current;
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
  }

  async function generateTextNode(node: AssetCanvasFlowNode, model: AgentModelRef, reasoningLevel: AgentReasoningLevel): Promise<void> {
    if (node.type !== "text" || generatingTextNodeId) return;
    const instruction = node.data.instruction?.trim();
    if (!instruction) {
      setGenerationError({ nodeId: node.id, message: t("assetCanvas.instructionRequired") });
      return;
    }
    setGeneratingTextNodeId(node.id);
    setGenerationError(undefined);
    try {
      const referenceSource = { boardId: storage.boardId, nodeId: node.id };
      await documents.flush();
      const result = await generateCanvasText(projectId, instruction, model, reasoningLevel, referenceSource);
      setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, text: result.text, textModel: result.model, reasoningLevel } }
        : candidate));
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      setGeneratingTextNodeId(undefined);
    }
  }

  async function uploadReferenceImages(node: AssetCanvasFlowNode, files: File[]): Promise<void> {
    if ((node.type !== "image" && node.type !== "model-3d") || files.length === 0 || uploadingNodeId) return;
    const available = (node.type === "image" ? imageReferenceLimit(node, imageModels) : (nodeModel3D(node, model3DModels)?.maxReferenceImages ?? MODEL_3D_MAX_REFERENCE_IMAGES)) - (node.data.images?.length ?? 0);
    if (available <= 0) {
      setGenerationError({ nodeId: node.id, message: t("assetCanvas.noMoreReferences") });
      return;
    }
    if (files.length > available) {
      setGenerationError({ nodeId: node.id, message: t("assetCanvas.addUpTo", { count: available }) });
      return;
    }
    setUploadingNodeId(node.id);
    setGenerationError(undefined);
    try {
      const images = await Promise.all(files.map(readUploadImage));
      const assets = await Promise.all(images.map(({ name, image }) => createLibraryImage({ name, image, purpose: "reference" })));
      setNodes((current) => current.map((candidate) => candidate.id === node.id && (candidate.type === "image" || candidate.type === "model-3d")
        ? {
            ...candidate,
            data: {
              ...candidate.data,
              images: [...(candidate.data.images ?? []), ...assets.map((asset): AssetCanvasReference => ({ type: "library", assetId: asset.id }))],
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

  function addLibraryReference(node: AssetCanvasFlowNode, asset: LibraryAsset): void {
    const reference: AssetCanvasReference = { type: "library", assetId: asset.id };
    setGenerationError(undefined);
    setNodes((current) => current.map((candidate) => candidate.id !== node.id ? candidate
      : candidate.type === "image" || candidate.type === "model-3d"
        ? { ...candidate, data: { ...candidate.data, images: [...(candidate.data.images ?? []), reference] } }
        : candidate.type === "video"
          ? { ...candidate, data: { ...candidate.data, references: [...(candidate.data.references ?? []), reference] } }
          : candidate));
  }

  async function uploadVideoReferences(node: AssetCanvasFlowNode, files: File[]): Promise<void> {
    if (node.type !== "video" || files.length === 0 || uploadingNodeId) return;
    const remaining = videoReferenceLimit(selectedVideoModel(node, videoModels), node.data.referenceMode) - (node.data.references?.length ?? 0);
    if (files.length > remaining) {
      setGenerationError({ nodeId: node.id, message: t("assetCanvas.modeAccepts", { count: Math.max(0, remaining) }) });
      return;
    }
    setUploadingNodeId(node.id);
    setGenerationError(undefined);
    try {
      const uploads = await Promise.all(files.map(prepareVideoReferenceFile));
      for (const upload of uploads) {
        const asset = await uploadLibraryAsset(upload.file, upload.mediaType, undefined, "reference");
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

  async function generateMedia(node: AssetCanvasFlowNode): Promise<void> {
    if (canvasJobs[node.id]?.status === "running" || startingCanvasNodesRef.current.has(node.id)) return;
    startingCanvasNodesRef.current.add(node.id);
    setStartingCanvasNodes((current) => new Set(current).add(node.id));
    setGenerationError(undefined);
    try {
      await flush();
      const job = await storageRef.current.generate(node.id);
      setCanvasJobs((current) => ({ ...current, [node.id]: job }));
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      startingCanvasNodesRef.current.delete(node.id);
      setStartingCanvasNodes((current) => {
        const next = new Set(current);
        next.delete(node.id);
        return next;
      });
    }
  }

  async function cancelCanvasJob(nodeId: string): Promise<void> {
    const job = canvasJobs[nodeId];
    if (!job) return;
    try {
      setCanvasJobs((current) => ({ ...current, [nodeId]: { ...job, status: "cancelled" } }));
      const next = await storageRef.current.cancel(job.id);
      setCanvasJobs((current) => ({ ...current, [nodeId]: next }));
    } catch (error) {
      setGenerationError({ nodeId, message: errorMessage(error) });
    }
  }

  function rememberSettings(node: AssetCanvasFlowNode, data: AssetCanvasFlowData): void {
    const next = nodeGenerationSettings({ type: node.type, data });
    if (!next || JSON.stringify(next) === JSON.stringify(nodeGenerationSettings(node))) return;
    rememberedSettings.current[node.type] = next;
  }

  function nodeReferencesRuntime(node: AssetCanvasFlowNode): CanvasNodeReferencesRuntime {
    return {
      references: (node.data.references ?? []).flatMap((reference) => {
        if (reference.type !== "node") return [];
        const source = nodes.find((candidate) => candidate.id === reference.nodeId);
        const doc = source?.type === "document" ? documents.documents.find((document) => document.id === source.data.documentId) : undefined;
        return [{
          nodeId: reference.nodeId,
          name: source ? canvasNodeTitle(toAssetCanvasNode(source), documents.documents, libraryAssets) : t("assetCanvas.missingNode"),
          type: source?.type === "text" ? "text" as const : source?.type === "document" ? "document" as const : "image" as const,
          text: source?.type === "text" ? source.data.text : doc?.markdown,
          assetId: source?.data.assetId,
        }];
      }),
      onRemoveReference: (index) => setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, references: (candidate.data.references ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
        : candidate)),
    };
  }

  const expanded = documents.documents.find((doc) => doc.id === expandedDocument?.id);
  const expandedNode = nodes.find((node) => node.id === expandedDocument?.nodeId && node.type === "document");

  const tableContents = [...tables.storage.sessions.values()].map((session) => session.local);
  const renderedNodes = nodes.map((original) => {
    const size = isResizableCanvasNodeType(original.type) ? RESIZABLE_CANVAS_NODE_SIZES[original.type] : undefined;
    const node = { ...original, ...(size ? { style: { ...original.style, width: original.width ?? size.width, height: original.height ?? size.height } } : {}), data: { ...original.data,
      ...(size ? { resizeRuntime: {
        start: beginHistoryGesture, end: finishHistoryGesture,
        reset: () => { beginHistoryGesture(); setNodes((current) => current.map((node) => { if (node.id !== original.id) return node; const { width: _width, height: _height, ...rest } = node; return rest; })); finishHistoryGesture(); },
        ...(original.type === "text" ? { open: () => setExpandedTextId(original.id) } : {}),
      } } : {}), assetAspectRatio: mediaAspectRatio(libraryAssets.find((asset) => asset.id === original.data.assetId)), panelOpen: original.selected === true && !marqueeActive && !marqueeSelectedIds.has(original.id), nodeDetails: {
      title: original.title?.trim(), label: canvasNodeTitle(toAssetCanvasNode(original, model3DModels), documents.documents, libraryAssets, tableContents), description: original.description,
      edit: () => setNodeDetails({ id: original.id, title: original.title ?? "", description: original.description ?? "" }),
    } } };
    if (node.type === "table") {
      const session = tables.storage.sessions.get(node.data.tableId ?? "");
      return { ...node, data: { ...node.data, tableRuntime: { tables, table: session?.local, issue: session?.issue ?? tables.issues?.find((issue) => issue.id === node.data.tableId)?.message, models: textModelCatalog.models, modelStatus: textModelCatalog.status, defaultModel: defaultTextModel, defaultReasoningLevel: textModelCatalog.defaultReasoningLevel } } };
    }
    if (node.type === "document") return { ...node, data: { ...node.data, documentRuntime: { ...nodeReferencesRuntime(node), referenceSource: { boardId: storage.boardId, nodeId: node.id }, design: documents, document: documents.documents.find((doc) => doc.id === node.data.documentId), models: textModelCatalog.models, modelStatus: textModelCatalog.status, defaultModel: defaultTextModel, defaultReasoningLevel: textModelCatalog.defaultReasoningLevel } } };
    if (node.type === "asset") return {
      ...node,
      data: (() => {
        const asset = libraryAssets.find((candidate) => candidate.id === node.data.assetId);
        const local = assetPaths.get(node.data.assetId ?? "");
        return {
          ...node.data,
          name: asset?.name ?? local?.name ?? t("assetCanvas.missingAsset"),
          assetError: local?.error,
          assetOrigin: local ? "Project" as const : "Library" as const,
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
          ...nodeReferencesRuntime(node),
          models: textModelCatalog.models,
          modelStatus: textModelCatalog.status,
          ...(defaultTextModel ? { defaultModel: defaultTextModel } : {}),
          defaultReasoningLevel: textModelCatalog.defaultReasoningLevel,
          generating: generatingTextNodeId === node.id,
          busy: Boolean(generatingTextNodeId),
          ...(generationError?.nodeId === node.id ? { error: generationError.message } : {}),
          onChange: (data: AssetCanvasFlowData) => {
            rememberSettings(node, data);
            setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
            setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
          },
          onGenerate: (model: AgentModelRef, reasoningLevel: AgentReasoningLevel) => void generateTextNode(node, model, reasoningLevel),
        },
      },
    };
    if (node.type === "model-3d") {
      const nodeJob = canvasJobs[node.id];
      const operation = node.data.model3DOperation ?? "image";
      const availableModels = (operation === "image" || operation === "text" ? model3DModels : operationModels3D).filter((model) => (model.operations ?? ["image"]).includes(operation));
      const model = nodeModel3D(node, availableModels);
      return {
        ...node,
        data: {
          ...node.data,
          model3DRuntime: {
            generating: nodeJob?.status === "running",
            busy: nodeJob?.status === "running" || startingCanvasNodes.has(node.id) || Boolean(uploadingNodeId),
            ...(nodeJob?.status === "failed" || nodeJob?.status === "cancelled" ? { error: nodeJob.error } : generationError?.nodeId === node.id ? { error: generationError.message } : {}),
            onCancel: nodeJob?.status === "running" ? () => void cancelCanvasJob(node.id) : undefined,
            onChange: (data: AssetCanvasFlowData) => {
              rememberSettings(node, data);
              setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
              setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
            },
            onGenerate: () => void generateMedia(node),
            references: imageReferenceViews(node, nodes, libraryAssets, model3DModels),
            maxReferences: operation === "text" || operation === "remesh" ? 0 : operation === "retexture" ? 1 : model?.maxReferenceImages ?? MODEL_3D_MAX_REFERENCE_IMAGES,
            slotLabels: operation === "image" ? model3DViewLabels(model) : undefined,
            showEmptySlots: operation === "image" && Boolean(model?.referenceImageLabels),
            uploading: uploadingNodeId === node.id,
            accept: "image/png,image/jpeg,image/webp",
            addLabel: t("assetCanvas.addReferences"),
            onRemoveReference: (index: number) => setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "model-3d"
              ? { ...candidate, data: { ...candidate.data, images: (candidate.data.images ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
              : candidate)),
            onUploadReferences: (files: File[]) => void uploadReferenceImages(node, files),
            libraryImages,
            onAddLibraryReference: (asset: LibraryAsset) => addLibraryReference(node, asset),
            models: availableModels,
            linkedPrompt: resolveLinkedPrompt(node, nodes, documents),
            onDisconnectPrompt: () => setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data: { ...candidate.data, promptSource: undefined } } : candidate)),
            sourceRuntime: {
              busy: nodeJob?.status === "running",
              references: modelReferenceViews(node, nodes, libraryAssets), maxReferences: 1, slotLabels: [t("assetCanvas.sourceModel")], uploading: false, accept: "", addLabel: t("assetCanvas.connectGlb"),
              onRemoveReference: () => setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data: { ...candidate.data, model3DSource: undefined } } : candidate)),
            },
            providers: model3DProviders,
          },
        },
      };
    }
    if (node.type === "animate-3d") {
      const nodeJob = canvasJobs[node.id];
      return {
        ...node,
        data: {
          ...node.data,
          animateRuntime: {
            generating: nodeJob?.status === "running",
            busy: nodeJob?.status === "running" || startingCanvasNodes.has(node.id),
            ...(nodeJob?.status === "failed" || nodeJob?.status === "cancelled" ? { error: nodeJob.error } : generationError?.nodeId === node.id ? { error: generationError.message } : {}),
            onCancel: nodeJob?.status === "running" ? () => void cancelCanvasJob(node.id) : undefined,
            onChange: (data: AssetCanvasFlowData) => {
              setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
              setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
            },
            onGenerate: () => void generateMedia(node),
            references: modelReferenceViews(node, nodes, libraryAssets),
            maxReferences: 1,
            slotLabels: [t("assetCanvas.model")],
            uploading: false,
            accept: "",
            addLabel: t("assetCanvas.connect3d"),
            onRemoveReference: () => setNodes((current) => current.map((candidate) => candidate.id === node.id
              ? { ...candidate, data: { ...candidate.data, images: [] } }
              : candidate)),
            models: operationModels3D.filter((model) => model.operations?.includes("animate")),
          } satisfies Animate3DNodeRuntime,
        },
      };
    }
    if (!isMediaNodeType(node.type)) return node;
    const linkedPrompt = resolveLinkedPrompt(node, nodes, documents);
    const nodeJob = canvasJobs[node.id];
    const runtime: MediaNodeRuntime = {
      generating: nodeJob?.status === "running",
      busy: nodeJob?.status === "running" || startingCanvasNodes.has(node.id) || Boolean(uploadingNodeId),
      ...(nodeJob?.status === "failed" || nodeJob?.status === "cancelled" ? { error: nodeJob.error } : generationError?.nodeId === node.id ? { error: generationError.message } : {}),
      onCancel: nodeJob?.status === "running" ? () => void cancelCanvasJob(node.id) : undefined,
      onChange: (data) => {
        rememberSettings(node, data);
        setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
        setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
      },
      onGenerate: () => void generateMedia(node),
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
      maxReferences: node.type === "image" ? imageReferenceLimit(node, imageModels) : videoReferenceLimit(selectedVideoModel(node, videoModels), node.data.referenceMode),
      uploading: uploadingNodeId === node.id,
      accept: "image/png,image/jpeg,image/webp",
      addLabel: t("assetCanvas.addReferences"),
      onRemoveReference: (index) => {
        setSelectedAssetEdgeId(undefined);
        setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "image"
          ? { ...candidate, data: { ...candidate.data, images: (candidate.data.images ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
          : candidate.id === node.id && candidate.type === "video"
            ? { ...candidate, data: { ...candidate.data, references: (candidate.data.references ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
          : candidate));
      },
      onUploadReferences: (files) => node.type === "image" ? void uploadReferenceImages(node, files) : void uploadVideoReferences(node, files),
      libraryImages,
      onAddLibraryReference: (asset) => addLibraryReference(node, asset),
    };
    return {
      ...node,
      data: node.type === "image"
        ? { ...node.data, imageRuntime: { ...referenceRuntime, models: imageModels, providers: imageProviders } satisfies ImageNodeRuntime }
        : { ...node.data, videoRuntime: { ...referenceRuntime, models: videoModels, providers: videoProviders } satisfies VideoNodeRuntime },
    };
  });

  function applyEditorCanvas(next: AssetCanvasDocument): void {
    next = { ...next, editorLayout: { ...next.editorLayout, viewport: latestCanvas.current?.editorLayout.viewport ?? next.editorLayout.viewport } };
    validateAssetCanvasDocument(next);
    observeHistoryDocument(next);
    setViewport(next.viewport);
    setNodes(next.nodes.map((node) => toFlowNode(node, imageModels, videoModels)));
    setEdges(next.edges);
    setEditorLayout(next.editorLayout);
  }

  return (
    <section className="viewer-pane interactive-story-workspace" hidden={hidden} aria-label={t("canvas.assetCanvasWorkspace")}>
      {expandedTextId && nodes.find((node) => node.id === expandedTextId)?.type === "text" ? <div className="design-expanded-document" role="dialog" aria-modal="true" aria-label={t("assetCanvas.expandedText")}>
        <header className="design-expanded-toolbar"><FileText size={16} /><strong>{t("assetCanvas.node.text")}</strong></header>
        <div className="design-expanded-body"><CanvasTextarea autoFocus aria-label={t("assetCanvas.expandedText")} value={nodes.find((node) => node.id === expandedTextId)?.data.text ?? ""} onChange={(text) => setNodes((current) => current.map((node) => node.id === expandedTextId ? { ...node, data: { ...node.data, text } } : node))} /></div>
        <button type="button" className="design-expanded-close" title={t("canvas.backToCanvas")} aria-label={t("canvas.backToCanvas")} onClick={() => setExpandedTextId(undefined)}><X size={16} /></button>
      </div> : null}
      <div className="interactive-story-body">
        <div ref={canvasElement} tabIndex={0} inert={resolving || undefined} aria-busy={resolving || undefined} className={`interactive-story-canvas${selectedNodes.length === 1 ? " has-single-selection" : ""}${fileDropActive ? " is-file-drop-active" : ""}`} onPointerMoveCapture={(event) => { pointer.current = { x: event.clientX, y: event.clientY }; }}
          onPointerDownCapture={(event) => { if (!isTextEntry(event.target) && !eventWithin(event, "button, a, .nokey")) event.currentTarget.focus({ preventScroll: true }); }}
          onCopy={copySelection} onCut={(event) => copySelection(event, true)} onPaste={pasteFromClipboard}
          onKeyDown={(event) => {
            if (phase !== "ready" || isTextEntry(event.target) || eventWithin(event, ".nokey")) return;
            // React Flow's keyboard activation does not emit onNodeClick.
            if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLElement && event.target.matches(".react-flow__node")) {
              const nodeId = event.target.dataset.id;
              if (nodeId) activateNode(nodeId);
            }
            pasteNativeFiles(event, (files) => { void importCanvasFiles(files, transferPosition()); }, (cause) => setTransferError(errorMessage(cause)));
          }}
          onDragEnter={(event) => { if (!hasTransferredFiles(event.dataTransfer)) return; event.preventDefault(); dragDepth.current++; setFileDropActive(true); }}
          onDragOver={(event) => { if (!hasTransferredFiles(event.dataTransfer)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
          onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setFileDropActive(false); }}
          onDrop={(event) => {
            if (!hasTransferredFiles(event.dataTransfer)) return;
            event.preventDefault(); dragDepth.current = 0; setFileDropActive(false);
            if (phase !== "ready") return;
            const at = flowInstance.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 96, y: 96 };
            void importCanvasFiles(transferredFiles(event.dataTransfer), at);
          }}>
          {overlay}
          {fileDropActive ? <div className="canvas-file-drop-overlay"><Upload size={18} /><span>{t("assetCanvas.dropFiles")}</span></div> : importingAssets ? <div className="canvas-file-import-status" role="status"><LoaderCircle size={13} className="spin" /><span>{t("assetCanvas.importing")}</span></div> : null}
          {phase === "loading" ? <div className="story-canvas-state">{t("assetCanvas.loading")}</div> : null}
          {phase === "error" ? <div className="story-canvas-state story-canvas-state-error" role="alert"><span>{t("assetCanvas.loadFailed", { error: loadError })}</span><button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>{t("assetCanvas.reload")}</button></div> : null}
          {phase === "ready" ? (
            <EditorCanvas<AssetCanvasFlowNode>
              nodes={renderedNodes}
              edges={[...edges, ...assetEdges]}
              nodeTypes={STORY_NODE_TYPES}
              onInit={(instance) => { flowInstance.current = instance; }}
              addControl={<AssetCanvasAddControl
                documents={documents} tables={tables}
                libraryAssets={libraryAssets.filter((asset) => asset.mediaType === "image" || asset.mediaType === "video" || asset.mediaType === "audio" || asset.mediaType === "model")}
                importing={importingAssets}
                onAdd={addNode}
                onAddAsset={addAssetNode}
                onUpload={(file, position) => void importAssetFile(file, position)}
              />}
              onOpenMenu={setCanvasContextMenu}
              addOnDoubleClick
              deleteKeyCode={["Backspace", "Delete"]}
              onNodesChange={onNodesChange}
              onNodeDragStart={() => { setCanvasContextMenu(undefined); beginHistoryGesture(); }}
              onNodeDragStop={finishHistoryGesture}
              onMoveStart={() => setCanvasContextMenu(undefined)}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onMoveEnd={(_event, viewport) => setEditorLayout((current) => ({ ...current, viewport }))}
              onEdgeClick={(_event, edge) => setSelectedAssetEdgeId(edge.id.startsWith(ASSET_EDGE_PREFIX) ? edge.id : undefined)}
              onSelectionStart={() => setMarqueeActive(true)}
              onSelectionEnd={() => {
                setMarqueeActive(false);
                setMarqueeSelectedIds(new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id)));
              }}
              onNodeClick={(event, node) => {
                activateNode(node.id);
                if (eventWithin(event, ".story-media-view-button")) openViewer(node);
              }}
              // Only the preview opens the viewer; the prompt, chips, and video controls below keep their own double-click.
              onNodeDoubleClick={(event, node) => { if (eventWithin(event, ".story-media-stage")) openViewer(node); }}
              onPaneClick={() => { setCanvasContextMenu(undefined); clearSelection(); }}
              onNodeContextMenu={(_event, node) => {
                activateNode(node.id);
                setNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
              }}
              onNodesDelete={(deleted) => {
                removeCanvasNodes(new Set(deleted.map((node) => node.id)));
              }}
              isValidConnection={(connection) => {
                const target = nodes.find((node) => node.id === connection.target);
                const source = nodes.find((node) => node.id === connection.source);
                return Boolean(source && target && connectionRelation(source, target, connection.sourceHandle, nodes, libraryAssets, imageModels, model3DModels));
              }}
              defaultViewport={editorLayout.viewport}
              fitViewOnLoad={editorLayout.fitView === true}
              onInitialFit={finishInitialFit}
            />
          ) : null}
          {canvasContextMenu ? <AssetCanvasContextMenu
            documents={documents} tables={tables}
            onUseInDocument={contextMenuNode?.type === "text" && contextMenuNode.data.text ? () => documents.appendText(contextMenuNode.data.text!) : contextMenuNode?.data.assetId && (contextMenuNode.type === "image" || contextMenuNode.data.mediaType === "image") ? () => documents.appendImage(contextMenuNode.data.assetId!) : undefined}
            menu={canvasContextMenu}
            canUndo={canUndo}
            canRedo={canRedo}
            canPaste={canInsertCopiedNode}
            canDuplicate={Boolean(contextMenuNode)}
            canView={Boolean(contextMenuNode && viewableCanvasAsset(contextMenuNode))}
            canDownload={Boolean(contextMenuNode?.data.assetId)}
            canSendToProject={Boolean(contextMenuNode?.data.assetId)}
            nodeActionsDisabled={Boolean(contextMenuNodeMissing)}
            importing={importingAssets}
            onClose={() => setCanvasContextMenu(undefined)}
            onDetails={contextMenuNode ? () => setNodeDetails({ id: contextMenuNode.id, title: contextMenuNode.title ?? "", description: contextMenuNode.description ?? "" }) : undefined}
            onUndo={undoEditorChange}
            onRedo={redoEditorChange}
            onPaste={() => { const value = lastCanvasClipboard(); if (value) pasteSelection(value, canvasContextMenu.flowPosition); }}
            onAdd={(item) => addCanvasNode(item, canvasContextMenu.flowPosition)}
            onUpload={(file) => void importAssetFile(file, canvasContextMenu.flowPosition)}
            onView={() => { if (contextMenuNode) openViewer(contextMenuNode); }}
            onDownload={() => { if (contextMenuNode?.data.assetId) downloadAsset(contextMenuNode.data.assetId, contextMenuNode.data.name || titleCase(contextMenuNode.type ?? "asset")); }}
            onSendToProject={() => { if (contextMenuNode?.data.assetId) sendAssetToProject(contextMenuNode.data.assetId, contextMenuNode.data.name || titleCase(contextMenuNode.type ?? "asset")); }}
            onCopy={() => { if (canvasContextMenu.nodeId) copyCanvasNode(canvasContextMenu.nodeId); }}
            onDuplicate={() => { if (canvasContextMenu.nodeId) duplicateCanvasNode(canvasContextMenu.nodeId); }}
            onDelete={() => { if (canvasContextMenu.nodeId) removeCanvasNodes(new Set([canvasContextMenu.nodeId])); }}
          /> : null}
          {notice && phase === "ready" && !conflicted ? <CanvasNotice className="story-save-notice" tone={notice.kind === "save" ? "error" : "neutral"} message={notice.kind === "save" ? t("assetCanvas.saveFailed") : t("canvas.actionFailed")} detail={notice.message} actionLabel={t("canvas.retrySave")} onAction={notice.kind === "save" ? flush : undefined} onDismiss={() => setNotice(undefined)} /> : null}
          {!notice && transferError && phase === "ready" ? <CanvasNotice className="story-save-notice canvas-transfer-error" message={t("assetCanvas.transferFailed")} detail={transferError} onDismiss={() => setTransferError(undefined)} /> : null}
        </div>
      </div>
      {expanded && expandedDocument ? <div className="design-expanded-document" role="dialog" aria-modal="true" aria-label={expanded.title}>
        <ExpandedCanvasDocument design={documents} document={expanded}
          references={expandedNode ? nodeReferencesRuntime(expandedNode) : undefined}
          referenceSource={expandedNode ? { boardId: storage.boardId, nodeId: expandedNode.id } : undefined} />
        <button className="design-expanded-close" type="button" title={t("canvas.backToCanvas")} aria-label={t("canvas.backToCanvas")} disabled={expandedDocument.busy} onClick={expandedDocument.onClose}><X size={16} /></button>
      </div> : null}
      {viewedAsset ? <CanvasAssetViewer
        asset={viewedAsset}
        name={libraryAssets.find((candidate) => candidate.id === viewedAsset.assetId)?.name ?? titleCase(viewedAsset.mediaType)}
        onDownload={(name) => downloadAsset(viewedAsset.assetId, name)}
        onSendToProject={(name) => sendAssetToProject(viewedAsset.assetId, name)}
        onClose={() => setViewedAsset(undefined)}
      /> : null}
      {sentAsset ? <SendToProjectDialog assetId={sentAsset.assetId} name={sentAsset.name} onClose={() => setSentAsset(undefined)} /> : null}
      {nodeDetails ? createPortal(<div className="design-modal-backdrop nokey" onPointerDown={(event) => { if (event.target === event.currentTarget) setNodeDetails(undefined); }}><section className="design-modal" role="dialog" aria-modal="true" aria-label={t("assetCanvas.nodeDetails")} onKeyDown={(event) => { if (event.key === "Escape") setNodeDetails(undefined); }}>
        <header><h2>{t("assetCanvas.nodeDetails")}</h2><button type="button" title={t("common.close")} aria-label={t("common.close")} onClick={() => setNodeDetails(undefined)}><X size={16} /></button></header>
        <form onSubmit={(event) => { event.preventDefault(); setNodes((current) => current.map((node) => node.id === nodeDetails.id ? { ...node, title: nodeDetails.title.trim() || undefined, description: nodeDetails.description.trim() || undefined } : node)); setNodeDetails(undefined); }}>
          <label>{t("common.name")}<input autoFocus maxLength={200} value={nodeDetails.title} placeholder={t("assetCanvas.automaticName")} onChange={(event) => setNodeDetails({ ...nodeDetails, title: event.target.value })} /></label>
          <label>{t("publish.description")}<textarea rows={3} maxLength={2000} value={nodeDetails.description} onChange={(event) => setNodeDetails({ ...nodeDetails, description: event.target.value })} /></label>
          <code className="canvas-node-id">{nodeDetails.id}</code>
          <footer><button type="button" onClick={() => setNodeDetails(undefined)}>{t("common.cancel")}</button><button type="submit">{t("common.save")}</button></footer>
        </form>
      </section></div>, window.document.body) : null}
    </section>
  );
}

export function canvasHistoryKey(canvas: AssetCanvasDocument): string {
  return JSON.stringify({ viewport: canvas.viewport, nodes: canvas.nodes, edges: canvas.edges }, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}

function TextNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.textRuntime;
  return (
    <div className={`story-node story-text-node${selected ? " is-selected" : ""}`}>
      <CanvasNodeResizer selected={selected} runtime={data.resizeRuntime} />
      <div data-alignment-frame className="story-text-output">
        <CanvasNodeLabel icon={FileText} label={t("assetCanvas.node.text")} details={data.nodeDetails} />
        <CanvasTextarea
          className="nodrag nowheel"
          aria-label={t("assetCanvas.textOutput")}
          rows={5}
          value={data.text ?? ""}
          disabled={runtime?.busy}
          readOnly={!selected}
          placeholder={t("assetCanvas.textPlaceholder")}
          onChange={(text) => runtime?.onChange({ ...data, textRuntime: undefined, text })}
        />
        <footer className={`design-document-node-footer nodrag nowheel${selected ? "" : " is-hidden"}`}><span /><div className="design-document-node-actions"><CanvasNodeSizeActions runtime={data.resizeRuntime} /></div></footer>
      </div>
      {data.panelOpen ? (
        <div className="canvas-node-auxiliary">
        <CanvasTextComposer models={runtime?.models ?? []} modelStatus={runtime?.modelStatus ?? "loading"} defaultModel={runtime?.defaultModel} defaultReasoningLevel={runtime?.defaultReasoningLevel}
          references={runtime ? <CanvasNodeReferenceStrip {...runtime} /> : null}
          model={data.textModel} reasoningLevel={data.reasoningLevel} instruction={data.instruction ?? ""} generating={runtime?.generating} busy={runtime?.busy} error={runtime?.error}
          onInstruction={(instruction) => runtime?.onChange({ ...data, textRuntime: undefined, instruction })}
          onModel={(textModel, reasoningLevel) => runtime?.onChange({ ...data, textRuntime: undefined, textModel, reasoningLevel })}
          onReasoningChange={(reasoningLevel) => runtime?.onChange({ ...data, textRuntime: undefined, textModel: data.textModel ?? runtime.defaultModel, reasoningLevel })}
          onGenerate={(model, reasoningLevel) => runtime?.onGenerate(model, reasoningLevel)} />
        </div>
      ) : null}
      <Handle className="story-text-output-handle" id="references" type="target" position={Position.Left} />
      <Handle className="story-text-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
    </div>
  );
}

function ImageNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.imageRuntime;
  const selectedModel = runtime?.models.find((model) => sameImageModel(model, data.model));
  const modelOptions = selectedModel?.generationOptions ?? [];
  const resolutions = [...new Set(modelOptions.map((option) => option.resolution))];
  const aspectRatios = [...new Set(modelOptions
    .filter((option) => option.resolution === data.resolution)
    .map((option) => option.aspectRatio))];

  function selectModel(key: string): void {
    const model = runtime?.models.find((candidate) => modelRefKey(candidate) === key);
    const option = model?.generationOptions.find((candidate) => candidate.resolution === data.resolution && candidate.aspectRatio === data.aspectRatio)
      ?? preferredImageOption(model, data.aspectRatio);
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
    <MediaNodeShell kind="image" selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} assetAspectRatio={data.assetAspectRatio} aspectRatio={data.aspectRatio} runtime={runtime} details={data.nodeDetails}>
      <MediaReferenceStrip runtime={runtime} />
      <MediaPrompt
        kind="image"
        value={data.prompt ?? ""}
        runtime={runtime}
        onChange={(prompt) => runtime?.onChange({ ...data, imageRuntime: undefined, prompt })}
      />
      {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
      <div className="story-media-controls">
        <CanvasChipSelect
          label={t("assetCanvas.imageModel")}
          wide
          value={selectedModel ? modelRefKey(selectedModel) : undefined}
          placeholder={data.model ? t("assetCanvas.unavailableModel") : runtime?.models.length ? t("assetCanvas.selectModel") : t("assetCanvas.noImageModel")}
          options={(runtime?.models ?? []).map((model) => ({ value: modelRefKey(model), label: mediaModelName(model), group: model.providerName }))}
          notes={providerNotes(runtime?.providers)}
          action={MANAGE_PROVIDERS}
          disabled={runtime?.busy}
          onChange={selectModel}
        />
        <CanvasChipSelect
          label={t("assetCanvas.imageAspect")}
          value={data.aspectRatio}
          options={aspectRatios.map((ratio) => ({ value: ratio, label: ratio }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={(aspectRatio) => runtime?.onChange({ ...data, imageRuntime: undefined, aspectRatio })}
        />
        <CanvasChipSelect
          label={t("assetCanvas.imageResolution")}
          value={data.resolution}
          options={resolutions.map((resolution) => ({ value: resolution, label: resolution }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={selectResolution}
        />
        <GenerateMediaButton kind="image" assetId={data.assetId} runtime={runtime} disabled={!effectivePrompt(data, runtime).trim() || !selectedModel} />
      </div>
    </MediaNodeShell>
  );
}

function VideoNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.videoRuntime;
  const selectedModel = runtime?.models.find((model) => sameModel(model, data.videoModel));
  const aspectRatios = videoAspectRatios(selectedModel, data.references?.length ?? 0, data.referenceMode);
  const mode = videoReferenceMode(selectedModel, data.referenceMode);
  const references = data.references ?? [];
  const aliases = videoReferenceAliases(references, data.referenceMentions);
  const mentionOptions = references.map((reference, index) => ({
    alias: Object.keys(aliases).find((alias) => sameVideoReference(aliases[alias]!, reference))!,
    name: runtime?.references[index]?.name ?? t("assetCanvas.imageNumber", { number: index + 1 }),
    assetId: runtime?.references[index]?.assetId,
  }));
  let referenceError: string | undefined;
  try { resolveVideoMentions(effectivePrompt(data, runtime), references, aliases); }
  catch (cause) { referenceError = errorMessage(cause); }
  const limit = videoReferenceLimit(selectedModel, data.referenceMode);
  if (selectedModel && references.length > limit) referenceError = t("assetCanvas.modeLimit", { limit });

  useEffect(() => {
    if (!runtime || !selectedModel || !aspectRatios.length || aspectRatios.includes(data.videoAspectRatio as VideoAspectRatio)) return;
    runtime.onChange({ ...data, videoRuntime: undefined, videoAspectRatio: aspectRatios[0] });
  }, [aspectRatios, data, runtime, selectedModel]);

  function selectModel(key: string): void {
    const model = runtime?.models.find((candidate) => modelKey(candidate) === key);
    if (!model || !runtime) return;
    const referenceMode = model.referenceModes?.includes(data.referenceMode!) ? data.referenceMode : model.imageReferenceMode;
    runtime.onChange({
      ...data,
      videoRuntime: undefined,
      videoModel: { provider: model.provider, id: model.id },
      videoResolution: model.resolutions.includes(data.videoResolution as VideoResolution) ? data.videoResolution : model.resolutions[0],
      videoAspectRatio: videoAspectRatios(model, data.references?.length ?? 0, referenceMode).includes(data.videoAspectRatio as VideoAspectRatio)
        ? data.videoAspectRatio
        : videoAspectRatios(model, data.references?.length ?? 0, referenceMode)[0],
      duration: model.durations.includes(data.duration ?? 0) ? data.duration : model.durations[0],
      referenceMode,
      references: data.references ?? [],
    });
  }

  return (
    <MediaNodeShell kind="video" selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} assetAspectRatio={data.assetAspectRatio} aspectRatio={data.videoAspectRatio} runtime={runtime} details={data.nodeDetails}>
      <MediaReferenceStrip runtime={runtime ? { ...runtime, slotLabels: mode === "frame" ? [t("assetCanvas.firstFrame"), t("assetCanvas.lastFrame")] : mentionOptions.map((option) => `@${option.alias}`) } : undefined} />
      <VideoReferencePrompt
        value={data.prompt ?? ""}
        disabled={runtime?.busy}
        options={mentionOptions}
        onChange={(prompt) => runtime?.onChange({ ...data, videoRuntime: undefined, prompt, referenceMentions: aliases })}
      />
      {referenceError ? <p role="alert">{referenceError}</p> : null}
      {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
      <div className="story-media-controls">
        <CanvasChipSelect
          label={t("assetCanvas.videoModel")}
          wide
          value={selectedModel ? modelKey(selectedModel) : undefined}
          placeholder={runtime?.models.length ? t("assetCanvas.selectModel") : t("assetCanvas.noVideoModel")}
          options={(runtime?.models ?? []).map((model) => ({ value: modelKey(model), label: mediaModelName(model), group: model.providerName }))}
          notes={providerNotes(runtime?.providers)}
          action={MANAGE_PROVIDERS}
          disabled={runtime?.busy}
          onChange={selectModel}
        />
        {selectedModel?.referenceModes?.length ? <CanvasChipSelect
          label={t("assetCanvas.referenceMode")} value={mode}
          options={selectedModel.referenceModes.map((value) => ({ value, label: value === "reference" ? t("assetCanvas.imageReferences") : t("assetCanvas.firstLast") }))}
          disabled={runtime?.busy}
          onChange={(referenceMode) => runtime?.onChange({ ...data, videoRuntime: undefined, referenceMode: referenceMode as "frame" | "reference" })}
        /> : null}
        <CanvasChipSelect
          label={t("assetCanvas.videoAspect")}
          value={data.videoAspectRatio}
          options={aspectRatios.map((ratio) => ({ value: ratio, label: ratio }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={(videoAspectRatio) => runtime?.onChange({ ...data, videoRuntime: undefined, videoAspectRatio })}
        />
        <CanvasChipSelect
          label={t("assetCanvas.videoResolution")}
          value={data.videoResolution}
          options={(selectedModel?.resolutions ?? []).map((resolution) => ({ value: resolution, label: resolution }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={(videoResolution) => runtime?.onChange({ ...data, videoRuntime: undefined, videoResolution })}
        />
        <CanvasChipSelect
          label={t("assetCanvas.videoDuration")}
          value={data.duration === undefined ? undefined : String(data.duration)}
          options={(selectedModel?.durations ?? []).map((duration) => ({ value: String(duration), label: t("assetCanvas.seconds", { count: duration }) }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={(duration) => runtime?.onChange({ ...data, videoRuntime: undefined, duration: Number(duration) })}
        />
        <GenerateMediaButton kind="video" assetId={data.assetId} runtime={runtime} disabled={!effectivePrompt(data, runtime).trim() || !selectedModel || Boolean(referenceError)} />
      </div>
    </MediaNodeShell>
  );
}

function videoAspectRatios(model: VideoModel | undefined, referenceCount: number, mode?: "frame" | "reference"): readonly VideoAspectRatio[] {
  return videoReferenceAspectRatios(model, referenceCount, mode);
}

function Model3DNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const auth = useAuth();
  const runtime = data.model3DRuntime;
  const config = nodeModel3DConfig({ type: "model-3d", data });
  const selectedModel = nodeModel3D({ type: "model-3d", data }, runtime?.models ?? []);
  const provider = runtime?.providers?.find((provider) => provider.provider === (selectedModel?.provider ?? config.model?.provider))
    ?? (!selectedModel && !config.model ? runtime?.providers?.find((provider) => provider.cloud) : undefined);
  const cloud = accountCloudState(provider?.cloud, auth.state.status === "signed-in" ? auth.state.user.id : undefined);
  const operation = data.model3DOperation ?? "image";
  const polycount = operation === "remesh" ? remeshPolycount(selectedModel?.protocol) : selectedModel?.polycount;
  const processing = operation === "retexture" || operation === "remesh";
  const hasInput = operation === "image" ? Boolean(data.images?.length) : operation === "text" ? Boolean(data.prompt?.trim() || runtime?.linkedPrompt?.trim())
    : Boolean(data.model3DSource) && (operation === "remesh" || (selectedModel?.protocol === "hyper3d" ? Boolean(data.images?.length) : Boolean(data.images?.length || data.prompt?.trim() || runtime?.linkedPrompt?.trim())));
  const changeOperation = (operation: Exclude<Model3DOperation, "animate">) => runtime?.onChange({ ...data, model3DOperation: operation, images: [], prompt: "", promptSource: undefined, model3DSource: undefined, model3DOptions: undefined });
  const updateConfig = (next: Partial<Model3DGenerationConfig>) => runtime?.onChange({
    ...data,
    model3DRuntime: undefined,
    model3DConfig: normalizeModel3DConfig({ ...config, ...next }, processing
      ? resolveModel3DConnection(next.model ?? config.model, runtime.models) : resolveModel3D(next.model ?? config.model, runtime.models), operation),
  });
  return (
    <MediaNodeShell
      kind="model"
      selected={selected}
      panelOpen={data.panelOpen}
      assetId={data.assetId}
      runtime={runtime}
      details={data.nodeDetails}
      emptyHint={operation === "text" ? t("assetCanvas.hint.text3d") : operation === "retexture" ? t("assetCanvas.hint.retexture") : operation === "remesh" ? t("assetCanvas.hint.remesh") : undefined}
    >
      {processing ? <MediaReferenceStrip runtime={runtime?.sourceRuntime} large /> : null}
      {operation !== "remesh" ? <MediaReferenceStrip runtime={runtime} large /> : null}
      {operation === "text" || operation === "retexture" ? <MediaPrompt kind="model" value={data.prompt ?? ""} runtime={runtime} onChange={(prompt) => runtime?.onChange({ ...data, prompt })} /> : null}
      {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
      <div className="story-media-controls is-3d">
        <CanvasChipSelect label={t("assetCanvas.operation")} value={operation} options={[
          { value: "image", label: t("assetCanvas.op.image") }, { value: "text", label: t("assetCanvas.op.text") }, { value: "retexture", label: t("assetCanvas.op.retexture") }, { value: "remesh", label: t("assetCanvas.op.remesh") },
        ]} disabled={runtime?.busy} onChange={(value) => changeOperation(value as Exclude<Model3DOperation, "animate">)} />
        <CanvasChipSelect
          label={processing ? t("assetCanvas.processingConnection") : t("assetCanvas.model3d")}
          wide
          value={selectedModel ? modelRefKey(selectedModel) : undefined}
          placeholder={processing ? t("assetCanvas.selectConnection") : runtime?.models.length ? t("assetCanvas.selectModel") : t("assetCanvas.no3dModel")}
          options={(runtime?.models ?? []).map((model) => ({ value: modelRefKey(model), label: model.name, group: model.id === MODEL3D_CONNECTION_ID ? undefined : model.providerName }))}
          notes={providerNotes(runtime?.providers)}
          action={MANAGE_PROVIDERS}
          disabled={runtime?.busy}
          onChange={(key) => {
            const model = runtime?.models.find((candidate) => modelRefKey(candidate) === key);
            if (model) { runtime?.onChange({ ...data, model3DOptions: undefined, model3DConfig: normalizeModel3DConfig({ ...config, model: modelRef(model), targetPolycount: model.polycount.default,
              texture: model.defaults?.texture ?? model.supportsTexture !== false, pbr: model.defaults?.pbr ?? false }, model, operation) }); }
          }}
        />
        {operation !== "retexture" ? <CanvasChipSelect
          label={t("assetCanvas.polycount")}
          value={String(config.targetPolycount)}
          options={polycountOptions(polycount?.presets ?? [], config.targetPolycount)}
          disabled={runtime?.busy || !selectedModel}
          onChange={(value) => updateConfig({ targetPolycount: Number(value) })}
        /> : null}
        {operation === "image" || operation === "text" ? <CanvasChipToggle label={t("assetCanvas.texture")} pressed={config.texture} disabled={runtime?.busy || !selectedModel || selectedModel.supportsTexture === false} onChange={(texture) => updateConfig({ texture, ...(!texture ? { pbr: false } : {}) })} /> : null}
        {operation !== "remesh" ? <CanvasChipToggle label="PBR" pressed={config.pbr} disabled={runtime?.busy || !selectedModel || !config.texture || selectedModel.supportsPbr === false} onChange={(pbr) => updateConfig({ pbr })} /> : null}
        {(operation === "image" || operation === "text") && (selectedModel?.protocol === "meshy" || selectedModel?.protocol === "hyper3d") ? <CanvasChipSelect label={t("assetCanvas.pose")} value={data.model3DOptions?.pose ?? "default"} options={[{ value: "default", label: t("assetCanvas.defaultPose") }, { value: "t-pose", label: selectedModel.protocol === "hyper3d" ? t("assetCanvas.atPose") : t("assetCanvas.tPose") }, ...(selectedModel.protocol === "meshy" ? [{ value: "a-pose", label: t("assetCanvas.aPose") }] : [])]} onChange={(pose) => runtime?.onChange({ ...data, model3DOptions: { ...data.model3DOptions, pose: pose === "default" ? undefined : pose as Model3DOptions["pose"] } })} disabled={runtime?.busy} /> : null}
        {operation === "retexture" && selectedModel?.protocol !== "hyper3d" ? <CanvasChipSelect label={t("assetCanvas.textureVersion")} value={data.model3DOptions?.textureModel ?? (selectedModel?.protocol === "tripo" ? "v3.5-20260815" : "latest")} options={(selectedModel?.protocol === "tripo" ? ["v3.5-20260815", "v3.0-20250812", "v2.5-20250123"] : ["latest", "meshy-7", "meshy-6", "meshy-6-lite"]).map((version) => ({ value: version, label: version }))} disabled={runtime?.busy} onChange={(textureModel) => runtime?.onChange({ ...data, model3DOptions: { ...data.model3DOptions, textureModel } })} /> : null}
        {operation === "retexture" && selectedModel?.protocol === "tripo" ? <CanvasChipSelect label={t("assetCanvas.textureQuality")} value={data.model3DOptions?.textureQuality ?? "standard"} options={(["fast", "standard", "detailed", "extreme"] as const).map((value) => ({ value, label: t(`assetCanvas.textureQualities.${value}`) }))} disabled={runtime?.busy} onChange={(textureQuality) => runtime?.onChange({ ...data, model3DOptions: { ...data.model3DOptions, textureQuality: textureQuality as Model3DOptions["textureQuality"] } })} /> : null}
        <GenerateMediaButton kind="model" assetId={data.assetId} runtime={runtime} disabled={!hasInput || !selectedModel || Boolean(cloud && !canAffordCloudModel(cloud, selectedModel?.estimatedCredits))} />
      </div>
      {selectedModel?.protocol === "hyper3d" && operation === "retexture" ? <small>{t("assetCanvas.hyper3dRetexture")}</small> : null}
      {cloud ? <CloudQuotaStatus cloud={cloud} estimatedCredits={selectedModel?.estimatedCredits} onSignIn={auth.openSignIn} /> : operation === "image" && selectedModel?.estimatedCredits !== undefined ? <div className="canvas-model-generation-label">{t("assetCanvas.apiKeyCredits", { credits: selectedModel.estimatedCredits })}</div> : null}
    </MediaNodeShell>
  );
}

function AssetNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const kind = data.mediaType ?? "image";
  const preview = useWorkspaceAssetUrl(undefined, "", 0, kind === "audio" ? undefined : data.assetId);
  const Icon = kind === "video" ? Film : kind === "audio" ? Music2 : kind === "model" ? Box : ImageIcon;
  const mediaLayout = useMediaNodeLayout(kind === "audio" || kind === "model" ? undefined : preview.url, data.assetAspectRatio);
  const style = kind === "audio" ? { "--story-media-width": "300px", "--story-media-height": "92px" } as CSSProperties : mediaLayout.style;
  return (
    <div className={`story-node story-media-node story-library-asset-node story-library-${kind}-node${selected ? " is-selected" : ""}`} style={style}>
      <CanvasNodeLabel icon={Icon} label={data.name || titleCase(kind)} details={data.nodeDetails} trailing={<small>{data.assetOrigin === "Project" ? t("assetCanvas.project") : t("assetCanvas.library")}</small>} />
      <div data-alignment-frame className="story-media-stage">
        {preview.url && kind !== "audio" ? <MediaViewButton /> : null}
        {preview.url && kind === "image" ? <img src={preview.url} alt={data.name || t("assetCanvas.libraryImage")} onLoad={mediaLayout.onImageLoad} /> : null}
        {preview.url && kind === "video" ? <CanvasVideo src={preview.url} onLoadedMetadata={mediaLayout.onVideoMetadata} /> : null}
        {preview.url && kind === "model" ? <ModelPreview source={preview.url} label={data.name || "3D model"} minHeight={220} interactive={false} /> : null}
        {kind === "audio" ? <div className="story-audio-asset"><Music2 size={25} /><strong>{data.assetError ? t("assetCanvas.assetUnavailable") : t("assetCanvas.audio")}</strong>{data.assetError ? <span>{data.assetError}</span> : data.assetDuration ? <span>{formatMediaTime(data.assetDuration)}</span> : null}</div> : null}
        {!preview.url && kind !== "audio" ? <div className="story-media-empty"><Icon size={34} /><strong>{preview.error ? t("assetCanvas.assetUnavailable") : t("assetCanvas.loadingAsset")}</strong><CanvasAssetRecovery preview={preview} /></div> : null}
      </div>
      <Handle className="story-media-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
    </div>
  );
}

const CHARACTER_HEIGHTS = [1, 1.2, 1.5, 1.7, 1.8, 2];

function Animate3DNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.animateRuntime;
  const selectedModel = data.animationModel ? resolveModel3DConnection(data.animationModel, runtime?.models ?? []) : runtime?.models.find((model) => model.provider === "meshy");
  const [pickerOpen, setPickerOpen] = useState(false);
  const actionIds = data.actionIds ?? [];
  const height = data.heightMeters ?? DEFAULT_CHARACTER_HEIGHT_METERS;
  const heights = CHARACTER_HEIGHTS.includes(height) ? CHARACTER_HEIGHTS : [...CHARACTER_HEIGHTS, height].sort((a, b) => a - b);
  const update = (next: Partial<AssetCanvasFlowData>) => runtime?.onChange({ ...data, animateRuntime: undefined, ...next });
  return (
    <MediaNodeShell kind="animation" selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} runtime={runtime} details={data.nodeDetails} emptyHint={t("assetCanvas.hint.animate")}>
      <MediaReferenceStrip runtime={runtime} large />
      {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
      <div className="story-media-controls is-3d">
        <CanvasChipSelect label={t("assetCanvas.animationProvider")} value={selectedModel ? modelRefKey(selectedModel) : undefined} placeholder={t("assetCanvas.selectAnimationProvider")} options={(runtime?.models ?? []).map((model) => ({ value: modelRefKey(model), label: model.name, group: model.id === MODEL3D_CONNECTION_ID ? undefined : model.providerName }))} disabled={runtime?.busy} action={MANAGE_PROVIDERS} onChange={(value) => {
          const model = runtime?.models.find((model) => modelRefKey(model) === value);
          if (model) update({ animationModel: modelRef(model), actionIds: [], model3DOptions: undefined });
        }} />
        {selectedModel?.protocol === "tripo" ? <>
          <CanvasChipSelect label={t("assetCanvas.rigVersion")} value={data.model3DOptions?.rigModel ?? "v1.0-20240301"} options={[{ value: "v1.0-20240301", label: t("assetCanvas.humanoid") }, { value: "v2.5-20260210", label: t("assetCanvas.creature") }]} disabled={runtime?.busy} onChange={(rigModel) => update({ model3DOptions: { ...data.model3DOptions, rigModel: rigModel as Model3DOptions["rigModel"], rigType: "biped" }, actionIds: [] })} />
          {data.model3DOptions?.rigModel === "v2.5-20260210" ? <CanvasChipSelect label={t("assetCanvas.rigType")} value={data.model3DOptions.rigType ?? "biped"} options={(["biped", "quadruped", "hexapod", "octopod", "serpentine", "aquatic"] as const).map((value) => ({ value, label: t(`assetCanvas.rigTypes.${value}`) }))} disabled={runtime?.busy} onChange={(rigType) => update({ model3DOptions: { ...data.model3DOptions, rigType: rigType as Model3DOptions["rigType"] }, actionIds: [] })} /> : null}
          <CanvasChipToggle label={t("assetCanvas.inPlace")} pressed={data.model3DOptions?.animateInPlace ?? false} disabled={runtime?.busy} onChange={(animateInPlace) => update({ model3DOptions: { ...data.model3DOptions, animateInPlace } })} />
        </> : null}
        <button className="canvas-chip" type="button" disabled={runtime?.busy} onClick={() => setPickerOpen(true)}>
          <WandSparkles size={12} /><span>{t("assetCanvas.moveCount", { count: actionIds.length })}</span>
        </button>
        {selectedModel?.protocol !== "tripo" ? <CanvasChipSelect
          label={t("assetCanvas.characterHeight")}
          value={String(height)}
          options={heights.map((value) => ({ value: String(value), label: t("assetCanvas.meters", { value }) }))}
          disabled={runtime?.busy}
          onChange={(value) => update({ heightMeters: Number(value) })}
        /> : null}
        <GenerateMediaButton kind="animation" assetId={data.assetId} runtime={runtime} disabled={!selectedModel || !data.images?.length || actionIds.length === 0} />
      </div>
      {pickerOpen && runtime ? (
        <AnimationActionPicker
          model={selectedModel}
          options={data.model3DOptions}
          selectedIds={actionIds}
          onChange={(next) => update({ actionIds: next })}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </MediaNodeShell>
  );
}

function AnimationActionPicker({ model, options, selectedIds, onChange, onClose }: {
  model?: Model3DModel;
  options?: Model3DOptions;
  selectedIds: Model3DActionId[];
  onChange: (actionIds: Model3DActionId[]) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ key: string; actions: Model3DAnimationAction[]; status: "loading" | "ready" | "error" }>({ key: "", actions: [], status: "loading" });
  const [reload, setReload] = useState(0);
  const key = JSON.stringify([model?.provider, model?.id, options?.rigModel, options?.rigType]);
  const actions = state.key === key ? state.actions : [];
  const status = state.key === key ? state.status : "loading";
  const hasPreviews = actions.some((action) => action.previewUrl);
  useEffect(() => {
    let active = true;
    if (!model) return;
    setState({ key, actions: [], status: "loading" });
    void listModel3DAnimations(modelRef(model), options)
      .then((actions) => { if (active) setState({ key, actions, status: "ready" }); })
      .catch(() => { if (active) setState({ key, actions: [], status: "error" }); });
    return () => { active = false; };
  }, [key, reload, model]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const dialog = useRef<HTMLElement>(null);
  // The parent passes a fresh onClose on every render (e.g. when clicking the dialog selects the node); depending on
  // it would re-run this effect and pull focus out of the search field mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    dialog.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  const categories = useMemo(() => [...new Set(actions.map((action) => action.category))], [actions]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return actions.filter((action) => (!category || action.category === category)
      && (!normalized || `${action.name} ${action.subCategory}`.toLowerCase().includes(normalized)));
  }, [actions, category, query]);
  const byId = useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);
  const full = selectedIds.length >= MAX_ANIMATION_ACTIONS;
  const toggle = (id: Model3DActionId) => onChange(selectedIds.includes(id) ? selectedIds.filter((candidate) => candidate !== id) : [...selectedIds, id]);

  return createPortal(
    // Keys typed here (search, Backspace) must not reach React Flow's delete shortcut.
    <div className="story-video-picker-backdrop nokey" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="story-video-picker story-animation-picker" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="story-animation-picker-title" tabIndex={-1}>
        <header><h2 id="story-animation-picker-title">{t("assetCanvas.chooseMoves")}</h2><button type="button" aria-label={t("assetCanvas.closePicker")} onClick={onClose}><X size={16} /></button></header>
        <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("assetCanvas.searchMoves")} /></label>
        <div className="story-animation-picker-filters">
          {status === "ready" && actions.length > 0 && !hasPreviews ? <p className="story-animation-picker-note">{t("assetCanvas.noPreviews", { provider: model?.providerName ?? t("assetCanvas.thisProvider") })}</p> : null}
          {categories.length > 1 || category ? <div className="story-animation-picker-categories" role="group" aria-label={t("assetCanvas.moveCategories")}>
            <button className="canvas-chip is-toggle" type="button" aria-pressed={!category} onClick={() => setCategory(undefined)}>{t("common.all")}</button>
            {categories.map((name) => (
              <button className="canvas-chip is-toggle" type="button" key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>{splitCamelCase(name)}</button>
            ))}
          </div> : null}
        </div>
        <div className={`story-animation-picker-grid${!hasPreviews ? " is-list" : ""}`}>
          {!model ? <p>{tNodes("assetCanvas.setupProvider", { link: <button type="button" onClick={MANAGE_PROVIDERS.onSelect}>{t("modelSelector.manage")}</button> })}</p>
            : status === "loading" ? <p><LoaderCircle className="spin" size={16} /> {t("assetCanvas.loadingMoves")}</p>
            : status === "error" ? <p>{t("assetCanvas.movesFailed")} <button type="button" onClick={() => setReload((value) => value + 1)}>{t("common.tryAgain")}</button></p>
            : visible.length === 0 ? <p>{t("assetCanvas.noMovesMatch")}</p>
            : visible.map((action) => {
              const chosen = selectedIds.includes(action.id);
              return (
                <button type="button" key={action.id} className={!action.previewUrl ? "story-animation-picker-text-move" : undefined} aria-pressed={chosen} disabled={!chosen && full} onClick={() => toggle(action.id)} title={`${action.name} · ${splitCamelCase(action.subCategory)}`}>
                  {action.previewUrl ? <span className="story-animation-picker-preview">
                    <img src={action.previewUrl} alt="" loading="lazy" />
                    {chosen ? <span className="story-animation-picker-check"><Check size={12} /></span> : null}
                  </span> : null}
                  <strong>{action.name}</strong>
                  {!action.previewUrl ? <span className="story-animation-picker-selection" aria-hidden="true">{chosen ? <Check size={12} /> : null}</span> : null}
                </button>
              );
            })}
        </div>
        <footer>
          <span>{t("assetCanvas.animationSelection", { count: selectedIds.length, max: MAX_ANIMATION_ACTIONS })}</span>
          <div className="story-animation-picker-selected" aria-label={t("assetCanvas.selectedMoves")}>
            {selectedIds.length === 0 ? <span>{t("assetCanvas.noMovesSelected")}</span> : selectedIds.map((id) => (
              <button className="canvas-chip" type="button" key={id} title={t("assetCanvas.removeMove")} onClick={() => toggle(id)}>
                <span>{byId.get(id)?.name ?? t("assetCanvas.moveId", { id })}</span><X size={11} />
              </button>
            ))}
          </div>
          <button className="story-animation-picker-done" type="button" onClick={onClose}>{t("common.done")}</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/** Meshy names categories in CamelCase ("WalkAndRun", and once "AttackingwithWeapon"); spaced words read better. */
function splitCamelCase(value: string): string {
  return value.replace(/([a-z])with([A-Z])/g, "$1With$2").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function MediaPrompt({ kind, value, runtime, onChange }: {
  kind: "image" | "video" | "model";
  value: string;
  runtime?: MediaNodeRuntime;
  onChange: (prompt: string) => void;
}) {
  return (
    <CanvasTextarea
      aria-label={t(`assetCanvas.media.${kind}.prompt`)}
      rows={3}
      value={value}
      disabled={runtime?.busy}
      placeholder={t(`assetCanvas.media.${kind}.placeholder`)}
      onChange={onChange}
    />
  );
}

function MediaReferenceStrip({ runtime, large = false }: { runtime?: ReferenceStripRuntime; large?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const references = runtime?.references ?? [];
  if (!runtime || (runtime.linkedPrompt === undefined && references.length === 0 && runtime.maxReferences === 0)) return null;
  // References fill positions in order, so only the next open slot takes an upload; later slots just show what can follow.
  const [nextSlot, ...laterSlots] = runtime.slotLabels?.slice(references.length) ?? [];
  const addLabel = nextSlot ? t("assetCanvas.addSlot", { slot: nextSlot }) : runtime.addLabel;
  return (
    <div className={`story-media-references${large ? " is-large" : ""}`} aria-label={t("assetCanvas.references")}>
      {runtime?.linkedPrompt !== undefined ? <TextReferenceThumbnail runtime={runtime} /> : null}
      {references.map((reference, index) => (
        <CanvasReferenceThumbnail
          key={reference.key}
          reference={reference}
          caption={runtime.slotLabels?.[index]}
          disabled={runtime?.busy}
          onRemove={() => runtime?.onRemoveReference(index)}
        />
      ))}
      {references.length < (runtime?.maxReferences ?? 0) && !runtime.onUploadReferences ? (
        <div className="story-media-reference-slot" title={runtime.addLabel}><span>{nextSlot ?? runtime.addLabel}</span></div>
      ) : null}
      {references.length < (runtime?.maxReferences ?? 0) && runtime.onUploadReferences ? (
        <>
          <button
            className="story-media-reference-add"
            type="button"
            title={addLabel}
            aria-label={addLabel}
            disabled={runtime?.busy}
            onClick={() => runtime.onAddLibraryReference ? setLibraryOpen(true) : input.current?.click()}
          >
            {runtime?.uploading ? <LoaderCircle className="spin" size={large ? 20 : 16} /> : <Plus size={large ? 24 : 18} />}
            {nextSlot ? <span>{nextSlot}</span> : null}
          </button>
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            accept={runtime.accept}
            multiple={(runtime?.maxReferences ?? 0) > 1}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              setLibraryOpen(false);
              runtime.onUploadReferences?.(files);
            }}
          />
          {libraryOpen && runtime.onAddLibraryReference ? <LibraryAssetPicker
            title={addLabel}
            includeReferences
            assets={runtime.libraryImages ?? []}
            uploading={runtime.uploading}
            onUpload={() => input.current?.click()}
            onClose={() => setLibraryOpen(false)}
            onSelect={(asset) => { setLibraryOpen(false); runtime.onAddLibraryReference?.(asset); }}
          /> : null}
        </>
      ) : null}
      {runtime.showEmptySlots !== false ? laterSlots.map((label) => <div className="story-media-reference-slot" key={label} aria-hidden="true"><span>{label}</span></div>) : null}
    </div>
  );
}

function TextReferenceThumbnail({ runtime }: { runtime: Pick<MediaNodeRuntime, "busy" | "linkedPrompt" | "onDisconnectPrompt"> }) {
  const text = runtime.linkedPrompt?.trim() ?? "";
  return (
    <div className="story-media-reference story-text-reference" title={text || t("assetCanvas.emptyText")}>
      <FileText size={19} />
      <button type="button" title={t("assetCanvas.disconnectText")} aria-label={t("assetCanvas.disconnectText")} disabled={runtime.busy} onClick={() => runtime.onDisconnectPrompt?.()}><X size={11} /></button>
    </div>
  );
}

function MediaNodeShell({ kind, selected, panelOpen, assetId, assetAspectRatio, aspectRatio, runtime, details, emptyHint, children }: {
  kind: "image" | "video" | "model" | "animation";
  selected: boolean;
  panelOpen?: boolean;
  assetId?: string;
  assetAspectRatio?: number;
  aspectRatio?: ImageAspectRatio | VideoAspectRatio;
  runtime?: MediaNodeRuntime;
  details?: CanvasNodeDetails;
  emptyHint?: string;
  children: React.ReactNode;
}) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, assetId);
  const Icon = kind === "image" ? ImageIcon : kind === "video" ? Film : kind === "animation" ? WandSparkles : Box;
  const label = t(`assetCanvas.media.${kind}.label`);
  const threeD = kind === "model" || kind === "animation";
  const mediaLayout = useMediaNodeLayout(threeD ? undefined : preview.url, assetAspectRatio ?? parseAspectRatio(aspectRatio));
  return (
    <div className={`story-node story-media-node story-generation-media-node${selected ? " is-selected" : ""}`} style={mediaLayout.style}>
      <CanvasNodeLabel icon={Icon} label={label} details={details} />
      <div data-alignment-frame className={`story-media-stage${runtime?.generating ? " is-generating" : ""}`}>
        {preview.url ? <MediaViewButton /> : null}
        {preview.url && kind === "image" ? <img src={preview.url} alt={t("timeline.generatedImage")} onLoad={mediaLayout.onImageLoad} /> : null}
        {preview.url && kind === "video" ? <CanvasVideo src={preview.url} onLoadedMetadata={mediaLayout.onVideoMetadata} /> : null}
        {preview.url && threeD ? <ModelPreview source={preview.url} label={kind === "animation" ? t("assetCanvas.animated3d") : t("timeline.generated3d")} minHeight={220} interactive={false} /> : null}
        {!preview.url && !runtime?.generating ? (
          <div className="story-media-empty">
            <Icon size={34} />
            <strong>{assetId ? preview.error ? t("assetCanvas.assetUnavailable") : t("assetCanvas.loadingAsset") : t(`assetCanvas.media.${kind}.none`)}</strong>
            {assetId ? <CanvasAssetRecovery preview={preview} /> : <span>{emptyHint ?? (kind === "animation" ? t("assetCanvas.hint.humanoid") : t(`assetCanvas.media.${kind}.describe`))}</span>}
          </div>
        ) : null}
        {runtime?.generating ? (
          <div className="story-media-empty story-media-generation" role="status">
            <LoaderCircle className="spin" size={20} />
            <strong>{kind === "animation" ? t("assetCanvas.rigging") : t(`assetCanvas.media.${kind}.generating`)}</strong>
            <span>{kind === "animation" ? t("assetCanvas.takesMinutes") : t("assetCanvas.takesMoment")}</span>
          </div>
        ) : null}
      </div>
      <Handle className="story-media-input-handle" type="target" position={Position.Left} />
      <Handle className="story-media-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
      {panelOpen ? <div className="canvas-node-auxiliary"><div className="story-media-composer nodrag nowheel">{children}</div></div> : null}
    </div>
  );
}

function CanvasAssetRecovery({ preview }: { preview: ReturnType<typeof useWorkspaceAssetUrl> }) {
  return preview.error ? <><span role="status">{preview.error}</span><button className="canvas-asset-retry nodrag" type="button" disabled={preview.loading} onClick={preview.retry}>{preview.loading ? t("assetCanvas.checking") : t("canvasDoc.checkAgain")}</button></> : null;
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
        label={t("assetCanvas.node.video")}
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
    <button type="button" title={playing ? t("assetCanvas.pause", { label }) : t("assetCanvas.play", { label })} aria-label={playing ? t("assetCanvas.pause", { label }) : t("assetCanvas.play", { label })} disabled={disabled} onClick={onToggle}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
    <time>{formatPreviewTime(current)}</time>
    <div className="story-inline-video-scrubber">
      {markers.length ? <div className="story-inline-video-markers" aria-hidden="true">{markers.map((marker) => <i key={marker.id} className={marker.blocking ? "is-blocking" : ""} style={{ left: `${duration ? Math.max(0, Math.min(100, marker.timeMs / duration * 100)) : 0}%` }} />)}</div> : null}
      <input aria-label={`${label} position`} type="range" min={0} max={duration} step={40} value={current} disabled={disabled} style={{ "--video-progress": `${progress}%` } as CSSProperties} onChange={(event) => onSeek(Number(event.target.value))} />
    </div>
    <time>{formatPreviewTime(duration)}</time>
    <button type="button" title={muted ? t("assetCanvas.unmute", { label }) : t("assetCanvas.mute", { label })} aria-label={muted ? t("assetCanvas.unmute", { label }) : t("assetCanvas.mute", { label })} disabled={disabled} onClick={onToggleMuted}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
  </div>;
}

function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

/** Sizes a media card from the loaded media, else from the ratio known in advance. */
function useMediaNodeLayout(source?: string, knownAspectRatio?: number): {
  style: CSSProperties;
  onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
  onVideoMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
} {
  const [intrinsic, setIntrinsic] = useState<{ source?: string; ratio: number }>();
  const size = fitMediaNode(intrinsic && intrinsic.source === source ? intrinsic.ratio : knownAspectRatio);

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

function mediaAspectRatio(asset?: Pick<LibraryAsset, "width" | "height">): number | undefined {
  return asset?.width && asset.height ? asset.width / asset.height : undefined;
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

const MANAGE_PROVIDERS = { label: t("modelSelector.manage"), onSelect: () => { window.location.hash = settingsHash("providers"); } };

/** OpenRouter names start with the vendor ("ByteDance: Seedance 2.5"); the provider heading already says where it runs. */
function mediaModelName(model: { provider: string; name: string }): string {
  return model.provider === "openrouter" ? model.name.replace(/^[^:]{1,40}:\s+/, "") : model.name;
}

function providerNotes(providers: readonly MediaProviderStatus[] | undefined): CanvasChipNote[] {
  return (providers ?? []).flatMap((provider) => provider.state === "ready" || !provider.message ? [] : [{ group: provider.providerName, message: provider.message }]);
}

function polycountOptions(presets: readonly number[], current: number): Array<{ value: string; label: string }> {
  const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
  return values.map((value) => ({ value: String(value), label: t("assetCanvas.polys", { value: value >= 1_000 ? `${value / 1_000}K` : value }) }));
}

function CanvasChipToggle({ label, pressed, disabled, onChange }: { label: string; pressed: boolean; disabled?: boolean; onChange: (pressed: boolean) => void }) {
  return (
    <button className="canvas-chip is-toggle" type="button" aria-pressed={pressed} disabled={disabled} onClick={() => onChange(!pressed)}>
      {pressed ? <Check size={12} /> : null}<span>{label}</span>
    </button>
  );
}

function GenerateMediaButton({ kind, assetId, runtime, disabled }: {
  kind: "image" | "video" | "model" | "animation";
  assetId?: string;
  runtime?: MediaNodeRuntime;
  disabled: boolean;
}) {
  const label = assetId ? t(`assetCanvas.media.${kind}.again`) : t(`assetCanvas.media.${kind}.generate`);
  if (runtime?.onCancel && runtime.generating) {
    return <button type="button" title={t("assetCanvas.cancelGeneration")} aria-label={t("assetCanvas.cancelGeneration")} onClick={runtime.onCancel}><Square size={13} /></button>;
  }
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled || runtime?.busy} onClick={() => runtime?.onGenerate()}>
      {runtime?.generating ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
    </button>
  );
}

function formatPreviewTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1_000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function AssetCanvasAddControl({
  documents,
  tables,
  libraryAssets,
  importing,
  onAdd,
  onAddAsset,
  onUpload,
}: {
  documents: CanvasDocuments;
  tables: CanvasTables;
  libraryAssets: LibraryAsset[];
  importing: boolean;
  onAdd: (type: Exclude<AssetCanvasNodeType, "asset">, position: { x: number; y: number }, documentId?: string) => void;
  onAddAsset: (asset: LibraryAsset, position: { x: number; y: number }) => void;
  onUpload: (file: File, position: { x: number; y: number }) => void;
}) {
  const creationGroups = canvasCreationGroups(documents, tables);
  const [addOpen, setAddOpen] = useState(false);
  const [openCreationBranch, setOpenCreationBranch] = useState<OpenCanvasNodeCreationBranch>();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const addMenu = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const placementPosition = useCanvasCenter();

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

  function addItem(item: CanvasNodeCreationLeaf): void {
    const position = placementPosition();
    if (!position) return;
    onAdd(item.action.type, position, item.action.documentId ?? item.action.tableId);
    setAddOpen(false);
  }

  return <>
      <div ref={addMenu} className="story-add-node">
        {addOpen ? (
          <div className="story-add-node-menu-shell">
            <div className="story-add-node-menu" role="menu" aria-label={t("assetCanvas.addNode")}>
              {creationGroups.map((group) => <Fragment key={group.label}>
                <span className="story-add-node-menu-label">{group.label}</span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  if (!isCanvasNodeCreationLeaf(item)) return <button
                    type="button"
                    role="menuitem"
                    key={item.label}
                    aria-haspopup="menu"
                    aria-expanded={openCreationBranch?.branch === item}
                    onPointerEnter={(event) => setOpenCreationBranch({ branch: item, top: event.currentTarget.offsetTop })}
                    onClick={(event) => setOpenCreationBranch({ branch: item, top: event.currentTarget.offsetTop })}
                  ><Icon size={15} /><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight className="story-add-node-submenu-arrow" size={13} /></button>;
                  return <button type="button" role="menuitem" key={item.label} onPointerEnter={() => setOpenCreationBranch(undefined)} onClick={() => addItem(item)}><Icon size={15} /><span><strong>{item.label}</strong><small>{item.description}</small></span></button>;
                })}
              </Fragment>)}
              <button type="button" role="menuitem" disabled={importing} onPointerEnter={() => setOpenCreationBranch(undefined)} onClick={() => uploadInput.current?.click()}><Upload size={15} /><span><strong>{importing ? t("assetCanvas.uploading") : t("assetCanvas.upload")}</strong><small>{t("assetCanvas.uploadHint")}</small></span></button>
              <button type="button" role="menuitem" onPointerEnter={() => setOpenCreationBranch(undefined)} onClick={() => { setAddOpen(false); setLibraryOpen(true); }}><Folder size={15} /><span><strong>{t("assetCanvas.fromLibrary")}</strong><small>{t("assetCanvas.fromLibraryHint")}</small></span></button>
            </div>
            {openCreationBranch ? <div className="story-add-node-submenu" role="menu" aria-label={openCreationBranch.branch.label} style={{ top: openCreationBranch.top }}>
              {openCreationBranch.branch.children.map((child) => { const ChildIcon = child.icon; return <button type="button" role="menuitem" key={child.label} onClick={() => addItem(child)}><ChildIcon size={15} /><span><strong>{child.label}</strong><small>{child.description}</small></span></button>; })}
            </div> : null}
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
        <button className={addOpen ? "is-active" : undefined} type="button" title={t("assetCanvas.addNode")} aria-label={t("assetCanvas.addNode")} aria-expanded={addOpen} onClick={() => { setOpenCreationBranch(undefined); setAddOpen((open) => !open); }}>
          <Plus size={18} />
        </button>
      </div>
      {libraryOpen ? <LibraryAssetPicker title={t("assetCanvas.addFromLibrary")} assets={libraryAssets} onClose={() => setLibraryOpen(false)} onSelect={(asset) => {
        const position = placementPosition();
        if (position) onAddAsset(asset, position);
        setLibraryOpen(false);
      }} /> : null}
  </>;
}

interface ViewableCanvasAsset {
  assetId: string;
  mediaType: Exclude<AssetMediaType, "audio">;
}

function viewableCanvasAsset(node: AssetCanvasFlowNode): ViewableCanvasAsset | undefined {
  const assetId = node.data.assetId;
  if (!assetId) return undefined;
  if (node.type === "image") return { assetId, mediaType: "image" };
  if (node.type === "video") return { assetId, mediaType: "video" };
  if (node.type === "model-3d" || node.type === "animate-3d") return { assetId, mediaType: "model" };
  const mediaType = node.data.mediaType;
  return node.type === "asset" && mediaType && mediaType !== "audio" ? { assetId, mediaType } : undefined;
}

/** The workspace opens the viewer from onNodeClick, which already knows the node. */
function MediaViewButton() {
  return (
    <button className="story-media-view-button nodrag" type="button" title={t("assetCanvas.viewAction")} aria-label={t("assetCanvas.viewAction")} onDoubleClick={(event) => event.stopPropagation()}>
      <Maximize size={14} />
    </button>
  );
}

function eventWithin(event: { target: EventTarget | null }, selector: string): boolean {
  return event.target instanceof Element && Boolean(event.target.closest(selector));
}

function CanvasAssetViewer({ asset, name, onDownload, onSendToProject, onClose }: {
  asset: ViewableCanvasAsset;
  name: string;
  onDownload: (name: string) => void;
  onSendToProject: (name: string) => void;
  onClose: () => void;
}) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, asset.assetId);
  // React Flow ignores key presses inside .nokey, so Backspace/Delete here never removes the node behind the dialog.
  return <div className="nokey">
    <AssetDialogShell
      title={name}
      labelledBy="canvas-asset-viewer-title"
      headerActions={<>
        <button type="button" title={t("assetCanvas.addToProject")} aria-label={t("assetCanvas.addNameToProject", { name })} onClick={() => onSendToProject(name)}><FolderPlus size={17} /></button>
        <button type="button" title={t("assetCanvas.download")} aria-label={t("assetCanvas.downloadName", { name })} onClick={() => onDownload(name)}><Download size={17} /></button>
      </>}
      onClose={onClose}
      preview={preview.url
        ? <AssetMedia type={asset.mediaType} url={preview.url} label={name} />
        : <span className="library-dialog-state">{preview.error ? t("assetCanvas.assetUnavailable") : t("assetCanvas.loadingAsset")}</span>}
      footer={null}
    />
  </div>;
}

function AssetCanvasContextMenu({
  documents,
  tables,
  onUseInDocument,
  menu,
  canUndo,
  canRedo,
  canPaste,
  canDuplicate,
  canView,
  canDownload,
  canSendToProject,
  nodeActionsDisabled,
  importing,
  onClose,
  onUndo,
  onRedo,
  onPaste,
  onAdd,
  onUpload,
  onView,
  onDownload,
  onSendToProject,
  onCopy,
  onDuplicate,
  onDelete,
  onDetails,
}: {
  documents: CanvasDocuments;
  tables: CanvasTables;
  onUseInDocument?: () => void;
  menu: CanvasContextMenuState;
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  canDuplicate: boolean;
  canView: boolean;
  canDownload: boolean;
  canSendToProject: boolean;
  nodeActionsDisabled: boolean;
  importing: boolean;
  onClose: () => void;
  onUndo: () => unknown;
  onRedo: () => unknown;
  onPaste: () => void;
  onAdd: (item: CanvasNodeCreationLeaf) => void;
  onUpload: (file: File) => void;
  onView: () => void;
  onDownload: () => void;
  onSendToProject: () => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDetails?: () => void;
}) {
  const creationGroups = canvasCreationGroups(documents, tables);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [openCreationBranch, setOpenCreationBranch] = useState<OpenCanvasNodeCreationBranch>();
  const run = (action: () => unknown) => {
    action();
    onClose();
  };
  const creationItems = <>
    {creationGroups.map((group) => <Fragment key={group.label}>
      <span className="story-canvas-context-menu-label">{group.label}</span>
      {group.items.map((item) => {
        const Icon = item.icon;
        if (!isCanvasNodeCreationLeaf(item)) return <button
          type="button"
          role="menuitem"
          key={item.label}
          aria-haspopup="menu"
          aria-expanded={openCreationBranch?.branch === item}
          onPointerEnter={(event) => setOpenCreationBranch({ branch: item, top: event.currentTarget.offsetTop })}
          onClick={(event) => setOpenCreationBranch({ branch: item, top: event.currentTarget.offsetTop })}
        ><Icon size={15} /><span>{item.label}</span><ChevronRight size={13} /></button>;
        return <button type="button" role="menuitem" key={item.label} onPointerEnter={() => setOpenCreationBranch(undefined)} onClick={() => run(() => onAdd(item))}><Icon size={15} /><span>{item.label}</span></button>;
      })}
    </Fragment>)}
  </>;
  const creationBranch = openCreationBranch ? <div className="story-canvas-context-branch-menu" role="menu" aria-label={openCreationBranch.branch.label} style={{ top: openCreationBranch.top }}>
    {openCreationBranch.branch.children.map((child) => { const ChildIcon = child.icon; return <button type="button" role="menuitem" key={child.label} onClick={() => run(() => onAdd(child))}><ChildIcon size={15} /><span>{child.label}</span></button>; })}
  </div> : null;

  // A double-click on the canvas opens just the Add node list.
  if (menu.kind === "add") return (
    <CanvasContextMenu screenPosition={menu.screenPosition} label={t("assetCanvas.addNode")} onClose={onClose}>
      {creationItems}
      {creationBranch}
    </CanvasContextMenu>
  );

  return (
    <CanvasContextMenu screenPosition={menu.screenPosition} label={menu.kind === "pane" ? t("assetCanvas.canvasActions") : t("assetCanvas.nodeActions")} onClose={onClose}>
      {onDetails ? <button type="button" role="menuitem" onClick={() => run(onDetails)}><Pencil size={15} /><span>{t("assetCanvas.nodeDetails")}</span></button> : null}
      {onUseInDocument ? <button type="button" role="menuitem" onClick={() => run(onUseInDocument)}><FileText size={15} /><span>{t("assetCanvas.addToDocument")}</span></button> : null}
      {menu.kind === "pane" ? <>
        <div className="story-canvas-context-submenu-root" onPointerEnter={() => setAddOpen(true)}>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={addOpen} onClick={() => setAddOpen(true)}><Plus size={15} /><span>{t("assetCanvas.addNode")}</span><ChevronRight size={13} /></button>
          {addOpen ? <div className="story-canvas-context-add-menu">
            <div className="story-canvas-context-submenu" role="menu" aria-label={t("assetCanvas.addNode")}>{creationItems}</div>
            {creationBranch}
          </div> : null}
        </div>
        <button type="button" role="menuitem" disabled={importing} onClick={() => uploadInput.current?.click()}><Upload size={15} /><span>{importing ? t("assetCanvas.uploading") : t("assetCanvas.upload")}</span></button>
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
        <div className="playable-project-menu-separator" role="separator" />
        <button type="button" role="menuitem" disabled={!canUndo} onClick={() => run(onUndo)}><Undo2 size={15} /><span>{t("assetCanvas.undo")}</span></button>
        <button type="button" role="menuitem" disabled={!canRedo} onClick={() => run(onRedo)}><Redo2 size={15} /><span>{t("assetCanvas.redo")}</span></button>
        <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onPaste)}><Clipboard size={15} /><span>{t("assetCanvas.paste")}</span></button>
      </> : <>
        {canView ? <button type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onView)}><Maximize size={15} /><span>{t("assetCanvas.viewAction")}</span></button> : null}
        {canDownload ? <button type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onDownload)}><Download size={15} /><span>{t("assetCanvas.download")}</span></button> : null}
        {canSendToProject ? <button type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onSendToProject)}><FolderPlus size={15} /><span>{t("assetCanvas.addToProjectEllipsis")}</span></button> : null}
        <button type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onCopy)}><Copy size={15} /><span>{t("assetCanvas.copyNode")}</span></button>
        <button type="button" role="menuitem" disabled={nodeActionsDisabled || !canDuplicate} onClick={() => run(onDuplicate)}><Plus size={15} /><span>{t("common.duplicate")}</span></button>
        <button className="is-danger" type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onDelete)}><Trash2 size={15} /><span>{t("common.delete")}</span></button>
      </>}
    </CanvasContextMenu>
  );
}

function toFlowNode(node: AssetCanvasNode, imageModels: ImageModel[], videoModels: VideoModel[]): AssetCanvasFlowNode {
  return { ...flowNodeData(node, imageModels, videoModels), ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}), ...(node.title !== undefined ? { title: node.title } : {}), ...(node.description !== undefined ? { description: node.description } : {}) };
}
function flowNodeData(node: AssetCanvasNode, imageModels: ImageModel[], videoModels: VideoModel[]): AssetCanvasFlowNode {
  if (node.type === "asset") return { ...node, deletable: true };
  if (node.type === "text") return {
    id: node.id,
    type: "text",
    position: node.position,
    deletable: true,
    data: {
      text: node.data.text,
      instruction: node.data.instruction,
      ...(node.data.references ? { references: node.data.references } : {}),
      ...(node.data.model ? { textModel: node.data.model } : {}),
      ...(node.data.reasoningLevel ? { reasoningLevel: node.data.reasoningLevel } : {}),
    },
  };
  if (node.type === "video") {
    const model = videoModels.find((candidate) => sameModel(candidate, node.data.model));
    return {
      id: node.id,
      type: "video",
      position: node.position,
      deletable: true,
      data: {
        prompt: node.data.prompt,
        ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
        ...(model ? { videoModel: { provider: model.provider, id: model.id } } : node.data.model ? { videoModel: node.data.model } : {}),
        videoResolution: model?.resolutions.includes(node.data.resolution) ? node.data.resolution : model?.resolutions[0] ?? node.data.resolution,
        videoAspectRatio: model?.aspectRatios.includes(node.data.aspectRatio) ? node.data.aspectRatio : model?.aspectRatios[0] ?? node.data.aspectRatio,
        duration: model?.durations.includes(node.data.duration) ? node.data.duration : model?.durations[0] ?? node.data.duration,
        references: node.data.references,
        referenceMode: node.data.referenceMode,
        referenceMentions: node.data.referenceMentions,
        ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      },
    };
  }
  if (node.type === "animate-3d") return {
    id: node.id,
    type: "animate-3d",
    position: node.position,
    deletable: true,
    // The flow keeps the source in `images` so connections, edges, and removal share the reference code paths.
    data: {
      images: node.data.source ? [node.data.source] : [],
      animationModel: node.data.model,
      model3DOptions: node.data.options,
      heightMeters: node.data.heightMeters,
      actionIds: node.data.actionIds,
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "model-3d") return {
    id: node.id,
    type: "model-3d",
    position: node.position,
    deletable: true,
    data: {
      prompt: node.data.prompt ?? "",
      promptSource: node.data.promptSource,
      model3DOperation: node.data.operation,
      model3DSource: node.data.source,
      model3DOptions: node.data.options,
      model3DConfig: normalizeModel3DConfig({
        model: node.data.model,
        targetPolycount: node.data.targetPolycount,
        texture: node.data.texture,
        pbr: node.data.pbr,
      }, undefined, node.data.operation),
      images: node.data.images.slice(0, MODEL_3D_MAX_REFERENCE_IMAGES),
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

function createFlowNode(type: Exclude<AssetCanvasNodeType, "asset">, position: { x: number; y: number }, imageModels: ImageModel[], videoModels: VideoModel[], defaultTextModel?: AgentModelRef): AssetCanvasFlowNode {
  if (type === "image") {
    const model = imageModels[0];
    const option = preferredImageOption(model);
    return toFlowNode(createAssetGenerationNode(type, position, {
      ...(model ? { imageModel: { provider: model.provider, id: model.id } } : {}),
      ...(option ? { imageResolution: option.resolution, imageAspectRatio: option.aspectRatio } : {}),
    }), imageModels, videoModels);
  }
  if (type === "video") {
    const model = videoModels[0];
    const aspectRatio = model?.aspectRatios[0] ?? DEFAULT_VIDEO_NODE_CONFIG.aspectRatio;
    return toFlowNode(createAssetGenerationNode(type, position, { ...(model ? { videoModel: { provider: model.provider, id: model.id }, videoReferenceMode: model.imageReferenceMode } : {}), videoAspectRatio: aspectRatio }), imageModels, videoModels);
  }
  if (type === "model-3d") return toFlowNode(createAssetGenerationNode(type, position), imageModels, videoModels);
  if (type === "animate-3d") {
    return { id: crypto.randomUUID(), type, position, data: { images: [], heightMeters: DEFAULT_CHARACTER_HEIGHT_METERS, actionIds: [...DEFAULT_ANIMATION_ACTION_IDS] } };
  }
  const id = crypto.randomUUID();
  return { id, type: "text", position, data: { text: "", instruction: "", ...(defaultTextModel ? { textModel: defaultTextModel } : {}) } };
}

/** The generation settings a node passes on to the next node of its type. */
type NodeGenerationSettings = Pick<AssetCanvasFlowData, "textModel" | "reasoningLevel" | "model" | "resolution" | "aspectRatio" | "videoModel" | "videoResolution" | "videoAspectRatio" | "duration" | "model3DConfig">;
type RememberedSettings = Partial<Record<AssetCanvasNodeType, NodeGenerationSettings>>;

export function nodeGenerationSettings(node: Pick<AssetCanvasFlowNode, "type" | "data">): NodeGenerationSettings | undefined {
  const { data } = node;
  if (node.type === "text") return { ...(data.textModel ? { textModel: { provider: data.textModel.provider, id: data.textModel.id } } : {}), ...(data.reasoningLevel ? { reasoningLevel: data.reasoningLevel } : {}) };
  if (node.type === "image") return { model: data.model, resolution: data.resolution, aspectRatio: data.aspectRatio };
  if (node.type === "video") return { videoModel: data.videoModel, videoResolution: data.videoResolution, videoAspectRatio: data.videoAspectRatio, duration: data.duration };
  if (node.type === "model-3d") return { model3DConfig: data.model3DConfig };
  return undefined;
}

/** Starts a new node with supported remembered options and configured media defaults. */
export function applyRememberedSettings(
  node: AssetCanvasFlowNode,
  settings: NodeGenerationSettings | undefined,
  catalogs: { imageModels: readonly ImageModel[]; defaultImageModel?: ImageModelRef; videoModels: readonly VideoModel[]; defaultVideoModel?: ModelRef; model3DModels?: readonly Model3DModel[]; defaultModel3D?: ModelRef; textModels: readonly AgentModel[] },
): AssetCanvasFlowNode {
  if (node.type === "image") {
    const reference = catalogs.defaultImageModel ?? settings?.model;
    if (!reference) return node;
    const model = catalogs.imageModels.find((candidate) => sameImageModel(candidate, reference));
    if (!model) return catalogs.defaultImageModel ? { ...node, data: { ...node.data, model: reference } } : node;
    const options = settings ?? node.data;
    const option = model.generationOptions.find((candidate) => candidate.resolution === options.resolution && candidate.aspectRatio === options.aspectRatio)
      ?? preferredImageOption(model, options.aspectRatio);
    return { ...node, data: { ...node.data, model: { provider: model.provider, id: model.id }, ...(option ? { resolution: option.resolution, aspectRatio: option.aspectRatio } : {}) } };
  }
  if (node.type === "video") {
    const reference = catalogs.defaultVideoModel ?? settings?.videoModel ?? node.data.videoModel;
    const model = catalogs.videoModels.find((candidate) => sameModel(candidate, reference));
    if (!model && catalogs.defaultVideoModel) return { ...node, data: { ...node.data, videoModel: catalogs.defaultVideoModel } };
    if (!model) return node;
    const options = settings ?? node.data;
    return {
      ...node,
      data: {
        ...node.data,
        videoModel: { provider: model.provider, id: model.id },
        videoResolution: options.videoResolution && model.resolutions.includes(options.videoResolution) ? options.videoResolution : model.resolutions[0],
        videoAspectRatio: options.videoAspectRatio && model.aspectRatios.includes(options.videoAspectRatio) ? options.videoAspectRatio : model.aspectRatios[0],
        duration: options.duration !== undefined && model.durations.includes(options.duration) ? options.duration : model.durations[0],
        referenceMode: model.referenceModes?.includes(node.data.referenceMode ?? model.imageReferenceMode ?? "reference") ? node.data.referenceMode ?? model.imageReferenceMode : model.referenceModes?.[0],
      },
    };
  }
  if (node.type === "model-3d") {
    const reference = catalogs.defaultModel3D ?? settings?.model3DConfig?.model;
    const model = reference ? catalogs.model3DModels?.find((candidate) => sameModel(candidate, reference)) : catalogs.model3DModels?.[0];
    if (reference && !model) return { ...node, data: { ...node.data, model3DConfig: normalizeModel3DConfig({ ...settings?.model3DConfig, model: reference }) } };
    if (model) {
      const options = settings?.model3DConfig;
      return { ...node, data: { ...node.data, model3DConfig: normalizeModel3DConfig({ ...options, model: modelRef(model),
        targetPolycount: options && options.targetPolycount >= model.polycount.min && options.targetPolycount <= model.polycount.max ? options.targetPolycount : model.polycount.default,
        texture: options?.texture, pbr: options?.pbr }, model) } };
    }
    if (settings?.model3DConfig) return { ...node, data: { ...node.data, model3DConfig: normalizeModel3DConfig(settings.model3DConfig) } };
  }
  if (!settings) return node;
  if (node.type === "text") {
    const model = catalogs.textModels.find((candidate) => sameModel(candidate, settings.textModel));
    if (model) return { ...node, data: { ...node.data, textModel: settings.textModel, ...(settings.reasoningLevel ? { reasoningLevel: clampReasoningLevel(settings.reasoningLevel, model.reasoningLevels) } : {}) } };
  }
  return node;
}

function assetCanvasDocument(
  viewport: { width: number; height: number },
  nodes: AssetCanvasFlowNode[],
  edges: Edge[],
  editorLayout: AssetCanvasEditorLayout,
  model3DModels: readonly Model3DModel[],
): AssetCanvasDocument {
  return {
    version: 1,
    editorLayout,
    viewport,
    nodes: nodes.map((node) => toAssetCanvasNode(node, model3DModels)),
    edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
  };
}

export function toAssetCanvasNode(node: AssetCanvasFlowNode, model3DModels?: readonly Model3DModel[]): AssetCanvasNode {
  return { ...assetCanvasNodeData(node, model3DModels), ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}), ...(node.title !== undefined ? { title: node.title } : {}), ...(node.description !== undefined ? { description: node.description } : {}) };
}
function assetCanvasNodeData(node: AssetCanvasFlowNode, model3DModels?: readonly Model3DModel[]): AssetCanvasNode {
  if (node.type === "animate-3d") {
    const source = node.data.images?.[0];
    return {
      id: node.id,
      type: "animate-3d",
      position: node.position,
      data: {
        ...(source ? { source } : {}),
        ...(node.data.animationModel ? { model: node.data.animationModel } : {}),
        ...(node.data.model3DOptions ? { options: node.data.model3DOptions } : {}),
        heightMeters: node.data.heightMeters ?? DEFAULT_CHARACTER_HEIGHT_METERS,
        actionIds: node.data.actionIds ?? [],
        ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      },
    };
  }
  if (node.type === "table") return { id: node.id, type: "table", position: node.position, data: { tableId: node.data.tableId ?? "" } };
  if (node.type === "document") return { id: node.id, type: "document", position: node.position, data: { documentId: node.data.documentId ?? "", ...(node.data.references ? { references: textNodeReferences(node) } : {}) } };
  if (node.type === "asset") return {
    id: node.id,
    type: "asset",
    position: node.position,
    data: { assetId: node.data.assetId ?? "", mediaType: node.data.mediaType ?? "image" },
  };
  if (node.type === "text") return {
    id: node.id,
    type: "text",
    position: node.position,
    data: {
      text: node.data.text ?? "",
      instruction: node.data.instruction ?? "",
      ...(node.data.references ? { references: textNodeReferences(node) } : {}),
      ...(node.data.textModel ? { model: modelRef(node.data.textModel) } : {}),
      ...(node.data.reasoningLevel ? { reasoningLevel: node.data.reasoningLevel } : {}),
    },
  };
  if (node.type === "image") return {
    id: node.id,
    type: "image",
    position: node.position,
    data: {
      prompt: node.data.prompt ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { model: modelRef(node.data.model) } : {}),
      resolution: node.data.resolution ?? DEFAULT_IMAGE_NODE_CONFIG.resolution,
      aspectRatio: node.data.aspectRatio ?? DEFAULT_IMAGE_NODE_CONFIG.aspectRatio,
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
      ...(node.data.videoModel ? { model: modelRef(node.data.videoModel) } : {}),
      resolution: node.data.videoResolution ?? DEFAULT_VIDEO_NODE_CONFIG.resolution,
      aspectRatio: node.data.videoAspectRatio ?? DEFAULT_VIDEO_NODE_CONFIG.aspectRatio,
      duration: node.data.duration ?? DEFAULT_VIDEO_NODE_CONFIG.duration,
      references: node.data.references ?? [],
      ...(node.data.referenceMode ? { referenceMode: node.data.referenceMode } : {}),
      ...(node.data.referenceMentions ? { referenceMentions: node.data.referenceMentions } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "model-3d") {
    const config = nodeModel3DConfig(node, model3DModels);
    return {
      id: node.id,
      type: "model-3d",
      position: node.position,
      data: {
        ...(node.data.model3DOperation ? { operation: node.data.model3DOperation } : {}),
        ...(node.data.prompt ? { prompt: node.data.prompt } : {}),
        ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
        ...(node.data.model3DSource ? { source: node.data.model3DSource } : {}),
        ...(node.data.model3DOptions ? { options: node.data.model3DOptions } : {}),
        ...(config.model ? { model: config.model } : {}),
        targetPolycount: config.targetPolycount,
        texture: config.texture,
        pbr: config.pbr,
        images: (node.data.images ?? []).slice(0, MODEL_3D_MAX_REFERENCE_IMAGES),
        ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      },
    };
  }
  throw new Error("Unsupported Asset Canvas Node type");
}

/** Keeps only the reference fields accepted by the persisted board schema. */
function textNodeReferences(node: AssetCanvasFlowNode): AssetCanvasTextReference[] {
  return (node.data.references ?? []).flatMap((reference) => reference.type === "node" ? [{ type: "node" as const, nodeId: reference.nodeId }] : []);
}

function modelRef<T extends { provider: string; id: string }>(model: T): { provider: string; id: string } {
  return { provider: model.provider, id: model.id };
}

function modelRefKey(model: ModelRef): string {
  return `${model.provider}:${model.id}`;
}

function sameImageModel(left: ImageModelRef, right?: ImageModelRef): boolean {
  return Boolean(right && left.provider === right.provider && left.id === right.id);
}

function imageReferenceViews(node: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], libraryAssets: LibraryAsset[], model3DModels?: readonly Model3DModel[]): MediaReferenceView[] {
  if (node.type !== "image" && node.type !== "model-3d") return [];
  const viewLabels = node.type === "model-3d" ? model3DViewLabels(nodeModel3D(node, model3DModels)) : undefined;
  return (node.data.images ?? []).map((reference, index) => {
    const label = viewLabels ? viewLabels[index] ?? t("assetCanvas.viewNumber", { number: index + 1 }) : t("assetCanvas.imageNumber", { number: index + 1 });
    if (reference.type === "library") {
      const asset = libraryAssets.find((candidate) => candidate.id === reference.assetId);
      return { assetId: reference.assetId, key: `library:${reference.assetId}:${index}`, name: asset?.name ?? t("assetCanvas.missingImage"), label, type: "image" };
    }
    const source = nodes.find((candidate) => candidate.id === reference.nodeId && isImageFlowSource(candidate));
    const assetId = source?.data.assetId;
    const asset = libraryAssets.find((candidate) => candidate.id === assetId);
    return {
      ...(assetId ? { assetId } : {}),
      key: `node:${reference.nodeId}`,
      type: "image",
      label,
      name: source?.type === "image"
        ? source.data.prompt?.trim() || t("assetCanvas.connectedImage")
        : asset?.name ?? (source ? t("assetCanvas.connectedImage") : t("assetCanvas.missingImageNode")),
    };
  });
}

function modelReferenceViews(node: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], libraryAssets: LibraryAsset[]): MediaReferenceView[] {
  const source = node.type === "animate-3d" ? node.data.images?.[0] : node.type === "model-3d" ? node.data.model3DSource : undefined;
  if (!source) return [];
  if (source.type === "library") {
    const asset = libraryAssets.find((candidate) => candidate.id === source.assetId);
    return [{ assetId: source.assetId, key: `library:${source.assetId}`, name: asset?.name ?? t("assetCanvas.missingModel"), label: t("assetCanvas.model"), type: "model" }];
  }
  const sourceNode = nodes.find((candidate) => candidate.id === source.nodeId);
  const assetId = sourceNode?.data.assetId;
  const asset = libraryAssets.find((candidate) => candidate.id === assetId);
  return [{
    ...(assetId ? { assetId } : {}),
    key: `node:${source.nodeId}`,
    type: "model",
    label: t("assetCanvas.model"),
    name: asset?.name ?? (sourceNode ? t("assetCanvas.connected3d") : t("assetCanvas.missingModelNode")),
  }];
}

function videoReferenceViews(node: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], libraryAssets: LibraryAsset[]): MediaReferenceView[] {
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
      name: asset?.name ?? (source?.type === "image" || source?.type === "video" ? source.data.prompt?.trim() || t(`assetCanvas.ref.${type}.connected`) : source ? t(`assetCanvas.ref.${type}.connected`) : t(`assetCanvas.ref.${type}.missing`)),
      label: t(`assetCanvas.ref.${type}.label`, { number: counts[type] }),
      type,
      ...(asset?.duration !== undefined ? { duration: asset.duration } : {}),
    };
  });
}

function imageReferenceLimit(node: AssetCanvasFlowNode, imageModels: ImageModel[]): number {
  if (node.type !== "image") return 0;
  const model = imageModels.find((candidate) => sameImageModel(candidate, node.data.model));
  return model?.supportsReferenceImage ? Math.min(IMAGE_MAX_REFERENCE_IMAGES, model.maxReferenceImages ?? IMAGE_MAX_REFERENCE_IMAGES) : 0;
}

function selectedVideoModel(node: AssetCanvasFlowNode, videoModels: VideoModel[]): VideoModel | undefined {
  return node.type === "video" ? videoModels.find((model) => sameModel(model, node.data.videoModel)) : undefined;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}:${model.id}`;
}

function sameModel(model: ModelRef, ref?: ModelRef): boolean {
  return Boolean(ref && model.provider === ref.provider && model.id === ref.id);
}

/** Direction labels are only shown for protocols that assign meaning to image order. */
export function model3DViewLabels(model?: Model3DModel): string[] {
  return Array.from({ length: model?.maxReferenceImages ?? MODEL_3D_MAX_REFERENCE_IMAGES }, (_, index) =>
    viewLabel(model?.referenceImageLabels?.[index]) ?? t("assetCanvas.referenceNumber", { number: index + 1 }));
}

function viewLabel(label?: string): string | undefined {
  return label === "Front" || label === "Left" || label === "Back" || label === "Right" ? t(`assetCanvas.view.${label}`) : label;
}

function nodeModel3D(node: Pick<AssetCanvasFlowNode, "type" | "data">, models: readonly Model3DModel[] = node.data.model3DRuntime?.models ?? []): Model3DModel | undefined {
  if (node.data.model3DOperation === "retexture" || node.data.model3DOperation === "remesh") return resolveModel3DConnection(node.data.model3DConfig?.model, models);
  return resolveModel3D(node.data.model3DConfig?.model, models);
}

function nodeModel3DConfig(node: Pick<AssetCanvasFlowNode, "type" | "data">, models?: readonly Model3DModel[]): Model3DGenerationConfig {
  if (node.type !== "model-3d") return DEFAULT_MODEL_3D_CONFIG;
  const config = node.data.model3DConfig;
  return normalizeModel3DConfig(config, nodeModel3D(node, models), node.data.model3DOperation);
}

type ConnectionRelation = "image-reference" | "video-reference" | "model-reference" | "prompt" | "text-reference";

export function connectionRelation(
  source: AssetCanvasFlowNode,
  target: AssetCanvasFlowNode,
  _sourceHandle: string | null | undefined,
  nodes: AssetCanvasFlowNode[],
  libraryAssets: LibraryAsset[],
  imageModels: ImageModel[],
  model3DModels: readonly Model3DModel[] = [],
): ConnectionRelation | undefined {
  if (source.id === target.id) return undefined;
  if (target.type === "text" || target.type === "document") {
    if (source.type === "asset" && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(libraryAssets.find((asset) => asset.id === source.data.assetId)?.contentType ?? "")) return undefined;
    if (!isTextGenerationReferenceNode(source) || (target.data.references?.length ?? 0) >= MAX_TEXT_NODE_REFERENCES ||
      target.data.references?.some((reference) => reference.type === "node" && reference.nodeId === source.id) ||
      (source.type === "document" && target.type === "document" && source.data.documentId === target.data.documentId)) return undefined;
    return "text-reference";
  }
  if (isSupportedImageReferenceSource(source, libraryAssets) && target.type === "image") {
    return (target.data.images?.length ?? 0) < imageReferenceLimit(target, imageModels) &&
      !(target.data.images ?? []).some((image) => image.type === "node" && image.nodeId === source.id)
      ? "image-reference"
      : undefined;
  }
  if (isSupportedImageReferenceSource(source, libraryAssets) && target.type === "model-3d") {
    if (target.data.model3DOperation === "text" || target.data.model3DOperation === "remesh") return undefined;
    if (target.data.model3DOperation === "retexture" && (target.data.images?.length ?? 0) >= 1) return undefined;
    return (target.data.images?.length ?? 0) < (nodeModel3D(target, model3DModels)?.maxReferenceImages ?? MODEL_3D_MAX_REFERENCE_IMAGES) &&
      !(target.data.images ?? []).some((image) => image.type === "node" && image.nodeId === source.id)
      ? "image-reference"
      : undefined;
  }
  if (target.type === "model-3d" && (target.data.model3DOperation === "retexture" || target.data.model3DOperation === "remesh") && isModelSource(source, libraryAssets)) {
    const current = target.data.model3DSource;
    return current?.type === "node" && current.nodeId === source.id ? undefined : "model-reference";
  }
  if (target.type === "animate-3d") {
    const current = target.data.images?.[0];
    return isModelSource(source, libraryAssets) && !(current?.type === "node" && current.nodeId === source.id) ? "model-reference" : undefined;
  }
  if ((source.type === "text" || source.type === "document") && (target.type === "image" || target.type === "video" || target.type === "model-3d" && (target.data.model3DOperation === "text" || target.data.model3DOperation === "retexture"))) {
    return target.data.promptSource?.nodeId === source.id ? undefined : "prompt";
  }
  if (target.type === "video") {
    return canAddVideoReference(target, source, nodes, libraryAssets) ? "video-reference" : undefined;
  }
  return undefined;
}

function isMediaNodeType(type: AssetCanvasNodeType): type is "image" | "video" {
  return type === "image" || type === "video";
}

/** GLB output of a Model 3D node or a Library model; only GLB can be rigged. */
function isModelSource(node: AssetCanvasFlowNode, libraryAssets: LibraryAsset[]): boolean {
  if (node.type === "model-3d" || node.type === "animate-3d") return true;
  if (node.type !== "asset" || node.data.mediaType !== "model") return false;
  return libraryAssets.find((asset) => asset.id === node.data.assetId)?.contentType === "model/gltf-binary";
}

function isImageFlowSource(node: AssetCanvasFlowNode | undefined): boolean {
  return node?.type === "image" || (node?.type === "asset" && node.data.mediaType === "image");
}

function isSupportedImageReferenceSource(node: AssetCanvasFlowNode, libraryAssets: LibraryAsset[]): boolean {
  if (node.type === "image") return true;
  if (node.type !== "asset" || node.data.mediaType !== "image") return false;
  const contentType = libraryAssets.find((asset) => asset.id === node.data.assetId)?.contentType;
  return contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp";
}

function videoReferenceType(node: AssetCanvasFlowNode | undefined, libraryAssets: LibraryAsset[]): VideoGenerationReference["type"] | undefined {
  if (node?.type === "image") return "image";
  if (node?.type !== "asset" || node.data.mediaType !== "image") return undefined;
  const asset = libraryAssets.find((candidate) => candidate.id === node.data.assetId);
  return asset?.contentType === "image/png" || asset?.contentType === "image/jpeg" || asset?.contentType === "image/webp" ? "image" : undefined;
}

function canAddVideoReference(target: AssetCanvasFlowNode, source: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], libraryAssets: LibraryAsset[]): boolean {
  if (target.type !== "video" || target.id === source.id || (target.data.references ?? []).some((reference) => reference.type === "node" && reference.nodeId === source.id)) return false;
  const type = videoReferenceType(source, libraryAssets);
  if (!type) return false;
  const references = videoReferenceViews(target, nodes, libraryAssets);
  return references.filter((reference) => reference.type === type).length < 9;
}

function assetEdgeId(relation: "scene" | "image" | "model" | "reference" | "prompt" | "presentation", targetId: string, referenceId: string): string {
  return `${ASSET_EDGE_PREFIX}${relation}:${targetId}:${referenceId}`;
}

export function removeNodesAndReferences(nodes: AssetCanvasFlowNode[], removedIds: ReadonlySet<string>): AssetCanvasFlowNode[] {
  return nodes
    .filter((node) => !removedIds.has(node.id))
    .map((node) => node.type === "image" || node.type === "model-3d" || node.type === "animate-3d"
        ? {
            ...node,
            data: {
              ...node.data,
              ...(node.data.model3DSource?.type === "node" && removedIds.has(node.data.model3DSource.nodeId) ? { model3DSource: undefined } : {}),
              images: (node.data.images ?? []).filter((image) => image.type !== "node" || !removedIds.has(image.nodeId)),
              ...(node.data.promptSource && removedIds.has(node.data.promptSource.nodeId) ? { promptSource: undefined } : {}),
            },
          }
      : node.type === "video" || node.type === "text" || node.type === "document"
        ? {
            ...node,
            data: {
              ...node.data,
              references: (node.data.references ?? []).filter((reference) => reference.type !== "node" || !removedIds.has(reference.nodeId)),
              ...(node.data.promptSource && removedIds.has(node.data.promptSource.nodeId) ? { promptSource: undefined } : {}),
            },
          }
      : node);
}

function resolveLinkedPrompt(node: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], documents: CanvasDocuments): string | undefined {
  if (!node.data.promptSource) return undefined;
  const source = nodes.find((candidate) => candidate.id === node.data.promptSource?.nodeId);
  return source?.type === "document" ? documents.documents.find((doc) => doc.id === source.data.documentId)?.markdown : source?.type === "text" ? source.data.text ?? "" : undefined;
}

function effectivePrompt(data: AssetCanvasFlowData, runtime?: MediaNodeRuntime): string {
  return combineAssetCanvasPrompt(runtime?.linkedPrompt, data.prompt ?? "");
}

async function promptImage(blob: Blob): Promise<CreateLibraryImageRequest["image"]> {
  if (blob.type !== "image/png" && blob.type !== "image/jpeg" && blob.type !== "image/webp") {
    throw new Error("Connected images must be PNG, JPEG, or WebP.");
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("assetCanvas.readImageFailed")));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
  return { mediaType: blob.type, data: dataUrl.split(",", 2)[1] ?? "" };
}

async function readUploadImage(file: File): Promise<{ name: string; image: CreateLibraryImageRequest["image"] }> {
  if (file.type !== "image/png" && file.type !== "image/jpeg" && file.type !== "image/webp") {
    throw new Error("Use PNG, JPEG, or WebP reference images.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error(t("assetCanvas.referenceSize"));
  return { name: file.name, image: await promptImage(file) };
}

function libraryUploadMediaType(file: File): LibraryUploadMediaType | undefined {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "svg") return "image/svg+xml";
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

async function projectCoverBlob(source: AssetCanvasCoverSource, assets: LibraryAsset[], content: (id: string) => Promise<Blob> = getLibraryAsset): Promise<Blob | undefined> {
  const asset = assets.find((candidate) => candidate.id === source.assetId);
  if (!asset || (asset.mediaType !== "image" && asset.mediaType !== "video") || asset.contentType === "image/svg+xml" || asset.name.toLowerCase().endsWith(".svg")) return undefined;
  return mediaBlobToWebP(await content(asset.id), asset.mediaType);
}

async function mediaBlobToWebP(blob: Blob, mediaType: "image" | "video"): Promise<Blob | undefined> {
  if (mediaType === "image") {
    const image = await createImageBitmap(blob);
    try {
      return bitmapToWebP(image);
    } finally {
      image.close();
    }
  }
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error(t("assetCanvas.videoCoverFailed"))), { once: true });
      video.load();
    });
    video.currentTime = 0;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return canvasToWebP(canvas);
  } finally {
    URL.revokeObjectURL(url);
    video.remove();
  }
}

function bitmapToWebP(image: ImageBitmap): Promise<Blob | undefined> {
  const canvas = document.createElement("canvas");
  const width = Math.min(800, image.width);
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(image.height * width / image.width));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasToWebP(canvas);
}

function canvasToWebP(canvas: HTMLCanvasElement): Promise<Blob | undefined> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), "image/webp", 0.8));
}
