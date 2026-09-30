import type {
  PlayableEdge,
  NodeGraph,
  PlayableNode,
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

export function playableOutgoingEdges(
  graph: NodeGraph,
  nodeId: string,
): PlayableEdge[] {
  return graph.edges.filter((edge) => edge.source.nodeId === nodeId);
}
