import {
  ArrowUp,
  ChevronDown,
  CircleStop,
  Clapperboard,
  Download,
  FileText,
  Flag,
  Film,
  Folder,
  Image as ImageIcon,
  GitBranch,
  Hand,
  LoaderCircle,
  Maximize,
  Minus,
  Music2,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "./icons.js";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  Handle,
  Panel,
  Position,
  ReactFlow,
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
} from "@xyflow/react";
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
  type RunImageToolRequest,
  type RunVideoToolRequest,
  type StoryChapter,
  type StoryChoiceOption,
  type StoryDocument,
  type StoryAssetReference,
  type StoryNode,
  type StoryNodeType,
  type StoryTextReference,
  type StoryVideoClip,
  type VideoAspectRatio,
  type VideoGenerationReference,
  type VideoResolution,
} from "../shared/contracts.js";
import { combineStoryPrompt, replaceOutgoingEdge, resolveStoryAssetId, resolveStoryImageAssetId, validatePlayableChapter, type StoryPlayIssue } from "../shared/story.js";
import { createLibraryImage, generateStoryText, getLibraryAsset, getStory, listImageModels, runTool, updateStory, uploadLibraryAsset } from "./api.js";
import { loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { useAgentModels, type AgentModelCatalogStatus } from "./model-selector.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { playtestHash } from "./routes.js";
import { prepareVideoReferenceFile, readMediaFileDuration, validateVideoReferenceCounts, validateVideoReferenceDurations, validVideoReferenceCombination, VIDEO_REFERENCE_ACCEPT, VIDEO_REFERENCE_LIMITS } from "./video-reference-files.js";
import "@xyflow/react/dist/style.css";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ASSET_EDGE_PREFIX = "asset:";
const MEDIA_NODE_MAX_WIDTH = 440;
const MEDIA_NODE_MIN_WIDTH = 300;
const MEDIA_NODE_MAX_HEIGHT = 360;
const MEDIA_NODE_MIN_HEIGHT = 200;
const IMAGE_REFERENCE_LIMIT = 14;
type InteractionMode = "pointer" | "pan";
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
  clips?: StoryVideoClip[];
  imageRuntime?: ImageNodeRuntime;
  videoRuntime?: VideoNodeRuntime;
  textRuntime?: TextNodeRuntime;
};
type StoryFlowNode = Node<StoryFlowData, StoryNodeType>;

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
  start: StartNode,
  scene: SceneNode,
  choice: ChoiceNode,
  ending: EndingNode,
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
  asset: AssetNode,
};

