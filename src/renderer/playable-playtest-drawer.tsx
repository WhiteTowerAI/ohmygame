import { useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, InfoCircle, Play, RotateCcw, X } from "./icons.js";
import type { JsonObject, NodeGraph } from "../shared/playable-nodes.js";
import { formatStateValue, type PlayableDebugRecord } from "../shared/playable-debug.js";
import { PreviewStateEditor } from "./playable-node-workbench.js";

const STATUS_LABELS: Record<PlayableDebugRecord["status"], string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Running",
  transitioning: "Changing Node",
  failed: "Failed",
  disposed: "Stopped",
};
const RECENT_LIMIT = 8;

/** A Playtest that starts somewhere other than the saved game. */
export interface PlaytestStart {
  nodeId: string;
  state: JsonObject;
}

/**
 * The Playtest debug drawer: where the player is, how they got there, what
 * changed in State, and what failed. It reads the same record the Agent's
 * game_use receives.
 */
export function PlaytestDebugDrawer({ graph, record, diagnostics, start, open, onOpenChange, onRestart, onStart, onOpenNode }: {
  graph: NodeGraph;
  record?: PlayableDebugRecord;
  diagnostics: readonly string[];
  start?: PlaytestStart;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestart: () => void;
  onStart: (start: PlaytestStart | undefined) => void;
  onOpenNode?: (nodeId: string) => void;
}) {
  const [startOpen, setStartOpen] = useState(false);
  const errorCount = (record?.errors.length ?? 0) + diagnostics.length;
  const titleOf = (nodeId?: string) => graph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId ?? "";
  const signalLabel = (nodeId: string, signal: string) =>
    graph.nodes.find((node) => node.id === nodeId)?.signals.find((candidate) => candidate.id === signal)?.label ?? signal;

  if (!open) return <button type="button" className={`playable-playtest-drawer-toggle${errorCount ? " has-errors" : ""}`} title="Show Playtest debug" aria-label="Show Playtest debug" onClick={() => onOpenChange(true)}>
    <ChevronRight size={12} />
    <span>{record ? titleOf(record.currentNode.id) : "Starting"}</span>
    {errorCount ? <b>{errorCount}</b> : null}
  </button>;

  return <aside className="playable-playtest-drawer" aria-label="Playtest debug">
    <header>
      <strong>Playtest</strong>
      <span className={record?.status === "failed" ? "is-error" : undefined}>{record ? STATUS_LABELS[record.status] : "Starting"}</span>
      {start ? <span className="playable-playtest-custom" title="This run started from a chosen Node and State; the saved game is untouched.">From {titleOf(start.nodeId)}</span> : null}
      <button type="button" title="Restart from the Entry Node with a new game" aria-label="Restart" onClick={onRestart}><RotateCcw size={12} /></button>
      <button type="button" title="Hide" aria-label="Hide Playtest debug" onClick={() => onOpenChange(false)}><ChevronDown size={12} /></button>
    </header>

    <section aria-label="Current Node">
      <h3>Node</h3>
      <div className="playable-playtest-current">
        <strong>{record ? titleOf(record.currentNode.id) : "Starting..."}</strong>
        {record ? <code>{record.currentNode.id}</code> : null}
        {record && onOpenNode ? <button type="button" onClick={() => onOpenNode(record.currentNode.id)}>Open in editor</button> : null}
      </div>
      <p className="playable-playtest-backstack">
        <span>Back stack</span>
        {record?.backStack.length ? record.backStack.map((node, index) => <span key={`${node.id}:${index}`}>{index ? <ArrowRight size={10} /> : null}{node.title ?? node.id}</span>) : <em>Empty</em>}
      </p>
    </section>

    <section aria-label="Recent Signals">
      <h3>Signals</h3>
      {record?.recentSignals.length ? <ol className="playable-playtest-list">
        {record.recentSignals.slice(-RECENT_LIMIT).reverse().map((entry, index) => <li key={`${entry.at}:${index}`} className={entry.followed ? undefined : "is-warning"}>
          <span>{titleOf(entry.nodeId)} · "{signalLabel(entry.nodeId, entry.signal)}"</span>
          <span>{entry.followed ? <><ArrowRight size={10} /> {titleOf(entry.targetNodeId)}</> : "not connected"}</span>
        </li>)}
      </ol> : <p className="playable-playtest-empty">No Signals yet.</p>}
    </section>

    <section aria-label="State">
      <h3>State</h3>
      {record?.stateChanges.length ? <ol className="playable-playtest-list">
        {record.stateChanges.slice(-RECENT_LIMIT).reverse().map((change, index) => <li key={`${change.at}:${change.key}:${index}`}>
          <code>{change.key}</code>
          <span>{formatStateValue(change.before)} → {formatStateValue(change.after)} <small>in {titleOf(change.nodeId)}</small></span>
        </li>)}
      </ol> : <p className="playable-playtest-empty">No State changes yet.</p>}
      <details>
        <summary>Current State</summary>
        <dl className="playable-playtest-state">
          {Object.entries(record?.state ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd title={formatStateValue(value)}>{formatStateValue(value)}</dd></div>)}
        </dl>
      </details>
    </section>

    {errorCount ? <section aria-label="Errors" role="alert">
      <h3>Errors</h3>
      <ol className="playable-playtest-list is-errors">
        {record?.errors.map((error, index) => <li key={`${error.at}:${index}`}><InfoCircle size={11} /><span>{error.nodeId ? `${titleOf(error.nodeId)}: ` : ""}{error.message}</span></li>)}
        {diagnostics.map((message, index) => <li key={`diagnostic:${index}`}><InfoCircle size={11} /><span>{message}</span></li>)}
      </ol>
    </section> : null}

    <section aria-label="Start from">
      <button type="button" className="playable-playtest-section-toggle" aria-expanded={startOpen} onClick={() => setStartOpen((current) => !current)}>
        {startOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<span>Start from a Node</span>
      </button>
      {startOpen ? <StartFromForm graph={graph} start={start} onStart={onStart} /> : null}
    </section>
  </aside>;
}

function StartFromForm({ graph, start, onStart }: {
  graph: NodeGraph;
  start?: PlaytestStart;
  onStart: (start: PlaytestStart | undefined) => void;
}) {
  const [nodeId, setNodeId] = useState(start?.nodeId ?? graph.entryNodeId);
  const [state, setState] = useState<JsonObject>(start?.state ?? {});
  return <div className="playable-playtest-start">
    <label>
      <span>Node</span>
      <select value={nodeId} onChange={(event) => setNodeId(event.target.value)}>
        {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
      </select>
    </label>
    <PreviewStateEditor initialState={graph.initialState} previewState={state} onChange={setState} />
    <p>A chosen start runs without saving, so the saved game is untouched.</p>
    <div className="playable-playtest-start-actions">
      <button type="button" className="is-primary" onClick={() => onStart({ nodeId, state })}><Play size={11} fill="currentColor" /><span>Start</span></button>
      {start ? <button type="button" onClick={() => onStart(undefined)}><X size={11} /><span>Back to the saved game</span></button> : null}
    </div>
  </div>;
}
