import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Flag, InfoCircle, MousePointer2, RotateCcw, X } from "./icons.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import type { PlayablePreviewOptions } from "../shared/playable-player-protocol.js";
import type { PlayablePickResult } from "../shared/playable-picker.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import type { PlayableProjectValidationIssue } from "../shared/playable-editor.js";
import { NodeWorkbenchLayout, WorkbenchBreadcrumb, WorkbenchPreview } from "./node-workbench.js";
import { createMemoryStorage, NodePlayer } from "./playable-player.js";
import { usePlayableChatReport, type PlayableChatState } from "./playable-chat.js";
import {
  DestinationKeyInput,
  PickedElement,
  PlayableAssetsSection,
  PreviewActivity,
  usePlayablePreviewRuntime,
  WorkbenchOverflowMenu,
  type PlayableAssetRequest,
} from "./playable-node-workbench.js";

/**
 * The Shell's Workbench: the persistent UI previewed over a sample Node, the
 * Destinations it can open, and the Assets it declares.
 */
export function PlayableShellWorkbench({
  projectId,
  graph,
  issues,
  revision,
  onClose,
  onOpenNode,
  onOpenSource,
  onSetDestination,
  onAddAsset,
  onRemoveAsset,
  onSnapshot,
  onChatContextChange,
  headerActions,
}: {
  projectId: string;
  graph: NodeGraph & { shell: NonNullable<NodeGraph["shell"]> };
  issues: readonly PlayableProjectValidationIssue[];
  revision: number;
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
  onOpenSource: () => void;
  onSetDestination: (key: string, nodeId: string | undefined) => void;
  onAddAsset: (asset: PlayableAssetRequest) => void;
  onRemoveAsset: (assetId: string) => void;
  onSnapshot?: (snapshot: NodeRuntimeSnapshot | undefined) => void;
  onChatContextChange?: (state: PlayableChatState | undefined) => void;
  /** Project tools shown in the header, such as the State panel toggle. */
  headerActions?: ReactNode;
}) {
  const runtime = usePlayablePreviewRuntime(projectId, revision);
  const [sampleNodeId, setSampleNodeId] = useState(graph.entryNodeId);
  const [session, setSession] = useState(0);
  const [snapshot, setSnapshot] = useState<NodeRuntimeSnapshot>();
  const [diagnostics, setDiagnostics] = useState<{ message: string; at: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PlayablePickResult>();
  const [storage] = useState(createMemoryStorage);
  const page = useRef<HTMLElement>(null);
  const sampleNode = graph.nodes.find((node) => node.id === sampleNodeId) ?? graph.nodes[0]!;

  useEffect(() => {
    setSnapshot(undefined);
    setDiagnostics([]);
    onSnapshot?.(undefined);
  }, [runtime.definition, sampleNode.id, session]);

  usePlayableChatReport({
    graph,
    surface: { kind: "shell" },
    picked,
    clearPicked: () => setPicked(undefined),
    stage: page,
    onChange: onChatContextChange,
  });

  const reportSnapshot = useCallback((next: NodeRuntimeSnapshot) => {
    setSnapshot(next);
    onSnapshot?.(next);
  }, [onSnapshot]);
  const onDiagnostic = useCallback((message: string) => {
    setDiagnostics((current) => [...current.slice(-19), { message, at: new Date().toISOString() }]);
  }, []);
  const onPick = useCallback((pick: PlayablePickResult) => {
    setPicked(pick);
    setPicking(false);
  }, []);
  const onPickCancel = useCallback(() => setPicking(false), []);

  const preview: PlayablePreviewOptions = { policy: "report", startNodeId: sampleNode.id };
  const shellIssues = issues.filter((issue) => issue.surfaceId === "shell" || issue.path.startsWith("shell/"));
  const destinations = Object.entries(graph.destinations);

  const actions = <>
    <label className="playable-workbench-tool playable-workbench-sample" title="Node shown under the Shell">
      <span>Over</span>
      <select aria-label="Sample Node" value={sampleNode.id} onChange={(event) => setSampleNodeId(event.target.value)}>
        {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
      </select>
    </label>
    <button type="button" className="playable-workbench-tool" title="Restart preview" aria-label="Restart preview" disabled={!runtime.definition} onClick={() => setSession((current) => current + 1)}><RotateCcw size={13} /><span>Restart</span></button>
    <button type="button" className={`playable-workbench-tool${picking ? " is-active" : ""}`} title="Point at part of the preview" aria-pressed={picking} disabled={!runtime.definition} onClick={() => setPicking((current) => !current)}><MousePointer2 size={13} /><span>{picking ? "Picking..." : "Pick element"}</span></button>
  </>;

  const footer = <>
    {picked ? <PickedElement pick={picked} onClear={() => setPicked(undefined)} /> : null}
    <PreviewActivity graph={graph} snapshot={snapshot} diagnostics={diagnostics} buildError={runtime.error} onOpenNode={onOpenNode} />
  </>;

  const previewPane = <WorkbenchPreview
    ariaLabel="Shell live preview"
    viewport={graph.viewport}
    stageClassName="playable-workbench-stage"
    actions={actions}
    footer={footer}
  >
    {runtime.definition && runtime.assets ? <NodePlayer
      key={`${session}:${sampleNode.id}`}
      definition={runtime.definition}
      assets={runtime.assets}
      saveKey={`ohmygame:playable:preview:${projectId}`}
      storage={storage}
      preview={preview}
      picking={picking}
      onPick={onPick}
      onPickCancel={onPickCancel}
      onSnapshot={reportSnapshot}
      onDiagnostic={onDiagnostic}
    /> : <div className={`playable-workbench-stage-state${runtime.error ? " is-error" : ""}`} role={runtime.error ? "alert" : undefined}>
      {runtime.error ?? "Loading preview..."}
    </div>}
  </WorkbenchPreview>;

  const inspector = <aside className="story-inspector playable-workbench-inspector" aria-label="Shell inspector">
    <div className="story-inspector-content">
      <p className="playable-workbench-meta">The Shell stays mounted while Nodes change. It opens Nodes by Destination.</p>
      {shellIssues.length ? <ul className="playable-workbench-issues" role="alert">
        {shellIssues.map((issue, index) => <li key={`${index}:${issue.message}`}><InfoCircle size={12} /><span>{issue.message}</span></li>)}
      </ul> : null}
      <section className="story-open-ui-inspector-section playable-workbench-section">
        <h3>Destinations</h3>
        {destinations.length ? <div className="playable-workbench-signals">
          {destinations.map(([key, nodeId]) => <div className="playable-workbench-signal" key={key}>
            <div className="playable-workbench-signal-label">
              <span className="playable-destination-chip"><Flag size={11} /><code>{key}</code></span>
              <button type="button" className="playable-destination-remove" title="Remove Destination" aria-label={`Remove Destination ${key}`} onClick={() => onSetDestination(key, undefined)}><X size={12} /></button>
            </div>
            <div className="playable-workbench-signal-target">
              <ArrowRight size={12} aria-hidden="true" />
              <select aria-label={`Node for Destination ${key}`} value={nodeId} onChange={(event) => onSetDestination(key, event.target.value)}>
                {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
              </select>
              <button type="button" title="Open Node" aria-label={`Open the Node for ${key}`} onClick={() => onOpenNode(nodeId)}><ArrowRight size={13} /></button>
            </div>
          </div>)}
        </div> : <p className="story-media-empty">No Destinations yet. Add one, or assign one from a Node.</p>}
        <DestinationKeyInput
          suggestions={[]}
          taken={destinations.map(([key]) => key)}
          onSubmit={(key) => onSetDestination(key, sampleNode.id)}
        />
      </section>
      <PlayableAssetsSection projectId={projectId} assetIds={graph.shell.assets} graph={graph} issues={issues} emptyText="No assets declared for the Shell." onAddAsset={onAddAsset} onRemoveAsset={onRemoveAsset} />
    </div>
  </aside>;

  return <section ref={page} className="story-node-editor-page playable-workbench-page" aria-label="Shell workbench">
    <header className="story-node-editor-header window-drag-handle">
      <WorkbenchBreadcrumb label="Shell" onClose={onClose} />
      <div className="playable-workbench-header-actions">
        {headerActions}
        <WorkbenchOverflowMenu onOpenSource={onOpenSource} />
      </div>
    </header>
    <NodeWorkbenchLayout className="playable-node-workbench" preview={previewPane} inspector={inspector} timeline={null} />
  </section>;
}