export function InteractiveDramaWorkspace({ projectId }: { projectId: string }) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string>();
  const [chapter, setChapter] = useState<{ id: string; title: string }>();
  const [nodes, setNodes] = useState<StoryFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedAssetEdgeId, setSelectedAssetEdgeId] = useState<string>();
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("pointer");
  const [playIssue, setPlayIssue] = useState<StoryPlayIssue>();
  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([]);
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const textModelCatalog = useAgentModels();
  const defaultTextModel = textModelCatalog.defaultModel ?? textModelCatalog.models[0];
  const [generatingNodeId, setGeneratingNodeId] = useState<string>();
  const [generatingTextNodeId, setGeneratingTextNodeId] = useState<string>();
  const [uploadingNodeId, setUploadingNodeId] = useState<string>();
  const [importingAssets, setImportingAssets] = useState(false);
  const [generationError, setGenerationError] = useState<{ nodeId: string; message: string }>();
  const canvas = useRef<HTMLDivElement>(null);
  const remainingChapters = useRef<StoryChapter[]>([]);
  const latestStory = useRef<StoryDocument | undefined>(undefined);
  const queuedStory = useRef<string | undefined>(undefined);
  const saveChain = useRef(Promise.resolve());

  useEffect(() => {
    let disposed = false;
    setPhase("loading");
    void Promise.all([getStory(projectId), loadLibraryAssets(), listImageModels().catch(() => [])]).then(([story, assets, models]) => {
      if (disposed) return;
      const firstChapter = story.chapters[0];
      if (!firstChapter) throw new Error("Story has no chapters");
      setChapter({ id: firstChapter.id, title: firstChapter.title });
      setNodes(firstChapter.nodes.map((node) => toFlowNode(node, models)));
      setEdges(firstChapter.edges);
      remainingChapters.current = story.chapters.slice(1);
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
  }, [projectId]);

  const document = useMemo(
    () => chapter ? storyDocument(chapter, nodes, edges, remainingChapters.current) : undefined,
    [chapter, nodes, edges],
  );
  latestStory.current = document;

  const assetEdges = useMemo(() => nodes.flatMap((node): Edge[] => {
    const derived: Edge[] = [];
    if (node.type === "scene") derived.push(...(node.data.clips ?? []).flatMap((clip) => clip.source.type === "node" ? [{
      id: assetEdgeId("scene", node.id, clip.id),
      source: clip.source.nodeId,
      target: node.id,
      sourceHandle: "asset-out",
      targetHandle: "video-in",
      className: "story-asset-edge",
      selected: selectedAssetEdgeId === assetEdgeId("scene", node.id, clip.id),
      data: { relation: "scene-clip", referenceId: clip.id },
    }] : []));
    if (node.type === "image") derived.push(...(node.data.images ?? []).flatMap((image) => image.type === "node" ? [{
      id: assetEdgeId("image", node.id, image.nodeId),
      source: image.nodeId,
      target: node.id,
      sourceHandle: "asset-out",
      targetHandle: "image-in",
      className: "story-asset-edge",
      selected: selectedAssetEdgeId === assetEdgeId("image", node.id, image.nodeId),
      data: { relation: "media-image", referenceId: image.nodeId },
    }] : []));
    if (node.type === "video") derived.push(...(node.data.references ?? []).flatMap((reference) => reference.type === "node" ? [{
      id: assetEdgeId("reference", node.id, reference.nodeId),
      source: reference.nodeId,
      target: node.id,
      sourceHandle: "asset-out",
      targetHandle: "reference-in",
      className: "story-asset-edge",
      selected: selectedAssetEdgeId === assetEdgeId("reference", node.id, reference.nodeId),
      data: { relation: "video-reference", referenceId: reference.nodeId },
    }] : []));
    if ((node.type === "image" || node.type === "video") && node.data.promptSource) derived.push({
      id: assetEdgeId("prompt", node.id, node.data.promptSource.nodeId),
      source: node.data.promptSource.nodeId,
      target: node.id,
      sourceHandle: "text-out",
      targetHandle: "prompt-in",
      className: "story-asset-edge",
      selected: selectedAssetEdgeId === assetEdgeId("prompt", node.id, node.data.promptSource.nodeId),
      data: { relation: "media-prompt", referenceId: node.data.promptSource.nodeId },
    });
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
      () => { setNotice(undefined); },
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

  const onNodesChange = useCallback((changes: NodeChange<StoryFlowNode>[]) => {
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
          if (relation === "scene-clip" && node.id === edge.target && node.type === "scene") {
            return { ...node, data: { ...node.data, clips: (node.data.clips ?? []).filter((clip) => clip.id !== referenceId) } };
          }
          if (relation === "media-image" && node.id === edge.target && node.type === "image") {
            return { ...node, data: { ...node.data, images: (node.data.images ?? []).filter((image) => image.type !== "node" || image.nodeId !== referenceId) } };
          }
          if (relation === "video-reference" && node.id === edge.target && node.type === "video") {
            return { ...node, data: { ...node.data, references: (node.data.references ?? []).filter((reference) => reference.type !== "node" || reference.nodeId !== referenceId) } };
          }
          if (relation === "media-prompt" && node.id === edge.target && (node.type === "image" || node.type === "video")) {
            return { ...node, data: { ...node.data, promptSource: undefined } };
          }
          return node;
        }));
        setSelectedAssetEdgeId(undefined);
      }
    }
    const storyChanges = changes.filter((change) => change.type === "add" || !assetEdgeIds.has(change.id));
    if (storyChanges.length) setEdges((current) => applyEdgeChanges(storyChanges, current));
  }

  function onConnect(connection: Connection): void {
    if (!connection.source || !connection.target) return;
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    if (source && isVideoFlowSource(source) && target?.type === "scene" && connection.sourceHandle === "asset-out" && connection.targetHandle === "video-in") {
      setNodes((current) => current.map((node) => node.id === target.id && node.type === "scene"
        ? {
            ...node,
            data: {
              ...node.data,
              clips: [...(node.data.clips ?? []), { id: crypto.randomUUID(), source: { type: "node", nodeId: source.id } }],
            },
          }
        : node));
      return;
    }
    if (source && isSupportedImageReferenceSource(source, libraryAssets) && target?.type === "image" && source.id !== target.id && connection.sourceHandle === "asset-out" && connection.targetHandle === "image-in") {
      setNodes((current) => current.map((node) => node.id === target.id && node.type === "image"
        ? { ...node, data: { ...node.data, images: [...(node.data.images ?? []), { type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    const referenceType = videoReferenceType(source, libraryAssets);
    if (source && referenceType && target?.type === "video" && canAddVideoReference(target, source, nodes, libraryAssets) && connection.sourceHandle === "asset-out" && connection.targetHandle === "reference-in") {
      setNodes((current) => current.map((node) => node.id === target.id && node.type === "video"
        ? { ...node, data: { ...node.data, references: [...(node.data.references ?? []), { type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if (source?.type === "text" && (target?.type === "image" || target?.type === "video") && connection.sourceHandle === "text-out" && connection.targetHandle === "prompt-in") {
      setNodes((current) => current.map((node) => node.id === target.id
        ? { ...node, data: { ...node.data, promptSource: { type: "node", nodeId: source.id } } }
        : node));
      return;
    }
    if (!source || !target || connection.sourceHandle === "asset-out" || connection.sourceHandle === "text-out" || connection.targetHandle === "video-in" || connection.targetHandle === "image-in" || connection.targetHandle === "reference-in" || connection.targetHandle === "prompt-in") return;
    setPlayIssue(undefined);
    setEdges((current) => replaceOutgoingEdge(current, {
      id: crypto.randomUUID(),
      source: connection.source!,
      target: connection.target!,
      ...(connection.sourceHandle ? { sourceHandle: connection.sourceHandle } : {}),
    }));
  }

  const selectedNode = nodes.find((node) => node.id === selectedId);
  const inspectorOpen = Boolean(selectedNode && !isInlineNodeType(selectedNode.type));
  const activeChapter = document?.chapters[0];

  function addNode(type: Exclude<StoryNodeType, "start" | "asset">, position: { x: number; y: number }): void {
    const node = { ...createFlowNode(type, position, imageModels, defaultTextModel), selected: true };
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

  function updateSelected(data: StoryFlowData, removedHandle?: string): void {
    if (!selectedId) return;
    setNodes((current) => current.map((node) => node.id === selectedId ? { ...node, data } : node));
    if (removedHandle) {
      setEdges((current) => current.filter((edge) => edge.source !== selectedId || edge.sourceHandle !== removedHandle));
    }
  }

  function deleteSelected(): void {
    if (!selectedNode || selectedNode.type === "start") return;
    setNodes((current) => removeNodesAndReferences(current, new Set([selectedNode.id])));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id));
    setSelectedId(undefined);
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
      const assetIssue = validatePlayableChapter(activeChapter, new Set(libraryAssets.map((asset) => asset.id)));
      if (assetIssue) {
        setPlayIssue(assetIssue);
        if (assetIssue.nodeId) {
          setSelectedId(assetIssue.nodeId);
          setNodes((current) => current.map((node) => ({ ...node, selected: node.id === assetIssue.nodeId })));
        }
        return;
      }
      await save(document);
      if (window.openGameDesktop) {
        await window.openGameDesktop.openPlaytest(projectId, activeChapter.id);
      } else {
        window.open(new URL(playtestHash(projectId, activeChapter.id), window.location.href).href, "open-game-playtest");
      }
    } catch (error) {
      setPlayIssue({ nodeId: "", message: errorMessage(error) });
    }
  }

  return (
    <section className="viewer-pane interactive-drama-workspace" aria-label="Interactive Drama workspace">
      <header className="interactive-drama-header window-drag-handle">
        <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
        <button className="interactive-drama-chapter" type="button">
          <span>Chapter 1 / {chapter?.title ?? "Untitled"}</span>
          <ChevronDown size={14} />
        </button>
        <div className="interactive-drama-header-actions">
          <button className="interactive-drama-action" type="button" title="Playtest" onClick={() => void startPlaytest()}>
            <Play size={14} fill="currentColor" />
            <span>Playtest</span>
          </button>
          <button className="interactive-drama-action interactive-drama-action-primary" type="button" title="Build game">
            <Download size={14} />
            <span>Build game</span>
          </button>
        </div>
      </header>
      <div className={`interactive-drama-body${inspectorOpen ? " has-inspector" : ""}`}>
        <div className="interactive-drama-canvas" ref={canvas}>
          {phase === "loading" ? <div className="story-canvas-state">Loading story...</div> : null}
          {phase === "error" ? <div className="story-canvas-state story-canvas-state-error">{notice}</div> : null}
          {phase === "ready" ? (
            <ReactFlow
              className={`story-canvas story-canvas-${interactionMode}`}
              nodes={renderedNodes}
              edges={[...edges, ...assetEdges]}
              nodeTypes={STORY_NODE_TYPES}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              nodesDraggable={interactionMode === "pointer"}
              elementsSelectable={interactionMode === "pointer"}
              selectionOnDrag={interactionMode === "pointer"}
              panOnDrag={interactionMode === "pan" ? true : [1, 2]}
              panOnScroll
              zoomOnScroll={false}
              zoomOnPinch
              zoomOnDoubleClick={false}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeClick={(_event, edge) => {
                setSelectedAssetEdgeId(edge.id.startsWith(ASSET_EDGE_PREFIX) ? edge.id : undefined);
                setSelectedId(undefined);
              }}
              onNodeClick={(_event, node) => { setSelectedAssetEdgeId(undefined); setSelectedId(node.id); }}
              onPaneClick={clearSelection}
              onNodesDelete={(deleted) => {
                if (deleted.some((node) => node.id === selectedId)) setSelectedId(undefined);
                setNodes((current) => removeNodesAndReferences(current, new Set(deleted.map((node) => node.id))));
              }}
              isValidConnection={(connection) => {
                const source = nodes.find((node) => node.id === connection.source);
                const target = nodes.find((node) => node.id === connection.target);
                if (source && isVideoFlowSource(source) && target?.type === "scene" && connection.sourceHandle === "asset-out" && connection.targetHandle === "video-in") {
                  return !(target.data.clips ?? []).some((clip) => clip.source.type === "node" && clip.source.nodeId === source.id);
                }
                if (source && isSupportedImageReferenceSource(source, libraryAssets) && target?.type === "image" && connection.sourceHandle === "asset-out" && connection.targetHandle === "image-in") {
                  return source.id !== target.id && (target.data.images?.length ?? 0) < imageReferenceLimit(target, imageModels) &&
                    !(target.data.images ?? []).some((image) => image.type === "node" && image.nodeId === source.id);
                }
                const referenceType = videoReferenceType(source, libraryAssets);
                if (source && referenceType && target?.type === "video" && connection.sourceHandle === "asset-out" && connection.targetHandle === "reference-in") {
                  return canAddVideoReference(target, source, nodes, libraryAssets);
                }
                if (source?.type === "text" && (target?.type === "image" || target?.type === "video") && connection.sourceHandle === "text-out" && connection.targetHandle === "prompt-in") {
                  return target.data.promptSource?.nodeId !== source.id;
                }
                return Boolean(source && target && connection.sourceHandle !== "asset-out" && connection.sourceHandle !== "text-out" && connection.targetHandle !== "video-in" && connection.targetHandle !== "image-in" && connection.targetHandle !== "reference-in" && connection.targetHandle !== "prompt-in" && source.type !== "ending" && !isInlineNodeType(source.type) && target.type !== "start" && !isInlineNodeType(target.type) && source.id !== target.id);
              }}
              proOptions={{ hideAttribution: true }}
              defaultViewport={{ x: 64, y: 32, zoom: 1 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--interactive-drama-grid)" />
              <ZoomControls />
              <CanvasToolbar
                mode={interactionMode}
                canvas={canvas}
                libraryAssets={libraryAssets.filter((asset) => asset.mediaType === "image" || asset.mediaType === "video" || asset.mediaType === "audio")}
                importing={importingAssets}
                reserveInspector={inspectorOpen}
                onAdd={addNode}
                onAddAsset={addAssetNode}
                onUpload={(file, position) => void importAssetFile(file, position)}
                onModeChange={setInteractionMode}
              />
            </ReactFlow>
          ) : null}
          {notice && phase === "ready" ? <div className="story-save-notice" role="alert">{notice}</div> : null}
          {playIssue && phase === "ready" ? (
            <div className="story-play-issue" role="alert">
              <div><strong>Cannot start playtest</strong><span>{playIssue.message}</span></div>
              <button type="button" aria-label="Dismiss playtest issue" onClick={() => setPlayIssue(undefined)}><X size={14} /></button>
            </div>
          ) : null}
        </div>
        {selectedNode && !isInlineNodeType(selectedNode.type) ? (
          <StoryInspector
            libraryAssets={libraryAssets}
            nodes={nodes}
            node={selectedNode}
            onChange={updateSelected}
            onClose={clearSelection}
            onDelete={deleteSelected}
          />
        ) : null}
      </div>
    </section>
  );
}

function StartNode({ selected }: NodeProps<StoryFlowNode>) {
  return (
    <div className={`story-node story-node-start${selected ? " is-selected" : ""}`}>
      <Flag size={15} />
      <span>Start</span>
      <Handle id="out" type="source" position={Position.Right} />
    </div>
  );
}

function SceneNode({ data, selected }: NodeProps<StoryFlowNode>) {
  const clipCount = data.clips?.length ?? 0;
  return (
    <div className={`story-node story-node-scene${selected ? " is-selected" : ""}`}>
      <Handle className="story-scene-flow-handle" type="target" position={Position.Left} />
      <span className="story-port-label story-scene-flow-label">Flow</span>
      <Handle className="story-asset-handle story-scene-video-handle" id="video-in" type="target" position={Position.Left} />
      <span className="story-port-label story-scene-video-label">Videos</span>
      <StoryNodeHeading icon={<Clapperboard size={14} />} type="Scene" title={data.title || "Untitled scene"} />
      <p className={clipCount ? undefined : "is-placeholder"}>{clipCount ? `${clipCount} video ${clipCount === 1 ? "clip" : "clips"}` : "Add video clips"}</p>
      <Handle id="out" type="source" position={Position.Right} />
    </div>
  );
}

function ChoiceNode({ data, selected }: NodeProps<StoryFlowNode>) {
  return (
    <div className={`story-node story-node-choice${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <StoryNodeHeading icon={<GitBranch size={14} />} type="Choice" title={data.title || "Make a choice"} />
      <div className="story-node-options">
        {data.options?.map((option, index) => (
          <div className="story-node-option" key={option.id}>
            <span>{index + 1}</span>
            <p>{option.label || `Option ${index + 1}`}</p>
            <Handle id={option.id} type="source" position={Position.Right} />
          </div>
        ))}
      </div>
    </div>
  );
}

function EndingNode({ data, selected }: NodeProps<StoryFlowNode>) {
  return (
    <div className={`story-node story-node-ending${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <StoryNodeHeading icon={<CircleStop size={14} />} type="Ending" title={data.title || "Untitled ending"} />
      {data.description ? <p>{data.description}</p> : null}
    </div>
  );
}

function TextNode({ data, selected }: NodeProps<StoryFlowNode>) {
  const runtime = data.textRuntime;
  const effectiveModel = data.textModel ?? runtime?.defaultModel;
  const selectedModel = runtime?.models.find((model) => sameAgentModel(model, effectiveModel));
  const modelStateLabel = runtime?.modelStatus === "loading" ? "Loading models..."
    : runtime?.modelStatus === "error" ? "Could not load models"
    : "No language model";
  return (
    <div className={`story-node story-text-node${selected ? " is-selected" : ""}`}>
      <div className="story-text-output">
        <div className="story-media-node-label"><FileText size={14} /><span>Text</span></div>
        <textarea
          className="nodrag nowheel"
          aria-label="Text output"
          rows={5}
          value={data.text ?? ""}
          disabled={runtime?.busy}
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
      <Handle className="story-asset-handle story-text-output-handle" id="text-out" type="source" position={Position.Right} />
    </div>
  );
}

function ImageNode({ data, selected }: NodeProps<StoryFlowNode>) {
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

function VideoNode({ data, selected }: NodeProps<StoryFlowNode>) {
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

function AssetNode({ data, selected }: NodeProps<StoryFlowNode>) {
  const kind = data.mediaType ?? "image";
  const preview = useWorkspaceAssetUrl(undefined, "", 0, kind === "audio" ? undefined : data.assetId);
  const Icon = kind === "video" ? Film : kind === "audio" ? Music2 : ImageIcon;
  const mediaLayout = useMediaNodeLayout(kind === "audio" ? undefined : preview.url);
  const style = kind === "audio" ? { "--story-media-width": "300px", "--story-media-height": "92px" } as CSSProperties : mediaLayout.style;
  return (
    <div className={`story-node story-media-node story-library-asset-node story-library-${kind}-node${selected ? " is-selected" : ""}`} style={style}>
      <div className="story-media-node-label"><Icon size={14} /><span>{data.name || titleCase(kind)}</span><small>Library</small></div>
      <div className="story-media-stage">
        {preview.url && kind === "image" ? <img src={preview.url} alt={data.name || "Library image"} onLoad={mediaLayout.onImageLoad} /> : null}
        {preview.url && kind === "video" ? <CanvasVideo src={preview.url} onLoadedMetadata={mediaLayout.onVideoMetadata} /> : null}
        {kind === "audio" ? <div className="story-audio-asset"><Music2 size={25} /><strong>{preview.error ? "Asset unavailable" : "Audio"}</strong>{data.assetDuration ? <span>{formatMediaTime(data.assetDuration)}</span> : null}</div> : null}
        {!preview.url && kind !== "audio" ? <div className="story-media-empty"><Icon size={34} /><strong>{preview.error ? "Asset unavailable" : "Loading asset..."}</strong></div> : null}
      </div>
      <Handle className="story-asset-handle story-media-output-handle" id="asset-out" type="source" position={Position.Right} />
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
      <div className="story-media-stage">
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
      <Handle className="story-asset-handle story-prompt-input-handle" id="prompt-in" type="target" position={Position.Left} />
      <span className="story-port-label story-prompt-input-label">Prompt</span>
      <Handle className="story-asset-handle story-reference-input-handle" id={kind === "video" ? "reference-in" : "image-in"} type="target" position={Position.Left} />
      <span className="story-port-label story-reference-input-label">References</span>
      <Handle className="story-asset-handle story-media-output-handle" id="asset-out" type="source" position={Position.Right} />
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
      <div className="story-video-controls nodrag nowheel">
        <button type="button" title={playing ? "Pause video" : "Play video"} aria-label={playing ? "Pause video" : "Play video"} onClick={togglePlayback}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <span>{formatMediaTime(currentTime)}</span>
        <input
          type="range"
          aria-label="Video progress"
          min={0}
          max={duration || 0}
          step="0.01"
          value={Math.min(currentTime, duration || 0)}
          disabled={!duration}
          onChange={(event) => {
            const nextTime = Number(event.target.value);
            if (video.current) video.current.currentTime = nextTime;
            setCurrentTime(nextTime);
          }}
        />
        <span>{formatMediaTime(duration)}</span>
      </div>
    </>
  );
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

function StoryInspector({
  libraryAssets,
  nodes,
  node,
  onChange,
  onClose,
  onDelete,
}: {
  libraryAssets: LibraryAsset[];
  nodes: StoryFlowNode[];
  node: StoryFlowNode;
  onChange: (data: StoryFlowData, removedHandle?: string) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const label = node.type[0]?.toUpperCase() + node.type.slice(1);
  return (
    <aside className="story-inspector" aria-label={`${label} inspector`}>
      <header>
        <div><span>{label}</span><strong>{inspectorTitle(node)}</strong></div>
        <button type="button" title="Close inspector" aria-label="Close inspector" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="story-inspector-content">
        {node.type === "start" ? <p className="story-inspector-help">The first node in this chapter. Connect it to the opening scene.</p> : null}
        {node.type === "scene" ? (
          <>
            <InspectorField label="Title">
              <input value={node.data.title ?? ""} onChange={(event) => onChange({ ...node.data, title: event.target.value })} />
            </InspectorField>
            <StoryClipEditor
              libraryAssets={libraryAssets}
              nodes={nodes}
              clips={node.data.clips ?? []}
              onChange={(clips) => onChange({ ...node.data, clips })}
            />
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
                <div key={option.id}>
                  <span>{index + 1}</span>
                  <input
                    aria-label={`Option ${index + 1}`}
                    value={option.label}
                    onChange={(event) => onChange({ ...node.data, options: options.map((current) => current.id === option.id ? { ...current, label: event.target.value } : current) })}
                  />
                  <button
                    type="button"
                    title="Remove option"
                    aria-label={`Remove option ${index + 1}`}
                    disabled={options.length === 1}
                    onClick={() => onChange({ ...node.data, options: options.filter((current) => current.id !== option.id) }, option.id)}
                  ><X size={14} /></button>
                </div>
              ))}
              <button className="story-inspector-add-option" type="button" onClick={() => onChange({
                ...node.data,
                options: [...(node.data.options ?? []), { id: crypto.randomUUID(), label: `Option ${(node.data.options?.length ?? 0) + 1}` }],
              })}><Plus size={14} />Add option</button>
            </div>
          </>
        ) : null}
      </div>
      {node.type !== "start" ? (
        <footer><button type="button" onClick={onDelete}><Trash2 size={14} />Delete node</button></footer>
      ) : null}
    </aside>
  );
}

function StoryClipEditor({ libraryAssets, nodes, clips, onChange }: {
  libraryAssets: LibraryAsset[];
  nodes: StoryFlowNode[];
  clips: StoryVideoClip[];
  onChange: (clips: StoryVideoClip[]) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  function move(index: number, offset: -1 | 1): void {
    const target = index + offset;
    if (target < 0 || target >= clips.length) return;
    const next = [...clips];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <section className="story-inspector-clips">
      <span>Video clips</span>
      {clips.length ? <div className="story-clip-list">{clips.map((clip, index) => {
        const reference = clip.source;
        const sourceNode = reference.type === "node" ? nodes.find((node) => node.id === reference.nodeId && isVideoFlowSource(node)) : undefined;
        const assetId = reference.type === "library" ? reference.assetId : sourceNode?.data.assetId;
        const asset = libraryAssets.find((candidate) => candidate.id === assetId);
        return <StoryClipRow
          key={clip.id}
          name={asset?.name ?? (sourceNode?.type === "video" ? sourceNode.data.prompt?.trim() || "Video node" : sourceNode ? "Library video" : "Missing video")}
          sourceLabel={clip.source.type === "node" ? (assetId ? "Linked node" : "Waiting for generation") : "Library"}
          index={index}
          count={clips.length}
          onMove={(offset) => move(index, offset)}
          onRemove={() => onChange(clips.filter((candidate) => candidate.id !== clip.id))}
        />;
      })}</div> : <p>No video clips yet</p>}
      <button className="story-clip-add" type="button" onClick={() => setPickerOpen(true)}><Plus size={14} />Add video</button>
      {pickerOpen ? <StoryAssetPicker title="Add video" assets={libraryAssets.filter((asset) => asset.mediaType === "video")} onClose={() => setPickerOpen(false)} onSelect={(asset) => {
        const assetId = asset.id;
        onChange([...clips, { id: crypto.randomUUID(), source: { type: "library", assetId } }]);
        setPickerOpen(false);
      }} /> : null}
    </section>
  );
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

function StoryClipRow({ name, sourceLabel, index, count, onMove, onRemove }: {
  name: string;
  sourceLabel: string;
  index: number;
  count: number;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="story-clip-row">
      <div className="story-clip-preview"><Film size={16} /></div>
      <div><strong>{name}</strong><span>{sourceLabel} - Clip {index + 1}</span></div>
      <div className="story-clip-actions">
        <button type="button" title="Move clip up" aria-label={`Move clip ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp size={13} /></button>
        <button type="button" title="Move clip down" aria-label={`Move clip ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}><ChevronDown size={13} /></button>
        <button type="button" title="Remove clip" aria-label={`Remove clip ${index + 1}`} onClick={onRemove}><X size={13} /></button>
      </div>
    </div>
  );
}

function InspectorField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="story-inspector-field"><span>{label}</span>{children}</label>;
}

function CanvasToolbar({
  mode,
  canvas,
  libraryAssets,
  importing,
  reserveInspector,
  onAdd,
  onAddAsset,
  onUpload,
  onModeChange,
}: {
  mode: InteractionMode;
  canvas: React.RefObject<HTMLDivElement | null>;
  libraryAssets: LibraryAsset[];
  importing: boolean;
  reserveInspector: boolean;
  onAdd: (type: Exclude<StoryNodeType, "start" | "asset">, position: { x: number; y: number }) => void;
  onAddAsset: (asset: LibraryAsset, position: { x: number; y: number }) => void;
  onUpload: (file: File, position: { x: number; y: number }) => void;
  onModeChange: (mode: InteractionMode) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
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

  function add(type: Exclude<StoryNodeType, "start" | "asset">): void {
    const position = placementPosition();
    if (!position) return;
    onAdd(type, position);
    setAddOpen(false);
  }

  return (
    <Panel className="story-canvas-toolbar" position="bottom-center">
      <div ref={addMenu} className="story-add-node">
        {addOpen ? (
          <div className="story-add-node-menu">
            <button type="button" onClick={() => add("scene")}><Clapperboard size={15} /><span><strong>Scene</strong><small>Ordered video clips</small></span></button>
            <button type="button" onClick={() => add("text")}><FileText size={15} /><span><strong>Text</strong><small>Write a reusable prompt</small></span></button>
            <button type="button" onClick={() => add("image")}><ImageIcon size={15} /><span><strong>Image</strong><small>Generate an image on canvas</small></span></button>
            <button type="button" onClick={() => add("video")}><Film size={15} /><span><strong>Video</strong><small>Generate a video on canvas</small></span></button>
            <button type="button" onClick={() => add("choice")}><GitBranch size={15} /><span><strong>Choice</strong><small>Branch into player options</small></span></button>
            <button type="button" onClick={() => add("ending")}><CircleStop size={15} /><span><strong>Ending</strong><small>Finish this story path</small></span></button>
            <span className="story-add-node-menu-label">Add media</span>
            <button type="button" disabled={importing} onClick={() => uploadInput.current?.click()}><Upload size={15} /><span><strong>{importing ? "Uploading..." : "Upload"}</strong><small>Add files from this device</small></span></button>
            <button type="button" onClick={() => { setAddOpen(false); setLibraryOpen(true); }}><Folder size={15} /><span><strong>From Library</strong><small>Use an existing asset</small></span></button>
          </div>
        ) : null}
        <input
          ref={uploadInput}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,.mov,.mp3,.wav"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            const position = placementPosition();
            if (file && position) onUpload(file, position);
            setAddOpen(false);
          }}
        />
        <button className={addOpen ? "is-active" : undefined} type="button" title="Add node" aria-label="Add node" aria-expanded={addOpen} onClick={() => setAddOpen((open) => !open)}>
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
  if (node.type === "asset") return { ...node, deletable: true };
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
  if (node.type !== "image" || node.data.model) return { ...node, deletable: node.type !== "start" };
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

function createFlowNode(type: Exclude<StoryNodeType, "start" | "asset">, position: { x: number; y: number }, imageModels: ImageModel[], defaultTextModel?: AgentModelRef): StoryFlowNode {
  const id = crypto.randomUUID();
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
    },
  };
  if (type === "scene") return { id, type, position, data: { title: "Untitled scene", clips: [] } };
  if (type === "image") {
    const model = imageModels[0];
    const option = preferredImageOption(model);
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
  if (type === "video") return {
    id,
    type,
    position,
    data: {
      prompt: "",
      videoModel: VIDEO_MODEL,
      videoResolution: "720p",
      videoAspectRatio: "adaptive",
      duration: 6,
      references: [],
    },
  };
  return { id, type, position, data: { title: "Untitled ending", description: "" } };
}

function storyDocument(
  chapter: { id: string; title: string },
  nodes: StoryFlowNode[],
  edges: Edge[],
  remainingChapters: StoryChapter[],
): StoryDocument {
  return {
    version: 3,
    chapters: [{
      ...chapter,
      nodes: nodes.map(toStoryNode),
      edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
    }, ...remainingChapters],
  };
}

function toStoryNode(node: StoryFlowNode): StoryNode {
  if (node.type === "start") return { id: node.id, type: "start", position: node.position, data: {} };
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
    data: { title: node.data.title ?? "", options: node.data.options ?? [] },
  };
  if (node.type === "scene") return {
    id: node.id,
    type: "scene",
    position: node.position,
    data: { title: node.data.title ?? "", clips: node.data.clips ?? [] },
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
    data: { title: node.data.title ?? "", description: node.data.description ?? "" },
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

function preferredImageOption(model?: ImageModel): ImageModel["generationOptions"][number] | undefined {
  return model?.generationOptions.find((option) => option.resolution === "1K" && option.aspectRatio === "1:1")
    ?? model?.generationOptions[0];
}

function isMediaNodeType(type: StoryNodeType): type is "image" | "video" {
  return type === "image" || type === "video";
}

function isInlineNodeType(type: StoryNodeType): type is "text" | "image" | "video" | "asset" {
  return type === "text" || type === "asset" || isMediaNodeType(type);
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

function assetEdgeId(relation: "scene" | "image" | "reference" | "prompt", targetId: string, referenceId: string): string {
  return `${ASSET_EDGE_PREFIX}${relation}:${targetId}:${referenceId}`;
}

function removeNodesAndReferences(nodes: StoryFlowNode[], removedIds: ReadonlySet<string>): StoryFlowNode[] {
  return nodes
    .filter((node) => !removedIds.has(node.id))
    .map((node) => node.type === "scene"
      ? {
          ...node,
          data: {
            ...node.data,
            clips: (node.data.clips ?? []).filter((clip) => clip.source.type !== "node" || !removedIds.has(clip.source.nodeId)),
          },
        }
      : node.type === "image"
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
      : node);
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
