const versions = new Map<string, string>();
export const workspaceVersion = (id: string): string => versions.get(id) ?? "0";
export function observeWorkspaceVersion(id: string, version: string): void {
  versions.set(id, version);
}
export interface WorkspaceRequestInit extends RequestInit {
  workspaceVersion?: string;
}

/** An editor keeps the version it opened with, including in delayed saves. */
export function assertWorkspaceVersion(id: string, version: string): void {
  if (workspaceVersion(id) !== version)
    throw Object.assign(
      new Error(
        "The workspace was restored. This editor's draft can no longer be saved.",
      ),
      { status: 409, code: "workspace_stale" },
    );
}
