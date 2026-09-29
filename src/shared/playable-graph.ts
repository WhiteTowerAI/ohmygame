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

export function playableDestinationNode(
  graph: NodeGraph,
  destination: string,
): PlayableNode | undefined {
  const nodeId = graph.destinations[destination];
  return nodeId === undefined ? undefined : playableNodeById(graph, nodeId);
}

export function playableOutgoingEdges(
  graph: NodeGraph,
  nodeId: string,
): PlayableEdge[] {
  return graph.edges.filter((edge) => edge.source.nodeId === nodeId);
}
