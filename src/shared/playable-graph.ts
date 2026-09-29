import {
  PLAYABLE_SHELL_ID,
  type PlayableEdge,
  type NodeGraph,
  type PlayableNode,
  type PlayableSignal,
} from "./playable-nodes.js";

export function playableNodeById(
  graph: NodeGraph,
  nodeId: string,
): PlayableNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

export function playableEdgeForSignal(
  graph: NodeGraph,
  nodeId: string,
  signal: string,
): PlayableEdge | undefined {
  return graph.edges.find(
    (edge) => edge.source.nodeId === nodeId && edge.source.signal === signal,
  );
}

/**
 * The Signals a surface declares: a Node's, or the Shell's for
 * `PLAYABLE_SHELL_ID`. Undefined when the surface does not exist.
 */
export function playableSignalsOf(
  graph: NodeGraph,
  surfaceId: string,
): readonly PlayableSignal[] | undefined {
  if (surfaceId === PLAYABLE_SHELL_ID) return graph.shell?.signals;
  return playableNodeById(graph, surfaceId)?.signals;
}

export function playableOutgoingEdges(
  graph: NodeGraph,
  nodeId: string,
): PlayableEdge[] {
  return graph.edges.filter((edge) => edge.source.nodeId === nodeId);
}
