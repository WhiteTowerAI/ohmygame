import { playableEdgeForSignal, playableNodeById } from "./playable-graph.js";
import type { NodeGraph, PlayableNavigationMode } from "./playable-nodes.js";

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
  if (!graph.nodes.length) {
    throw new PlayableNavigationError(
      "unknown-node",
      "The project has no Scenes yet. Add a Scene to play it.",
    );
  }
  if (!playableNodeById(graph, graph.entryNodeId)) {
    throw new PlayableNavigationError(
      "unknown-node",
      `Entry Node "${graph.entryNodeId}" does not exist.`,
    );
  }
  return { currentNodeId: graph.entryNodeId, backStack: [] };
}

export function navigatePlayableSignal(
  graph: NodeGraph,
  state: PlayableNavigationState,
  signal: string,
): PlayableNavigationState {
  const node = playableNodeById(graph, state.currentNodeId);
  if (!node)
    throw new PlayableNavigationError(
      "unknown-node",
      `Current Node "${state.currentNodeId}" does not exist.`,
    );
  if (!node.signals.some((candidate) => candidate.id === signal)) {
    throw new PlayableNavigationError(
      "unknown-signal",
      `Node "${node.id}" did not declare Signal "${signal}".`,
    );
  }
  const edge = playableEdgeForSignal(graph, node.id, signal);
  if (!edge)
    throw new PlayableNavigationError(
      "unconnected-signal",
      `Signal "${node.id}.${signal}" has no Edge.`,
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
