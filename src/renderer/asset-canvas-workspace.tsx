import { CanvasImageCrop } from "./canvas-image-crop.js";
import { MEDIA_TOOL_GROUPS, isMultiImageOperation, type CanvasMediaToolbarAction } from "../shared/media-tools.js";
import { CanvasLayerEditor, CanvasVideoFrameEditor, type CanvasLayerSetting } from "./canvas-media-editors.js";
import { workspaceVersion } from "./workspace-version.js";
import { CanvasTableNode, type CanvasTables } from "./canvas-table-node.js";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Box,
  Check,
  ChevronDown,
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
  Gameboy,
  Layers3,
  Maximize,
  Music2,
  Pencil,
  Play,
  Plus,
  Trash2,
  Upload,
  Undo2,
  WandSparkles,
  Widget,
  Redo2,
  RotateCcw,
  Scissors,
  Volume2,
  X,
  type IconComponent,
} from "./icons.js";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent, type ClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  Handle,
  NodeToolbar,
  Position,
  useViewport,
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
import { CanvasNodeResizer } from "./canvas-node-resizer.js";
import { clampCanvasGroupResize, canvasAbsolutePosition, canvasDescendantIds, canvasDropGroup, canvasGroupExecutionPlan, canvasSelectionRoots, expandCanvasGroups, findCanvasFreeArea, layoutPixelLevelGroups, orderedCanvasNodes, reparentCanvasNode } from "./canvas-groups.js";
import { RESIZABLE_CANVAS_NODE_SIZES, canvasNodeLayout, isResizableCanvasNodeType } from "../shared/canvas-node-layout.js";
import { MAX_ASSET_CANVAS_NODES, MAX_TEXT_NODE_REFERENCES } from "../shared/asset-canvas-schema.js";
import { createCanvasClipboard, duplicateAssetCanvasNode, duplicateCanvasSelection, lastCanvasClipboard, parseCanvasClipboard, rememberCanvasClipboard, type CanvasClipboard } from "./asset-canvas-clipboard.js";
import { AssetCanvasTemplateGuide, PixelAssetTemplateGuide } from "./asset-canvas-template-guide.js";
import { templateGuideInfo, templateImagePresets, type AssetCanvasTemplate } from "./asset-canvas-templates.js";
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
  type AgentModel,
  type AgentModelRef,
  type AgentReasoningLevel,
  type CreateLibraryImageRequest,
  type ImageModel,
  type MediaProviderStatus,
  type ImageModelRef,
  type ModelRef,
  type LibraryUploadMediaType,
  type Model3DModel,
  type ProjectState,
  type ToolJob,
  type VideoModel,
  type VideoGenerationReference,
} from "../shared/contracts.js";
import { combineAssetCanvasPrompt, createAssetGenerationNode, isTextGenerationReferenceNode, preferredImageOption, validateAssetCanvasDocument } from "../shared/asset-canvas.js";
import { allActionsPrompt, continuousActionsPrompt, resolveContinuousActionPrompt, preferredCharacterSheetOption } from "../shared/canvas-character-tools.js";
import { canvasImagePresetPrompt, canvasMaterialStyle, type CanvasImagePreset, type CanvasMaterialStyle } from "../shared/canvas-image-presets.js";
import { VOLCENGINE_TTS_VOICES, audioCanvasSettings, audioNodeHasSettings, audioSettings, isAudioNodeType, type AudioCanvasSettings, type AudioModel, type AudioOperation, type AudioProviderCatalogStatus } from "../shared/audio.js";
import { createLibraryImage, getLibraryAsset, getWorkspaceAsset, getProjectCover, getProjectCoverState, listAudioModelCatalog, listImageModelCatalog, listModel3DAnimations, listModel3DOperations, listModel3DCatalog, listVideoModelCatalog, MODELS_CHANGED_EVENT, setProjectCover, uploadLibraryAsset, importCanvasFile, createCanvasImportFolder } from "./api.js";
import { useAuth } from "./auth.js";
import { accountCloudState, canAffordCloudModel, CloudQuotaStatus } from "./cloud-quota.js";
import { canvasAssetDownloadName, downloadAssetBlob, loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { SendToProjectDialog } from "./send-to-project-dialog.js";
import { useAgentModels } from "./model-selector.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { useCanvasAssetSources, useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { canvasNodeTitle } from "../shared/canvas-assets.js";
import type { CanvasAssetCatalogEntry } from "../shared/canvas-assets.js";
import { prepareVideoReferenceFile, readMediaFileDuration } from "./video-reference-files.js";
import { findAssetCanvasCoverSource, type AssetCanvasCoverSource } from "../shared/asset-canvas-cover.js";
import { ModelPreview } from "./model-preview.js";
import { type PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { PIXEL_ASSET_TEMPLATE_NOTE, createPixelAssetPresetContents, pixelArtLevelLabel, pixelAssetTemplateGuideCategory, placePixelPresetOutsideDensityGroups, type PixelAssetPresetId } from "./asset-canvas-pixel-workflows.js";
import { AssetCanvasPixelPresetDialog } from "./asset-canvas-pixel-preset-dialog.js";
import { pixelExampleCoverUrl, pixelExampleImageUrl } from "./asset-canvas-pixel-examples.js";
import { LibraryAssetPicker } from "./node-workbench.js";
import { AssetDialogShell, AssetMedia, type AssetMediaType } from "./asset-gallery.js";
import { DEFAULT_IMAGE_NODE_CONFIG, DEFAULT_ANIMATION_ACTION_IDS, DEFAULT_CHARACTER_HEIGHT_METERS, DEFAULT_VIDEO_NODE_CONFIG, MODEL_3D_MAX_REFERENCE_IMAGES, normalizeModel3DConfig } from "../shared/generation-config.js";
import { mergeCanvasDocument } from "../shared/canvas-workspace.js";
import { CanvasDocumentNode, ExpandedCanvasDocument, type CanvasDocuments, type DocumentNodeRuntime } from "./canvas-document-node.js";
import { CanvasNodeLabel, type CanvasNodeDetails } from "./canvas-node-label.js";
import { exportCanvasAsset, generateCanvasText, runCanvasMedia, type CanvasMediaOperation } from "./canvas-api.js";
import { saveTrimmedVideo, VideoTrimmer } from "./video-trimmer.js";
import type { VideoTrim } from "./video-trim.js";
import type { CanvasBoardStorage } from "./canvas-board-storage.js";
import { CanvasNotice } from "./canvas-notice.js";
import { useDesktopClosing } from "./desktop-close-guard.js";
import { isDesktopClosing } from "./desktop-save.js";
import { CanvasTextarea } from "./canvas-text-composer.js";
import { videoReferenceLimit } from "../shared/video-references.js";
import type { CanvasNodeReferencesRuntime } from "./canvas-node-references.js";
import { t } from "./i18n.js";
import { canvasImportKind, droppedFolders, isIgnoredImportPath, type DroppedFolder } from "./canvas-file-import.js";
import { importCanvasCsv } from "../shared/canvas-table.js";
import { MEDIA_NODE_MAX_WIDTH, type AssetCanvasFlowNode, errorMessage, type AssetCanvasFlowData, OUTPUT_HANDLE, titleCase, nodeModel3D, type Animate3DNodeRuntime, type AudioNodeRuntime, type MediaNodeRuntime, type ReferenceMediaNodeRuntime, type ImageNodeRuntime, type VideoNodeRuntime, sameImageModel, sameModel, type MediaReferenceView, nodeModel3DConfig, modelRef } from "./asset-canvas-flow.js";
import { CanvasAssetRecovery, TextNode, ImageNode, VideoNode, SpeechNode, AudioSceneNode, SoundEffectNode, MusicNode, Model3DNode, Animate3DNode, AssetNode, FileNode, canvasHistoryKey, mediaAspectRatio, audioOperationForNode, FolderImportDialog } from "./asset-canvas-nodes.js";
export { canvasHistoryKey } from "./asset-canvas-nodes.js";

const ASSET_EDGE_PREFIX = "asset:";
const GROUP_GENERATION_CONCURRENCY = 3;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_FOLDER_IMPORT_FILES = 5_000;
const MAX_FOLDER_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
type CanvasNodeCreationAction = { kind: "node"; type: Exclude<AssetCanvasNodeType, "asset">; documentId?: string; tableId?: string };
interface CanvasNodeCreationLeaf {
  label: string;
  description?: string;
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

const BASE_CANVAS_NODE_CREATION_GROUPS: CanvasNodeCreationGroup[] = [
  {
    label: t("assetCanvas.group.assets"),
    items: [
      { label: t("assetCanvas.node.text"), description: t("assetCanvas.node.textHint"), icon: FileText, action: { kind: "node", type: "text" } },
      { label: t("assetCanvas.node.image"), description: t("assetCanvas.node.imageHint"), icon: ImageIcon, action: { kind: "node", type: "image" } },
      { label: t("assetCanvas.node.video"), description: t("assetCanvas.node.videoHint"), icon: Film, action: { kind: "node", type: "video" } },
      { label: t("assetCanvas.node.soundEffect"), description: t("assetCanvas.node.soundEffectHint"), icon: Volume2, action: { kind: "node", type: "sound-effect" } },
      { label: t("assetCanvas.node.music"), description: t("assetCanvas.node.musicHint"), icon: Music2, action: { kind: "node", type: "music" } },
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
  return [{ label: t("assetCanvas.group.documents"), items }, ...BASE_CANVAS_NODE_CREATION_GROUPS];
}

type CanvasGroupFlowNode = Node<AssetCanvasFlowData, "group"> & { title?: string; description?: string };

const STORY_NODE_TYPES: NodeTypes = {
  group: CanvasGroupNode,
  table: CanvasTableNode,
  document: CanvasDocumentNode,
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
  speech: SpeechNode,
  "sound-effect": SoundEffectNode,
  music: MusicNode,
  "audio-scene": AudioSceneNode,
  "model-3d": Model3DNode,
  "animate-3d": Animate3DNode,
  asset: AssetNode,
  file: FileNode,
};

function CanvasGroupNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  return <div className={`canvas-group-node${selected ? " is-selected" : ""}`}>
    <CanvasNodeResizer selected={selected} runtime={data.resizeRuntime} />
    <div className="canvas-group-heading"><Layers3 size={14} /><strong>{data.pixelStyle ? pixelArtLevelLabel(data.pixelStyle) : data.name}</strong></div>
  </div>;
}

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
  const [writeVersion] = useState(() => workspaceVersion(projectId));
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
  const [audioModels, setAudioModels] = useState<AudioModel[]>([]);
  const [audioProviders, setAudioProviders] = useState<AudioProviderCatalogStatus[]>([]);
  const [globalDefaultVideoModel, setDefaultVideoModel] = useState<ModelRef>();
  const [model3DModels, setModel3DModels] = useState<Model3DModel[]>([]);
  const [model3DProviders, setModel3DProviders] = useState<MediaProviderStatus[]>([]);
  const pollCloud3D = useRef(false);
  pollCloud3D.current = model3DProviders.some((provider) => provider.cloud && provider.cloud.availability !== "sign_in_required");
  const [globalDefaultModel3D, setDefaultModel3D] = useState<ModelRef>();
  const defaultImageModel = project.mediaModelDefaults?.image ?? globalDefaultImageModel;
  const defaultVideoModel = project.mediaModelDefaults?.video ?? globalDefaultVideoModel;
  const defaultModel3D = project.mediaModelDefaults?.["3d"] ?? globalDefaultModel3D;
  const [operationModels3D, setOperationModels3D] = useState<Model3DModel[]>([]);
  const textModelCatalog = useAgentModels();
  const defaultTextModel = textModelCatalog.defaultModel ?? textModelCatalog.models[0];
  const [canvasJobs, setCanvasJobs] = useState<Record<string, ToolJob>>({});
  const canvasJobsRef = useRef(canvasJobs); canvasJobsRef.current = canvasJobs;
  const observedGroupJobs = useRef(new Map<string, ToolJob>());
  const groupJobWaiters = useRef(new Map<string, (job: ToolJob) => void>());
  // The last settings picked per node type, so a new node starts where the user left off.
  const rememberedSettings = useRef<RememberedSettings>({});
  const [viewedAsset, setViewedAsset] = useState<ViewableCanvasAsset>();
  const [cropNodeId, setCropNodeId] = useState<string>();
  const [mediaToolDialog, setMediaToolDialog] = useState<{ operation: DialogMediaOperation; assetIds: string[] }>();
  const [mediaToolBusy, setMediaToolBusy] = useState(false);
  const [mediaToolError, setMediaToolError] = useState<string>();
  const [sentAsset, setSentAsset] = useState<{ assetId: string; name: string }>();
  const [startingCanvasNodes, setStartingCanvasNodes] = useState<Set<string>>(() => new Set());
  const startingCanvasNodesRef = useRef(new Set<string>());
  const hydratedJobRuns = useRef(new Set<string>());
  const [generatingTextNodeIds, setGeneratingTextNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const generatingTextNodesRef = useRef(new Set<string>());
  const [uploadingNodeId, setUploadingNodeId] = useState<string>();
  const [importingAssets, setImportingAssets] = useState(false);
  const [folderPrompt, setFolderPrompt] = useState<{ folders: DroppedFolder[]; answer: (choice: "folder" | "files" | undefined) => void }>();
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
  const altDragCopies = useRef<ReadonlyMap<string, string> | undefined>(undefined);
  const [, setHistoryRevision] = useState(0);
  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedGroup = selectedNodes.length === 1 && selectedNodes[0]?.type === "group" ? selectedNodes[0] : undefined;
  const canGroupSelection = canvasSelectionRoots(nodes, new Set(selectedNodes.map((node) => node.id))).length >= 2;
  const canUngroupSelection = selectedNodes.some((node) => node.type === "group");
  const groupDescendants = selectedGroup ? canvasDescendantIds(nodes, new Set([selectedGroup.id])) : new Set<string>();
  const executableGroupNodes = selectedGroup ? orderedCanvasNodes(nodes).filter((node) => groupDescendants.has(node.id) && (
    node.type === "text" && Boolean(node.data.instruction?.trim() && (node.data.textModel ?? defaultTextModel)) ||
    (node.type === "image" && !node.data.sourceInput || node.type === "video" || node.type === "speech" || node.type === "sound-effect" || node.type === "music" || node.type === "model-3d" || node.type === "animate-3d")
  )) : [];
  const [batchExecuting, setBatchExecuting] = useState(false);
  const batchRun = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { batchRun.current?.abort(); }, [storage, closing]);
  const selectedMediaNodes = selectedNodes.filter((node) => {
    const mediaType = node.type === "asset" ? node.data.mediaType : node.type;
    return Boolean((node.data.assetId || hasExampleOutput(node)) && (mediaType === "image" || mediaType === "video"));
  });
  const selectedMediaType = selectedMediaNodes.length && selectedMediaNodes.every((node) => (node.type === "asset" ? node.data.mediaType : node.type) === "image") ? "image"
    : selectedMediaNodes.length && selectedMediaNodes.every((node) => (node.type === "asset" ? node.data.mediaType : node.type) === "video") ? "video" : undefined;
  const selectedNodeIdsJson = JSON.stringify(selectedNodes.map((node) => node.id));
  const selectedImageIsGif = selectedMediaNodes.length === 1 &&
    ((libraryAssets.find((asset) => asset.id === selectedMediaNodes[0]?.data.assetId)?.contentType
      ?? selectedMediaNodes[0]?.data.contentType) === "image/gif"
      || (!selectedMediaNodes[0]?.data.assetId && Boolean(selectedMediaNodes[0]?.data.exampleImage?.endsWith(".gif"))));
  useEffect(() => { setCropNodeId(undefined); }, [selectedNodeIdsJson]);
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
      const loadedNodes = orderedCanvasNodes(story.nodes).map((node) => toFlowNode(node, models, loadedVideoModels));
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
      // Audio models are not needed for the first render, so fetching them must not delay the board.
      void listAudioModelCatalog().then((audioCatalog) => {
        if (disposed) return;
        setAudioModels(audioCatalog.models);
        setAudioProviders(audioCatalog.providers);
      }).catch(() => undefined);
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
    let model3DPending = false;
    const refresh3D = () => {
      const current = ++model3DRevision;
      model3DPending = true;
      void listModel3DCatalog().then((catalog) => {
        if (!active || current !== model3DRevision) return;
        setModel3DModels(catalog.models); setModel3DProviders(catalog.providers); setDefaultModel3D(catalog.defaultModel);
      }).catch(() => undefined).finally(() => { if (current === model3DRevision) model3DPending = false; });
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
      void listAudioModelCatalog().then((catalog) => {
        if (!active || current !== revision) return;
        setAudioModels(catalog.models); setAudioProviders(catalog.providers);
      }).catch(() => undefined);
      void listModel3DOperations().then((models) => {
        if (active && current === revision) setOperationModels3D(models);
      }).catch(() => undefined);
      refresh3D();
    };
    // Only cloud availability and allowance change without a local settings event.
    const refreshCloud3D = () => {
      if (pollCloud3D.current && window.document.visibilityState !== "hidden" && !model3DPending) refresh3D();
    };
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    window.document.addEventListener("visibilitychange", refreshCloud3D);
    const timer = setInterval(refreshCloud3D, 30_000);
    return () => { active = false; clearInterval(timer); window.removeEventListener(MODELS_CHANGED_EVENT, refresh); window.document.removeEventListener("visibilitychange", refreshCloud3D); };
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
        observedGroupJobs.current = new Map(jobs.map((job) => [job.id, job]));
        for (const job of jobs) if (job.status !== "running") groupJobWaiters.current.get(job.id)?.(job);
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
    if (project.type !== "asset-canvas" || phase !== "ready" || !document) return;
    const source = findAssetCanvasCoverSource(document);
    const exampleUrl = source ? undefined : pixelExampleCoverUrl(document.nodes);
    if (source ? libraryAssets.length === 0 : !exampleUrl) return;
    let disposed = false;
    void (async () => {
      if (await getProjectCover(projectId)) return;
      const cover = source
        ? await projectCoverBlob(source, libraryAssets, assetBlob)
        : await mediaBlobToWebP(await (await fetch(exampleUrl!)).blob(), "image");
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (event.shiftKey) ungroupSelection(); else groupSelection();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        const selected = clipboardNodes(new Set(nodes.filter((node) => node.selected).map((node) => node.id)));
        if (selected.length) {
          const roots = selected.filter((node) => !node.parentId);
          pasteSelection(createCanvasClipboard(projectId, selected, document.edges), { x: Math.min(...roots.map((node) => node.position.x)) + 40, y: Math.min(...roots.map((node) => node.position.y)) + 40 });
        }
        return;
      }
      const step = undoShortcut(event);
      if (!step) return;
      event.preventDefault();
      if (historyGestureBase.current) return;
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
    if ((node.type === "image" || node.type === "video" || node.type === "model-3d" || node.type === "speech" || node.type === "sound-effect" || node.type === "music" || node.type === "audio-scene") && node.data.promptSource) derived.push({
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
  const [materializingExamples, setMaterializingExamples] = useState(false);
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
    const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
    latestCanvas.current = merged;
    observeHistoryDocument(merged);
    setNodes(orderedCanvasNodes(merged.nodes).map((node) => ({ ...toFlowNode(node, imageModelsRef.current, videoModelsRef.current, previous.get(node.id)), selected: previous.get(node.id)?.selected === true })));
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
    // A hidden window shows nobody the external changes, so it syncs again on return instead.
    const run = () => {
      if (pending || window.document.hidden) return;
      pending = true;
      void sync().catch(() => {}).finally(() => { pending = false; });
    };
    const timer = window.setInterval(run, 2500);
    window.document.addEventListener("visibilitychange", run);
    return () => {
      window.clearInterval(timer);
      window.document.removeEventListener("visibilitychange", run);
    };
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
    const copies = altDragCopies.current;
    const moves = copies ? changes.flatMap<NodeChange<AssetCanvasFlowNode>>((change) => {
      if (change.type !== "position") return [change];
      const id = copies.get(change.id);
      return id ? [{ ...change, id }] : [];
    }) : changes;
    setNodes((current) => {
      const resizedGroups = new Map<string, ReturnType<typeof clampCanvasGroupResize>>();
      for (const change of moves) {
        if (change.type !== "dimensions" || !change.resizing) continue;
        const group = current.find((node) => node.id === change.id);
        if (group?.type !== "group") continue;
        const position = moves.find((candidate) => candidate.type === "position" && candidate.id === group.id);
        const proposed = position?.type === "position" ? position.position ?? group.position : group.position;
        resizedGroups.set(group.id, clampCanvasGroupResize(group, current, {
          x: proposed.x, y: proposed.y,
          width: change.dimensions?.width ?? group.width ?? group.measured?.width ?? 500,
          height: change.dimensions?.height ?? group.height ?? group.measured?.height ?? 400,
        }));
      }
      const corrected = moves.flatMap<NodeChange<AssetCanvasFlowNode>>((change) => {
        if (change.type === "dimensions") {
          const group = current.find((node) => node.id === change.id);
          if (group?.type !== "group") return [change];
          if (change.resizing === false && group.resizing) return [{ ...change, dimensions: { width: group.width ?? group.measured?.width ?? 500, height: group.height ?? group.measured?.height ?? 400 } }];
          if (!change.resizing) return [change];
          const bounds = resizedGroups.get(change.id)!;
          return [{ ...change, dimensions: { width: bounds.width, height: bounds.height } }];
        }
        if (change.type !== "position") return [change];
        const groupBounds = resizedGroups.get(change.id);
        if (groupBounds) return [{ ...change, position: { x: groupBounds.x, y: groupBounds.y } }];
        const node = current.find((candidate) => candidate.id === change.id);
        const parent = node?.parentId && current.find((candidate) => candidate.id === node.parentId);
        const bounds = parent && resizedGroups.get(parent.id);
        return bounds && node ? [{ ...change, position: {
          x: node.position.x + parent.position.x - bounds.x,
          y: node.position.y + parent.position.y - bounds.y,
        } }] : [change];
      });
      return applyNodeChanges(corrected, current);
    });
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
          if (relation === "media-prompt" && node.id === edge.target && (node.type === "image" || node.type === "video" || node.type === "model-3d" || node.type === "speech" || node.type === "sound-effect" || node.type === "music" || node.type === "audio-scene")) {
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
    const relation = connectionRelation(source, target, connection.sourceHandle, nodes, libraryAssets, imageModels, model3DModels, audioModels);
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
    if (relation === "prompt" && (target.type === "image" || target.type === "video" || target.type === "model-3d" || target.type === "speech" || target.type === "sound-effect" || target.type === "music" || target.type === "audio-scene")) {
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
    const node = { ...applyRememberedSettings(created, rememberedSettings.current[type], { imageModels, defaultImageModel, videoModels, defaultVideoModel, audioModels, model3DModels, defaultModel3D, textModels: textModelCatalog.models }), selected: true };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
  }

  function addPixelAssetPreset(presetId: PixelAssetPresetId, pixelStyle: PixelArtLevel, position: { x: number; y: number }): void {
    const current = nodesRef.current;
    const densityGroups = current.filter((node): node is CanvasGroupFlowNode => node.type === "group" && !node.parentId && Boolean(node.data.pixelStyle));
    const placement = placePixelPresetOutsideDensityGroups(presetId, position, densityGroups.map((group) => ({
      position: group.position,
      width: group.width ?? group.measured?.width ?? 560,
      height: group.height ?? group.measured?.height ?? 720,
    })));
    placement.workflowGroupPosition = snapCanvasPosition(placement.workflowGroupPosition);
    const contents = createPixelAssetPresetContents(presetId, pixelStyle, imageModels, placement);
    const nodes = contents.nodes.map((node) => ({ ...toFlowNode(node, imageModels, videoModels), selected: node.id === contents.outputNodeId, deletable: true }));
    const workflowGroup = contents.group ? { ...toFlowNode(contents.group, imageModels, videoModels), deletable: true } : undefined;
    const additions = [...(workflowGroup ? [workflowGroup] : []), ...nodes];
    if (current.length + additions.length > MAX_ASSET_CANVAS_NODES) {
      setNotice({ kind: "action", message: t("assetCanvas.nodeLimit") });
      return;
    }

    commitPendingHistory();
    const next = layoutPixelLevelGroups(expandCanvasGroups([
      ...current.map((node) => ({ ...node, selected: false })),
      ...additions,
    ]));
    setNodes(orderedCanvasNodes(next));
    const flow = flowInstance.current;
    const focusNode = next.find((node) => node.id === (workflowGroup?.id ?? contents.outputNodeId))!;
    const focusPosition = canvasAbsolutePosition(focusNode, next);
    void flow?.setCenter(focusPosition.x + (workflowGroup ? 730 : MEDIA_NODE_MAX_WIDTH / 2), focusPosition.y + (workflowGroup ? 325 : 240), {
      zoom: Math.min(flow.getViewport().zoom, workflowGroup ? 0.72 : 1),
      duration: 300,
    });
  }

  function addAssetNode(asset: Pick<LibraryAsset, "id" | "name" | "mediaType" | "contentType" | "duration" | "width" | "height">, position: { x: number; y: number }): void {
    if (asset.mediaType !== "image" && asset.mediaType !== "video" && asset.mediaType !== "audio" && asset.mediaType !== "model") return;
    const node = assetFlowNode(asset, position);
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
  }

  function assetFlowNode(asset: Pick<LibraryAsset, "id" | "name" | "mediaType" | "contentType" | "duration" | "width" | "height">, position: { x: number; y: number }): AssetCanvasFlowNode {
    return {
      id: crypto.randomUUID(),
      type: "asset",
      position,
      selected: true,
      deletable: true,
      data: { assetId: asset.id, mediaType: asset.mediaType, contentType: asset.contentType, assetDuration: asset.duration, assetWidth: asset.width, assetHeight: asset.height, name: asset.name },
    };
  }

  async function uploadAssetFile(file: File, mediaType: LibraryUploadMediaType): Promise<LibraryAsset> {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(t("assetCanvas.uploadSize"));
    const kind = mediaType.startsWith("video/") ? "video" : mediaType.startsWith("audio/") ? "audio" : undefined;
    const duration = kind ? await readMediaFileDuration(file, kind) : undefined;
    const uploaded = await uploadLibraryAsset(file, mediaType, duration);
    const asset: LibraryAsset = { ...uploaded, assetId: uploaded.id, path: uploaded.name };
    setLibraryAssets((current) => [asset, ...current]);
    return asset;
  }

  /** Copies a file that is not a document, table or media asset into the project; returns its project path. */
  async function importProjectFile(file: File, directory?: string): Promise<string> {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(t("assetCanvas.uploadSize"));
    return (await importCanvasFile(projectId, file, directory)).path;
  }

  async function importAssetFiles(files: File[], position: { x: number; y: number }): Promise<void> {
    await importCanvasFiles(files.map((file) => ({ file })), position);
  }

  async function importTableFile(file: File, delimiter: "," | "\t"): Promise<string> {
    if (file.size > 4 * 1024 * 1024) throw new Error(t("tableNode.tooLarge"));
    const text = await file.text();
    const title = file.name.replace(/\.[^.]+$/, "").slice(0, 200);
    // Parse before creating, so a malformed file leaves no empty table behind.
    const draft = importCanvasCsv({ version: 1, id: "import", title, columns: [], rows: [] }, text, delimiter);
    const id = await tables.add();
    if (!id || !tables.storage.sessions.has(id)) throw new Error(t("assetCanvas.tableCreateFailed"));
    tables.storage.update({ ...draft, id }, false);
    return id;
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
      const accepted = (await source).filter(({ file, relativePath }) => !isIgnoredImportPath(relativePath ?? file.name));
      let { folders, files: chosen } = droppedFolders(accepted);
      if (folders.length) {
        // A folder is easy to drop by mistake and can hold many files, so ask first.
        setImportingAssets(false);
        const choice = await new Promise<"folder" | "files" | undefined>((answer) => setFolderPrompt({ folders, answer }));
        setFolderPrompt(undefined);
        if (!choice || !mounted.current) return;
        setImportingAssets(true);
        if (choice === "files") { chosen = accepted; folders = []; }
      }
      if (folders.reduce((count, folder) => count + folder.files.length, 0) > MAX_FOLDER_IMPORT_FILES) throw new Error(t("assetCanvas.folderFileLimit"));
      if (folders.reduce((bytes, folder) => bytes + folder.bytes, 0) > MAX_FOLDER_IMPORT_BYTES) throw new Error(t("assetCanvas.folderSizeLimit"));
      const files = chosen.map(({ file }) => ({ file, kind: canvasImportKind(file.name) }));
      if (files.length > 1_000) throw new Error(t("assetCanvas.importLimit"));
      if (nodesRef.current.length + files.length + folders.length > MAX_ASSET_CANVAS_NODES) throw new Error(t("assetCanvas.nodeLimit"));
      let placed = 0;
      const nextPosition = () => { const index = placed++; return snapCanvasPosition({ x: position.x + (index % 3) * 480, y: position.y + Math.floor(index / 3) * 560 }); };
      for (const folder of folders) {
        try {
          const root = (await createCanvasImportFolder(projectId, folder.name)).path;
          const queue = [...folder.files];
          await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
            for (let item = queue.shift(); item; item = queue.shift()) {
              const { file, directory } = item;
              try { await importProjectFile(file, directory ? `${root}/${directory}` : root); } catch (cause) { failures.push(`${[folder.name, directory, file.name].filter(Boolean).join("/")}: ${errorMessage(cause)}`); }
            }
          }));
          imported.push({ id: crypto.randomUUID(), type: "file", position: nextPosition(), selected: true, data: { path: root, directory: true } });
        } catch (cause) { failures.push(`${folder.name}: ${errorMessage(cause)}`); }
      }
      for (const { file, kind } of files) {
        const at = nextPosition();
        try {
          if (kind.kind === "table") {
            imported.push({ id: crypto.randomUUID(), type: "table", position: at, selected: true, data: { tableId: await importTableFile(file, kind.delimiter) } });
          } else if (kind.kind === "document") {
            if (file.size > 1_000_000) throw new Error(t("assetCanvas.textTooLarge"));
            const text = await file.text();
            const id = await documents.add();
            if (!id) throw new Error(t("assetCanvas.documentCreateFailed"));
            documents.update(id, { title: file.name.replace(/\.[^.]+$/, "").slice(0, 200), markdown: text });
            imported.push({ id: crypto.randomUUID(), type: "document", position: at, selected: true, data: { documentId: id } });
          } else if (kind.kind === "media") imported.push(assetFlowNode(await uploadAssetFile(file, kind.mediaType), at));
          else imported.push({ id: crypto.randomUUID(), type: "file", position: at, selected: true, data: { path: await importProjectFile(file) } });
        } catch (cause) { failures.push(`${file.name}: ${errorMessage(cause)}`); }
      }
      if (nodesRef.current.length + imported.length > MAX_ASSET_CANVAS_NODES) throw new Error(t("assetCanvas.canvasFull"));
      // Tables and documents start at their default size; other nodes leave room for their selected controls.
      const footprint = (node: AssetCanvasFlowNode) => isResizableCanvasNodeType(node.type) ? { width: node.width ?? RESIZABLE_CANVAS_NODE_SIZES[node.type].width, height: node.height ?? RESIZABLE_CANVAS_NODE_SIZES[node.type].height } : { width: 440, height: 520 };
      const occupied = nodesRef.current.map((node) => ({ ...node.position, width: node.measured?.width ?? footprint(node).width, height: node.measured?.height ?? footprint(node).height }));
      for (const node of imported) {
        // Keep imported files near the drop point while leaving space for selected node controls.
        const { width, height } = footprint(node);
        let overlaps;
        do {
          overlaps = occupied.filter((rect) => node.position.x < rect.x + rect.width + 20 && node.position.x + width + 20 > rect.x && node.position.y < rect.y + rect.height + 20 && node.position.y + height + 20 > rect.y);
          if (overlaps.length) node.position.y = snapCanvasPosition({ x: node.position.x, y: Math.max(...overlaps.map((rect) => rect.y + rect.height)) + 40 }).y;
        } while (overlaps.length);
        occupied.push({ ...node.position, width, height });
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
    if (value.nodes.some((node) => (node.type === "document" || node.type === "table" || node.type === "file")) && value.projectId !== projectId) {
      setTransferError(t("assetCanvas.pasteProject")); return;
    }
    commitPendingHistory();
    setTransferError(undefined);
    const copied = duplicateCanvasSelection(value.nodes, value.edges, position);
    setNodes((current) => orderedCanvasNodes([...current.map((node) => ({ ...node, selected: false })), ...copied.nodes.map((node) => ({ ...toFlowNode(node, imageModels, videoModels), selected: !node.parentId }))]));
    setEdges((current) => [...current, ...copied.edges]);
    setSelectedAssetEdgeId(undefined);
  }

  function clipboardNodes(selectedIds: ReadonlySet<string>): AssetCanvasNode[] {
    const ids = canvasDescendantIds(nodes, selectedIds);
    return orderedCanvasNodes(nodes.filter((node) => ids.has(node.id))).map((node) => {
      const canonical = toAssetCanvasNode(node, model3DModels);
      return canonical.parentId && ids.has(canonical.parentId) ? canonical : { ...canonical, parentId: undefined, position: canvasAbsolutePosition(node, nodes) };
    });
  }

  function groupSelection(): void {
    const selected = nodes.filter((node) => node.selected);
    const roots = canvasSelectionRoots(nodes, new Set(selected.map((node) => node.id)));
    if (roots.length < 2) return;
    if (nodes.length >= MAX_ASSET_CANVAS_NODES) { setTransferError(t("assetCanvas.nodeLimit")); return; }
    const parentId = roots.every((node) => node.parentId === roots[0]?.parentId) ? roots[0]?.parentId : undefined;
    const parent = nodes.find((node) => node.id === parentId);
    const origin = parent ? canvasAbsolutePosition(parent, nodes) : { x: 0, y: 0 };
    const positions = roots.map((node) => ({ node, at: canvasAbsolutePosition(node, nodes) }));
    const left = Math.min(...positions.map(({ at }) => at.x)) - 28;
    const top = Math.min(...positions.map(({ at }) => at.y)) - 54;
    const right = Math.max(...positions.map(({ node, at }) => at.x + (node.width ?? node.measured?.width ?? 440))) + 28;
    const bottom = Math.max(...positions.map(({ node, at }) => at.y + (node.height ?? node.measured?.height ?? 320))) + 28;
    if (right - left > 4096 || bottom - top > 4096) { setTransferError(t("assetCanvas.groupTooLarge")); return; }
    const group: AssetCanvasFlowNode = { id: crypto.randomUUID(), type: "group", parentId, position: { x: left - origin.x, y: top - origin.y }, width: Math.min(4096, Math.max(500, right - left)), height: Math.min(4096, Math.max(400, bottom - top)), data: { name: t("assetCanvas.groupName") }, selected: true, deletable: true };
    const selectedIds = new Set(roots.map((node) => node.id));
    commitPendingHistory();
    setNodes((current) => orderedCanvasNodes([...current.map((node) => selectedIds.has(node.id)
      ? { ...node, parentId: group.id, position: { x: canvasAbsolutePosition(node, current).x - left, y: canvasAbsolutePosition(node, current).y - top }, selected: false }
      : { ...node, selected: false }), group]));
    setMarqueeSelectedIds(new Set());
  }

  async function executeGroup(): Promise<void> {
    if (batchRun.current || closing || !executableGroupNodes.length) return;
    const plan = canvasGroupExecutionPlan(executableGroupNodes.map((node) => toAssetCanvasNode(node, model3DModels)));
    if (!plan) { setNotice({ kind: "action", message: t("assetCanvas.groupDependencyCycle") }); return; }
    const controller = new AbortController();
    const { signal } = controller;
    batchRun.current = controller;
    setNotice((current) => current?.kind === "action" ? undefined : current);
    setBatchExecuting(true);
    const failed = new Set<string>();
    const failures: string[] = [];
    const completed = new Set<string>();
    const pending = new Map(plan.map((item) => [item.node.id, item]));
    const running = new Map<string, Promise<void>>();
    const execute = async (item: (typeof plan)[number]) => {
      try {
        if (signal.aborted) return;
        if (item.dependencies.some((id) => failed.has(id))) throw new Error(t("assetCanvas.groupDependencyFailed"));
        const node = nodesRef.current.find((candidate) => candidate.id === item.node.id);
        if (!node || node.type !== item.node.type) throw new Error(t("assetCanvas.groupNodeUnavailable"));
        if (node.type === "text") {
          const model = node.data.textModel ?? defaultTextModel;
          if (!model) throw new Error(t("assetCanvas.selectModel"));
          await generateTextNode(node, model, node.data.reasoningLevel ?? textModelCatalog.defaultReasoningLevel ?? "medium", true, signal);
        } else {
          const job = await generateMedia(node, true, signal);
          if (signal.aborted) return;
          if (!job) throw new Error(t("assetCanvas.groupNodeUnavailable"));
          const result = await waitForGroupJob(job, signal);
          if (result.status !== "succeeded") throw new Error(result.error || t("assetCanvas.groupGenerationFailed"));
          // The daemon has persisted the output. Merge it before releasing dependents.
          if (signal.aborted) return;
          await sync();
        }
      } catch (cause) {
        if (signal.aborted) return;
        failed.add(item.node.id);
        failures.push(`${canvasNodeTitle(item.node)}: ${errorMessage(cause)}`);
      } finally {
        completed.add(item.node.id);
      }
    };
    try {
      while (pending.size || running.size) {
        if (signal.aborted) return;
        for (const [id, item] of pending) {
          if (running.size >= GROUP_GENERATION_CONCURRENCY) break;
          if (!item.dependencies.every((dependency) => completed.has(dependency))) continue;
          pending.delete(id);
          const operation = execute(item).finally(() => { running.delete(id); });
          running.set(id, operation);
        }
        // Refill a slot as soon as one node finishes, including newly ready dependents.
        await Promise.race(running.values());
      }
      if (failures.length) setNotice({ kind: "action", message: failures.join("\n") });
    } finally {
      if (batchRun.current === controller) {
        batchRun.current = undefined;
        if (mounted.current) setBatchExecuting(false);
      }
    }
  }

  function waitForGroupJob(job: ToolJob, signal: AbortSignal): Promise<ToolJob> {
    if (signal.aborted) return Promise.reject(signal.reason);
    job = observedGroupJobs.current.get(job.id) ?? job;
    if (job.status !== "running") return Promise.resolve(job);
    return new Promise((resolve, reject) => {
      const cleanup = () => { groupJobWaiters.current.delete(job.id); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(signal.reason); };
      groupJobWaiters.current.set(job.id, (completed) => { cleanup(); resolve(completed); });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  function ungroupSelection(): void {
    const groups = nodes.filter((node) => node.selected && node.type === "group");
    if (!groups.length) return;
    commitPendingHistory();
    setNodes((current) => {
      const groupIds = new Set(groups.map((group) => group.id));
      return orderedCanvasNodes(current.filter((node) => !groupIds.has(node.id)).map((node) => {
        if (!node.parentId || !groupIds.has(node.parentId)) return node;
        const group = current.find((candidate) => candidate.id === node.parentId)!;
        let destination = group.parentId;
        while (destination && groupIds.has(destination)) destination = current.find((candidate) => candidate.id === destination)?.parentId;
        return { ...reparentCanvasNode(node, destination, current), selected: true };
      }));
    });
  }

  function finishGroupDrag(dragged: readonly AssetCanvasFlowNode[]): void {
    const ids = new Set(dragged.map((node) => node.id));
    setNodes((current) => {
      const roots = canvasSelectionRoots(current, ids);
      let next = current;
      for (const node of roots) {
        const target = canvasDropGroup(node, current, ids);
        if (target !== node.parentId) next = next.map((candidate) => candidate.id === node.id ? reparentCanvasNode(candidate, target, next) : candidate);
      }
      return expandCanvasGroups(orderedCanvasNodes(next));
    });
  }

  function startAltDragDuplicate(dragged: readonly AssetCanvasFlowNode[]): void {
    // A rejected copy gesture must not fall back to moving the originals.
    altDragCopies.current = new Map();
    const source = clipboardNodes(new Set(dragged.map((node) => node.id)));
    if (nodesRef.current.length + source.length > MAX_ASSET_CANVAS_NODES) { setTransferError(t("assetCanvas.nodeLimit")); return; }
    setTransferError(undefined);
    const roots = canvasSelectionRoots(nodes, new Set(dragged.map((node) => node.id)));
    const at = roots.map((node) => canvasAbsolutePosition(node, nodes));
    const duplicated = duplicateCanvasSelection(source, [], { x: Math.min(...at.map((point) => point.x)), y: Math.min(...at.map((point) => point.y)) });
    const mapping = new Map(source.map((node, index) => [node.id, duplicated.nodes[index]!.id]));
    const copies = duplicated.nodes.map((node, index) => {
      const original = nodes.find((item) => item.id === source[index]!.id)!;
      // Keep the roots in the original coordinate space while React Flow reports the drag.
      const disconnected = duplicateAssetCanvasNode(source[index]!, node.position, node.id);
      const copy = source[index]!.parentId ? { ...disconnected, parentId: node.parentId } : { ...disconnected, parentId: original.parentId, position: original.position };
      return { ...toFlowNode(copy, imageModels, videoModels), selected: roots.some((root) => root.id === original.id) };
    });
    altDragCopies.current = mapping;
    clearSelection();
    setNodes((current) => orderedCanvasNodes([...current, ...copies]));
    setMarqueeSelectedIds(new Set(altDragCopies.current.values()));
  }

  function finishAltDragDuplicate(dragged: readonly AssetCanvasFlowNode[]): void {
    const copies = altDragCopies.current;
    altDragCopies.current = undefined;
    if (!copies?.size) return;
    const start = new Map(nodesRef.current.map((node) => [node.id, node.position]));
    if (dragged.some((node) => node.position.x !== start.get(node.id)?.x || node.position.y !== start.get(node.id)?.y)) return;
    const copyIds = new Set(copies.values());
    setEdges((current) => current.filter((edge) => !copyIds.has(edge.source) && !copyIds.has(edge.target)));
    setNodes((current) => current.flatMap((node) => copyIds.has(node.id) ? [] : [copies.has(node.id) ? { ...node, selected: true } : node]));
    setMarqueeSelectedIds(new Set(copies.keys()));
  }

  function copySelection(event: ClipboardEvent<HTMLDivElement>, cut = false): void {
    if (isTextEntry(event.target) || eventWithin(event, ".nokey")) return;
    const selected = clipboardNodes(new Set(nodes.filter((node) => node.selected).map((node) => node.id)));
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
    const value = createCanvasClipboard(projectId, clipboardNodes(new Set([nodeId])), document.edges);
    rememberCanvasClipboard(value); setCopiedSelection(value);
    void navigator.clipboard?.writeText(JSON.stringify(value)).catch(() => {});
  }

  function duplicateCanvasNode(nodeId: string): void {
    const source = nodes.find((node) => node.id === nodeId);
    if (!source) return;
    const selection = clipboardNodes(new Set([nodeId]));
    const at = canvasAbsolutePosition(source, nodes);
    pasteSelection(createCanvasClipboard(projectId, selection, document.edges), { x: at.x + CANVAS_GRID_SIZE * 2, y: at.y + CANVAS_GRID_SIZE * 2 });
  }

  function removeCanvasNodes(requestedIds: ReadonlySet<string>): void {
    const removedIds = canvasDescendantIds(nodes, requestedIds);
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

  /**
   * Saves the kept part of a viewed video as a new Library video, placed as
   * an asset node beside the node it was trimmed from.
   */
  async function saveTrimmedVideoNode(viewed: ViewableCanvasAsset, name: string, video: Blob, trim: VideoTrim): Promise<void> {
    // A canvas copy of a Library video records the Library original.
    const libraryAssetId = localAssets.find((asset) => asset.id === viewed.assetId)?.libraryAssetId ?? viewed.assetId;
    const saved = await saveTrimmedVideo(video, trim, { name, ...(globalAssets.some((asset) => asset.id === libraryAssetId) ? { libraryAssetId } : {}) });
    setLibraryAssets((current) => [{ ...saved, assetId: saved.id, path: saved.name }, ...current]);
    const source = nodesRef.current.find((node) => node.id === viewed.nodeId);
    const position = { x: (source?.position.x ?? 0) + (source?.measured?.width ?? 440) + 60, y: source?.position.y ?? 0 };
    const occupied = nodesRef.current.map((node) => ({ ...node.position, width: node.measured?.width ?? 440, height: node.measured?.height ?? 520 }));
    let overlaps;
    do {
      overlaps = occupied.filter((rect) => position.x < rect.x + rect.width + 20 && position.x + 460 > rect.x && position.y < rect.y + rect.height + 20 && position.y + 540 > rect.y);
      if (overlaps.length) position.y = snapCanvasPosition({ x: position.x, y: Math.max(...overlaps.map((rect) => rect.y + rect.height)) + 40 }).y;
    } while (overlaps.length);
    addAssetNode(saved, snapCanvasPosition(position));
    setViewedAsset(undefined);
  }

  // An open viewer can still refer to an earlier output after the node regenerates.
  function assetDownloadName(assetId: string, nodeId: string): string {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    const asset = libraryAssets.find((candidate) => candidate.id === assetId);
    return canvasAssetDownloadName(node?.title, asset?.name || node?.data.name || titleCase(node?.type ?? "asset"), asset?.contentType);
  }

  function downloadAsset(assetId: string, name: string): void {
    void assetBlob(assetId).then((blob) => downloadAssetBlob(blob, name)).catch((cause) => setNotice({ kind: "action", message: t("assetCanvas.downloadFailed", { error: errorMessage(cause) }) }));
  }

  function openMediaTool(operation: CanvasMediaToolbarAction, grid?: MediaGridSize): void {
    if (mediaToolBusy || materializingExamples) return;
    if (!selectedMediaNodes.some((node) => !node.data.assetId)) {
      runMediaTool(operation, grid, selectedMediaNodes);
      return;
    }
    setMaterializingExamples(true);
    setMediaToolError(undefined);
    void materializeExampleOutputs(selectedMediaNodes)
      .then((targets) => runMediaTool(operation, grid, targets))
      .catch((error) => setNotice({ kind: "action", message: errorMessage(error) }))
      .finally(() => setMaterializingExamples(false));
  }

  // Example previews are bundled files, but media tools need a library asset: the first tool use makes the example the node's output.
  async function materializeExampleOutputs(targets: readonly AssetCanvasFlowNode[]): Promise<AssetCanvasFlowNode[]> {
    const assigned = new Map<string, string>();
    for (const node of targets) {
      const url = node.data.assetId ? undefined : pixelExampleImageUrl(node.data.exampleImage);
      if (!url) continue;
      const blob = await (await fetch(url)).blob();
      const contentType = (blob.type || "image/webp") as LibraryUploadMediaType;
      const name = `${node.data.exampleImage!.split("/").pop()!.replace(/\.[^.]+$/, "")}.${contentType.split("/")[1]}`;
      const asset = await uploadLibraryAsset(new File([blob], name, { type: contentType }), contentType, undefined, "asset");
      assigned.set(node.id, asset.id);
    }
    if (assigned.size) {
      flushSync(() => setNodes((current) => current.map((candidate) => assigned.has(candidate.id)
        ? { ...candidate, data: { ...candidate.data, assetId: assigned.get(candidate.id) } }
        : candidate)));
      setLibraryAssets(await loadLibraryAssets());
    }
    return targets.map((node) => assigned.has(node.id) ? { ...node, data: { ...node.data, assetId: assigned.get(node.id) } } : node);
  }

  function runMediaTool(operation: CanvasMediaToolbarAction, grid: MediaGridSize | undefined, targets: readonly AssetCanvasFlowNode[]): void {
    const ids = targets.map((node) => node.data.assetId!).filter(Boolean);
    if (!ids.length || (isMultiImageOperation(operation) && ids.length < 2) || (operation === "extract-gif-frames" && !selectedImageIsGif)) return;
    setMediaToolError(undefined);
    if (operation === "ai-image-cutout") {
      startAiImageCutout(targets[0]!);
      return;
    }
    if (operation === "crop-image") { setCropNodeId(targets[0]!.id); return; }
    setCropNodeId(undefined);
    if (operation === "split-image-grid" || operation === "extract-gif-frames") {
      void executeMediaTool(operation, ids.slice(0, 1), operation === "split-image-grid" ? { ...grid, format: "png" } : {});
      return;
    }
    setMediaToolDialog({ operation, assetIds: isMultiImageOperation(operation) ? ids : ids.slice(0, 1) });
  }

  function startAiImageCutout(source: AssetCanvasFlowNode): void {
    if (!source.data.assetId || nodesRef.current.length >= MAX_ASSET_CANVAS_NODES) {
      setNotice({ kind: "action", message: t("assetCanvas.canvasFull") });
      return;
    }
    const position = snapCanvasPosition({
      x: source.position.x + (source.measured?.width ?? 440) + 60,
      y: source.position.y,
    });
    const created = createFlowNode("image", position, imageModels, videoModels, defaultTextModel);
    const configured = applyRememberedSettings(created, rememberedSettings.current.image, {
      imageModels,
      defaultImageModel,
      videoModels,
      defaultVideoModel,
      audioModels,
      model3DModels,
      defaultModel3D,
      textModels: textModelCatalog.models,
    });
    const node: AssetCanvasFlowNode = {
      ...configured,
      selected: true,
      data: {
        ...configured.data,
        prompt: "Remove the background from the referenced image and isolate the main subject. Preserve the subject's appearance, shape, details, colors, proportions, and pose. Generate a clean image with the subject centered on a transparent background.",
        images: [{ type: "node", nodeId: source.id }],
      },
    };
    flushSync(() => setNodes((current) => [
      ...current.map((candidate) => ({ ...candidate, selected: false })),
      node,
    ]));
    setSelectedAssetEdgeId(undefined);
    const flow = flowInstance.current;
    void flow?.setCenter(node.position.x + 220, node.position.y + 220, { zoom: Math.min(flow.getViewport().zoom, 1), duration: 300 });
    void generateMedia(node);
  }

  async function executeMediaTool(operation: CanvasMediaOperation, assetIds: string[], toolOptions: Record<string, unknown>): Promise<void> {
    if (mediaToolBusy) return;
    const expectedNodes = operation === "split-image-grid"
      ? Array.isArray(toolOptions.selectedFrames)
        ? toolOptions.selectedFrames.length
        : Number(toolOptions.columns ?? 2) * Number(toolOptions.rows ?? 2)
      : operation === "video-frame-strip" && Array.isArray(toolOptions.selectedFrames)
        ? toolOptions.selectedFrames.length : 1;
    if (nodesRef.current.length + expectedNodes > MAX_ASSET_CANVAS_NODES) {
      const message = t("assetCanvas.canvasFull");
      setMediaToolError(message);
      setNotice({ kind: "action", message });
      return;
    }
    setMediaToolBusy(true);
    setMediaToolError(undefined);
    setGenerationError(undefined);
    try {
      await flush();
      const result = await runCanvasMedia(projectId, { boardId: storage.boardId, operation, assetIds, options: toolOptions });
      if (result.kind === "download") {
        const blob = await getWorkspaceAsset(projectId, result.path);
        downloadAssetBlob(blob, result.name);
        setMediaToolDialog(undefined);
        setCropNodeId(undefined);
        setNotice({ kind: "action", message: t("assetCanvas.mediaTools.downloaded", { name: result.name }) });
      } else {
        const assets = await loadLibraryAssets();
        setLibraryAssets(assets);
        const source = nodesRef.current.find((node) => node.data.assetId && assetIds.includes(node.data.assetId));
        const resultAssets = result.kind === "assets" ? result.assets : [result];
        const created = resultAssets.map((item) => assets.find((asset) => asset.id === item.assetId)).filter((asset): asset is LibraryAsset => Boolean(asset));
        if (!created.length || created.length !== resultAssets.length) throw new Error(t("assetCanvas.mediaTools.resultUnavailable"));
        if (nodesRef.current.length + created.length > MAX_ASSET_CANVAS_NODES) throw new Error(t("assetCanvas.canvasFull"));
        const sourceAt = source ? canvasAbsolutePosition(source, nodesRef.current) : { x: 0, y: 0 };
        const columns = Math.min(3, created.length);
        const block = { width: columns * 480 - 40, height: Math.ceil(created.length / columns) * 560 - 40 };
        // Place the results as one block in empty canvas space nearest to the source.
        const start = snapCanvasPosition(findCanvasFreeArea(nodesRef.current, block, { x: sourceAt.x + (source?.measured?.width ?? 440) + 60, y: sourceAt.y }));
        const createdNodes = created.map((asset, index) => assetFlowNode(asset, { x: start.x + (index % columns) * 480, y: start.y + Math.floor(index / columns) * 560 }));
        flushSync(() => setNodes((current) => [
          ...current.map((node) => ({ ...node, selected: false })),
          ...createdNodes,
        ]));
        const flow = flowInstance.current;
        // New nodes have not been measured yet, so fitView would ignore them; frame their block instead.
        if (createdNodes.length > 1) void flow?.fitBounds({ ...start, ...block }, { padding: 0.15, duration: 300 });
        else void flow?.setCenter(start.x + 220, start.y + 220, { zoom: Math.min(flow.getViewport().zoom, 1), duration: 300 });
        setMediaToolDialog(undefined);
        setCropNodeId(undefined);
        setNotice({ kind: "action", message: t("assetCanvas.mediaTools.created", { name: created.length === 1 ? created[0]!.name : `${created.length} assets` }) });
      }
    } catch (error) {
      const message = errorMessage(error);
      const detail = message === "Unsupported media operation" ? t("assetCanvas.mediaTools.restartService") : message;
      setMediaToolError(detail);
      if (operation === "split-image-grid" || operation === "extract-gif-frames") setNotice({ kind: "action", message: detail });
    } finally {
      setMediaToolBusy(false);
    }
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
    setEdges((current) => current.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
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

  async function generateTextNode(node: AssetCanvasFlowNode, model: AgentModelRef, reasoningLevel: AgentReasoningLevel, propagateError = false, signal?: AbortSignal): Promise<void> {
    if (node.type !== "text" || generatingTextNodesRef.current.has(node.id)) {
      if (propagateError) throw new Error(t("assetCanvas.groupNodeUnavailable"));
      return;
    }
    const instruction = node.data.instruction?.trim();
    if (!instruction) {
      setGenerationError({ nodeId: node.id, message: t("assetCanvas.instructionRequired") });
      if (propagateError) throw new Error(t("assetCanvas.instructionRequired"));
      return;
    }
    generatingTextNodesRef.current.add(node.id);
    setGeneratingTextNodeIds(new Set(generatingTextNodesRef.current));
    setGenerationError(undefined);
    try {
      const referenceSource = { boardId: storage.boardId, nodeId: node.id };
      await flush();
      await documents.flush();
      signal?.throwIfAborted();
      const result = await generateCanvasText(projectId, instruction, model, reasoningLevel, referenceSource, writeVersion);
      signal?.throwIfAborted();
      // Publish the text before a batch proceeds to a dependent node or flushes the board.
      flushSync(() => setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, text: result.text, textModel: result.model, reasoningLevel } }
        : candidate)));
    } catch (error) {
      if (!signal?.aborted) setGenerationError({ nodeId: node.id, message: errorMessage(error) });
      if (propagateError) throw error;
    } finally {
      generatingTextNodesRef.current.delete(node.id);
      if (mounted.current) setGeneratingTextNodeIds(new Set(generatingTextNodesRef.current));
    }
  }

  async function uploadReferenceImages(node: AssetCanvasFlowNode, files: File[]): Promise<void> {
    if ((node.type !== "image" && node.type !== "model-3d") || files.length === 0 || uploadingNodeId) return;
    const available = (node.type === "image" ? node.data.quickReskinMode === "person-clothing" ? 2 : node.data.presetId === "quick-reskin" ? 1 : imageReferenceLimit(node, imageModels) : (nodeModel3D(node, model3DModels)?.maxReferenceImages ?? MODEL_3D_MAX_REFERENCE_IMAGES)) - (node.data.images?.length ?? 0);
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

  async function uploadSourceImage(node: AssetCanvasFlowNode, file: File): Promise<void> {
    if (node.type !== "image" || !node.data.sourceInput || uploadingNodeId) return;
    setUploadingNodeId(node.id);
    setGenerationError(undefined);
    try {
      const image = await readUploadImage(file);
      const asset = await createLibraryImage({ ...image, purpose: "reference" });
      setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, assetId: asset.id } }
        : candidate));
      setLibraryAssets(await loadLibraryAssets());
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      setUploadingNodeId(undefined);
    }
  }

  function setSourceAsset(node: AssetCanvasFlowNode, asset: LibraryAsset): void {
    if (node.type !== "image" || !node.data.sourceInput || asset.mediaType !== "image") return;
    setNodes((current) => current.map((candidate) => candidate.id === node.id
      ? { ...candidate, data: { ...candidate.data, assetId: asset.id } }
      : candidate));
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

  async function generateMedia(node: AssetCanvasFlowNode, propagateError = false, signal?: AbortSignal): Promise<ToolJob | undefined> {
    const running = canvasJobsRef.current[node.id];
    if (running?.status === "running") return propagateError ? running : undefined;
    if (startingCanvasNodesRef.current.has(node.id)) {
      if (propagateError) throw new Error(t("assetCanvas.groupNodeUnavailable"));
      return;
    }
    startingCanvasNodesRef.current.add(node.id);
    setStartingCanvasNodes((current) => new Set(current).add(node.id));
    setGenerationError(undefined);
    try {
      const targetStorage = storageRef.current;
      await flush();
      signal?.throwIfAborted();
      const job = await targetStorage.generate(node.id);
      signal?.throwIfAborted();
      setCanvasJobs((current) => ({ ...current, [node.id]: job }));
      return job;
    } catch (error) {
      if (!signal?.aborted) setGenerationError({ nodeId: node.id, message: errorMessage(error) });
      if (propagateError) throw error;
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
  const templateBoard = nodes.flatMap((node) => node.type === "text" ? [templateGuideInfo(node.data.instruction)?.template] : []).find((value) => value !== undefined);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const pixelStyleGroupIds = new Set(nodes.filter((node) => node.type === "group" && node.data.pixelStyle).map((node) => node.id));
  const renderedNodes = orderedCanvasNodes(nodes).map((original) => {
    const size = isResizableCanvasNodeType(original.type) ? RESIZABLE_CANVAS_NODE_SIZES[original.type] : undefined;
    const isTemplateGuide = original.type === "text" && Boolean(templateGuideInfo(original.data.instruction) || pixelAssetTemplateGuideCategory(original.data.instruction) || original.data.instruction === PIXEL_ASSET_TEMPLATE_NOTE);
    const parent = original.parentId ? nodesById.get(original.parentId) : undefined;
    const isPixelWorkflow = Boolean(parent?.parentId && pixelStyleGroupIds.has(parent.parentId));
    // A render can arrive before React Flow publishes its first dimensions.
    // An empty measurement keeps it from clearing freshly measured handle bounds.
    const node = { ...original, measured: original.measured ?? {}, ...(isTemplateGuide ? { height: undefined } : {}), ...(size ? { style: { ...original.style, width: original.width ?? size.width, height: isTemplateGuide ? "auto" : original.height ?? size.height } } : {}), data: { ...original.data,
      audioAsset: libraryAssets.find((asset) => asset.id === original.data.assetId)?.audio,
      ...(size ? { resizeRuntime: {
        start: beginHistoryGesture,
        end: finishHistoryGesture,
        reset: () => { beginHistoryGesture(); setNodes((current) => current.map((node) => { if (node.id !== original.id || node.type === "group") return node; const { width: _width, height: _height, ...rest } = node; return rest; })); finishHistoryGesture(); },
        ...(original.type === "text" ? { open: () => setExpandedTextId(original.id) } : {}),
    } } : {}), assetAspectRatio: mediaAspectRatio(libraryAssets.find((asset) => asset.id === original.data.assetId)), panelOpen: original.selected === true && !marqueeActive && !marqueeSelectedIds.has(original.id), nodeDetails: {
      title: original.title?.trim(), label: canvasNodeTitle(toAssetCanvasNode(original, model3DModels), documents.documents, libraryAssets, tableContents), description: original.description,
      edit: () => setNodeDetails({ id: original.id, title: original.type === "group" ? original.data.name ?? "" : original.title ?? "", description: original.description ?? "" }),
    } } };
    if (node.type === "group") return { ...node, dragHandle: ".canvas-group-heading" };
    if (node.type === "table") {
      const session = tables.storage.sessions.get(node.data.tableId ?? "");
      return { ...node, data: { ...node.data, tableRuntime: { tables, table: session?.local, issue: session?.issue ?? tables.issues?.find((issue) => issue.id === node.data.tableId)?.message, models: textModelCatalog.models, modelStatus: textModelCatalog.status, defaultModel: defaultTextModel, defaultReasoningLevel: textModelCatalog.defaultReasoningLevel } } };
    }
    if (node.type === "file") {
      const reveal = window.ohMyGameDesktop?.openProjectFile;
      return { ...node, data: { ...node.data, fileRuntime: { onReveal: reveal && node.data.path ? () => { void reveal(projectId, node.data.path!, "reveal").catch((cause) => setNotice({ kind: "action", message: errorMessage(cause) })); } : undefined } } };
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
          assetWidth: asset?.width,
          assetHeight: asset?.height,
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
          generating: generatingTextNodeIds.has(node.id),
          busy: generatingTextNodeIds.has(node.id),
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
    if (node.type === "speech" || node.type === "sound-effect" || node.type === "music" || node.type === "audio-scene") {
      const nodeJob = canvasJobs[node.id];
      const linkedPrompt = resolveLinkedPrompt(node, nodes, documents);
      const operation = audioOperationForNode(node.type)!;
      return {
        ...node,
        data: {
          ...node.data,
          audioRuntime: {
            generating: nodeJob?.status === "running",
            busy: nodeJob?.status === "running" || startingCanvasNodes.has(node.id),
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
            models: audioModels.filter((model) => model.capabilities.operations.includes(operation)),
            providers: audioProviders,
            audio: node.data.audioAsset,
          } satisfies AudioNodeRuntime,
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
      maxReferences: node.type === "image" ? node.data.quickReskinMode === "person-clothing" ? Math.min(2, imageReferenceLimit(node, imageModels)) : node.data.presetId === "quick-reskin" ? 1 : imageReferenceLimit(node, imageModels) : videoReferenceLimit(selectedVideoModel(node, videoModels), node.data.referenceMode),
      uploading: uploadingNodeId === node.id,
      accept: "image/png,image/jpeg,image/webp",
      addLabel: node.type === "image" && node.data.presetId === "quick-reskin" ? t("assetCanvasTemplates.quickReskinSource") : t("assetCanvas.addReferences"),
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
        ? { ...node.data, imageRuntime: { ...referenceRuntime,
          template: templateBoard,
          models: node.data.quickReskinMode === "person-clothing"
            ? imageModels.filter((model) => model.supportsReferenceImage && (model.maxReferenceImages ?? IMAGE_MAX_REFERENCE_IMAGES) >= 2)
            : node.data.presetId === "quick-reskin" || isPixelWorkflow || (templateBoard && (node.data.sourceInput || templateBoard === "pixel-art" || templateBoard === "action-set" || node.data.presetId === "continuous-sequence" || node.data.presetId === "consistent-sequence")) ? imageModels.filter((model) => model.supportsReferenceImage && model.maxReferenceImages !== 0) : imageModels,
          ...(node.data.quickReskinMode === "person-clothing" ? { slotLabels: [t("assetCanvasTemplates.quickReskinPerson"), t("assetCanvasTemplates.quickReskinClothing")] } : {}),
          providers: imageProviders, onUploadSourceImage: (file) => void uploadSourceImage(node, file), onSetSourceAsset: (asset) => setSourceAsset(node, asset) } satisfies ImageNodeRuntime }
        : { ...node.data, videoRuntime: { ...referenceRuntime, models: videoModels, providers: videoProviders } satisfies VideoNodeRuntime },
    };
  });

  function applyEditorCanvas(next: AssetCanvasDocument): void {
    next = { ...next, editorLayout: { ...next.editorLayout, viewport: latestCanvas.current?.editorLayout.viewport ?? next.editorLayout.viewport } };
    validateAssetCanvasDocument(next);
    observeHistoryDocument(next);
    setViewport(next.viewport);
    const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
    setNodes(orderedCanvasNodes(next.nodes).map((node) => toFlowNode(node, imageModels, videoModels, previous.get(node.id))));
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
                project={project}
                documents={documents} tables={tables}
                libraryAssets={libraryAssets.filter((asset) => asset.mediaType === "image" || asset.mediaType === "video" || asset.mediaType === "audio" || asset.mediaType === "model")}
                importing={importingAssets}
                onAdd={addNode}
                onAddPixelPreset={addPixelAssetPreset}
                onAddAsset={addAssetNode}
                onUpload={(files, position) => void importAssetFiles(files, position)}
              />}
              onOpenMenu={setCanvasContextMenu}
              addOnDoubleClick
              deleteKeyCode={["Backspace", "Delete"]}
              onNodesChange={onNodesChange}
              onNodeDragStart={(event, _node, dragged) => {
                setCanvasContextMenu(undefined); beginHistoryGesture();
                altDragCopies.current = undefined;
                if (event.altKey) startAltDragDuplicate(dragged);
              }}
              onNodeDragStop={(_event, _node, dragged) => { const copies = altDragCopies.current; finishAltDragDuplicate(dragged); if (!copies) finishGroupDrag(dragged); else if (copies.size) finishGroupDrag(nodesRef.current.filter((node) => [...copies.values()].includes(node.id) && node.selected)); finishHistoryGesture(); }}
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
              onNodeDoubleClick={(event, node) => { if (node.type === "group") setNodeDetails({ id: node.id, title: node.data.name ?? "", description: node.description ?? "" }); else if (eventWithin(event, ".story-media-stage")) openViewer(node); }}
              onPaneClick={() => { setCanvasContextMenu(undefined); clearSelection(); }}
              onNodeContextMenu={(_event, node) => {
                activateNode(node.id);
                setNodes((current) => current.map((candidate) => ({ ...candidate, selected: node.selected ? candidate.selected : candidate.id === node.id })));
              }}
              onNodesDelete={(deleted) => {
                removeCanvasNodes(new Set(deleted.map((node) => node.id)));
                finishHistoryGesture();
              }}
              isValidConnection={(connection) => {
                const target = nodes.find((node) => node.id === connection.target);
                const source = nodes.find((node) => node.id === connection.source);
                return Boolean(source && target && connectionRelation(source, target, connection.sourceHandle, nodes, libraryAssets, imageModels, model3DModels, audioModels));
              }}
              defaultViewport={editorLayout.viewport}
              fitViewOnLoad={editorLayout.fitView === true}
              onInitialFit={finishInitialFit}
            >
              {selectedNodes.length > 1 && !selectedMediaType && (canGroupSelection || canUngroupSelection) ? <SelectionCanvasToolbarOverlay
                nodes={selectedNodes}
                allNodes={nodes}
                onGroup={canGroupSelection ? groupSelection : undefined}
                onUngroup={canUngroupSelection ? ungroupSelection : undefined}
              /> : null}
              {selectedGroup ? <GroupCanvasToolbarOverlay
                node={selectedGroup}
                nodes={nodes}
                canExecute={executableGroupNodes.length > 0 && !batchExecuting}
                onExecute={() => void executeGroup()}
                onUngroup={ungroupSelection}
              /> : null}
              {selectedMediaType && selectedMediaNodes[0] && !cropNodeId ? <MediaCanvasToolbarOverlay
                node={renderedNodes.find((node) => node.id === selectedMediaNodes[0]!.id)!}
                nodes={nodes}
                canvasElement={canvasElement}
                mediaType={selectedMediaType}
                isGif={selectedImageIsGif}
                imageCount={selectedMediaType === "image" ? selectedMediaNodes.length : 0}
                busy={mediaToolBusy || materializingExamples}
                onOpen={openMediaTool}
                onGroup={canGroupSelection ? groupSelection : undefined}
                onUngroup={canUngroupSelection ? ungroupSelection : undefined}
              /> : null}
              {cropNodeId && selectedMediaNodes[0]?.id === cropNodeId ? <CanvasImageCrop
                key={cropNodeId} nodeId={cropNodeId} busy={mediaToolBusy} error={mediaToolError}
                onClose={() => { if (!mediaToolBusy) setCropNodeId(undefined); }}
                onSubmit={(crop) => void executeMediaTool("crop-image", [selectedMediaNodes[0]!.data.assetId!], { ...crop, format: "png" })}
              /> : null}
            </EditorCanvas>
          ) : null}
          {canvasContextMenu ? <AssetCanvasContextMenu
            documents={documents} tables={tables}
            onUseInDocument={contextMenuNode?.type === "text" && contextMenuNode.data.text ? () => documents.appendText(contextMenuNode.data.text!) : contextMenuNode?.data.assetId && (contextMenuNode.type === "image" || contextMenuNode.data.mediaType === "image") ? () => documents.appendImage(contextMenuNode.data.assetId!) : undefined}
            menu={canvasContextMenu}
            canUndo={canUndo}
            canRedo={canRedo}
            canPaste={canInsertCopiedNode}
            canDuplicate={Boolean(contextMenuNode)}
            canUngroup={selectedNodes.some((node) => node.type === "group")}
            canView={Boolean(contextMenuNode && viewableCanvasAsset(contextMenuNode))}
            canDownload={Boolean(contextMenuNode?.data.assetId)}
            canSendToProject={Boolean(contextMenuNode?.data.assetId)}
            nodeActionsDisabled={Boolean(contextMenuNodeMissing)}
            importing={importingAssets}
            onClose={() => setCanvasContextMenu(undefined)}
            onDetails={contextMenuNode ? () => setNodeDetails({ id: contextMenuNode.id, title: contextMenuNode.type === "group" ? contextMenuNode.data.name ?? "" : contextMenuNode.title ?? "", description: contextMenuNode.description ?? "" }) : undefined}
            onUngroup={ungroupSelection}
            onUndo={undoEditorChange}
            onRedo={redoEditorChange}
            onPaste={() => { const value = lastCanvasClipboard(); if (value) pasteSelection(value, canvasContextMenu.flowPosition); }}
            onAdd={(item) => addCanvasNode(item, canvasContextMenu.flowPosition)}
            onUpload={(files) => void importAssetFiles(files, canvasContextMenu.flowPosition)}
            onView={() => { if (contextMenuNode) openViewer(contextMenuNode); }}
            onDownload={() => { if (contextMenuNode?.data.assetId) downloadAsset(contextMenuNode.data.assetId, assetDownloadName(contextMenuNode.data.assetId, contextMenuNode.id)); }}
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
        name={assetDownloadName(viewedAsset.assetId, viewedAsset.nodeId)}
        onDownload={(name) => downloadAsset(viewedAsset.assetId, name)}
        onSendToProject={(name) => sendAssetToProject(viewedAsset.assetId, name)}
        onClose={() => setViewedAsset(undefined)}
        {...(viewedAsset.mediaType === "video" ? { trimmer: {
          loadSource: () => assetBlob(viewedAsset.assetId),
          onSave: (video: Blob, trim: VideoTrim) => saveTrimmedVideoNode(viewedAsset, libraryAssets.find((candidate) => candidate.id === viewedAsset.assetId)?.name ?? "video", video, trim),
        } } : {})}
      /> : null}
      {sentAsset ? <SendToProjectDialog assetId={sentAsset.assetId} name={sentAsset.name} onClose={() => setSentAsset(undefined)} /> : null}
      {mediaToolDialog ? <MediaToolDialog
        operation={mediaToolDialog.operation}
        key={mediaToolDialog.operation}
        assetIds={mediaToolDialog.assetIds}
        busy={mediaToolBusy}
        error={mediaToolError}
        onClose={() => { if (!mediaToolBusy) setMediaToolDialog(undefined); }}
        onSubmit={(options, orderedIds) => void executeMediaTool(mediaToolDialog.operation, orderedIds, options)}
      /> : null}
      {folderPrompt ? createPortal(<FolderImportDialog folders={folderPrompt.folders} onAnswer={folderPrompt.answer} />, window.document.body) : null}
      {nodeDetails ? createPortal(<div className="design-modal-backdrop nokey" onPointerDown={(event) => { if (event.target === event.currentTarget) setNodeDetails(undefined); }}><section className="design-modal" role="dialog" aria-modal="true" aria-label={t("assetCanvas.nodeDetails")} onKeyDown={(event) => { if (event.key === "Escape") setNodeDetails(undefined); }}>
        <header><h2>{t("assetCanvas.nodeDetails")}</h2><button type="button" title={t("common.close")} aria-label={t("common.close")} onClick={() => setNodeDetails(undefined)}><X size={16} /></button></header>
        <form onSubmit={(event) => { event.preventDefault(); setNodes((current) => current.map((node) => node.id === nodeDetails.id ? node.type === "group" ? { ...node, data: { ...node.data, name: nodeDetails.title.trim().slice(0, 120) || t("assetCanvas.groupName") }, description: nodeDetails.description.trim() || undefined } : { ...node, title: nodeDetails.title.trim() || undefined, description: nodeDetails.description.trim() || undefined } : node)); setNodeDetails(undefined); }}>
          <label>{t("common.name")}<input autoFocus maxLength={nodes.find((node) => node.id === nodeDetails.id)?.type === "group" ? 120 : 200} value={nodeDetails.title} placeholder={t("assetCanvas.automaticName")} onChange={(event) => setNodeDetails({ ...nodeDetails, title: event.target.value })} /></label>
          <label>{t("publish.description")}<textarea rows={3} maxLength={2000} value={nodeDetails.description} onChange={(event) => setNodeDetails({ ...nodeDetails, description: event.target.value })} /></label>
          <code className="canvas-node-id">{nodeDetails.id}</code>
          <footer><button type="button" onClick={() => setNodeDetails(undefined)}>{t("common.cancel")}</button><button type="submit">{t("common.save")}</button></footer>
        </form>
      </section></div>, window.document.body) : null}
    </section>
  );
}

type MediaGridSize = { columns: number; rows: number };

type DialogMediaOperation = Exclude<CanvasMediaOperation, "crop-image" | "split-image-grid" | "extract-gif-frames">;

function MediaCanvasToolbar({ mediaType, imageCount, isGif, busy, menuBelow, onOpen, onGroup, onUngroup }: {
  mediaType: "image" | "video";
  imageCount: number;
  isGif: boolean;
  busy: boolean;
  menuBelow: boolean;
  onOpen: (operation: CanvasMediaToolbarAction, grid?: MediaGridSize) => void;
  onGroup?: () => void;
  onUngroup?: () => void;
}) {
  const [openGroup, setOpenGroup] = useState<string>();
  const [customGrid, setCustomGrid] = useState(false);
  const [gridOffset, setGridOffset] = useState(0);
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openGroup) return;
    const dismiss = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as globalThis.Node)) setOpenGroup(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenGroup(undefined);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [openGroup]);
  function revealCustomGrid(element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    const preferred = rect.right + 190 <= window.innerWidth ? rect.width : -190;
    setGridOffset(Math.max(-rect.left, Math.min(window.innerWidth - 190 - rect.left, preferred)));
    setCustomGrid(true);
  }
  const group = (id: string, label: string, Icon: IconComponent, items: { id: string; label: string; onClick: () => void; disabled?: boolean; title?: string }[], extra?: ReactNode) => <div className={`asset-media-toolbar-group${menuBelow ? " is-below" : ""}`} key={id} onMouseEnter={() => { if (!busy) setOpenGroup(id); }} onMouseLeave={() => { setOpenGroup(undefined); setCustomGrid(false); }}>
    <button className="asset-media-toolbar-button" type="button" disabled={busy} aria-haspopup="menu" aria-expanded={openGroup === id} aria-label={label} onClick={() => setOpenGroup(id)}>
      <Icon size={16} /><span>{label}</span><ChevronDown size={14} />
    </button>
    {openGroup === id ? <div className={`asset-media-toolbar-menu${menuBelow ? " is-below" : ""}${id === "grid" ? " has-submenu" : ""}`} role="menu" aria-label={label}>
      {items.map((item) => <button key={item.id} type="button" role="menuitem" title={item.title} disabled={busy || item.disabled} onMouseEnter={() => setCustomGrid(false)} onClick={() => { setOpenGroup(undefined); item.onClick(); }}>{item.label}</button>)}
      {extra}
    </div> : null}
  </div>;
  const operation = (id: CanvasMediaToolbarAction) => ({ id, label: t(`assetCanvas.mediaTools.${id}`), title: id === "ai-image-cutout" ? t("assetCanvas.mediaTools.aiImageCutoutHint") : undefined, onClick: () => onOpen(id), disabled: (isMultiImageOperation(id) && imageCount < 2) || (id === "extract-gif-frames" && !isGif) });
  return <div ref={toolbar} className="asset-media-toolbar" role="toolbar" aria-label={t("assetCanvas.mediaTools.toolbar") } onPointerDown={(event) => event.stopPropagation()}>
    {onGroup ? <button className="asset-media-toolbar-button" type="button" onClick={onGroup}><Layers3 size={16} /><span>{t("assetCanvas.createGroup")}</span></button> : null}
    {onUngroup ? <button className="asset-media-toolbar-button" type="button" onClick={onUngroup}><Layers3 size={16} /><span>{t("assetCanvas.ungroup")}</span></button> : null}
    {mediaType === "image" ? <>
      {MEDIA_TOOL_GROUPS.map((entry) => <Fragment key={entry.id}>
        {entry.id === "gif-frames" ? group("grid", t("assetCanvas.mediaTools.grid"), Widget, [
          ...[2, 3, 4, 5].map((side) => ({ id: String(side), label: t("assetCanvas.mediaTools.gridPreset", { count: side * side, columns: side, rows: side }), onClick: () => onOpen("split-image-grid", { columns: side, rows: side }) })),
        ], <div className="asset-grid-submenu-trigger" onMouseEnter={(event) => revealCustomGrid(event.currentTarget)} onMouseLeave={() => setCustomGrid(false)} onFocus={(event) => revealCustomGrid(event.currentTarget)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setCustomGrid(false); }}>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={customGrid} onClick={(event) => revealCustomGrid(event.currentTarget.parentElement!)}>{t("assetCanvas.mediaTools.gridCustom")}<ChevronRight size={14} /></button>
          {customGrid ? <div className="asset-grid-submenu" style={{ left: gridOffset }} role="menu" aria-label={t("assetCanvas.mediaTools.gridCustom")}><MediaGridPicker onPick={(grid) => { setOpenGroup(undefined); setCustomGrid(false); onOpen("split-image-grid", grid); }} /></div> : null}
        </div>) : null}
        {group(entry.id, t(`assetCanvas.mediaTools.${entry.id}`), entry.id === "image-processing" ? Scissors : Film, entry.operations.map(operation))}
      </Fragment>)}
    </> : <>
      <button className="asset-media-toolbar-button" type="button" disabled={busy} onClick={() => onOpen("video-frame-strip")}>
        <Film size={16} /><span>{t("assetCanvas.mediaTools.video-frame-strip")}</span>
      </button>
    </>}
    {busy ? <LoaderCircle className="spin" size={15} aria-label={t("common.loading")} /> : null}
  </div>;
}

function MediaGridPicker({ onPick }: { onPick: (grid: MediaGridSize) => void }) {
  const [hover, setHover] = useState({ columns: 2, rows: 2 });
  return <div className="asset-grid-picker">
    <div className="asset-grid-picker-cells" role="group" aria-label={t("assetCanvas.mediaTools.gridCustom")}>
      {Array.from({ length: 64 }, (_, index) => {
        const columns = index % 8 + 1;
        const rows = Math.floor(index / 8) + 1;
        return <button key={index} type="button" aria-label={`${columns} × ${rows}`} className={columns <= hover.columns && rows <= hover.rows ? "is-active" : ""} onMouseEnter={() => setHover({ columns, rows })} onFocus={() => setHover({ columns, rows })} onClick={() => onPick({ columns, rows })} />;
      })}
    </div>
    <span>{hover.columns} × {hover.rows}</span>
  </div>;
}

function SelectionCanvasToolbarOverlay({ nodes, allNodes, onGroup, onUngroup }: {
  nodes: readonly AssetCanvasFlowNode[];
  allNodes: readonly AssetCanvasFlowNode[];
  onGroup?: () => void;
  onUngroup?: () => void;
}) {
  const { y, zoom } = useViewport();
  const below = y + Math.min(...nodes.map((node) => canvasAbsolutePosition(node, allNodes).y)) * zoom < 70;
  return <NodeToolbar nodeId={nodes.map((node) => node.id)} isVisible position={below ? Position.Bottom : Position.Top} offset={10} className="asset-media-toolbar-panel nodrag nopan nowheel">
    <div className="asset-media-toolbar">
      {onGroup ? <button className="asset-media-toolbar-button" type="button" onClick={onGroup}><Layers3 size={16} /><span>{t("assetCanvas.createGroup")}</span></button> : null}
      {onUngroup ? <button className="asset-media-toolbar-button" type="button" onClick={onUngroup}><Layers3 size={16} /><span>{t("assetCanvas.ungroup")}</span></button> : null}
    </div>
  </NodeToolbar>;
}

function GroupCanvasToolbarOverlay({ node, nodes, canExecute, onExecute, onUngroup }: {
  node: AssetCanvasFlowNode;
  nodes: readonly AssetCanvasFlowNode[];
  canExecute: boolean;
  onExecute: () => void;
  onUngroup: () => void;
}) {
  const { y, zoom } = useViewport();
  const below = y + canvasAbsolutePosition(node, nodes).y * zoom < 70;
  return <NodeToolbar nodeId={node.id} isVisible position={below ? Position.Bottom : Position.Top} offset={10} className="asset-media-toolbar-panel nodrag nopan nowheel">
    <div className="asset-media-toolbar">
      <button className="asset-media-toolbar-button" type="button" disabled={!canExecute} onClick={onExecute}><Play size={16} /><span>{t("assetCanvas.executeGroup")}</span></button>
      <button className="asset-media-toolbar-button" type="button" onClick={onUngroup}><Layers3 size={16} /><span>{t("assetCanvas.ungroup")}</span></button>
    </div>
  </NodeToolbar>;
}

function MediaCanvasToolbarOverlay({ node, nodes, canvasElement, mediaType, imageCount, isGif, busy, onOpen, onGroup, onUngroup }: {
  node: AssetCanvasFlowNode;
  nodes: readonly AssetCanvasFlowNode[];
  canvasElement: RefObject<HTMLDivElement | null>;
  mediaType: "image" | "video";
  imageCount: number;
  isGif: boolean;
  busy: boolean;
  onOpen: (operation: CanvasMediaToolbarAction, grid?: MediaGridSize) => void;
  onGroup?: () => void;
  onUngroup?: () => void;
}) {
  const { y, zoom } = useViewport();
  const toolbar = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(180);
  const [formOffset, setFormOffset] = useState(0);
  useLayoutEffect(() => {
    const canvas = canvasElement.current;
    if (!canvas) return;
    let observed: Element[] = [];
    const observer = new ResizeObserver(measure);
    function measure(): void {
      const root = [...canvas!.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")].find((element) => element.dataset.id === node.id);
      const form = node.data.panelOpen ? root?.querySelector<HTMLElement>(".canvas-node-auxiliary") : undefined;
      const targets = [toolbar.current, root, form].filter((element): element is HTMLElement => Boolean(element));
      if (targets.length !== observed.length || targets.some((element, index) => element !== observed[index])) {
        observer.disconnect();
        targets.forEach((element) => observer.observe(element));
        observed = targets;
      }
      const height = toolbar.current?.getBoundingClientRect().height ?? 0;
      if (height > 0) setToolbarHeight(height);
      // The form sits outside the measured node frame; NodeToolbar cannot account for it.
      setFormOffset(form && root ? Math.max(0, form.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom) : 0);
    }
    // React Flow may mount the selected node's form after this overlay's layout effect.
    const mutations = new MutationObserver(measure);
    mutations.observe(canvas, { childList: true, subtree: true });
    measure();
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, [canvasElement, node.id, node.data.panelOpen, node.measured?.width, node.measured?.height, zoom]);
  const screenTop = y + canvasAbsolutePosition(node, nodes).y * zoom;
  const below = screenTop < toolbarHeight + 20;
  return <NodeToolbar nodeId={node.id} isVisible position={below ? Position.Bottom : Position.Top} offset={10 + (below ? formOffset : 0)} className="asset-media-toolbar-panel nodrag nopan nowheel">
    <div ref={toolbar}><MediaCanvasToolbar key={node.id} mediaType={mediaType} imageCount={imageCount} isGif={isGif} busy={busy} menuBelow={below || screenTop < toolbarHeight + 320} onOpen={onOpen} onGroup={onGroup} onUngroup={onUngroup} /></div>
  </NodeToolbar>;
}

function MediaToolDialog({ operation, assetIds, busy, error, onClose, onSubmit }: {
  operation: DialogMediaOperation;
  assetIds: string[];
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (options: Record<string, unknown>, orderedIds: string[]) => void;
}) {
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [fps, setFps] = useState(operation === "compose-video" ? "12" : "8");
  const [startTime, setStartTime] = useState("0");
  const [duration, setDuration] = useState("");
  const [format, setFormat] = useState(operation === "compose-video" ? "mp4" : "png");
  const [orderedIds, setOrderedIds] = useState(assetIds);
  const [layers, setLayers] = useState<CanvasLayerSetting[]>(() => assetIds.map((assetId) => ({ assetId, x: 0, y: 0, scale: 1, opacity: 1, visible: true })));
  const [selectedFrames, setSelectedFrames] = useState<number[]>([]);
  const [videoPreviewUnavailable, setVideoPreviewUnavailable] = useState(false);
  const [showVideoRange, setShowVideoRange] = useState(false);
  const [showFrameSelection, setShowFrameSelection] = useState(false);
  const needsPreview = operation === "compose-image-layers" || operation === "video-frame-strip";
  const sourcePreview = useWorkspaceAssetUrl(undefined, "", 0, needsPreview ? assetIds[0] : undefined);
  const title = t(`assetCanvas.mediaTools.${operation}`);
  const field = (label: string, value: string, setValue: (value: string) => void, props: { min?: number; max?: number; step?: number; required?: boolean } = {}) => (
    <label><span>{label}</span><input type="number" required={props.required} value={value} min={props.min} max={props.max} step={props.step ?? 1} onChange={(event) => setValue(event.target.value)} /></label>
  );
  function submit(event: FormEvent): void {
    event.preventDefault();
    const value: Record<string, unknown> = {};
    const number = (raw: string): number | undefined => raw.trim() ? Number(raw) : undefined;
    if (operation === "compose-image-layers") { value.width = Number(width); value.height = Number(height); value.layers = layers.map(({ x, y, scale, opacity, visible }) => ({ x, y, scale, opacity, visible })); }
    if (operation === "video-frame-strip") {
      value.fps = number(fps);
      value.startTime = showVideoRange ? number(startTime) : 0;
      value.duration = showVideoRange ? number(duration) : undefined;
      value.format = format;
      if (showFrameSelection && !videoPreviewUnavailable) value.selectedFrames = selectedFrames;
    }
    if (operation === "compose-video") { value.fps = number(fps); value.format = format; }
    if (operation === "compose-gif") value.fps = number(fps);
    onSubmit(value, operation === "compose-image-layers" ? layers.map((layer) => layer.assetId) : orderedIds);
  }
  return <div className="asset-media-tool-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className={`asset-media-tool-dialog${operation === "compose-image-layers" || operation === "video-frame-strip" ? " is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
      <header><div><small>{t("assetCanvas.mediaTools.title")}</small><h2>{title}</h2></div><button type="button" aria-label={t("common.close")} onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <div className="asset-media-tool-body">
      {operation === "compose-image-layers" ? <p className="asset-media-tool-input-count">{t("assetCanvas.mediaTools.inputCount", { count: assetIds.length })}</p> : null}
      {operation === "compose-gif" || operation === "compose-video" ? <>
        <div className="asset-media-frame-heading"><strong>{t("assetCanvas.mediaTools.frameOrder")}</strong><span>{t("assetCanvas.mediaTools.inputCount", { count: assetIds.length })}</span></div>
        <ol className="asset-media-frame-order">{orderedIds.map((id, index) => <MediaToolFrame key={`${id}-${index}`} assetId={id} index={index} count={orderedIds.length} busy={busy} onMove={(delta) => setOrderedIds((current) => { const next = [...current]; const target = index + delta; [next[index], next[target]] = [next[target]!, next[index]!]; return next; })} />)}</ol>
      </> : null}
      {operation === "compose-image-layers" ? <>
        <div className="asset-media-tool-grid">{field(t("assetCanvas.mediaTools.width"), width, setWidth, { min: 1, max: 16384, required: true })}{field(t("assetCanvas.mediaTools.height"), height, setHeight, { min: 1, max: 16384, required: true })}</div>
        <CanvasAssetRecovery preview={sourcePreview} />
        <CanvasLayerEditor layers={layers} onChange={setLayers} width={Number(width)} height={Number(height)} disabled={busy} onFirstSize={(imageWidth, imageHeight) => { setWidth((current) => current || String(imageWidth)); setHeight((current) => current || String(imageHeight)); }} />
      </> : null}
      {operation === "compose-gif" ? field(t("assetCanvas.mediaTools.fps"), fps, setFps, { min: 0.1, max: 120, step: 0.1 }) : null}
      {operation === "video-frame-strip" ? <>
        <CanvasAssetRecovery preview={sourcePreview} />
        <CanvasVideoFrameEditor
          url={sourcePreview.url}
          fps={Number(fps)}
          startTime={showVideoRange ? Number(startTime) : 0}
          duration={showVideoRange && duration ? Number(duration) : undefined}
          selected={selectedFrames}
          showSelection={showFrameSelection}
          toolbar={
            <div className="asset-video-frame-controls">
              <div className="asset-media-tool-compact-settings">
                <label className="asset-media-tool-compact-field">
                  <span>{t("assetCanvas.mediaTools.fps")}</span>
                  <input type="number" required value={fps} min={0.1} max={120} step={0.1} onChange={(event) => setFps(event.target.value)} />
                </label>
                <label className="asset-media-tool-compact-field asset-media-tool-format-field">
                  <span>{t("assetCanvas.mediaTools.format")}</span>
                  <select value={format} onChange={(event) => setFormat(event.target.value)}>
                    <option value="png">PNG</option>
                    <option value="jpg">JPEG</option>
                  </select>
                </label>
              </div>
              <div className="asset-media-tool-setting">
                <div className="asset-media-tool-setting-heading">
                  <strong>{t("assetCanvas.mediaTools.range")}</strong>
                  <span>{t(showVideoRange ? "assetCanvas.mediaTools.rangeCustomHint" : "assetCanvas.mediaTools.rangeAllHint")}</span>
                </div>
                <div className="asset-media-tool-range-row">
                  <div className="asset-media-tool-segmented" role="radiogroup" aria-label={t("assetCanvas.mediaTools.range")}>
                    <label className={!showVideoRange ? "is-active" : undefined}>
                      <input type="radio" name="video-range" value="all" checked={!showVideoRange} onChange={() => setShowVideoRange(false)} disabled={busy} />
                      <span>{t("assetCanvas.mediaTools.rangeAll")}</span>
                    </label>
                    <label className={showVideoRange ? "is-active" : undefined}>
                      <input type="radio" name="video-range" value="custom" checked={showVideoRange} onChange={() => setShowVideoRange(true)} disabled={busy} />
                      <span>{t("assetCanvas.mediaTools.rangeCustom")}</span>
                    </label>
                  </div>
                  {showVideoRange ? <div className="asset-media-tool-grid asset-media-tool-range-fields">
                    {field(t("assetCanvas.mediaTools.start"), startTime, setStartTime, { min: 0, step: 0.1 })}
                    {field(t("assetCanvas.mediaTools.duration"), duration, setDuration, { min: 0.01, max: 300, step: 0.1, required: true })}
                  </div> : null}
                </div>
              </div>
            </div>
          }
          selectionToolbar={
            <div className="asset-media-tool-setting asset-media-tool-frame-mode">
              <div className="asset-media-tool-setting-heading">
                <strong>{t("assetCanvas.mediaTools.frameSelection")}</strong>
                <span>{t(showFrameSelection ? "assetCanvas.mediaTools.frameModeSelectedHint" : "assetCanvas.mediaTools.frameModeAllHint")}</span>
              </div>
              <div className="asset-media-tool-segmented" role="radiogroup" aria-label={t("assetCanvas.mediaTools.frameSelection")}>
                <label className={!showFrameSelection ? "is-active" : undefined}>
                  <input type="radio" name="frame-mode" value="all" checked={!showFrameSelection} onChange={() => setShowFrameSelection(false)} disabled={busy} />
                  <span>{t("assetCanvas.mediaTools.frameModeAll")}</span>
                </label>
                <label className={showFrameSelection ? "is-active" : undefined}>
                  <input type="radio" name="frame-mode" value="selected" checked={showFrameSelection} onChange={() => setShowFrameSelection(true)} disabled={busy} />
                  <span>{t("assetCanvas.mediaTools.frameModeSelected")}</span>
                </label>
              </div>
            </div>
          }
          onSelected={setSelectedFrames}
          onPreviewUnavailable={setVideoPreviewUnavailable}
          disabled={busy}
        />
        {videoPreviewUnavailable ? <p className="asset-media-tool-hint">{t("assetCanvas.mediaTools.videoPreviewUnavailable")}</p> : null}
      </> : null}
      {operation === "compose-video" ? <div className="asset-media-tool-grid">
        {field(t("assetCanvas.mediaTools.fps"), fps, setFps, { min: 0.1, max: 120, step: 0.1 })}
      </div> : null}
      {operation === "compose-video" ? <label><span>{t("assetCanvas.mediaTools.format")}</span><select value={format} onChange={(event) => setFormat(event.target.value)}><option value="mp4">MP4</option></select></label> : null}
      {error ? <p className="asset-media-tool-error" role="alert">{error}</p> : null}
      </div>
      <footer><button type="button" className="asset-media-tool-cancel" onClick={onClose} disabled={busy}>{t("common.cancel")}</button><button type="submit" className="asset-media-tool-submit" disabled={busy || (operation === "video-frame-strip" && showFrameSelection && !videoPreviewUnavailable && !selectedFrames.length) || (operation === "compose-image-layers" && (!width || !height || layers.every((layer) => !layer.visible)))}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t(busy ? "assetCanvas.mediaTools.running" : "assetCanvas.mediaTools.run")}</button></footer>
    </form>
  </div>;
}

function MediaToolFrame({ assetId, index, count, busy, onMove }: { assetId: string; index: number; count: number; busy: boolean; onMove: (delta: number) => void }) {
  const source = useWorkspaceAssetUrl(undefined, "", 0, assetId);
  return <li className="asset-media-frame-item">
    <div className="asset-media-frame-thumb">
      {source.url ? <img src={source.url} alt="" /> : <ImageIcon size={20} aria-hidden="true" />}
      <span className="asset-media-frame-index">{String(index + 1).padStart(2, "0")}</span>
    </div>
    <div className="asset-media-frame-actions">
      <button type="button" disabled={busy || index === 0} title={t("assetCanvas.mediaTools.moveEarlier")} aria-label={t("assetCanvas.mediaTools.moveEarlier")} onClick={() => onMove(-1)}><ArrowLeft size={14} /></button>
      <button type="button" disabled={busy || index === count - 1} title={t("assetCanvas.mediaTools.moveLater")} aria-label={t("assetCanvas.mediaTools.moveLater")} onClick={() => onMove(1)}><ArrowRight size={14} /></button>
    </div>
  </li>;
}

/** Generated nodes from pixel templates show a bundled example until they have their own output. */
function hasExampleOutput(node: AssetCanvasFlowNode): boolean {
  return node.type === "image" && !node.data.sourceInput && Boolean(pixelExampleImageUrl(node.data.exampleImage));
}
function AssetCanvasAddControl({
  project,
  documents,
  tables,
  libraryAssets,
  importing,
  onAdd,
  onAddPixelPreset,
  onAddAsset,
  onUpload,
}: {
  project: Pick<ProjectState, "id" | "name" | "type">;
  documents: CanvasDocuments;
  tables: CanvasTables;
  libraryAssets: LibraryAsset[];
  importing: boolean;
  onAdd: (type: Exclude<AssetCanvasNodeType, "asset">, position: { x: number; y: number }, documentId?: string) => void;
  onAddPixelPreset: (preset: PixelAssetPresetId, level: PixelArtLevel, position: { x: number; y: number }) => void;
  onAddAsset: (asset: LibraryAsset, position: { x: number; y: number }) => void;
  onUpload: (files: File[], position: { x: number; y: number }) => void;
}) {
  const creationGroups = canvasCreationGroups(documents, tables);
  const [addOpen, setAddOpen] = useState(false);
  const [openCreationBranch, setOpenCreationBranch] = useState<OpenCanvasNodeCreationBranch>();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [pixelPresetsOpen, setPixelPresetsOpen] = useState(false);
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
                  ><Icon size={15} /><span><strong>{item.label}</strong>{item.description ? <small>{item.description}</small> : null}</span><ChevronRight className="story-add-node-submenu-arrow" size={13} /></button>;
                  return <button type="button" role="menuitem" key={item.label} onPointerEnter={() => setOpenCreationBranch(undefined)} onClick={() => addItem(item)}><Icon size={15} /><span><strong>{item.label}</strong>{item.description ? <small>{item.description}</small> : null}</span></button>;
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
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            const position = placementPosition();
            if (files.length && position) onUpload(files, position);
            setAddOpen(false);
          }}
        />
        <button className={addOpen ? "is-active" : undefined} type="button" data-tooltip={t("assetCanvas.addNode")} aria-label={t("assetCanvas.addNode")} aria-expanded={addOpen} onClick={() => { setOpenCreationBranch(undefined); setAddOpen((open) => !open); }}>
          <Plus size={18} />
        </button>
      </div>
      <button type="button" data-tooltip={t("assetCanvas.pixelPresets.open")} aria-label={t("assetCanvas.pixelPresets.open")} onClick={() => setPixelPresetsOpen(true)}>
        <Gameboy size={18} />
      </button>
      {libraryOpen ? <LibraryAssetPicker title={t("assetCanvas.addFromLibrary")} projectId={project.id} project={project} assets={libraryAssets} onClose={() => setLibraryOpen(false)} onSelect={(asset) => {
        const position = placementPosition();
        if (position) onAddAsset(asset, position);
        setLibraryOpen(false);
      }} /> : null}
      {pixelPresetsOpen ? <AssetCanvasPixelPresetDialog
        onClose={() => setPixelPresetsOpen(false)}
        onSelect={(preset, level) => {
          const position = placementPosition();
          if (position) onAddPixelPreset(preset, level, position);
          setPixelPresetsOpen(false);
        }}
      /> : null}
  </>;
}

interface ViewableCanvasAsset {
  /** The node the viewer was opened from. */
  nodeId: string;
  assetId: string;
  mediaType: Exclude<AssetMediaType, "audio">;
}

function viewableCanvasAsset(node: AssetCanvasFlowNode): ViewableCanvasAsset | undefined {
  const assetId = node.data.assetId;
  if (!assetId) return undefined;
  const nodeId = node.id;
  if (node.type === "image") return { nodeId, assetId, mediaType: "image" };
  if (node.type === "video") return { nodeId, assetId, mediaType: "video" };
  if (node.type === "model-3d" || node.type === "animate-3d") return { nodeId, assetId, mediaType: "model" };
  const mediaType = node.data.mediaType;
  return node.type === "asset" && mediaType && mediaType !== "audio" ? { nodeId, assetId, mediaType } : undefined;
}

function eventWithin(event: { target: EventTarget | null }, selector: string): boolean {
  return event.target instanceof Element && Boolean(event.target.closest(selector));
}

function CanvasAssetViewer({ asset, name, onDownload, onSendToProject, onClose, trimmer }: {
  asset: ViewableCanvasAsset;
  name: string;
  onDownload: (name: string) => void;
  onSendToProject: (name: string) => void;
  onClose: () => void;
  /** Shows a video with handles to trim it, saving the kept part as a new video. */
  trimmer?: { loadSource: () => Promise<Blob>; onSave: (video: Blob, trim: VideoTrim) => Promise<void> };
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
        ? trimmer && asset.mediaType === "video"
          ? <VideoTrimmer key={asset.assetId} url={preview.url} label={name} loadSource={trimmer.loadSource} onSave={trimmer.onSave} />
          : <AssetMedia type={asset.mediaType} url={preview.url} label={name} />
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
  canUngroup,
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
  onUngroup,
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
  canUngroup: boolean;
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
  onUpload: (files: File[]) => void;
  onView: () => void;
  onDownload: () => void;
  onSendToProject: () => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onUngroup: () => void;
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
      {canUngroup ? <button type="button" role="menuitem" onClick={() => run(onUngroup)}><Layers3 size={15} /><span>{t("assetCanvas.ungroup")}</span></button> : null}
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
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length) onUpload(files);
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

function toFlowNode(node: AssetCanvasNode, imageModels: ImageModel[], videoModels: VideoModel[], previous?: AssetCanvasFlowNode): AssetCanvasFlowNode {
  // Clearing measured on a mounted node also clears React Flow's handle bounds.
  // Keep them across document updates; ResizeObserver handles actual size changes.
  const measured = previous?.id === node.id && previous.type === node.type ? previous.measured : undefined;
  return { ...flowNodeData(node, imageModels, videoModels), ...(node.parentId ? { parentId: node.parentId } : {}), ...(measured ? { measured } : {}), ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}), ...(node.title !== undefined ? { title: node.title } : {}), ...(node.description !== undefined ? { description: node.description } : {}) };
}
function flowNodeData(node: AssetCanvasNode, imageModels: ImageModel[], videoModels: VideoModel[]): AssetCanvasFlowNode {
  if (node.type === "group") return { id: node.id, type: "group", position: node.position, data: { name: node.data.name, ...(node.data.pixelStyle ? { pixelStyle: node.data.pixelStyle } : {}) }, width: node.width, height: node.height, deletable: true };
  if (node.type === "asset" || node.type === "file") return { ...node, deletable: true };
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
  if (node.type === "audio-scene") return { id: node.id, type: "audio-scene", position: node.position, data: {
    ...audioCanvasSettings(node.data), prompt: node.data.prompt ?? "", ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
    ...(node.data.model ? { audioModel: node.data.model } : {}), ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}), ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
  } };
  if (node.type === "speech") return {
    id: node.id,
    type: "speech",
    position: node.position,
    deletable: true,
    data: {
      ...audioCanvasSettings(node.data),
      text: node.data.text,
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { audioModel: node.data.model } : {}),
      ...(node.data.voiceId ? { voiceId: node.data.voiceId } : {}),
      ...(node.data.speed !== undefined ? { speed: node.data.speed } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "sound-effect") return {
    id: node.id,
    type: "sound-effect",
    position: node.position,
    deletable: true,
    data: {
      ...audioCanvasSettings(node.data),
      prompt: node.data.prompt,
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { audioModel: node.data.model } : {}),
      ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
      ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
      ...(node.data.negativePrompt ? { negativePrompt: node.data.negativePrompt } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "music") return {
    id: node.id,
    type: "music",
    position: node.position,
    deletable: true,
    data: {
      ...audioCanvasSettings(node.data),
      prompt: node.data.prompt,
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { audioModel: node.data.model } : {}),
      instrumental: node.data.instrumental,
      ...(node.data.lyrics ? { lyrics: node.data.lyrics } : {}),
      ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
      ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
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
  if (node.type === "model-3d") {
    const modelData = node.data as Extract<AssetCanvasNode, { type: "model-3d" }>["data"];
    return {
    id: node.id,
    type: "model-3d",
    position: node.position,
    deletable: true,
    data: {
      prompt: modelData.prompt ?? "",
      promptSource: modelData.promptSource,
      model3DOperation: modelData.operation,
      model3DSource: modelData.source,
      model3DOptions: modelData.options,
      model3DConfig: normalizeModel3DConfig({
        model: modelData.model,
        targetPolycount: modelData.targetPolycount,
        texture: modelData.texture,
        pbr: modelData.pbr,
      }, undefined, modelData.operation),
      images: modelData.images.slice(0, MODEL_3D_MAX_REFERENCE_IMAGES),
      ...(modelData.assetId ? { assetId: modelData.assetId } : {}),
    },
    };
  }
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
  if (type === "audio-scene") return { id: crypto.randomUUID(), type, position, data: { prompt: "" } };
  if (type === "speech") return { id: crypto.randomUUID(), type, position, data: { text: "" } };
  if (type === "sound-effect") return { id: crypto.randomUUID(), type, position, data: { prompt: "" } };
  if (type === "music") return { id: crypto.randomUUID(), type, position, data: { prompt: "", instrumental: true } };
  if (type === "animate-3d") {
    return { id: crypto.randomUUID(), type, position, data: { images: [], heightMeters: DEFAULT_CHARACTER_HEIGHT_METERS, actionIds: [...DEFAULT_ANIMATION_ACTION_IDS] } };
  }
  const id = crypto.randomUUID();
  return { id, type: "text", position, data: { text: "", instruction: "", ...(defaultTextModel ? { textModel: defaultTextModel } : {}) } };
}

/** The generation settings a node passes on to the next node of its type. */
type NodeGenerationSettings = AudioCanvasSettings & Pick<AssetCanvasFlowData, "textModel" | "reasoningLevel" | "model" | "resolution" | "aspectRatio" | "videoModel" | "videoResolution" | "videoAspectRatio" | "duration" | "audioModel" | "voiceId" | "speed" | "durationSeconds" | "loop" | "instrumental" | "model3DConfig">;
type RememberedSettings = Partial<Record<AssetCanvasNodeType, NodeGenerationSettings>>;

export function nodeGenerationSettings(node: Pick<AssetCanvasFlowNode, "type" | "data">): NodeGenerationSettings | undefined {
  const { data } = node;
  if (node.type === "text") return { ...(data.textModel ? { textModel: { provider: data.textModel.provider, id: data.textModel.id } } : {}), ...(data.reasoningLevel ? { reasoningLevel: data.reasoningLevel } : {}) };
  if (node.type === "image") return { model: data.model, resolution: data.resolution, aspectRatio: data.aspectRatio };
  if (node.type === "video") return { videoModel: data.videoModel, videoResolution: data.videoResolution, videoAspectRatio: data.videoAspectRatio, duration: data.duration };
  if (node.type === "speech") return { ...audioSettings(data), ...(data.audioModel ? { audioModel: { provider: data.audioModel.provider, id: data.audioModel.id } } : {}), ...(data.voiceId ? { voiceId: data.voiceId } : {}), ...(data.speed !== undefined ? { speed: data.speed } : {}) };
  if (node.type === "sound-effect") return { ...audioSettings(data), ...(data.audioModel ? { audioModel: modelRef(data.audioModel) } : {}), ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}), ...(data.loop !== undefined ? { loop: data.loop } : {}) };
  if (node.type === "audio-scene") return { ...(data.audioModel ? { audioModel: modelRef(data.audioModel) } : {}), ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}), ...(data.loop !== undefined ? { loop: data.loop } : {}) };
  if (node.type === "music") return { ...(data.audioModel ? { audioModel: modelRef(data.audioModel) } : {}), ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}), ...(data.loop !== undefined ? { loop: data.loop } : {}), ...(data.instrumental !== undefined ? { instrumental: data.instrumental } : {}) };
  if (node.type === "model-3d") return { model3DConfig: data.model3DConfig };
  return undefined;
}

