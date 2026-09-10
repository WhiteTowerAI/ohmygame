import {
  ArrowUp,
  ChevronDown,
  CircleStop,
  Clapperboard,
  Download,
  FileText,
  Flag,
  Film,
  Image as ImageIcon,
  GitBranch,
  Hand,
  LoaderCircle,
  Maximize,
  Minus,
  MousePointer2,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from "./icons.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type VideoResolution,
} from "../shared/contracts.js";
import { combineStoryPrompt, replaceOutgoingEdge, resolveStoryImageAssetId, validatePlayableChapter, type StoryPlayIssue } from "../shared/story.js";
import { createLibraryImage, generateStoryText, getLibraryAsset, getStory, listImageModels, runTool, updateStory } from "./api.js";
import { loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { useAgentModels, type AgentModelCatalogStatus } from "./model-selector.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { playtestHash } from "./routes.js";
import "@xyflow/react/dist/style.css";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ASSET_EDGE_PREFIX = "asset:";
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
  assetId?: string;
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

interface ImageNodeRuntime extends MediaNodeRuntime {
  models: ImageModel[];
}

interface VideoNodeRuntime extends MediaNodeRuntime {
  references: VideoReferenceView[];
  uploading: boolean;
  onRemoveImage: (index: number) => void;
  onUploadImages: (files: File[]) => void;
}

interface VideoReferenceView {
  assetId?: string;
  key: string;
  linked: boolean;
  name: string;
}

const STORY_NODE_TYPES: NodeTypes = {
  start: StartNode,
  scene: SceneNode,
  choice: ChoiceNode,
  ending: EndingNode,
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
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
    if (node.type === "video") derived.push(...(node.data.images ?? []).flatMap((image) => image.type === "node" ? [{
      id: assetEdgeId("video", node.id, image.nodeId),
      source: image.nodeId,
      target: node.id,
      sourceHandle: "asset-out",
      targetHandle: "image-in",
      className: "story-asset-edge",
      selected: selectedAssetEdgeId === assetEdgeId("video", node.id, image.nodeId),
      data: { relation: "video-image", referenceId: image.nodeId },
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
          if (relation === "video-image" && node.id === edge.target && node.type === "video") {
            return { ...node, data: { ...node.data, images: (node.data.images ?? []).filter((image) => image.type !== "node" || image.nodeId !== referenceId) } };
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
    if (source?.type === "video" && target?.type === "scene" && connection.sourceHandle === "asset-out" && connection.targetHandle === "video-in") {
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
    if (source?.type === "image" && target?.type === "video" && connection.sourceHandle === "asset-out" && connection.targetHandle === "image-in") {
      setNodes((current) => current.map((node) => node.id === target.id && node.type === "video"
        ? { ...node, data: { ...node.data, images: [...(node.data.images ?? []), { type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if (source?.type === "text" && (target?.type === "image" || target?.type === "video") && connection.sourceHandle === "text-out" && connection.targetHandle === "prompt-in") {
      setNodes((current) => current.map((node) => node.id === target.id
        ? { ...node, data: { ...node.data, promptSource: { type: "node", nodeId: source.id } } }
        : node));
      return;
    }
    if (!source || !target || connection.sourceHandle === "asset-out" || connection.sourceHandle === "text-out" || connection.targetHandle === "video-in" || connection.targetHandle === "image-in" || connection.targetHandle === "prompt-in") return;
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

  function addNode(type: Exclude<StoryNodeType, "start">, position: { x: number; y: number }): void {
    const node = { ...createFlowNode(type, position, imageModels, defaultTextModel), selected: true };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
    setSelectedId(node.id);
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
    await generateMedia(node, "generate-image", {
      prompt,
      imageModel: node.data.model,
      resolution: node.data.resolution ?? "1K",
      aspectRatio: node.data.aspectRatio ?? "1:1",
      outputs: 1,
    }, "Image");
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
      const images = await resolveVideoImages(node);
      await generateMedia(node, "generate-video", {
        prompt,
        ...(images.length ? { images } : {}),
        duration: node.data.duration ?? 6,
        aspectRatio: node.data.videoAspectRatio ?? "adaptive",
        resolution: node.data.videoResolution ?? "720p",
      }, "Video");
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    }
  }

  async function resolveVideoImages(node: StoryFlowNode): Promise<PromptImage[]> {
    if (node.type !== "video" || !activeChapter) return [];
    return Promise.all((node.data.images ?? []).map(async (reference) => {
      const assetId = resolveStoryImageAssetId(activeChapter, reference);
      if (!assetId) throw new Error("Generate every connected image before generating the video.");
      return promptImage(await getLibraryAsset(assetId));
    }));
  }

  async function uploadVideoImages(node: StoryFlowNode, files: File[]): Promise<void> {
    if (node.type !== "video" || files.length === 0 || generatingNodeId || uploadingNodeId) return;
    const available = 9 - (node.data.images?.length ?? 0);
    if (files.length > available) {
      setGenerationError({ nodeId: node.id, message: `Add up to ${available} more ${available === 1 ? "image" : "images"}.` });
      return;
    }
    setUploadingNodeId(node.id);
    setGenerationError(undefined);
    try {
      const images = await Promise.all(files.map(readUploadImage));
      const assets = await Promise.all(images.map(({ name, image }) => createLibraryImage({ name, image })));
      setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "video"
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
    return {
      ...node,
      data: node.type === "image"
        ? { ...node.data, imageRuntime: { ...runtime, models: imageModels } }
        : {
            ...node.data,
            videoRuntime: {
              ...runtime,
              references: videoReferenceViews(node, nodes, libraryAssets),
              uploading: uploadingNodeId === node.id,
              onRemoveImage: (index) => {
                setSelectedAssetEdgeId(undefined);
                setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "video"
                  ? { ...candidate, data: { ...candidate.data, images: (candidate.data.images ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
                  : candidate));
              },
              onUploadImages: (files) => void uploadVideoImages(node, files),
            } satisfies VideoNodeRuntime,
          },
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
                if (source?.type === "video" && target?.type === "scene" && connection.sourceHandle === "asset-out" && connection.targetHandle === "video-in") {
                  return !(target.data.clips ?? []).some((clip) => clip.source.type === "node" && clip.source.nodeId === source.id);
                }
                if (source?.type === "image" && target?.type === "video" && connection.sourceHandle === "asset-out" && connection.targetHandle === "image-in") {
                  return (target.data.images?.length ?? 0) < 9 && !(target.data.images ?? []).some((image) => image.type === "node" && image.nodeId === source.id);
                }
                if (source?.type === "text" && (target?.type === "image" || target?.type === "video") && connection.sourceHandle === "text-out" && connection.targetHandle === "prompt-in") {
                  return target.data.promptSource?.nodeId !== source.id;
                }
                return Boolean(source && target && connection.sourceHandle !== "asset-out" && connection.sourceHandle !== "text-out" && connection.targetHandle !== "video-in" && connection.targetHandle !== "image-in" && connection.targetHandle !== "prompt-in" && source.type !== "ending" && !isInlineNodeType(source.type) && target.type !== "start" && !isInlineNodeType(target.type) && source.id !== target.id);
              }}
              proOptions={{ hideAttribution: true }}
              defaultViewport={{ x: 64, y: 32, zoom: 1 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--interactive-drama-grid)" />
              <ZoomControls />
              <CanvasToolbar
                mode={interactionMode}
                canvas={canvas}
                reserveInspector={inspectorOpen}
                onAdd={addNode}
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
      <Handle type="target" position={Position.Left} />
      <Handle className="story-asset-handle story-scene-video-handle" id="video-in" type="target" position={Position.Top} />
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
    <MediaNodeShell kind="image" selected={selected} assetId={data.assetId} runtime={runtime}>
      <TextReferenceStrip runtime={runtime} />
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
  return (
    <MediaNodeShell kind="video" selected={selected} assetId={data.assetId} inputCount={data.images?.length} runtime={runtime}>
      <VideoReferenceStrip runtime={runtime} />
      <MediaPrompt
        kind="video"
        value={data.prompt ?? ""}
        runtime={runtime}
        onChange={(prompt) => runtime?.onChange({ ...data, videoRuntime: undefined, prompt })}
      />
      {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
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
        <GenerateMediaButton kind="video" assetId={data.assetId} runtime={runtime} disabled={!effectivePrompt(data, runtime).trim()} />
      </div>
    </MediaNodeShell>
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

function VideoReferenceStrip({ runtime }: { runtime?: VideoNodeRuntime }) {
  const input = useRef<HTMLInputElement>(null);
  const references = runtime?.references ?? [];
  return (
    <div className="story-media-references" aria-label="References">
      {runtime?.linkedPrompt !== undefined ? <TextReferenceThumbnail runtime={runtime} /> : null}
      {references.map((reference, index) => (
        <VideoReferenceThumbnail
          key={reference.key}
          reference={reference}
          disabled={runtime?.busy}
          onRemove={() => runtime?.onRemoveImage(index)}
        />
      ))}
      {references.length < 9 ? (
        <>
          <button
            className="story-video-reference-add"
            type="button"
            title="Upload reference images"
            aria-label="Upload reference images"
            disabled={runtime?.busy}
            onClick={() => input.current?.click()}
          >
            {runtime?.uploading ? <LoaderCircle className="spin" size={16} /> : <Plus size={18} />}
          </button>
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              runtime?.onUploadImages(files);
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function TextReferenceStrip({ runtime }: { runtime?: MediaNodeRuntime }) {
  if (runtime?.linkedPrompt === undefined) return null;
  return <div className="story-media-references" aria-label="References"><TextReferenceThumbnail runtime={runtime} /></div>;
}

function TextReferenceThumbnail({ runtime }: { runtime: MediaNodeRuntime }) {
  const text = runtime.linkedPrompt?.trim() ?? "";
  return (
    <div className="story-video-reference story-text-reference is-linked" title={text || "Connected Text node is empty"}>
      <FileText size={19} />
      <span className="story-video-reference-link" aria-label="Connected Text node" />
      <button type="button" title="Disconnect text" aria-label="Disconnect text" disabled={runtime.busy} onClick={runtime.onDisconnectPrompt}><X size={11} /></button>
    </div>
  );
}

function VideoReferenceThumbnail({ reference, disabled, onRemove }: {
  reference: VideoReferenceView;
  disabled?: boolean;
  onRemove: () => void;
}) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, reference.assetId);
  return (
    <div className={`story-video-reference${reference.linked ? " is-linked" : ""}`} title={reference.name}>
      {preview.url ? <img src={preview.url} alt={reference.name} /> : <ImageIcon size={18} />}
      {reference.linked ? <span className="story-video-reference-link" aria-label="Connected image node" /> : null}
      <button type="button" title={`Remove ${reference.name}`} aria-label={`Remove ${reference.name}`} disabled={disabled} onClick={onRemove}>
        <X size={11} />
      </button>
    </div>
  );
}

function MediaNodeShell({ kind, selected, assetId, inputCount = 0, runtime, children }: {
  kind: "image" | "video";
  selected: boolean;
  assetId?: string;
  inputCount?: number;
  runtime?: MediaNodeRuntime;
  children: React.ReactNode;
}) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, assetId);
  const Icon = kind === "image" ? ImageIcon : Film;
  const label = kind === "image" ? "Image" : "Video";
  return (
    <div className={`story-node story-media-node${selected ? " is-selected" : ""}`}>
      <div className="story-media-node-label"><Icon size={14} /><span>{label}{inputCount ? ` · ${inputCount} ${inputCount === 1 ? "image" : "images"}` : ""}</span></div>
      <div className="story-media-stage">
        {preview.url && kind === "image" ? <img src={preview.url} alt="Generated image" /> : null}
        {preview.url && kind === "video" ? <video className="nodrag nowheel" src={preview.url} controls playsInline preload="metadata" /> : null}
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
      {kind === "video" ? <Handle className="story-asset-handle story-video-image-handle" id="image-in" type="target" position={Position.Top} /> : null}
      <Handle className="story-asset-handle story-media-output-handle" id="asset-out" type="source" position={Position.Right} />
      {selected ? <div className="story-media-composer nodrag nowheel">{children}</div> : null}
    </div>
  );
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
        const sourceNode = reference.type === "node" ? nodes.find((node) => node.id === reference.nodeId && node.type === "video") : undefined;
        const assetId = reference.type === "library" ? reference.assetId : sourceNode?.data.assetId;
        const asset = libraryAssets.find((candidate) => candidate.id === assetId);
        return <StoryClipRow
          key={clip.id}
          name={asset?.name ?? (sourceNode?.data.prompt?.trim() || (sourceNode ? "Video node" : "Missing video"))}
          sourceLabel={clip.source.type === "node" ? (assetId ? "Linked node" : "Waiting for generation") : "Library"}
          index={index}
          count={clips.length}
          onMove={(offset) => move(index, offset)}
          onRemove={() => onChange(clips.filter((candidate) => candidate.id !== clip.id))}
        />;
      })}</div> : <p>No video clips yet</p>}
      <button className="story-clip-add" type="button" onClick={() => setPickerOpen(true)}><Plus size={14} />Add video</button>
      {pickerOpen ? <StoryVideoPicker videos={libraryAssets.filter((asset) => asset.mediaType === "video")} onClose={() => setPickerOpen(false)} onSelect={(assetId) => {
        onChange([...clips, { id: crypto.randomUUID(), source: { type: "library", assetId } }]);
        setPickerOpen(false);
      }} /> : null}
    </section>
  );
}

function StoryVideoPicker({ videos, onClose, onSelect }: {
  videos: LibraryAsset[];
  onClose: () => void;
  onSelect: (assetId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    dialog.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const visibleVideos = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? videos.filter((video) => `${video.name} ${video.prompt ?? ""}`.toLowerCase().includes(normalized))
      : videos;
  }, [query, videos]);

  return createPortal(
    <div className="story-video-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="story-video-picker" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="story-video-picker-title" tabIndex={-1}>
        <header><h2 id="story-video-picker-title">Add video</h2><button type="button" aria-label="Close video picker" onClick={onClose}><X size={16} /></button></header>
        <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Library videos" /></label>
        <div className="story-video-picker-list">
          {visibleVideos.length === 0 ? <p>{videos.length ? "No videos match your search" : "No videos in Library"}</p> : null}
          {visibleVideos.map((video) => {
            return <button type="button" key={video.id} onClick={() => onSelect(video.id)}>
              <span><Film size={17} /></span>
              <span><strong>{video.prompt ?? video.name}</strong><small>{video.name}</small></span>
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
  reserveInspector,
  onAdd,
  onModeChange,
}: {
  mode: InteractionMode;
  canvas: React.RefObject<HTMLDivElement | null>;
  reserveInspector: boolean;
  onAdd: (type: Exclude<StoryNodeType, "start">, position: { x: number; y: number }) => void;
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

  function add(type: Exclude<StoryNodeType, "start">): void {
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds) return;
    const availableWidth = Math.max(0, bounds.width - (reserveInspector ? 300 : 0));
    onAdd(type, screenToFlowPosition({ x: bounds.left + availableWidth / 2, y: bounds.top + bounds.height / 2 }));
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
          </div>
        ) : null}
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
      images: node.data.images,
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

function createFlowNode(type: Exclude<StoryNodeType, "start">, position: { x: number; y: number }, imageModels: ImageModel[], defaultTextModel?: AgentModelRef): StoryFlowNode {
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
      images: [],
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
    version: 2,
    chapters: [{
      ...chapter,
      nodes: nodes.map(toStoryNode),
      edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
    }, ...remainingChapters],
  };
}

function toStoryNode(node: StoryFlowNode): StoryNode {
  if (node.type === "start") return { id: node.id, type: "start", position: node.position, data: {} };
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
      images: node.data.images ?? [],
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

function videoReferenceViews(node: StoryFlowNode, nodes: StoryFlowNode[], libraryAssets: LibraryAsset[]): VideoReferenceView[] {
  if (node.type !== "video") return [];
  return (node.data.images ?? []).map((reference, index) => {
    if (reference.type === "library") {
      const asset = libraryAssets.find((candidate) => candidate.id === reference.assetId);
      return { assetId: reference.assetId, key: `library:${reference.assetId}:${index}`, linked: false, name: asset?.name ?? "Missing image" };
    }
    const source = nodes.find((candidate) => candidate.id === reference.nodeId && candidate.type === "image");
    return {
      ...(source?.data.assetId ? { assetId: source.data.assetId } : {}),
      key: `node:${reference.nodeId}`,
      linked: true,
      name: source?.data.prompt?.trim() || (source ? "Connected image" : "Missing image node"),
    };
  });
}

function preferredImageOption(model?: ImageModel): ImageModel["generationOptions"][number] | undefined {
  return model?.generationOptions.find((option) => option.resolution === "1K" && option.aspectRatio === "1:1")
    ?? model?.generationOptions[0];
}

function isMediaNodeType(type: StoryNodeType): type is "image" | "video" {
  return type === "image" || type === "video";
}

function isInlineNodeType(type: StoryNodeType): type is "text" | "image" | "video" {
  return type === "text" || isMediaNodeType(type);
}

function assetEdgeId(relation: "scene" | "video" | "prompt", targetId: string, referenceId: string): string {
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
      : node.type === "video"
        ? {
            ...node,
            data: {
              ...node.data,
              images: (node.data.images ?? []).filter((image) => image.type !== "node" || !removedIds.has(image.nodeId)),
              ...(node.data.promptSource && removedIds.has(node.data.promptSource.nodeId) ? { promptSource: undefined } : {}),
            },
          }
      : node.type === "image" && node.data.promptSource && removedIds.has(node.data.promptSource.nodeId)
        ? { ...node, data: { ...node.data, promptSource: undefined } }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
