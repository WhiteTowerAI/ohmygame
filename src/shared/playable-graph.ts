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

/**
 * A project may have no Nodes, and then its Entry Node names nothing. Once it
 * has Nodes, the Entry Node must be one of them: when it is not, the first
 * Node becomes the Start. The editor and playable_add_node both keep the
 * graph this way.
 */
export function withPlayableEntry<T extends Pick<NodeGraph, "entryNodeId" | "nodes">>(graph: T): T {
  const [first] = graph.nodes;
  if (!first || graph.nodes.some((node) => node.id === graph.entryNodeId)) return graph;
  return { ...graph, entryNodeId: first.id };
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
