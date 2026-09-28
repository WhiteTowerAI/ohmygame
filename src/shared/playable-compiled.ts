import type { PlayableGraph } from "./playable-nodes.js";

export interface CompiledPlayableSurface {
  id: string;
  html: string;
  css: string;
  javascript: string;
  /** Workspace-relative source files included in this surface. */
  inputs: string[];
}

export interface CompiledPlayableGraph {
  version: 1;
  nodes: Record<string, CompiledPlayableSurface>;
  shell?: CompiledPlayableSurface;
}

export function isCompiledPlayableGraph(
  value: unknown,
  graph: PlayableGraph,
): value is CompiledPlayableGraph {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.nodes))
    return false;
  const nodes = value.nodes;
  if (!hasOnlyKeys(value, graph.shell ? ["version", "nodes", "shell"] : ["version", "nodes"]))
    return false;

  const expectedNodeIds = graph.nodes.map((node) => node.id).sort();
  const compiledNodeIds = Object.keys(nodes).sort();
  if (
    expectedNodeIds.length !== compiledNodeIds.length ||
    expectedNodeIds.some((id, index) => id !== compiledNodeIds[index])
  )
    return false;
  if (
    compiledNodeIds.some((id) => !isCompiledPlayableSurface(nodes[id], id))
  )
    return false;

  return graph.shell
    ? isCompiledPlayableSurface(value.shell, "shell")
    : value.shell === undefined;
}

function isCompiledPlayableSurface(
  value: unknown,
  expectedId: string,
): value is CompiledPlayableSurface {
  return isRecord(value) &&
    hasOnlyKeys(value, ["id", "html", "css", "javascript", "inputs"]) &&
    value.id === expectedId &&
    typeof value.html === "string" &&
    typeof value.css === "string" &&
    typeof value.javascript === "string" &&
    Array.isArray(value.inputs) &&
    value.inputs.every((input) => typeof input === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
