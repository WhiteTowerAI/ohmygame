import type { JsonObject, JsonValue, NodeGraph } from "./playable-nodes.js";
import type { NodeRuntimeSnapshot } from "./playable-runtime.js";

/** One State key whose value changed between two Runtime snapshots. */
export interface PlayableStateChange {
  key: string;
  /** Absent when the key was added. */
  before?: JsonValue;
  /** Absent when the key was removed. */
  after?: JsonValue;
  /** The Node that was current when the change was seen. */
  nodeId: string;
  at: string;
}

/**
 * What a Playtest shows about a running project, in a form that is both
 * rendered in the Playtest drawer and returned to the agent by game_use.
 */
export interface PlayableDebugRecord {
  status: NodeRuntimeSnapshot["status"];
  currentNode: { id: string; title?: string };
  backStack: { id: string; title?: string }[];
  state: JsonObject;
  recentSignals: {
    nodeId: string;
    signal: string;
    edgeId?: string;
    targetNodeId?: string;
    /** False when the Signal has no outgoing edge. */
    followed: boolean;
    at: string;
  }[];
  stateChanges: PlayableStateChange[];
  errors: NodeRuntimeSnapshot["errors"];
  save: NodeRuntimeSnapshot["save"];
}

const STATE_CHANGE_LIMIT = 30;

/** The keys whose values differ between two States, in a stable order. */
export function diffPlayableState(
  before: JsonObject,
  after: JsonObject,
  nodeId: string,
  at: string,
): PlayableStateChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => {
    const hadKey = Object.hasOwn(before, key);
    const hasKey = Object.hasOwn(after, key);
    if (hadKey && hasKey && sameJson(before[key]!, after[key]!)) return [];
    return [{
      key,
      ...(hadKey ? { before: before[key] } : {}),
      ...(hasKey ? { after: after[key] } : {}),
      nodeId,
      at,
    }];
  });
}

/**
 * Keeps the State changes of one Runtime session. Snapshots only carry the
 * current State, so changes are the differences between successive ones.
 */
export class PlayableStateHistory {
  #state: JsonObject | undefined;
  #changes: PlayableStateChange[] = [];

  get changes(): readonly PlayableStateChange[] {
    return this.#changes;
  }

  /** Records a snapshot and returns whether any State changed. */
  record(snapshot: NodeRuntimeSnapshot, at = new Date().toISOString()): boolean {
    const previous = this.#state;
    this.#state = snapshot.state;
    if (!previous) return false;
    const changes = diffPlayableState(previous, snapshot.state, snapshot.currentNodeId, at);
    if (!changes.length) return false;
    this.#changes = [...this.#changes, ...changes].slice(-STATE_CHANGE_LIMIT);
    return true;
  }

  reset(): void {
    this.#state = undefined;
    this.#changes = [];
  }
}

export function playableDebugRecord(
  snapshot: NodeRuntimeSnapshot,
  graph: NodeGraph,
  stateChanges: readonly PlayableStateChange[],
): PlayableDebugRecord {
  const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
  const reference = (id: string) => ({ id, ...(titles.get(id) ? { title: titles.get(id) } : {}) });
  return {
    status: snapshot.status,
    currentNode: reference(snapshot.currentNodeId),
    backStack: snapshot.backStack.map(reference),
    state: snapshot.state,
    recentSignals: snapshot.recentSignals.map((record) => ({
      nodeId: record.nodeId,
      signal: record.signal,
      ...(record.edgeId ? { edgeId: record.edgeId } : {}),
      ...(record.targetNodeId ? { targetNodeId: record.targetNodeId } : {}),
      followed: record.edgeId !== undefined,
      at: record.at,
    })),
    stateChanges: [...stateChanges],
    errors: snapshot.errors,
    save: snapshot.save,
  };
}

/** A State value as short text for a table cell. */
export function formatStateValue(value: JsonValue | undefined): string {
  return value === undefined ? "—" : JSON.stringify(value);
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
