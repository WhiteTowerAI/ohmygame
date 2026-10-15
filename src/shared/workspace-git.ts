import type { CheckpointChangeItem, CheckpointFileView } from "./contracts.js";

/** Current workspace changes against HEAD, independent of turn checkpoints. */
export interface WorkspaceGitChange extends Pick<
  CheckpointChangeItem,
  "path" | "kind" | "lines"
> {
  untracked?: boolean;
  conflicted?: boolean;
}

export interface WorkspaceGitChanges {
  available: boolean;
  /** Absent before the first commit or when Git is unavailable. */
  head?: string;
  changes: WorkspaceGitChange[];
}

export interface WorkspaceGitFileView extends CheckpointFileView {
  /** Links and submodules are listed without reading their targets. */
  unsupported?: boolean;
}
