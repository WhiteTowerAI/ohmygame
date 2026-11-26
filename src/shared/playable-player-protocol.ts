import type { NodeGraph } from "./playable-nodes.js";

/** A story as the editor built it: its graph, checked, and what each Scene shows. */
export interface NodePlayerDefinition {
  version: 1;
  graph: NodeGraph;
  graphSignature: string;
  /** Each Scene's content hash, by Node ID; see `checkPlayableSources`. */
  hashes: Record<string, string>;
}
