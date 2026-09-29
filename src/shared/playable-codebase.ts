import { Check } from "typebox/value";
import { EDITOR_LAYOUT_SCHEMA } from "./editor-layout-schema.js";
import { PLAYABLE_SHELL_ID, type NodeGraph } from "./playable-nodes.js";

export interface NodeEditorLayout {
  version: 1;
  /** Canvas positions by Node ID; the Shell's card is under `PLAYABLE_SHELL_ID`. */
  nodes: Record<string, { x: number; y: number }>;
  viewport: { x: number; y: number; zoom: number };
  view: "canvas" | "code";
}

export interface NodeCodebase {
  graph: NodeGraph;
  editorLayout: NodeEditorLayout;
}

export interface NodeCodebaseUpdate extends NodeCodebase {
  sources?: Record<string, string>;
  sourceDeletions?: string[];
}

export function isNodeEditorLayout(
  value: unknown,
): value is NodeEditorLayout {
  return Check(EDITOR_LAYOUT_SCHEMA, value);
}

/** Every Node has a position and nothing else does, except an optional one for the Shell. */
export function playableLayoutMatchesGraph(
  graph: NodeGraph,
  layout: NodeEditorLayout,
): boolean {
  const graphIds = new Set(graph.nodes.map((node) => node.id));
  const layoutIds = Object.keys(layout.nodes).filter((id) => !(graph.shell && id === PLAYABLE_SHELL_ID));
  return (
    layoutIds.length === graphIds.size &&
    layoutIds.every((id) => graphIds.has(id))
  );
}
