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

/**
 * Carries the editor's unsaved change over to a codebase that changed on disk
 * since `base` was read. Only a layout change can be carried: the positions
 * the editor moved, its viewport, and its view are kept on the graph from
 * disk. Undefined when the editor changed the graph too.
 */
export function rebasePlayableLayout(
  base: NodeCodebase,
  local: NodeCodebase,
  remote: NodeCodebase,
): NodeCodebase | undefined {
  if (JSON.stringify(local.graph) !== JSON.stringify(base.graph)) return undefined;
  const nodes: NodeEditorLayout["nodes"] = {};
  for (const node of remote.graph.nodes) {
    const before = base.editorLayout.nodes[node.id];
    const ours = local.editorLayout.nodes[node.id];
    const theirs = remote.editorLayout.nodes[node.id];
    const moved = ours && (!before || ours.x !== before.x || ours.y !== before.y);
    const position = moved ? ours : theirs ?? ours;
    if (position) nodes[node.id] = position;
  }
  return {
    graph: remote.graph,
    editorLayout: fitPlayableLayout(remote.graph, { ...local.editorLayout, nodes }),
  };
}
