import { Check } from "typebox/value";
import { EDITOR_LAYOUT_SCHEMA } from "./editor-layout-schema.js";
import type { NodeGraph } from "./playable-nodes.js";

export interface NodeEditorLayout {
  version: 1;
  /** Canvas positions by Node ID. */
  nodes: Record<string, { x: number; y: number }>;
  viewport: { x: number; y: number; zoom: number };
  view: "canvas" | "code";
}

export interface NodeCodebase {
  graph: NodeGraph;
  editorLayout: NodeEditorLayout;
}

/** A codebase as read from disk. */
export interface NodeCodebaseDetail extends NodeCodebase {
  /** Identifies the graph.json and editor/layout.json this was read from. */
  revision: string;
}

export interface NodeCodebaseUpdate extends NodeCodebase {
  sources?: Record<string, string>;
  sourceDeletions?: string[];
  /** The revision the update was made from. The write is refused when the files changed since. */
  revision?: string;
}

export function isNodeEditorLayout(
  value: unknown,
): value is NodeEditorLayout {
  return Check(EDITOR_LAYOUT_SCHEMA, value);
}

/** Every Node has a position and nothing else does. */
export function playableLayoutMatchesGraph(
  graph: NodeGraph,
  layout: NodeEditorLayout,
): boolean {
  const graphIds = new Set(graph.nodes.map((node) => node.id));
  const layoutIds = Object.keys(layout.nodes);
  return (
    layoutIds.length === graphIds.size &&
    layoutIds.every((id) => graphIds.has(id))
  );
}

const COLUMN_WIDTH = 340;
const ROW_HEIGHT = 260;
const COLUMNS = 4;

/** The next grid slot that no Node occupies. */
export function freePlayablePosition(layout: NodeEditorLayout): { x: number; y: number } {
  const taken = new Set(
    Object.values(layout.nodes).map((position) => `${position.x}:${position.y}`),
  );
  for (let slot = 0; ; slot += 1) {
    const candidate = {
      x: 80 + (slot % COLUMNS) * COLUMN_WIDTH,
      y: 180 + Math.floor(slot / COLUMNS) * ROW_HEIGHT,
    };
    if (!taken.has(`${candidate.x}:${candidate.y}`)) return candidate;
  }
}

/**
 * Fits the layout to the graph: a Node the Agent added without a position
 * gets a free one, and positions of removed Nodes are dropped.
 */
export function fitPlayableLayout(
  graph: NodeGraph,
  layout: NodeEditorLayout,
): NodeEditorLayout {
  if (playableLayoutMatchesGraph(graph, layout)) return layout;
  const fitted: NodeEditorLayout = { ...layout, nodes: {} };
  for (const node of graph.nodes) {
    const position = layout.nodes[node.id];
    if (position) fitted.nodes[node.id] = position;
  }
  for (const node of graph.nodes) {
    fitted.nodes[node.id] ??= freePlayablePosition(fitted);
  }
  return fitted;
}

/** Whether two graphs hold the same data, whatever order their keys are written in. */
export function samePlayableGraph(left: NodeGraph, right: NodeGraph): boolean {
  return sameJson(left, right);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftValues = left as Record<string, unknown>;
  const rightValues = right as Record<string, unknown>;
  // A key that holds undefined is not written to the file.
  const leftKeys = Object.keys(leftValues).filter((key) => leftValues[key] !== undefined);
  const rightKeys = Object.keys(rightValues).filter((key) => rightValues[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => sameJson(leftValues[key], rightValues[key]));
}

/**
 * Carries the editor's unsaved change over to a codebase that changed on disk
 * since `base` was read. Keeps the graph changed on either side and only the
 * layout fields the editor changed. Refuses different graph edits on both sides.
 */
export function rebasePlayableCodebase(
  base: NodeCodebase,
  local: NodeCodebase,
  remote: NodeCodebase,
): NodeCodebase | undefined {
  const localGraphChanged = !samePlayableGraph(local.graph, base.graph);
  if (localGraphChanged && !samePlayableGraph(remote.graph, base.graph) && !samePlayableGraph(local.graph, remote.graph)) return undefined;
  const graph = localGraphChanged ? local.graph : remote.graph;
  const nodes: NodeEditorLayout["nodes"] = {};
  for (const node of graph.nodes) {
    const before = base.editorLayout.nodes[node.id];
    const ours = local.editorLayout.nodes[node.id];
    const theirs = remote.editorLayout.nodes[node.id];
    const moved = ours && (!before || ours.x !== before.x || ours.y !== before.y);
    const position = moved ? ours : theirs ?? ours;
    if (position) nodes[node.id] = position;
  }
  return {
    graph,
    editorLayout: fitPlayableLayout(graph, {
      ...remote.editorLayout,
      nodes,
      viewport: sameJson(local.editorLayout.viewport, base.editorLayout.viewport) ? remote.editorLayout.viewport : local.editorLayout.viewport,
      view: local.editorLayout.view === base.editorLayout.view ? remote.editorLayout.view : local.editorLayout.view,
    }),
  };
}
