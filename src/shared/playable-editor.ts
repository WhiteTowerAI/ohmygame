import type { PlayableGraph } from "./playable-nodes.js";

export function renamePlayableSignal(
  graph: PlayableGraph,
  nodeId: string,
  oldId: string,
  newId: string,
): PlayableGraph {
  const next = structuredClone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || !newId || node.signals.some((signal) => signal.id === newId && signal.id !== oldId)) {
    return graph;
  }
  node.signals = node.signals.map((signal) => signal.id === oldId ? { ...signal, id: newId } : signal);
  next.edges = next.edges.map((edge) => edge.source.nodeId === nodeId && edge.source.signal === oldId
    ? { ...edge, source: { ...edge.source, signal: newId } }
    : edge);
  return next;
}

export function deletePlayableSignal(
  graph: PlayableGraph,
  nodeId: string,
  signalId: string,
): PlayableGraph {
  const next = structuredClone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return graph;
  node.signals = node.signals.filter((signal) => signal.id !== signalId);
  next.edges = next.edges.filter((edge) => edge.source.nodeId !== nodeId || edge.source.signal !== signalId);
  return next;
}
