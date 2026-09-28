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
