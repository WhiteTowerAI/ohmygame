import { getLibraryAsset, getWorkspaceAsset } from "./api.js";

interface FileRead {
  users: number;
  request: AbortController;
  result: Promise<string>;
  url?: string;
}
const reads = new Map<string, FileRead>();

/** One object URL for the thumbnail and any detail view still reading this model. */
export function acquireModelFile(
  project: string | undefined,
  path: string,
  asset: string | undefined,
  revision: number,
) {
  const key = JSON.stringify(asset ? [asset] : [project, path, revision]);
  let entry = reads.get(key);
  if (!entry) {
    const request = new AbortController();
    const file = asset
      ? getLibraryAsset(asset, request.signal)
      : getWorkspaceAsset(project!, path, request.signal);
    const created: FileRead = {
      users: 0,
      request,
      result: file.then((blob) => {
        request.signal.throwIfAborted();
        return (created.url = URL.createObjectURL(blob));
      }),
    };
    reads.set(key, created);
    entry = created;
  }
  const current = entry;
  current.users++;
  return {
    result: current.result,
    release() {
      if (--current.users) return;
      reads.delete(key);
      current.request.abort();
      if (current.url) URL.revokeObjectURL(current.url);
    },
  };
}
