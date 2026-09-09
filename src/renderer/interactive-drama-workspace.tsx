import {
  ArrowUp,
  ChevronDown,
  CircleStop,
  Clapperboard,
  Download,
  Flag,
  Film,
  GitBranch,
  Hand,
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
import type { StoryChapter, StoryChoiceOption, StoryDocument, StoryNode, StoryNodeType, StoryVideoClip } from "../shared/contracts.js";
import { replaceOutgoingEdge, validatePlayableChapter, type StoryPlayIssue } from "../shared/story.js";
import { getStory, updateStory } from "./api.js";
import { loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { playtestHash } from "./routes.js";
import "@xyflow/react/dist/style.css";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
type InteractionMode = "pointer" | "pan";
type StoryFlowData = { title?: string; description?: string; options?: StoryChoiceOption[]; clips?: StoryVideoClip[] };
type StoryFlowNode = Node<StoryFlowData, StoryNodeType>;

const STORY_NODE_TYPES: NodeTypes = {
  start: StartNode,
  scene: SceneNode,
  choice: ChoiceNode,
  ending: EndingNode,
};

export function InteractiveDramaWorkspace({ projectId }: { projectId: string }) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string>();
  const [chapter, setChapter] = useState<{ id: string; title: string }>();
  const [nodes, setNodes] = useState<StoryFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("pointer");
  const [playIssue, setPlayIssue] = useState<StoryPlayIssue>();
  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([]);
  const canvas = useRef<HTMLDivElement>(null);
  const remainingChapters = useRef<StoryChapter[]>([]);
  const latestStory = useRef<StoryDocument | undefined>(undefined);
  const queuedStory = useRef<string | undefined>(undefined);
  const saveChain = useRef(Promise.resolve());

  useEffect(() => {
    let disposed = false;
    setPhase("loading");
    void Promise.all([getStory(projectId), loadLibraryAssets()]).then(([story, assets]) => {
      if (disposed) return;
      const firstChapter = story.chapters[0];
      if (!firstChapter) throw new Error("Story has no chapters");
      setChapter({ id: firstChapter.id, title: firstChapter.title });
      setNodes(firstChapter.nodes.map(toFlowNode));
      setEdges(firstChapter.edges);
      remainingChapters.current = story.chapters.slice(1);
      queuedStory.current = JSON.stringify(story);
      setLibraryAssets(assets);
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
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    setPlayIssue(undefined);
    setEdges((current) => replaceOutgoingEdge(current, {
      id: crypto.randomUUID(),
      source: connection.source!,
      target: connection.target!,
      ...(connection.sourceHandle ? { sourceHandle: connection.sourceHandle } : {}),
    }));
  }, []);

  const selectedNode = nodes.find((node) => node.id === selectedId);
  const activeChapter = document?.chapters[0];

  function addNode(type: Exclude<StoryNodeType, "start">, position: { x: number; y: number }): void {
    const node = createFlowNode(type, position);
    setNodes((current) => [...current, node]);
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
    setNodes((current) => current.filter((node) => node.id !== selectedNode.id));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id));
    setSelectedId(undefined);
  }

  function clearSelection(): void {
    setSelectedId(undefined);
    setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
  }

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
      <div className={`interactive-drama-body${selectedNode ? " has-inspector" : ""}`}>
        <div className="interactive-drama-canvas" ref={canvas}>
          {phase === "loading" ? <div className="story-canvas-state">Loading story...</div> : null}
          {phase === "error" ? <div className="story-canvas-state story-canvas-state-error">{notice}</div> : null}
          {phase === "ready" ? (
            <ReactFlow
              className={`story-canvas story-canvas-${interactionMode}`}
              nodes={nodes}
              edges={edges}
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
              onNodeClick={(_event, node) => setSelectedId(node.id)}
              onPaneClick={clearSelection}
              onNodesDelete={(deleted) => {
                if (deleted.some((node) => node.id === selectedId)) setSelectedId(undefined);
              }}
              isValidConnection={(connection) => {
                const source = nodes.find((node) => node.id === connection.source);
                const target = nodes.find((node) => node.id === connection.target);
                return Boolean(source && target && source.type !== "ending" && target.type !== "start" && source.id !== target.id);
              }}
              proOptions={{ hideAttribution: true }}
              defaultViewport={{ x: 64, y: 32, zoom: 1 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--interactive-drama-grid)" />
              <ZoomControls />
              <CanvasToolbar
                mode={interactionMode}
                canvas={canvas}
                reserveInspector={!selectedNode}
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
        {selectedNode ? (
          <StoryInspector
            libraryAssets={libraryAssets}
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

function StoryNodeHeading({ icon, type, title }: { icon: React.ReactNode; type: string; title: string }) {
  return <div className="story-node-heading"><span>{icon}{type}</span><strong>{title}</strong></div>;
}

function StoryInspector({
  libraryAssets,
  node,
  onChange,
  onClose,
  onDelete,
}: {
  libraryAssets: LibraryAsset[];
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

function StoryClipEditor({ libraryAssets, clips, onChange }: {
  libraryAssets: LibraryAsset[];
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
      {clips.length ? <div className="story-clip-list">{clips.map((clip, index) => (
        <StoryClipRow
          key={clip.id}
          clip={clip}
          asset={libraryAssets.find((asset) => asset.id === clip.assetId)}
          index={index}
          count={clips.length}
          onMove={(offset) => move(index, offset)}
          onRemove={() => onChange(clips.filter((candidate) => candidate.id !== clip.id))}
        />
      ))}</div> : <p>No video clips yet</p>}
      <button className="story-clip-add" type="button" onClick={() => setPickerOpen(true)}><Plus size={14} />Add video</button>
      {pickerOpen ? <StoryVideoPicker videos={libraryAssets.filter((asset) => asset.mediaType === "video")} onClose={() => setPickerOpen(false)} onSelect={(assetId) => {
        onChange([...clips, { id: crypto.randomUUID(), assetId }]);
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

function StoryClipRow({ clip, asset, index, count, onMove, onRemove }: {
  clip: StoryVideoClip;
  asset?: LibraryAsset;
  index: number;
  count: number;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="story-clip-row">
      <div className="story-clip-preview"><Film size={16} /></div>
      <div><strong>{asset?.name ?? "Missing video"}</strong><span>Clip {index + 1}</span></div>
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

function toFlowNode(node: StoryNode): StoryFlowNode {
  return { ...node, deletable: node.type !== "start" };
}

function createFlowNode(type: Exclude<StoryNodeType, "start">, position: { x: number; y: number }): StoryFlowNode {
  const id = crypto.randomUUID();
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
