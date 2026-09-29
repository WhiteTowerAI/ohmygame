import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, InfoCircle, Play, RotateCcw, X } from "./icons.js";
import type { JsonObject, NodeGraph } from "../shared/playable-nodes.js";
import { formatStateValue, type PlayableDebugRecord } from "../shared/playable-debug.js";
import { PLAYABLE_SHELL_ID } from "../shared/playable-nodes.js";
import { playableSignalsOf } from "../shared/playable-graph.js";
import { PreviewStateEditor, type PlaytestStart } from "./playable-node-workbench.js";
import { useTechnicalDetails } from "./playable-details.js";

export type { PlaytestStart };

const STATUS_LABELS: Record<PlayableDebugRecord["status"], string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Running",
  transitioning: "Changing Scene",
  failed: "Failed",
  disposed: "Stopped",
};
const RECENT_LIMIT = 8;

const startKey = (projectId: string) => `ohmygame:playtest:start:${projectId}`;

/**
 * Asks the Playtest window to start at a Scene ("Play from here"). The window
 * may not be open yet, so the request waits in localStorage until it is taken.
 */
export function requestPlaytestStart(projectId: string, start: PlaytestStart): void {
  window.localStorage.setItem(startKey(projectId), JSON.stringify(start));
}

/** Takes a waiting start request, so it runs once. */
export function takePlaytestStart(projectId: string): PlaytestStart | undefined {
  const key = startKey(projectId);
  const raw = window.localStorage.getItem(key);
  if (raw === null) return undefined;
  window.localStorage.removeItem(key);
  try {
    const start = JSON.parse(raw) as Partial<PlaytestStart>;
    return typeof start.nodeId === "string" && start.state && typeof start.state === "object" && !Array.isArray(start.state)
      ? { nodeId: start.nodeId, state: start.state }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Calls `onStart` whenever another window asks this Playtest to start somewhere. */
export function usePlaytestStartRequests(projectId: string, onStart: (start: PlaytestStart) => void): void {
  const handler = useRef(onStart);
  handler.current = onStart;
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== startKey(projectId) || event.newValue === null) return;
      const start = takePlaytestStart(projectId);
      if (start) handler.current(start);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);
}

/**
 * The Playtest debug drawer: which Scene the player is in, the Exits they
 * took, what changed in the Variables, and what failed. It reads the same
 * record the Agent's game_use receives.
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
  const technical = useTechnicalDetails();
  const [startOpen, setStartOpen] = useState(false);
  const errorCount = (record?.errors.length ?? 0) + diagnostics.length;
  const titleOf = (nodeId?: string) => nodeId === PLAYABLE_SHELL_ID
    ? "Overlay"
    : graph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId ?? "";
  const signalLabel = (nodeId: string, signal: string) =>
    playableSignalsOf(graph, nodeId)?.find((candidate) => candidate.id === signal)?.label ?? signal;

  if (!open) return <button type="button" className={`playable-playtest-drawer-toggle${errorCount ? " has-errors" : ""}`} title="Show what is happening in the game" aria-label="Show Playtest details" onClick={() => onOpenChange(true)}>
    <ChevronRight size={12} />
    <span>{record ? titleOf(record.currentNode.id) : "Starting"}</span>
    {errorCount ? <b>{errorCount}</b> : null}
  </button>;

  return <aside className="playable-playtest-drawer" aria-label="Playtest details">
    <header>
      <strong>Playtest</strong>
      <span className={record?.status === "failed" ? "is-error" : undefined}>{record ? STATUS_LABELS[record.status] : "Starting"}</span>
      {start ? <span className="playable-playtest-custom" title="This run started from a chosen Scene and Variables; the saved game is untouched.">From {titleOf(start.nodeId)}</span> : null}
      <button type="button" title="Replay from the Start Scene with a new game" aria-label="Replay" onClick={onRestart}><RotateCcw size={12} /></button>
      <button type="button" title="Hide" aria-label="Hide Playtest details" onClick={() => onOpenChange(false)}><ChevronDown size={12} /></button>
    </header>

    <section aria-label="Current Scene">
      <h3>Scene</h3>
      <div className="playable-playtest-current">
        <strong>{record ? titleOf(record.currentNode.id) : "Starting..."}</strong>
        {record && technical ? <code>{record.currentNode.id}</code> : null}
        {record && onOpenNode ? <button type="button" onClick={() => onOpenNode(record.currentNode.id)}>Open in editor</button> : null}
      </div>
      {technical ? <p className="playable-playtest-backstack">
        <span>History</span>
        {record?.backStack.length ? record.backStack.map((node, index) => <span key={`${node.id}:${index}`}>{index ? <ArrowRight size={10} /> : null}{node.title ?? node.id}</span>) : <em>Empty</em>}
      </p> : null}
    </section>

    <section aria-label="Exits taken">
      <h3>Exits taken</h3>
      {record?.recentSignals.length ? <ol className="playable-playtest-list">
        {record.recentSignals.slice(-RECENT_LIMIT).reverse().map((entry, index) => <li key={`${entry.at}:${index}`} className={entry.followed ? undefined : "is-warning"}>
          <span>{titleOf(entry.nodeId)} · "{signalLabel(entry.nodeId, entry.signal)}"</span>
          <span>{entry.followed ? <><ArrowRight size={10} /> {titleOf(entry.targetNodeId)}</> : "goes nowhere yet"}</span>
        </li>)}
      </ol> : <p className="playable-playtest-empty">No exits taken yet.</p>}
    </section>

    <section aria-label="Variables">
      <h3>Variables</h3>
      {record?.stateChanges.length ? <ol className="playable-playtest-list">
        {record.stateChanges.slice(-RECENT_LIMIT).reverse().map((change, index) => <li key={`${change.at}:${change.key}:${index}`}>
          <code>{change.key}</code>
          <span>{formatStateValue(change.before)} → {formatStateValue(change.after)} <small>in {titleOf(change.nodeId)}</small></span>
        </li>)}
      </ol> : <p className="playable-playtest-empty">No Variables changed yet.</p>}
      <details>
        <summary>All Variables now</summary>
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

    <section aria-label="Play from a Scene">
      <button type="button" className="playable-playtest-section-toggle" aria-expanded={startOpen} onClick={() => setStartOpen((current) => !current)}>
        {startOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<span>Play from a Scene…</span>
      </button>
      {startOpen ? <StartFromForm key={start ? `${start.nodeId}:${JSON.stringify(start.state)}` : "saved"} graph={graph} start={start} onStart={onStart} /> : null}
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
      <span>Scene</span>
      <select value={nodeId} onChange={(event) => setNodeId(event.target.value)}>
        {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
      </select>
    </label>
    <PreviewStateEditor initialState={graph.initialState} previewState={state} onChange={setState} />
    <p>This run doesn't save, so the saved game is untouched.</p>
    <div className="playable-playtest-start-actions">
      <button type="button" className="is-primary" onClick={() => onStart({ nodeId, state })}><Play size={11} fill="currentColor" /><span>Play</span></button>
      {start ? <button type="button" onClick={() => onStart(undefined)}><X size={11} /><span>Back to the saved game</span></button> : null}
    </div>
  </div>;
}
