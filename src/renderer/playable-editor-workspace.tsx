import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import type { NodeCodebase } from "../shared/playable-codebase.js";
import type { JsonObject, NodeGraph, PlayableNode, NodeSource } from "../shared/playable-nodes.js";
import { deletePlayableSignal, renamePlayableSignal } from "../shared/playable-editor.js";
import type { NodePlayerDefinition } from "../shared/playable-player-protocol.js";
import {
  buildInteractiveDrama,
  getLibraryAsset,
  getNodeCodebase,
  getNodeRuntime,
  getWorkspaceAsset,
  getWorkspaceFile,
  updateNodeCodebase,
} from "./api.js";
import { WorkspaceCodeView } from "./coding-workspace.js";
import { AssetMedia } from "./asset-gallery.js";
import {
  Code2,
  Copy,
  Download,
  FileCode2,
  GitBranch,
  House,
  Layers3,
  LoaderCircle,
  Monitor,
  PanelToggle,
  Play,
  Plus,
  Share2,
  Trash2,
  Wrench,
  X,
} from "./icons.js";
import { loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { NodePlayer } from "./playable-player.js";
import { playtestHash } from "./routes.js";
import { PublishDialog, type PublishDetails } from "./publish-dialog.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import "@xyflow/react/dist/style.css";

type EditorView = "flow" | "state" | "assets" | "shell" | "destinations" | "code";
type SourceKind = keyof NodeSource;
type PlayableFlowData = Record<string, unknown> & {
  node: PlayableNode;
  entry: boolean;
  destinations: string[];
};
type PlayableFlowNode = Node<PlayableFlowData, "playable">;

const SOURCE_KINDS: SourceKind[] = ["html", "css", "javascript"];
const SOURCE_LABELS: Record<SourceKind, string> = { html: "HTML", css: "CSS", javascript: "JavaScript" };
const FLOW_NODE_TYPES: NodeTypes = { playable: PlayableNodeCard };
const DEFAULT_HTML = "<main><h1>New Node</h1></main>\n";
const DEFAULT_CSS = ":host { display: block; width: 100%; height: 100%; }\nmain { display: grid; width: 100%; height: 100%; place-items: center; }\n";
const DEFAULT_JS = "export function mount() {}\n";

export function PlayableEditorWorkspace({
  project,
  agentBusy,
  publishing,
  workspaceRevision = 0,
  openFileRequest,
  onPublish,
  chatOnRight = false,
  chatCollapsed = false,
  onHome,
  onToggleChat,
}: {
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
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [codebase, setCodebase] = useState<NodeCodebase>();
  const [view, setView] = useState<EditorView>("flow");
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [sourceKind, setSourceKind] = useState<SourceKind>("html");
  const [sources, setSources] = useState<Record<string, string>>({});
  const [dirtySources, setDirtySources] = useState<Set<string>>(() => new Set());
  const [sourceDeletions, setSourceDeletions] = useState<Set<string>>(() => new Set());
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([]);
  const [preview, setPreview] = useState<{ definition: NodePlayerDefinition; assets: Record<string, Blob> }>();
  const [codebaseGeneration, setCodebaseGeneration] = useState(0);
  const editVersionRef = useRef(0);
  const dirtyRef = useRef(false);
  const persistedSourcePathsRef = useRef<Set<string>>(new Set());
  const loadRequestRef = useRef(0);
  const observedWorkspaceRef = useRef({ projectId: project.id, revision: workspaceRevision });

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setPhase("loading");
    setError(undefined);
    try {
      const [next, assets] = await Promise.all([getNodeCodebase(project.id), loadLibraryAssets()]);
      if (request !== loadRequestRef.current) return;
      setCodebase(next);
      setLibraryAssets(assets);
      setView(next.editorLayout.view === "code" ? "code" : "flow");
      setSelectedNodeId((current) => current && next.graph.nodes.some((node) => node.id === current) ? current : undefined);
      setSources({});
      setDirtySources(new Set());
      setSourceDeletions(new Set());
      setDirty(false);
      dirtyRef.current = false;
      setExternalChange(false);
      persistedSourcePathsRef.current = declaredSourcePaths(next.graph);
      editVersionRef.current = 0;
      setCodebaseGeneration((current) => current + 1);
      setPhase("ready");
    } catch (cause) {
      if (request !== loadRequestRef.current) return;
      setError(errorMessage(cause));
      setPhase("error");
    }
  }, [project.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const observed = observedWorkspaceRef.current;
    if (observed.projectId !== project.id) {
      observedWorkspaceRef.current = { projectId: project.id, revision: workspaceRevision };
      return;
    }
    if (observed.revision === workspaceRevision) return;
    observedWorkspaceRef.current = { projectId: project.id, revision: workspaceRevision };
    if (dirtyRef.current) setExternalChange(true);
    else void load();
  }, [load, project.id, workspaceRevision]);
  useEffect(() => {
    if (!openFileRequest) return;
    setView("code");
    setSelectedNodeId(undefined);
  }, [openFileRequest?.id]);

  const graph = codebase?.graph;
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = graph?.edges.find((edge) => edge.id === selectedEdgeId);
  const flowNodes = useMemo(() => codebase ? codebase.graph.nodes.map((node): PlayableFlowNode => ({
    id: node.id,
    type: "playable",
    position: codebase.editorLayout.nodes[node.id] ?? { x: 0, y: 0 },
    initialWidth: 210,
    initialHeight: 82 + Math.max(1, node.signals.length) * 24,
    selected: node.id === selectedNodeId,
    data: {
      node,
      entry: codebase.graph.entryNodeId === node.id,
      destinations: Object.entries(codebase.graph.destinations).flatMap(([name, id]) => id === node.id ? [name] : []),
    },
  })) : [], [codebase, selectedNodeId]);
  const flowEdges = useMemo(() => graph ? graph.edges.map((edge): Edge => ({
    id: edge.id,
    source: edge.source.nodeId,
    sourceHandle: edge.source.signal,
    target: edge.targetNodeId,
    targetHandle: "in",
    selected: edge.id === selectedEdgeId,
    label: edge.mode,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "var(--story-edge-color)", strokeWidth: 1.5 },
    labelStyle: { fill: "var(--text-muted)", fontSize: 9 },
  })) : [], [graph, selectedEdgeId]);

  function updateCodebase(change: (draft: NodeCodebase) => void): void {
    setCodebase((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      change(next);
      return next;
    });
    editVersionRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    setPreview(undefined);
  }

  async function loadSurfaceSources(source: NodeSource): Promise<void> {
    setError(undefined);
    try {
      const loaded = await Promise.all(SOURCE_KINDS.map(async (kind) => {
        const file = source[kind];
        if (sources[file] !== undefined) return [file, sources[file]] as const;
        const content = await getWorkspaceFile(project.id, file);
        if (content.binary || content.truncated || content.content === undefined) throw new Error(`${file} is not editable text.`);
        return [file, content.content] as const;
      }));
      setSources((current) => {
        const next = { ...current };
        for (const [file, content] of loaded) {
          if (next[file] === undefined) next[file] = content;
        }
        return next;
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  useEffect(() => {
    if (selectedNode) void loadSurfaceSources(selectedNode.source);
  }, [selectedNode?.id, codebaseGeneration]);

  async function save(): Promise<boolean> {
    if (!codebase || saving || externalChange) return false;
    const saveVersion = editVersionRef.current;
    const savedSources = new Set(dirtySources);
    const savedDeletions = new Set(sourceDeletions);
    setSaving(true);
    setError(undefined);
    try {
      await updateNodeCodebase(project.id, {
        ...codebase,
        sources: Object.fromEntries([...savedSources].map((file) => [file, sources[file] ?? ""])),
        sourceDeletions: [...savedDeletions],
      });
      setSourceDeletions((current) => new Set([...current].filter((file) => !savedDeletions.has(file))));
      persistedSourcePathsRef.current = declaredSourcePaths(codebase.graph);
      const fullySaved = editVersionRef.current === saveVersion;
      if (fullySaved) {
        setDirty(false);
        dirtyRef.current = false;
        setDirtySources(new Set());
        setSourceDeletions(new Set());
      }
      return fullySaved;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function updateSource(file: string, content: string): void {
    setSources((current) => ({ ...current, [file]: content }));
    setDirtySources((current) => new Set(current).add(file));
    editVersionRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    setPreview(undefined);
  }

  function discardSourceDrafts(source: NodeSource): void {
    const files = new Set(SOURCE_KINDS.map((kind) => source[kind]));
    setDirtySources((current) => new Set([...current].filter((file) => !files.has(file))));
  }

  function deleteUnusedSources(source: NodeSource, nextGraph: NodeGraph): void {
    const stillDeclared = declaredSourcePaths(nextGraph);
    const deleted = SOURCE_KINDS.map((kind) => source[kind]).filter((file) => (
      persistedSourcePathsRef.current.has(file) && !stillDeclared.has(file)
    ));
    if (deleted.length === 0) return;
    setSourceDeletions((current) => new Set([...current, ...deleted]));
    setDirtySources((current) => new Set([...current].filter((file) => !deleted.includes(file))));
  }

  async function startPlaytest(): Promise<void> {
    if (!graph || !await save()) return;
    if (window.ohMyGameDesktop) {
      await window.ohMyGameDesktop.openPlaytest(project.id, graph.entryNodeId, graph.viewport);
    } else {
      window.open(new URL(playtestHash(project.id, graph.entryNodeId), window.location.href).href, "ohmygame-playtest");
    }
  }

  async function previewNode(nodeId: string): Promise<void> {
    if (!await save()) return;
    setError(undefined);
    try {
      const runtime = await getNodeRuntime(project.id);
      const assets = await loadRuntimeAssets(project.id, runtime.definition.graph);
      setPreview({
        definition: { ...runtime.definition, graph: { ...runtime.definition.graph, entryNodeId: nodeId } },
        assets,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function exportGame(): Promise<void> {
    if (building || !await save()) return;
    setBuilding(true);
    setError(undefined);
    try {
      const artifact = await buildInteractiveDrama(project.id);
      const url = URL.createObjectURL(artifact);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.name}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBuilding(false);
    }
  }

  async function publish(details: PublishDetails): Promise<boolean> {
    return await save() && onPublish(details);
  }

  function createNode(): void {
    if (!codebase) return;
    const id = uniqueId("node", new Set(codebase.graph.nodes.map((node) => node.id)));
    const source = nodeSource(id);
    updateCodebase((next) => {
      next.graph.nodes.push({ id, title: "New Node", source, assets: [], signals: [] });
      next.editorLayout.nodes[id] = { x: 160 + next.graph.nodes.length * 36, y: 160 + next.graph.nodes.length * 24 };
    });
    setSources((current) => ({ ...current, [source.html]: DEFAULT_HTML, [source.css]: DEFAULT_CSS, [source.javascript]: DEFAULT_JS }));
    setDirtySources((current) => new Set([...current, source.html, source.css, source.javascript]));
    setSourceDeletions((current) => new Set([...current].filter((file) => !Object.values(source).includes(file))));
    setSelectedNodeId(id);
    setSelectedEdgeId(undefined);
  }

  function deleteSelectedNode(): void {
    if (!codebase || !selectedNode || codebase.graph.nodes.length === 1) return;
    const nextGraph = structuredClone(codebase.graph);
    nextGraph.nodes = nextGraph.nodes.filter((node) => node.id !== selectedNode.id);
    updateCodebase((next) => {
      next.graph.nodes = next.graph.nodes.filter((node) => node.id !== selectedNode.id);
      next.graph.edges = next.graph.edges.filter((edge) => edge.source.nodeId !== selectedNode.id && edge.targetNodeId !== selectedNode.id);
      delete next.editorLayout.nodes[selectedNode.id];
      for (const [name, nodeId] of Object.entries(next.graph.destinations)) {
        if (nodeId === selectedNode.id) delete next.graph.destinations[name];
      }
      if (next.graph.entryNodeId === selectedNode.id) next.graph.entryNodeId = next.graph.nodes[0]!.id;
    });
    discardSourceDrafts(selectedNode.source);
    deleteUnusedSources(selectedNode.source, nextGraph);
    setSelectedNodeId(undefined);
  }

  function onConnect(connection: Connection): void {
    if (!graph || !connection.source || !connection.target || !connection.sourceHandle) return;
    const source = graph.nodes.find((node) => node.id === connection.source);
    if (!source?.signals.some((signal) => signal.id === connection.sourceHandle)) return;
    updateCodebase((next) => {
      next.graph.edges = next.graph.edges.filter((edge) => edge.source.nodeId !== connection.source || edge.source.signal !== connection.sourceHandle);
      next.graph.edges.push({
        id: uniqueId("edge", new Set(next.graph.edges.map((edge) => edge.id))),
        source: { nodeId: connection.source!, signal: connection.sourceHandle! },
        targetNodeId: connection.target!,
        mode: "replace",
      });
    });
  }

  function onNodesChange(changes: NodeChange<PlayableFlowNode>[]): void {
    const positionChanges = changes.filter((change) => change.type === "position" && change.position);
    if (positionChanges.length === 0) return;
    const next = applyNodeChanges(positionChanges, flowNodes);
    updateCodebase((draft) => {
      for (const node of next) draft.editorLayout.nodes[node.id] = node.position;
    });
  }

  function onEdgesChange(changes: EdgeChange[]): void {
    const removals = changes.filter((change) => change.type === "remove");
    if (removals.length === 0) return;
    const remaining = new Set(applyEdgeChanges(removals, flowEdges).map((edge) => edge.id));
    updateCodebase((draft) => { draft.graph.edges = draft.graph.edges.filter((edge) => remaining.has(edge.id)); });
  }

  function onViewportChange(viewport: Viewport): void {
    if (!codebase) return;
    const current = codebase.editorLayout.viewport;
    if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) return;
    updateCodebase((draft) => { draft.editorLayout.viewport = viewport; });
  }

  if (phase !== "ready" || !codebase || !graph) {
    return <section className="viewer-pane playable-editor-workspace"><div className={`playable-editor-state${phase === "error" ? " is-error" : ""}`}>{phase === "error" ? error : "Loading Playable Nodes..."}</div></section>;
  }

  return (
    <section className="viewer-pane playable-editor-workspace" aria-label="Playable Nodes editor">
      <header className="interactive-drama-header window-drag-handle">
        <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
        <div className="interactive-drama-project-tools">
          {chatOnRight && onHome ? <button className="interactive-drama-home-button" type="button" onClick={onHome} title="Home"><House size={14} /></button> : null}
          <button type="button" title="Viewport"><Monitor size={14} /><span>{graph.viewport.width} x {graph.viewport.height}</span></button>
          <button type="button" title="Project state" onClick={() => setView("state")}><Layers3 size={14} /><span>State</span><small>{Object.keys(graph.initialState).length}</small></button>
        </div>
        <nav className="workspace-tabs interactive-drama-workspace-switch" data-active-tab={view === "code" ? "code" : "canvas"} data-tab-count="2" aria-label="Workspace mode">
          <button type="button" className={`workspace-tab${view !== "code" ? " workspace-tab-active" : ""}`} title="Flow" aria-label="Flow" onClick={() => setView("flow")}><GitBranch size={14} /><span>Flow</span></button>
          <button type="button" className={`workspace-tab${view === "code" ? " workspace-tab-active" : ""}`} title="Code" aria-label="Code" onClick={() => setView("code")}><Code2 size={14} /><span>Code</span></button>
        </nav>
        <div className="interactive-drama-header-actions">
          <button className="interactive-drama-action" type="button" title="Playtest" aria-label="Playtest" disabled={externalChange} onClick={() => void startPlaytest()}><Play size={14} /><span>Playtest</span></button>
          <button className="interactive-drama-action" type="button" title="Publish" aria-label="Publish" disabled={externalChange || agentBusy || publishing || saving} onClick={() => setPublishOpen(true)}><Share2 size={14} /><span>Publish</span></button>
          {chatOnRight && chatCollapsed && onToggleChat ? <button className="interactive-drama-action" type="button" title="Show chat" onClick={onToggleChat}><PanelToggle size={14} /></button> : null}
          <button className="interactive-drama-action" type="button" title={dirty ? "Save" : "Saved"} aria-label={dirty ? "Save" : "Saved"} disabled={externalChange || !dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={14} /> : <FileCode2 size={14} />}<span>{dirty ? "Save" : "Saved"}</span></button>
          <button className="interactive-drama-action interactive-drama-action-primary" type="button" title="Export" aria-label="Export" disabled={externalChange || building || saving} onClick={() => void exportGame()}>{building ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}<span>Export</span></button>
        </div>
      </header>

      {externalChange ? <div className="playable-editor-conflict" role="alert"><span>The workspace changed while you had unsaved edits.</span><button type="button" onClick={() => void load()}>Reload workspace</button><button type="button" onClick={() => setExternalChange(false)}>Keep local edits</button></div> : null}

      {view === "code" ? <main className="story-code-view"><WorkspaceCodeView projectId={project.id} revision={workspaceRevision} openFileRequest={openFileRequest} /></main> : (
        <div className={`playable-editor-body${selectedNode || selectedEdge ? " has-inspector" : ""}`}>
          <aside className="playable-editor-rail" aria-label="Playable project sections">
            <RailButton active={view === "flow"} label="Flow" icon={<GitBranch size={16} />} onClick={() => setView("flow")} />
            <RailButton active={view === "state"} label="State" icon={<Layers3 size={16} />} onClick={() => setView("state")} />
            <RailButton active={view === "assets"} label="Assets" icon={<Monitor size={16} />} onClick={() => setView("assets")} />
            <RailButton active={view === "shell"} label="Shell" icon={<Wrench size={16} />} onClick={() => setView("shell")} />
            <RailButton active={view === "destinations"} label="Destinations" icon={<GitBranch size={16} />} onClick={() => setView("destinations")} />
          </aside>
          <main className="playable-editor-main">
            {view === "flow" ? <div className="playable-flow">
              <ReactFlow<PlayableFlowNode>
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={FLOW_NODE_TYPES}
                defaultViewport={codebase.editorLayout.viewport}
                minZoom={0.25}
                maxZoom={2}
                snapToGrid
                snapGrid={[20, 20]}
                nodesDraggable
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onMoveEnd={(_event, viewport) => onViewportChange(viewport)}
                onNodeClick={(_event, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(undefined); }}
                onNodeDoubleClick={(_event, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(undefined); void previewNode(node.id); }}
                onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(undefined); }}
                onPaneClick={() => { setSelectedNodeId(undefined); setSelectedEdgeId(undefined); }}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--interactive-drama-grid)" />
                <Controls position="bottom-left" showInteractive={false} />
                <Panel position="top-left" className="playable-flow-toolbar"><button type="button" onClick={createNode}><Plus size={14} />New Node</button></Panel>
              </ReactFlow>
            </div> : null}
            {view === "state" ? <JsonProjectEditor title="Initial State" description="Authoritative JSON state for a new playthrough." value={graph.initialState} onApply={(value) => updateCodebase((next) => { next.graph.initialState = value; })} /> : null}
            {view === "assets" ? <AssetsEditor graph={graph} libraryAssets={libraryAssets} onChange={(assets) => updateCodebase((next) => { next.graph.assets = assets; next.graph.nodes = next.graph.nodes.map((node) => ({ ...node, assets: node.assets.filter((id) => assets[id]) })); if (next.graph.shell) next.graph.shell.assets = next.graph.shell.assets.filter((id) => assets[id]); })} /> : null}
            {view === "shell" ? <ShellEditor graph={graph} sources={sources} sourceKind={sourceKind} loadGeneration={codebaseGeneration} onSourceKind={setSourceKind} onLoad={loadSurfaceSources} onChangeSource={updateSource} onEnable={() => { const source = { html: "shell/index.html", css: "shell/style.css", javascript: "shell/shell.js" }; setSources((current) => ({ ...current, [source.html]: "<nav></nav>\n", [source.css]: ":host { display: block; width: 100%; height: 100%; pointer-events: none; }\n", [source.javascript]: DEFAULT_JS })); setDirtySources((current) => new Set([...current, source.html, source.css, source.javascript])); setSourceDeletions((current) => new Set([...current].filter((file) => !Object.values(source).includes(file)))); updateCodebase((next) => { next.graph.shell = { source, assets: [] }; }); }} onChange={(shell) => { const removed = !shell ? graph.shell : undefined; updateCodebase((next) => { next.graph.shell = shell; }); if (removed) { discardSourceDrafts(removed.source); deleteUnusedSources(removed.source, { ...graph, shell: undefined }); } }} /> : null}
            {view === "destinations" ? <DestinationsEditor graph={graph} onChange={(destinations) => updateCodebase((next) => { next.graph.destinations = destinations; })} /> : null}
          </main>
          {selectedNode ? <NodeInspector
            graph={graph}
            node={selectedNode}
            projectId={project.id}
            workspaceRevision={workspaceRevision}
            sources={sources}
            sourceKind={sourceKind}
            preview={preview}
            onSourceKind={setSourceKind}
            onSourceChange={updateSource}
            onChange={(node) => updateCodebase((next) => { next.graph.nodes = next.graph.nodes.map((candidate) => candidate.id === node.id ? node : candidate); })}
            onRenameSignal={(oldId, newId) => updateCodebase((next) => {
              next.graph = renamePlayableSignal(next.graph, selectedNode.id, oldId, newId);
            })}
            onDeleteSignal={(signalId) => updateCodebase((next) => {
              next.graph = deletePlayableSignal(next.graph, selectedNode.id, signalId);
            })}
            onEntry={() => updateCodebase((next) => { next.graph.entryNodeId = selectedNode.id; })}
            onPreview={() => void previewNode(selectedNode.id)}
            onDelete={deleteSelectedNode}
            onClose={() => { setSelectedNodeId(undefined); setPreview(undefined); }}
          /> : null}
          {selectedEdge ? <EdgeInspector edge={selectedEdge} onChange={(mode) => updateCodebase((next) => { const edge = next.graph.edges.find((candidate) => candidate.id === selectedEdge.id); if (edge) edge.mode = mode; })} onDelete={() => { updateCodebase((next) => { next.graph.edges = next.graph.edges.filter((edge) => edge.id !== selectedEdge.id); }); setSelectedEdgeId(undefined); }} onClose={() => setSelectedEdgeId(undefined)} /> : null}
        </div>
      )}
      {error ? <div className="playable-editor-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(undefined)}><X size={14} /></button></div> : null}
      {publishOpen ? <PublishDialog project={project} publishing={publishing} onClose={() => setPublishOpen(false)} onPublish={publish} /> : null}
    </section>
  );
}

function PlayableNodeCard({ data, selected }: NodeProps<PlayableFlowNode>) {
  return <article className={`playable-flow-node${selected ? " is-selected" : ""}`}>
    <Handle id="in" type="target" position={Position.Left} />
    <header><strong>{data.node.title}</strong><span>{data.node.id}</span></header>
    <div className="playable-flow-node-badges">{data.entry ? <span>Entry</span> : null}{data.destinations.map((name) => <span key={name}>{name}</span>)}</div>
    <footer>{data.node.signals.length ? data.node.signals.map((signal) => <div key={signal.id}><span>{signal.label}</span><Handle id={signal.id} type="source" position={Position.Right} /></div>) : <small>No signals</small>}</footer>
  </article>;
}

function RailButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return <button className={active ? "is-active" : ""} type="button" title={label} aria-label={label} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function NodeInspector({ graph, node, projectId, workspaceRevision, sources, sourceKind, preview, onSourceKind, onSourceChange, onChange, onRenameSignal, onDeleteSignal, onEntry, onPreview, onDelete, onClose }: {
  graph: NodeGraph;
  node: PlayableNode;
  projectId: string;
  workspaceRevision: number;
  sources: Record<string, string>;
  sourceKind: SourceKind;
  preview?: { definition: NodePlayerDefinition; assets: Record<string, Blob> };
  onSourceKind: (kind: SourceKind) => void;
  onSourceChange: (file: string, content: string) => void;
  onChange: (node: PlayableNode) => void;
  onRenameSignal: (oldId: string, newId: string) => void;
  onDeleteSignal: (signalId: string) => void;
  onEntry: () => void;
  onPreview: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const file = node.source[sourceKind];
  const sourceEditorRef = useRef<HTMLTextAreaElement>(null);
  function insertAssetReference(id: string): void {
    const editor = sourceEditorRef.current;
    const current = sources[file] ?? "";
    const start = editor?.selectionStart ?? current.length;
    const end = editor?.selectionEnd ?? start;
    const reference = `context.assets.url(${JSON.stringify(id)})`;
    onSourceChange(file, `${current.slice(0, start)}${reference}${current.slice(end)}`);
    window.requestAnimationFrame(() => {
      sourceEditorRef.current?.focus();
      sourceEditorRef.current?.setSelectionRange(start + reference.length, start + reference.length);
    });
  }
  return <aside className="playable-inspector">
    <header><div><strong>{node.title}</strong><span>{node.id}</span></div><button type="button" onClick={onClose} title="Close"><X size={14} /></button></header>
    <div className="playable-inspector-scroll">
      <section className="playable-inspector-section">
        <label><span>Title</span><input value={node.title} maxLength={120} onChange={(event) => onChange({ ...node, title: event.target.value })} /></label>
        <div className="playable-inline-actions"><button type="button" disabled={graph.entryNodeId === node.id} onClick={onEntry}>{graph.entryNodeId === node.id ? "Entry Node" : "Set as Entry"}</button><button type="button" onClick={onPreview}><Play size={12} />Preview</button></div>
      </section>
      {preview ? <section className="playable-node-preview"><NodePlayer definition={preview.definition} assets={preview.assets} saveKey={`ohmygame:editor-preview:${node.id}`} /></section> : null}
      <section className="playable-inspector-section"><div className="playable-section-heading"><strong>Signals</strong><button type="button" onClick={() => onChange({ ...node, signals: [...node.signals, { id: uniqueId("signal", new Set(node.signals.map((signal) => signal.id))), label: "New signal" }] })}><Plus size={12} />Add</button></div>
        <div className="playable-list-editor">{node.signals.map((signal, index) => <SignalRow key={signal.id} signal={signal} duplicateIds={new Set(node.signals.filter((_, item) => item !== index).map((item) => item.id))} onRename={onRenameSignal} onLabel={(label) => { const signals = [...node.signals]; signals[index] = { ...signal, label }; onChange({ ...node, signals }); }} onDelete={() => onDeleteSignal(signal.id)} />)}</div>
      </section>
      <section className="playable-inspector-section"><div className="playable-section-heading"><strong>Declared Assets</strong><span>{node.assets.length}</span></div>
        <div className="playable-check-list">{Object.entries(graph.assets).map(([id, asset]) => <NodeAssetRow key={id} id={id} asset={asset} projectId={projectId} revision={workspaceRevision} checked={node.assets.includes(id)} onChecked={(checked) => onChange({ ...node, assets: checked ? [...node.assets, id] : node.assets.filter((assetId) => assetId !== id) })} onInsert={() => insertAssetReference(id)} />)}{Object.keys(graph.assets).length === 0 ? <p>No project assets declared.</p> : null}</div>
      </section>
      <section className="playable-source-editor"><div className="playable-source-tabs">{SOURCE_KINDS.map((kind) => <button className={sourceKind === kind ? "is-active" : ""} type="button" key={kind} onClick={() => onSourceKind(kind)}>{SOURCE_LABELS[kind]}</button>)}</div><div className="playable-source-path">{file}</div><textarea ref={sourceEditorRef} spellCheck={false} value={sources[file] ?? ""} onChange={(event) => onSourceChange(file, event.target.value)} /></section>
      <section className="playable-danger-zone"><button type="button" disabled={graph.nodes.length === 1} onClick={onDelete}><Trash2 size={13} />Delete Node</button></section>
    </div>
  </aside>;
}

function NodeAssetRow({ id, asset, projectId, revision, checked, onChecked, onInsert }: {
  id: string;
  asset: NodeGraph["assets"][string];
  projectId: string;
  revision: number;
  checked: boolean;
  onChecked: (checked: boolean) => void;
  onInsert: () => void;
}) {
  const preview = useWorkspaceAssetUrl(
    asset.source.kind === "workspace" ? projectId : undefined,
    asset.source.kind === "workspace" ? asset.source.path : "",
    revision,
    asset.source.kind === "library" ? asset.source.assetId : undefined,
  );
  return <div className="playable-node-asset-row"><label><input type="checkbox" checked={checked} onChange={(event) => onChecked(event.target.checked)} /><span className="playable-node-asset-preview">{preview.url ? <AssetMedia type={asset.type} url={preview.url} label={id} /> : <small>{preview.error ? "Missing" : asset.type}</small>}</span><span>{id}</span><small>{preview.error ?? asset.type}</small></label><button type="button" title={`Insert reference for ${id}`} aria-label={`Insert reference for ${id}`} onClick={onInsert}><Copy size={12} /></button></div>;
}

function SignalRow({ signal, duplicateIds, onRename, onLabel, onDelete }: {
  signal: PlayableNode["signals"][number];
  duplicateIds: ReadonlySet<string>;
  onRename: (oldId: string, newId: string) => void;
  onLabel: (label: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(signal.id);
  useEffect(() => setDraft(signal.id), [signal.id]);
  function commit(): void {
    const next = normalizeIdentifier(draft);
    if (!next || duplicateIds.has(next)) {
      setDraft(signal.id);
      return;
    }
    if (next !== signal.id) onRename(signal.id, next);
  }
  return <div><input aria-label="Signal ID" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(signal.id); event.currentTarget.blur(); } }} /><input aria-label="Signal label" value={signal.label} onChange={(event) => onLabel(event.target.value)} /><button type="button" title="Remove signal" onClick={onDelete}><Trash2 size={13} /></button></div>;
}

function EdgeInspector({ edge, onChange, onDelete, onClose }: { edge: NodeGraph["edges"][number]; onChange: (mode: "replace" | "push") => void; onDelete: () => void; onClose: () => void }) {
  return <aside className="playable-inspector"><header><div><strong>Navigation</strong><span>{edge.id}</span></div><button type="button" title="Close" aria-label="Close" onClick={onClose}><X size={14} /></button></header><div className="playable-inspector-scroll"><section className="playable-inspector-section"><dl className="playable-edge-summary"><dt>Signal</dt><dd>{edge.source.nodeId}.{edge.source.signal}</dd><dt>Target</dt><dd>{edge.targetNodeId}</dd></dl><label><span>History mode</span><select value={edge.mode} onChange={(event) => onChange(event.target.value as "replace" | "push")}><option value="replace">Replace</option><option value="push">Push</option></select></label></section><section className="playable-danger-zone"><button type="button" onClick={onDelete}><Trash2 size={13} />Delete Edge</button></section></div></aside>;
}

function JsonProjectEditor({ title, description, value, onApply }: { title: string; description: string; value: JsonObject; onApply: (value: JsonObject) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string>();
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return <section className="playable-project-editor"><header><h2>{title}</h2><p>{description}</p></header><textarea spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} /><footer>{error ? <span role="alert">{error}</span> : <span>JSON object</span>}<button type="button" onClick={() => { try { const parsed = JSON.parse(text) as unknown; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("State must be a JSON object."); onApply(parsed as JsonObject); setError(undefined); } catch (cause) { setError(errorMessage(cause)); } }}>Apply</button></footer></section>;
}

function AssetsEditor({ graph, libraryAssets, onChange }: { graph: NodeGraph; libraryAssets: LibraryAsset[]; onChange: (assets: NodeGraph["assets"]) => void }) {
  function addLibraryAsset(asset: LibraryAsset): void {
    if (asset.mediaType === "model") return;
    const id = uniqueId(normalizeIdentifier(asset.name.replace(/\.[^.]+$/, "")) || "asset", new Set(Object.keys(graph.assets)));
    onChange({ ...graph.assets, [id]: { type: asset.mediaType, source: { kind: "library", assetId: asset.id } } });
  }
  return <section className="playable-project-editor playable-assets-editor"><header><h2>Assets</h2><p>Stable IDs exposed to Node and Shell code.</p></header><div className="playable-assets-grid"><section><h3>Manifest</h3>{Object.entries(graph.assets).map(([id, asset]) => <div className="playable-asset-row" key={id}><div><strong>{id}</strong><span>{asset.type} · {asset.source.kind === "library" ? asset.source.assetId : asset.source.path}</span></div><button type="button" title="Remove asset" onClick={() => { const next = { ...graph.assets }; delete next[id]; onChange(next); }}><Trash2 size={13} /></button></div>)}{Object.keys(graph.assets).length === 0 ? <p className="playable-empty">No assets declared.</p> : null}</section><section><h3>Library</h3>{libraryAssets.filter((asset) => asset.mediaType !== "model").map((asset) => <button className="playable-library-row" type="button" key={asset.id} disabled={Object.values(graph.assets).some((item) => item.source.kind === "library" && item.source.assetId === asset.id)} onClick={() => addLibraryAsset(asset)}><Plus size={13} /><span>{asset.name}</span><small>{asset.mediaType}</small></button>)}{libraryAssets.length === 0 ? <p className="playable-empty">Library is empty.</p> : null}</section></div></section>;
}

function ShellEditor({ graph, sources, sourceKind, loadGeneration, onSourceKind, onLoad, onChangeSource, onEnable, onChange }: { graph: NodeGraph; sources: Record<string, string>; sourceKind: SourceKind; loadGeneration: number; onSourceKind: (kind: SourceKind) => void; onLoad: (source: NodeSource) => Promise<void>; onChangeSource: (file: string, content: string) => void; onEnable: () => void; onChange: (shell: NodeGraph["shell"]) => void }) {
  const shell = graph.shell;
  useEffect(() => { if (shell) void onLoad(shell.source); }, [Boolean(shell), loadGeneration]);
  if (!shell) return <section className="playable-project-editor playable-empty-editor"><header><h2>Shell</h2><p>Persistent project UI mounted above every Node.</p></header><button type="button" onClick={onEnable}><Plus size={14} />Enable Shell</button></section>;
  const file = shell.source[sourceKind];
  return <section className="playable-project-editor playable-shell-editor"><header><div><h2>Shell</h2><p>Persistent UI and named Destination actions.</p></div><button className="playable-secondary-action" type="button" onClick={() => onChange(undefined)}>Disable Shell</button></header><div className="playable-shell-assets"><strong>Declared Assets</strong>{Object.keys(graph.assets).map((id) => <label key={id}><input type="checkbox" checked={shell.assets.includes(id)} onChange={(event) => onChange({ ...shell, assets: event.target.checked ? [...shell.assets, id] : shell.assets.filter((asset) => asset !== id) })} /><span>{id}</span></label>)}{Object.keys(graph.assets).length === 0 ? <span>No project assets declared.</span> : null}</div><div className="playable-source-tabs">{SOURCE_KINDS.map((kind) => <button className={sourceKind === kind ? "is-active" : ""} type="button" key={kind} onClick={() => onSourceKind(kind)}>{SOURCE_LABELS[kind]}</button>)}</div><div className="playable-source-path">{file}</div><textarea spellCheck={false} value={sources[file] ?? (sourceKind === "html" ? "<nav></nav>\n" : sourceKind === "css" ? ":host { pointer-events: none; }\n" : DEFAULT_JS)} onChange={(event) => onChangeSource(file, event.target.value)} /></section>;
}

function DestinationsEditor({ graph, onChange }: { graph: NodeGraph; onChange: (value: Record<string, string>) => void }) {
  return <section className="playable-project-editor"><header><h2>Destinations</h2><p>Stable names the Shell can open without knowing Node IDs.</p></header><div className="playable-destination-list">{Object.entries(graph.destinations).map(([name, nodeId]) => <DestinationRow key={name} name={name} nodeId={nodeId} nodes={graph.nodes} onRename={(requestedName) => { if (!requestedName || requestedName === name) return; const used = new Set(Object.keys(graph.destinations).filter((candidate) => candidate !== name)); const nextName = uniqueId(requestedName, used); const next = { ...graph.destinations }; delete next[name]; next[nextName] = nodeId; onChange(next); }} onNode={(nextNodeId) => onChange({ ...graph.destinations, [name]: nextNodeId })} onDelete={() => { const next = { ...graph.destinations }; delete next[name]; onChange(next); }} />)}<button type="button" onClick={() => onChange({ ...graph.destinations, [uniqueId("destination", new Set(Object.keys(graph.destinations)))]: graph.entryNodeId })}><Plus size={13} />Add Destination</button></div></section>;
}

function DestinationRow({ name, nodeId, nodes, onRename, onNode, onDelete }: { name: string; nodeId: string; nodes: PlayableNode[]; onRename: (name: string) => void; onNode: (nodeId: string) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  return <div><input aria-label={`Destination ${name}`} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { const normalized = normalizeIdentifier(draft); if (normalized) onRename(normalized); else setDraft(name); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><select aria-label={`Node for ${name}`} value={nodeId} onChange={(event) => onNode(event.target.value)}>{nodes.map((node) => <option value={node.id} key={node.id}>{node.title}</option>)}</select><button type="button" title={`Remove ${name}`} aria-label={`Remove ${name}`} onClick={onDelete}><Trash2 size={13} /></button></div>;
}

function nodeSource(id: string): NodeSource { return { html: `nodes/${id}/index.html`, css: `nodes/${id}/style.css`, javascript: `nodes/${id}/node.js` }; }
function declaredSourcePaths(graph: NodeGraph): Set<string> {
  const paths = new Set<string>();
  for (const node of graph.nodes) for (const kind of SOURCE_KINDS) paths.add(node.source[kind]);
  if (graph.shell) for (const kind of SOURCE_KINDS) paths.add(graph.shell.source[kind]);
  return paths;
}
function normalizeIdentifier(value: string): string { return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 120); }
function uniqueId(base: string, used: ReadonlySet<string>): string { let id = base || "item"; let index = 2; while (used.has(id)) id = `${base}-${index++}`; return id; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }

async function loadRuntimeAssets(projectId: string, graph: NodeGraph): Promise<Record<string, Blob>> {
  return Object.fromEntries(await Promise.all(Object.entries(graph.assets).map(async ([id, asset]) => [id, asset.source.kind === "library" ? await getLibraryAsset(asset.source.assetId) : await getWorkspaceAsset(projectId, asset.source.path)] as const)));
}
