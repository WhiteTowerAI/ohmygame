import type { NodeGraphValidationIssue } from "./playable-graph-validation.js";
import type { NodeGraph } from "./playable-nodes.js";
import type { NodePlayerDefinition } from "./playable-player-protocol.js";

export interface PlayableProjectValidationIssue {
  phase: "graph" | "compiler";
  code: NodeGraphValidationIssue["code"] | "invalid-json" | "missing-graph" | string;
  path: string;
  message: string;
  /** Node ID, or `"shell"`, when the issue belongs to one surface. */
  surfaceId?: string;
}

export interface PlayableProjectValidationResult {
  ok: boolean;
  missing?: boolean;
  issues: PlayableProjectValidationIssue[];
  definition?: NodePlayerDefinition;
}

/** A Preset as offered to the editor's add-node menu. */
export interface PlayablePresetSummary {
  id: string;
  label: string;
  brief: string;
  signals: string[];
}

export interface PlayableAddedNode {
  id: string;
  title: string;
  preset: string;
  files: string[];
  signals: string[];
  brief: string;
}

export function renamePlayableSignal(
  graph: NodeGraph,
  nodeId: string,
  oldId: string,
  newId: string,
): NodeGraph {
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
  graph: NodeGraph,
  nodeId: string,
  signalId: string,
): NodeGraph {
  const next = structuredClone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return graph;
  node.signals = node.signals.filter((signal) => signal.id !== signalId);
  next.edges = next.edges.filter((edge) => edge.source.nodeId !== nodeId || edge.source.signal !== signalId);
  return next;
}