/** Starts a new node with supported remembered options and configured media defaults. */
export function applyRememberedSettings(
  node: AssetCanvasFlowNode,
  settings: NodeGenerationSettings | undefined,
  catalogs: { imageModels: readonly ImageModel[]; defaultImageModel?: ImageModelRef; videoModels: readonly VideoModel[]; defaultVideoModel?: ModelRef; audioModels?: readonly AudioModel[]; model3DModels?: readonly Model3DModel[]; defaultModel3D?: ModelRef; textModels: readonly AgentModel[] },
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
  if (node.type === "speech" || node.type === "sound-effect" || node.type === "music" || node.type === "audio-scene") {
    const operation = audioOperationForNode(node.type)!;
    const compatibleModels = catalogs.audioModels?.filter((candidate) => candidate.capabilities.operations.includes(operation)) ?? [];
    const reference = settings?.audioModel;
    const model = reference ? compatibleModels.find((candidate) => sameModel(candidate, reference)) : compatibleModels[0];
    return {
      ...node,
      data: {
        ...node.data,
        ...(audioNodeHasSettings(node.type) ? audioSettings(settings ?? {}) : {}),
        ...(model ? { audioModel: { provider: model.provider, id: model.id } } : reference ? { audioModel: reference } : {}),
        ...(settings?.voiceId ? { voiceId: settings.voiceId } : {}),
        ...(settings?.speed !== undefined ? { speed: settings.speed } : {}),
        ...(settings?.durationSeconds !== undefined ? { durationSeconds: settings.durationSeconds } : {}),
        ...(settings?.loop !== undefined ? { loop: settings.loop } : {}),
        ...(settings?.instrumental !== undefined ? { instrumental: settings.instrumental } : {}),
      },
    };
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
    nodes: orderedCanvasNodes(nodes).map((node) => toAssetCanvasNode(node, model3DModels)),
    edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
  };
}

