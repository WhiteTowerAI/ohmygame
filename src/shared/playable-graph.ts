import type {
  PlayableEdge,
  PlayableGraph,
  PlayableNode,
} from "./playable-nodes.js";

export function playableNodeById(
  graph: PlayableGraph,
  nodeId: string,
): PlayableNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

export function playableEdgeForSignal(
  graph: PlayableGraph,
  nodeId: string,
  signal: string,
): PlayableEdge | undefined {
  return graph.edges.find(
    (edge) => edge.source.nodeId === nodeId && edge.source.signal === signal,
  );
}

export function playableDestinationNode(
  graph: PlayableGraph,
  destination: string,
): PlayableNode | undefined {
  const nodeId = graph.destinations[destination];
  return nodeId === undefined ? undefined : playableNodeById(graph, nodeId);
}

export function playableOutgoingEdges(
  graph: PlayableGraph,
  nodeId: string,
): PlayableEdge[] {
  return graph.edges.filter((edge) => edge.source.nodeId === nodeId);
}
