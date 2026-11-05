import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFile } from "../shared/contracts.js";
import { listWorkspaceFiles } from "./api.js";

/** Code loads the root and open folders, while search explicitly asks for the complete index. */
export function useWorkspaceFiles(projectId: string | undefined, revision: number, selectedPath?: string, enabled = true) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ projectId?: string; key?: string; files: WorkspaceFile[]; loading: boolean; error?: string }>({ files: [], loading: true });
  const cache = useRef<{ projectId?: string; revision: number; reload: number; directories: Map<string, Promise<WorkspaceFile[]>>; all?: Promise<WorkspaceFile[]> }>({ revision, reload, directories: new Map() });
  // A child whose parent is closed is retained in the tree cache but is not refreshed.
  const directories = new Set([""]);
  for (const folder of open) {
    const parents = folder.split("/").slice(0, -1);
    if (parents.every((_, index) => open.has(parents.slice(0, index + 1).join("/")))) directories.add(folder);
  }
  if (selectedPath) {
    const parts = selectedPath.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const directoryKey = JSON.stringify([...directories].sort());
  const key = JSON.stringify([projectId, revision, reload, directoryKey, searching]);

  useEffect(() => { setOpen(new Set()); setSearching(false); }, [projectId]);
  useEffect(() => {
    if (!projectId || !enabled) {
      cache.current = { projectId, revision, reload, directories: new Map() };
      return;
    }
    let disposed = false;
    if (cache.current.projectId !== projectId || cache.current.revision !== revision || cache.current.reload !== reload) {
      cache.current = { projectId, revision, reload, directories: new Map() };
    }
    const current = cache.current;
    setState((previous) => ({ projectId, key, files: previous.projectId === projectId ? previous.files : [], loading: true }));
    async function load() {
      if (searching) {
        current.all ??= listWorkspaceFiles(projectId!);
        try { return await current.all; }
        catch (cause) { current.all = undefined; throw cause; }
      }
      const requested = JSON.parse(directoryKey) as string[];
      const lists = await Promise.all(requested.map(async (directory) => {
        let promise = current.directories.get(directory);
        if (!promise) {
          promise = listWorkspaceFiles(projectId!, directory);
          current.directories.set(directory, promise);
        }
        try { return await promise; }
        catch (cause) {
          current.directories.delete(directory);
          // A removed folder must disappear, rather than leave its old children in the tree.
          if (directory && cause instanceof Error && "status" in cause && cause.status === 404) return [];
          throw cause;
        }
      }));
      const byDirectory = new Map(requested.map((directory, index) => [directory, lists[index]!]));
      const files: WorkspaceFile[] = [];
      function append(directory: string) {
        for (const file of byDirectory.get(directory) ?? []) {
          files.push(file);
          if (file.directory) append(file.path);
        }
      }
      append("");
      return files;
    }
    void load().then((files) => {
      if (!disposed) setState({ projectId, key, files, loading: false });
    }, (cause) => {
      if (!disposed) setState((previous) => ({ ...previous, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
    });
    return () => { disposed = true; };
  }, [projectId, revision, reload, directoryKey, searching, enabled, key]);

  const toggle = useCallback((directory: string, expanded: boolean) => {
    setOpen((previous) => {
      if (previous.has(directory) === expanded) return previous;
      const next = new Set(previous);
      if (expanded) next.add(directory);
      else next.delete(directory);
      return next;
    });
  }, []);
  const search = useCallback((term: string) => setSearching(Boolean(term.trim())), []);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const files = useMemo(() => state.projectId === projectId ? state.files : [], [state.projectId, state.files, projectId]);
  return { files, loading: state.key !== key || state.loading, error: state.projectId === projectId ? state.error : undefined, toggle, search, refresh };
}