export function toAssetCanvasNode(node: AssetCanvasFlowNode, model3DModels?: readonly Model3DModel[]): AssetCanvasNode {
  return { ...assetCanvasNodeData(node, model3DModels), ...(node.parentId ? { parentId: node.parentId } : {}), ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}), ...(node.title !== undefined ? { title: node.title } : {}), ...(node.description !== undefined ? { description: node.description } : {}) };
}
function assetCanvasNodeData(node: AssetCanvasFlowNode, model3DModels?: readonly Model3DModel[]): AssetCanvasNode {
  if (node.type === "group") return { id: node.id, type: "group", position: node.position, data: { name: node.data.name ?? "Group", ...(node.data.pixelStyle ? { pixelStyle: node.data.pixelStyle } : {}) } };
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
  if (node.type === "file") return { id: node.id, type: "file", position: node.position, data: { path: node.data.path ?? "", ...(node.data.directory ? { directory: true as const } : {}) } };
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
      prompt: node.data.generationMode === "character-asset" ? canvasImagePresetPrompt("character-sheet", node.data.prompt ?? "", "pixel", 1, node.data.pixelStyle ?? "classic")
        : node.data.generationMode === "continuous-actions" ? continuousActionsPrompt(node.data.prompt ?? "", node.data.pixelStyle ?? "classic")
          : node.data.generationMode === "all-actions" ? allActionsPrompt(node.data.prompt ?? "", node.data.pixelStyle ?? "classic") : node.data.prompt ?? "",
      ...(node.data.presetId ? { presetId: node.data.presetId } : {}),
      ...(node.data.promptExpanded || node.data.generationMode ? { promptExpanded: true } : {}),
      ...(node.data.pixelStyle ? { pixelStyle: node.data.pixelStyle } : {}),
      ...(node.data.actionDescription !== undefined ? { actionDescription: node.data.actionDescription } : {}),
      ...(node.data.quickReskinMode ? { quickReskinMode: node.data.quickReskinMode } : {}),
      ...(node.data.materialStyle && node.data.materialStyle !== canvasMaterialStyle(node.data.presetId) ? { materialStyle: node.data.materialStyle } : {}),
      ...(node.data.sourceInput ? { sourceInput: true } : {}),
      ...(node.data.sourceInputLabel ? { sourceInputLabel: node.data.sourceInputLabel } : {}),
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { model: modelRef(node.data.model) } : {}),
      resolution: node.data.resolution ?? DEFAULT_IMAGE_NODE_CONFIG.resolution,
      aspectRatio: node.data.aspectRatio ?? DEFAULT_IMAGE_NODE_CONFIG.aspectRatio,
      images: node.data.images ?? [],
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      ...(node.data.exampleImage ? { exampleImage: node.data.exampleImage } : {}),
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
  if (node.type === "audio-scene") return { id: node.id, type: "audio-scene", position: node.position, data: {
    ...audioCanvasSettings(node.data), prompt: node.data.prompt ?? "", ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
    ...(node.data.audioModel ? { model: node.data.audioModel } : {}), ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}), ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
  } };
  if (node.type === "speech") return {
    id: node.id,
    type: "speech",
    position: node.position,
    data: {
      ...audioCanvasSettings(node.data),
      text: node.data.text ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.audioModel ? { model: modelRef(node.data.audioModel) } : {}),
      ...(node.data.voiceId ? { voiceId: node.data.voiceId } : {}),
      ...(node.data.speed !== undefined ? { speed: node.data.speed } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "sound-effect") return {
    id: node.id,
    type: "sound-effect",
    position: node.position,
    data: {
      ...audioCanvasSettings(node.data),
      prompt: node.data.prompt ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.audioModel ? { model: modelRef(node.data.audioModel) } : {}),
      ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
      ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
      ...(node.data.negativePrompt ? { negativePrompt: node.data.negativePrompt } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "music") return {
    id: node.id,
    type: "music",
    position: node.position,
    data: {
      ...audioCanvasSettings(node.data),
      prompt: node.data.prompt ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.audioModel ? { model: modelRef(node.data.audioModel) } : {}),
      instrumental: node.data.instrumental !== false,
      ...(node.data.lyrics ? { lyrics: node.data.lyrics } : {}),
      ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
      ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
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

/** Direction labels are only shown for protocols that assign meaning to image order. */
export function model3DViewLabels(model?: Model3DModel): string[] {
  return Array.from({ length: model?.maxReferenceImages ?? MODEL_3D_MAX_REFERENCE_IMAGES }, (_, index) =>
    viewLabel(model?.referenceImageLabels?.[index]) ?? t("assetCanvas.referenceNumber", { number: index + 1 }));
}

function viewLabel(label?: string): string | undefined {
  return label === "Front" || label === "Left" || label === "Back" || label === "Right" ? t(`assetCanvas.view.${label}`) : label;
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
  _audioModels: readonly AudioModel[] = [],
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
  if ((source.type === "text" || source.type === "document") && (target.type === "image" || target.type === "video" || target.type === "speech" || target.type === "sound-effect" || target.type === "music" || target.type === "audio-scene" || target.type === "model-3d" && (target.data.model3DOperation === "text" || target.data.model3DOperation === "retexture"))) {
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
              audioReferences: node.data.audioReferences?.filter((reference) => reference.source.type !== "node" || !removedIds.has(reference.source.nodeId)),
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
              audioReferences: node.data.audioReferences?.filter((reference) => reference.source.type !== "node" || !removedIds.has(reference.source.nodeId)),
              references: (node.data.references ?? []).filter((reference) => reference.type !== "node" || !removedIds.has(reference.nodeId)),
              ...(node.data.promptSource && removedIds.has(node.data.promptSource.nodeId) ? { promptSource: undefined } : {}),
            },
          }
      : node.type === "speech" || node.type === "sound-effect" || node.type === "music" || node.type === "audio-scene"
        ? {
            ...node,
            data: {
              ...node.data,
              audioReferences: node.data.audioReferences?.filter((reference) => reference.source.type !== "node" || !removedIds.has(reference.source.nodeId)),
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
