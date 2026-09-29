import {
  playableEdgeForSignal,
  playableNodeById,
  playableSignalsOf,
} from "./playable-graph.js";
import {
  PLAYABLE_SHELL_ID,
  type NodeGraph,
  type PlayableNavigationMode,
} from "./playable-nodes.js";

export interface PlayableNavigationState {
  currentNodeId: string;
  backStack: string[];
}

export class PlayableNavigationError extends Error {
  constructor(
    readonly code:
      | "unknown-node"
      | "unknown-signal"
      | "unconnected-signal"
      | "empty-back-stack"
      | "invalid-mode",
    message: string,
  ) {
    super(message);
    this.name = "PlayableNavigationError";
  }
}

export function createPlayableNavigation(
  graph: NodeGraph,
): PlayableNavigationState {
  if (!playableNodeById(graph, graph.entryNodeId)) {
    throw new PlayableNavigationError(
      "unknown-node",
      `Entry Node "${graph.entryNodeId}" does not exist.`,
    );
  }
  return { currentNodeId: graph.entryNodeId, backStack: [] };
}

/**
 * Follows the edge of a Signal. The current Node emits by default; the Shell
 * emits its own Signals with `source` set to `PLAYABLE_SHELL_ID`.
 */
export function navigatePlayableSignal(
  graph: NodeGraph,
  state: PlayableNavigationState,
  signal: string,
  source: string = state.currentNodeId,
): PlayableNavigationState {
  if (!playableNodeById(graph, state.currentNodeId))
    throw new PlayableNavigationError(
      "unknown-node",
      `Current Node "${state.currentNodeId}" does not exist.`,
    );
  const owner = source === PLAYABLE_SHELL_ID ? "The Shell" : `Node "${source}"`;
  if (!playableSignalsOf(graph, source)?.some((candidate) => candidate.id === signal)) {
    throw new PlayableNavigationError(
      "unknown-signal",
      `${owner} did not declare Signal "${signal}".`,
    );
  }
  const edge = playableEdgeForSignal(graph, source, signal);
  if (!edge)
    throw new PlayableNavigationError(
      "unconnected-signal",
      `Signal "${source}.${signal}" has no Edge.`,
    );
  if (!playableNodeById(graph, edge.targetNodeId)) {
    throw new PlayableNavigationError(
      "unknown-node",
      `Edge "${edge.id}" targets missing Node "${edge.targetNodeId}".`,
    );
  }
  return navigateToNode(state, edge.targetNodeId, edge.mode);
}

export function navigatePlayableBack(
  state: PlayableNavigationState,
): PlayableNavigationState {
  if (state.backStack.length === 0)
    throw new PlayableNavigationError(
      "empty-back-stack",
      "Navigation back stack is empty.",
    );
  return {
    currentNodeId: state.backStack[state.backStack.length - 1]!,
    backStack: state.backStack.slice(0, -1),
  };
}

function navigateToNode(
  state: PlayableNavigationState,
  targetNodeId: string,
  mode: PlayableNavigationMode,
): PlayableNavigationState {
  if (mode !== "replace" && mode !== "push") {
    throw new PlayableNavigationError(
      "invalid-mode",
      `Navigation mode "${String(mode)}" is not supported.`,
    );
  }
  return {
    currentNodeId: targetNodeId,
    backStack:
      mode === "push"
        ? [...state.backStack, state.currentNodeId]
        : [...state.backStack],
  };
}
