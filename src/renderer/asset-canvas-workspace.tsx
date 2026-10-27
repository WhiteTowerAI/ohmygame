import { workspaceVersion } from "./workspace-version.js";
import { CanvasTableNode, type CanvasTables } from "./canvas-table-node.js";
import {
  Box,
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
  Pencil,
  Plus,
  Trash2,
  Upload,
  Undo2,
  WandSparkles,
  Redo2,
  Volume2,
  X,
  type IconComponent,
} from "./icons.js";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { CANVAS_GRID_SIZE, snapCanvasPosition } from "./canvas-alignment.js";
import { RESIZABLE_CANVAS_NODE_SIZES, canvasNodeLayout, isResizableCanvasNodeType } from "../shared/canvas-node-layout.js";
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
import { createAssetGenerationNode, isTextGenerationReferenceNode, preferredImageOption, validateAssetCanvasDocument } from "../shared/asset-canvas.js";
import { audioCanvasSettings, audioSettings, isAudioNodeType, type AudioCanvasSettings, type AudioModel, type AudioProviderCatalogStatus } from "../shared/audio.js";
import type { AudioReferenceControls } from "./canvas-audio-controls.js";
import { createLibraryImage, getLibraryAsset, getWorkspaceAsset, getProjectCover, getProjectCoverState, listAudioModelCatalog, listImageModelCatalog, listModel3DOperations, listModel3DCatalog, listVideoModelCatalog, MODELS_CHANGED_EVENT, setProjectCover, uploadLibraryAsset, importCanvasFile, createCanvasImportFolder } from "./api.js";
import { canvasAssetDownloadName, downloadAssetBlob, loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { SendToProjectDialog } from "./send-to-project-dialog.js";
import { useAgentModels } from "./model-selector.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { useCanvasAssetSources, useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { canvasNodeTitle } from "../shared/canvas-assets.js";
import type { CanvasAssetCatalogEntry } from "../shared/canvas-assets.js";
import { prepareVideoReferenceFile, readMediaFileDuration } from "./video-reference-files.js";
import { findAssetCanvasCoverSource, type AssetCanvasCoverSource } from "../shared/asset-canvas-cover.js";
import { LibraryAssetPicker } from "./node-workbench.js";
import { AssetDialogShell, AssetMedia, type AssetMediaType } from "./asset-gallery.js";
import { DEFAULT_IMAGE_NODE_CONFIG, DEFAULT_ANIMATION_ACTION_IDS, DEFAULT_CHARACTER_HEIGHT_METERS, DEFAULT_VIDEO_NODE_CONFIG, MODEL_3D_MAX_REFERENCE_IMAGES, normalizeModel3DConfig } from "../shared/generation-config.js";
import { mergeCanvasDocument } from "../shared/canvas-workspace.js";
import { CanvasDocumentNode, ExpandedCanvasDocument, type CanvasDocuments } from "./canvas-document-node.js";
import { exportCanvasAsset, generateCanvasText } from "./canvas-api.js";
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
import { type AssetCanvasFlowNode, errorMessage, type AssetCanvasFlowData, OUTPUT_HANDLE, titleCase, nodeModel3D, type Animate3DNodeRuntime, type AudioNodeRuntime, type MediaNodeRuntime, type ReferenceMediaNodeRuntime, type ImageNodeRuntime, type VideoNodeRuntime, sameImageModel, sameModel, type MediaReferenceView, nodeModel3DConfig, modelRef } from "./asset-canvas-flow.js";
import { TextNode, ImageNode, VideoNode, SpeechNode, AudioSceneNode, SoundEffectNode, MusicNode, Model3DNode, Animate3DNode, AssetNode, FileNode, canvasHistoryKey, mediaAspectRatio, audioOperationForNode, FolderImportDialog } from "./asset-canvas-nodes.js";
export { canvasHistoryKey } from "./asset-canvas-nodes.js";

const ASSET_EDGE_PREFIX = "asset:";
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
      { label: t("assetCanvas.node.speech"), description: t("assetCanvas.node.speechHint"), icon: Music2, action: { kind: "node", type: "speech" } },
      { label: t("assetCanvas.node.soundEffect"), description: t("assetCanvas.node.soundEffectHint"), icon: Volume2, action: { kind: "node", type: "sound-effect" } },
      { label: t("audioStudio.scene"), icon: Music2, action: { kind: "node", type: "audio-scene" } },
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

const STORY_NODE_TYPES: NodeTypes = {
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
    if (isAudioNodeType(node.type)) for (const reference of node.data.audioReferences ?? []) if (reference.source.type === "node") derived.push({
      id: assetEdgeId("audio", node.id, reference.id), source: reference.source.nodeId, target: node.id, sourceHandle: OUTPUT_HANDLE,
      selected: selectedAssetEdgeId === assetEdgeId("audio", node.id, reference.id), data: { relation: "audio-reference", referenceId: reference.id },
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
    const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
    latestCanvas.current = merged;
    observeHistoryDocument(merged);
    setNodes(merged.nodes.map((node) => ({ ...toFlowNode(node, imageModelsRef.current, videoModelsRef.current, previous.get(node.id)), selected: previous.get(node.id)?.selected === true })));
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
    setNodes((current) => applyNodeChanges(moves, current));
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
          if (relation === "audio-reference" && node.id === edge.target) return { ...node, data: { ...node.data, audioReferences: node.data.audioReferences?.filter((reference) => reference.id !== referenceId) } };
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
    if (relation === "audio-reference") {
      updateAudioReferences(target.id, (data) => { const serial = Math.max(data.audioReferenceSerial ?? 0, ...(data.audioReferences ?? []).map((item) => Number(item.id.replace(/\D/g, "")))) + 1; const type = isImageFlowSource(source) ? "image" as const : "audio" as const; return (data.audioReferences?.length ?? 0) >= 3 ? data : { ...data, audioReferenceSerial: serial, audioReferences: [...data.audioReferences ?? [], { id: `${type === "audio" ? "Audio" : "Image"}${serial}`, type, source: { type: "node", nodeId: source.id } }] }; });
      return;
    }
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
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...copied.nodes.map((node) => ({ ...toFlowNode(node, imageModels, videoModels), selected: true }))]);
    setEdges((current) => [...current, ...copied.edges]);
    setSelectedAssetEdgeId(undefined);
  }

  function startAltDragDuplicate(dragged: readonly AssetCanvasFlowNode[]): void {
    // A rejected copy gesture must not fall back to moving the originals.
    altDragCopies.current = new Map();
    if (nodesRef.current.length + dragged.length > MAX_ASSET_CANVAS_NODES) { setTransferError(t("assetCanvas.nodeLimit")); return; }
    setTransferError(undefined);
    const copies = dragged.map((node) => {
      const source = toAssetCanvasNode(node, model3DModels);
      return { ...toFlowNode(duplicateAssetCanvasNode(source, source.position), imageModels, videoModels), selected: true };
    });
    altDragCopies.current = new Map(dragged.map((node, index) => [node.id, copies[index]!.id]));
    clearSelection();
    setNodes((current) => [...current, ...copies]);
    setMarqueeSelectedIds(new Set(altDragCopies.current.values()));
  }

  function finishAltDragDuplicate(dragged: readonly AssetCanvasFlowNode[]): void {
    const copies = altDragCopies.current;
    altDragCopies.current = undefined;
    if (!copies?.size) return;
    const start = new Map(nodesRef.current.map((node) => [node.id, node.position]));
    if (dragged.some((node) => node.position.x !== start.get(node.id)?.x || node.position.y !== start.get(node.id)?.y)) return;
    const copyIds = new Set(copies.values());
    setNodes((current) => current.flatMap((node) => copyIds.has(node.id) ? [] : [copies.has(node.id) ? { ...node, selected: true } : node]));
    setMarqueeSelectedIds(new Set(copies.keys()));
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
      const result = await generateCanvasText(projectId, instruction, model, reasoningLevel, referenceSource, writeVersion);
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
  function updateAudioReferences(nodeId: string, update: (data: AssetCanvasFlowData) => AssetCanvasFlowData) {
    setNodes((current) => current.map((item) => item.id === nodeId ? { ...item, data: update(item.data) } : item));
  }
  function audioReferenceRuntime(node: AssetCanvasFlowNode): AudioReferenceControls {
    const read = (assetId: string) => { const local = localAssets?.find((asset) => asset.id === assetId); return local ? getWorkspaceAsset(projectId, local.path) : getLibraryAsset(assetId); };
    return {
      choices: libraryAssets.filter((asset) => (asset.mediaType === "image" || asset.mediaType === "audio") && asset.id !== node.data.assetId).map((asset) => ({ id: asset.id, name: asset.name, type: asset.mediaType as "audio" | "image" })),
      references: (node.data.audioReferences ?? []).map((reference) => {
        const source = reference.source.type === "node" ? nodes.find((candidate) => candidate.id === (reference.source.type === "node" ? reference.source.nodeId : "")) : undefined;
        const id = reference.source.type === "library" ? reference.source.assetId : source?.data.assetId;
        return { ...reference, assetId: id, name: libraryAssets.find((asset) => asset.id === id)?.name ?? t("assetCanvas.missingNode") };
      }), read,
      add: (assetId, type) => updateAudioReferences(node.id, (data) => { const serial = Math.max(data.audioReferenceSerial ?? 0, ...(data.audioReferences ?? []).map((item) => Number(item.id.replace(/\D/g, "")))) + 1; return (data.audioReferences?.length ?? 0) >= 3 ? data : { ...data, audioReferenceSerial: serial, audioReferences: [...data.audioReferences ?? [], { id: `${type === "audio" ? "Audio" : "Image"}${serial}`, type, source: { type: "library", assetId } }] }; }),
      remove: (id) => updateAudioReferences(node.id, (data) => ({ ...data, audioReferences: data.audioReferences?.filter((item) => item.id !== id) })),
      move: (id, direction) => updateAudioReferences(node.id, (data) => { const references = [...data.audioReferences ?? []], index = references.findIndex((item) => item.id === id), next = index + direction; if (index >= 0 && next >= 0 && next < references.length) [references[index], references[next]] = [references[next]!, references[index]!]; return { ...data, audioReferences: references }; }),
      replace: (id, assetId) => updateAudioReferences(node.id, (data) => ({ ...data, audioReferences: data.audioReferences?.map((reference) => reference.id === id ? { ...reference, source: { type: "library", assetId } } : reference) })),
      upload: async (file, mediaType, duration, derivedFrom) => {
        let derivation = derivedFrom;
        if (derivation && localAssets?.some((asset) => asset.id === derivation!.assetId)) {
          const source = localAssets.find((asset) => asset.id === derivation!.assetId)!;
          const blob = await read(source.id);
          const imported = await uploadLibraryAsset(new File([blob], source.name, { type: blob.type }), blob.type as LibraryUploadMediaType, undefined, "reference");
          derivation = { ...derivation, assetId: imported.id };
        }
        const uploaded = await uploadLibraryAsset(file, mediaType, duration, "reference", derivation);
        setLibraryAssets((current) => [...current.filter((asset) => asset.id !== uploaded.id), { ...uploaded, assetId: uploaded.id, path: uploaded.name }]);
        return uploaded.id;
      },
    };
  }
  const renderedNodes = nodes.map((original) => {
    const size = isResizableCanvasNodeType(original.type) ? RESIZABLE_CANVAS_NODE_SIZES[original.type] : undefined;
    // A render can arrive before React Flow publishes its first dimensions.
    // An empty measurement keeps it from clearing freshly measured handle bounds.
    const node = { ...original, measured: original.measured ?? {}, ...(size ? { style: { ...original.style, width: original.width ?? size.width, height: original.height ?? size.height } } : {}), data: { ...original.data,
      audioAsset: libraryAssets.find((asset) => asset.id === original.data.assetId)?.audio,
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
            referenceControls: audioReferenceRuntime(node),
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
    const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
    setNodes(next.nodes.map((node) => toFlowNode(node, imageModels, videoModels, previous.get(node.id))));
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
              onNodeDragStop={(_event, _node, dragged) => { finishAltDragDuplicate(dragged); finishHistoryGesture(); }}
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
      {folderPrompt ? createPortal(<FolderImportDialog folders={folderPrompt.folders} onAnswer={folderPrompt.answer} />, window.document.body) : null}
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

function AssetCanvasAddControl({
  project,
  documents,
  tables,
  libraryAssets,
  importing,
  onAdd,
  onAddAsset,
  onUpload,
}: {
  project: Pick<ProjectState, "id" | "name" | "type">;
  documents: CanvasDocuments;
  tables: CanvasTables;
  libraryAssets: LibraryAsset[];
  importing: boolean;
  onAdd: (type: Exclude<AssetCanvasNodeType, "asset">, position: { x: number; y: number }, documentId?: string) => void;
  onAddAsset: (asset: LibraryAsset, position: { x: number; y: number }) => void;
  onUpload: (files: File[], position: { x: number; y: number }) => void;
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
        <button className={addOpen ? "is-active" : undefined} type="button" title={t("assetCanvas.addNode")} aria-label={t("assetCanvas.addNode")} aria-expanded={addOpen} onClick={() => { setOpenCreationBranch(undefined); setAddOpen((open) => !open); }}>
          <Plus size={18} />
        </button>
      </div>
      {libraryOpen ? <LibraryAssetPicker title={t("assetCanvas.addFromLibrary")} projectId={project.id} project={project} assets={libraryAssets} onClose={() => setLibraryOpen(false)} onSelect={(asset) => {
        const position = placementPosition();
        if (position) onAddAsset(asset, position);
        setLibraryOpen(false);
      }} /> : null}
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
  onUpload: (files: File[]) => void;
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
  return { ...flowNodeData(node, imageModels, videoModels), ...(measured ? { measured } : {}), ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}), ...(node.title !== undefined ? { title: node.title } : {}), ...(node.description !== undefined ? { description: node.description } : {}) };
}
function flowNodeData(node: AssetCanvasNode, imageModels: ImageModel[], videoModels: VideoModel[]): AssetCanvasFlowNode {
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
  if (node.type === "sound-effect" || node.type === "audio-scene") return { ...audioSettings(data), ...(data.audioModel ? { audioModel: modelRef(data.audioModel) } : {}), ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}), ...(data.loop !== undefined ? { loop: data.loop } : {}) };
  if (node.type === "music") return { ...audioSettings(data), ...(data.audioModel ? { audioModel: modelRef(data.audioModel) } : {}), ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}), ...(data.loop !== undefined ? { loop: data.loop } : {}), ...(data.instrumental !== undefined ? { instrumental: data.instrumental } : {}) };
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
        ...audioSettings(settings ?? {}),
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

type ConnectionRelation = "image-reference" | "video-reference" | "model-reference" | "prompt" | "text-reference" | "audio-reference";

export function connectionRelation(
  source: AssetCanvasFlowNode,
  target: AssetCanvasFlowNode,
  _sourceHandle: string | null | undefined,
  nodes: AssetCanvasFlowNode[],
  libraryAssets: LibraryAsset[],
  imageModels: ImageModel[],
  model3DModels: readonly Model3DModel[] = [],
  audioModels: readonly AudioModel[] = [],
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
  if (isAudioNodeType(target.type) && source.data.assetId) {
    const image = isSupportedImageReferenceSource(source, libraryAssets), audio = isAudioNodeType(source.type) || source.type === "asset" && source.data.mediaType === "audio";
    const model = audioModels.find((model) => sameModel(model, target.data.audioModel));
    const references = target.data.audioReferences ?? [];
    const type = image ? "image" : "audio";
    const limit = image ? model?.capabilities.maxReferenceImages ?? 0 : model?.capabilities.maxReferenceAudio ?? 0;
    // Images stand alone; a Speaker ID takes one of the audio reference slots.
    const exclusive = model?.capabilities.referenceModesExclusive && (image ? target.data.voiceId || references.some((reference) => reference.type === "audio") : references.some((reference) => reference.type === "image"));
    const used = references.filter((reference) => reference.type === type).length + (!image && target.data.voiceId ? 1 : 0);
    if (!exclusive && used < limit && (image && model?.capabilities.supportsReferenceImage || audio && model?.capabilities.supportsReferenceAudio) && !references.some((reference) => reference.source.type === "node" && reference.source.nodeId === source.id)) return "audio-reference";
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

function assetEdgeId(relation: "scene" | "image" | "model" | "reference" | "prompt" | "presentation" | "audio", targetId: string, referenceId: string): string {
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
