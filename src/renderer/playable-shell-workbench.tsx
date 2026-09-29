import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { InfoCircle, RotateCcw } from "./icons.js";
import { PLAYABLE_SHELL_ID, type NodeGraph } from "../shared/playable-nodes.js";
import type { PlayablePreviewOptions } from "../shared/playable-player-protocol.js";
import type { PlayablePickResult } from "../shared/playable-picker.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import type { PlayableProjectValidationIssue } from "../shared/playable-editor.js";
import { NodeWorkbenchLayout, WorkbenchBreadcrumb, WorkbenchPreview } from "./node-workbench.js";
import { createMemoryStorage, NodePlayer } from "./playable-player.js";
import { usePlayableChatReport, type PlayableChatState } from "./playable-chat.js";
import {
  PickedElement,
  PlayableAssetsSection,
  PlayableExitsSection,
  PointAtButton,
  PreviewActivity,
  usePlayablePreviewRuntime,
  WorkbenchOverflowMenu,
  type PlayableAssetRequest,
  type PlayableSignalEdits,
} from "./playable-node-workbench.js";

/**
 * The Shell's Workbench (the editor calls it the Overlay): the persistent UI
 * previewed over a sample Node, its own Exits, and the Assets it declares.
 */
export function PlayableShellWorkbench({
  projectId,
  graph,
  issues,
  revision,
  onClose,
  onOpenNode,
  onOpenSource,
  onSignalLabel,
  onSignalTarget,
  onAskAgent,
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
  onAddAsset: (asset: PlayableAssetRequest) => void;
  onRemoveAsset: (assetId: string) => void;
  onSnapshot?: (snapshot: NodeRuntimeSnapshot | undefined) => void;
  onChatContextChange?: (state: PlayableChatState | undefined) => void;
  /** Project tools shown in the header, such as the State panel toggle. */
  headerActions?: ReactNode;
} & PlayableSignalEdits) {
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
  const shellIssues = issues.filter((issue) => issue.surfaceId === PLAYABLE_SHELL_ID || issue.path.startsWith("shell/") || issue.path.startsWith("/shell/"));

  const actions = <>
    <label className="playable-workbench-tool playable-workbench-sample" title="The Scene shown under the Overlay">
      <span>Shown over</span>
      <select aria-label="Scene shown under the Overlay" value={sampleNode.id} onChange={(event) => setSampleNodeId(event.target.value)}>
        {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
      </select>
    </label>
    <button type="button" className="playable-workbench-tool" title="Play the preview again from the start" aria-label="Replay" disabled={!runtime.definition} onClick={() => setSession((current) => current + 1)}><RotateCcw size={13} /><span>Replay</span></button>
    <PointAtButton picking={picking} disabled={!runtime.definition} onToggle={() => setPicking((current) => !current)} />
  </>;

  const footer = <>
    {picked ? <PickedElement pick={picked} onClear={() => setPicked(undefined)} /> : null}
    <PreviewActivity graph={graph} snapshot={snapshot} diagnostics={diagnostics} buildError={runtime.error} onOpenNode={onOpenNode} onSignalTarget={onSignalTarget} onAskAgent={onAskAgent} />
  </>;

  const previewPane = <WorkbenchPreview
    ariaLabel="Overlay live preview"
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

  const inspector = <aside className="story-inspector playable-workbench-inspector" aria-label="Overlay inspector">
    <div className="story-inspector-content">
      <p className="playable-workbench-meta">The Overlay stays on screen while Scenes change, such as a top bar or a menu button.</p>
      {shellIssues.length ? <ul className="playable-workbench-issues" role="alert">
        {shellIssues.map((issue, index) => <li key={`${index}:${issue.message}`}><InfoCircle size={12} /><span>{issue.message}</span></li>)}
      </ul> : null}
      <PlayableExitsSection
        surfaceId={PLAYABLE_SHELL_ID}
        signals={graph.shell.signals}
        graph={graph}
        emptyText="The Overlay has no exits yet. Ask the AI to add one, such as a Home button."
        onOpenNode={onOpenNode}
        onSignalLabel={onSignalLabel}
        onSignalTarget={onSignalTarget}
      />
      <PlayableAssetsSection projectId={projectId} assetIds={graph.shell.assets} graph={graph} issues={issues} emptyText="The Overlay uses no assets yet." onAddAsset={onAddAsset} onRemoveAsset={onRemoveAsset} />
    </div>
  </aside>;

  return <section ref={page} className="story-node-editor-page playable-workbench-page" aria-label="Overlay workbench">
    <header className="story-node-editor-header window-drag-handle">
      <WorkbenchBreadcrumb label="Overlay" onClose={onClose} />
      <div className="playable-workbench-header-actions">
        {headerActions}
        <WorkbenchOverflowMenu onOpenSource={onOpenSource} />
      </div>
    </header>
    <NodeWorkbenchLayout className="playable-node-workbench" preview={previewPane} inspector={inspector} timeline={null} />
  </section>;
}
