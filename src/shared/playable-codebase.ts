import { Check } from "typebox/value";
import { EDITOR_LAYOUT_SCHEMA } from "./editor-layout-schema.js";
import type { PlayableGraph } from "./playable-nodes.js";

export interface PlayableEditorLayout {
  version: 1;
  nodes: Record<string, { x: number; y: number }>;
  viewport: { x: number; y: number; zoom: number };
  view: "canvas" | "code";
}

export interface PlayableCodebase {
  graph: PlayableGraph;
  editorLayout: PlayableEditorLayout;
}

export function isPlayableEditorLayout(
  value: unknown,
): value is PlayableEditorLayout {
  return Check(EDITOR_LAYOUT_SCHEMA, value);
}

export function playableLayoutMatchesGraph(
  graph: PlayableGraph,
  layout: PlayableEditorLayout,
): boolean {
  const graphIds = new Set(graph.nodes.map((node) => node.id));
  const layoutIds = Object.keys(layout.nodes);
  return (
    layoutIds.length === graphIds.size &&
    layoutIds.every((id) => graphIds.has(id))
  );
}
