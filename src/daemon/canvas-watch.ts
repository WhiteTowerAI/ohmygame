import { lstatSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { CanvasSyncScope } from "../shared/canvas-workspace.js";

type Listener = (changed: CanvasSyncScope[]) => void;
const all: CanvasSyncScope[] = ["workspace", "board", "jobs"];

/** Share native watches between windows. Events invalidate snapshots, so a batch only needs each scope once. */
export function createCanvasWatches() {
  const projects = new Map<string, { listeners: Set<Listener>; close: () => void }>();
  return (workspace: string, listener: Listener) => {
    let project = projects.get(workspace);
    if (!project) {
      const listeners = new Set<Listener>();
      const close = watchWorkspace(workspace, (changed) => {
        for (const notify of listeners) notify(changed);
      });
      project = { listeners, close };
      projects.set(workspace, project);
    }
    project.listeners.add(listener);
    const unsubscribe = () => {
      if (!project!.listeners.delete(listener) || project!.listeners.size) return;
      project!.close();
      if (projects.get(workspace) === project) projects.delete(workspace);
    };
    try {
      // Snapshot after subscribing also covers changes made while no window was connected.
      listener(all);
    } catch (cause) {
      unsubscribe();
      throw cause;
    }
    return unsubscribe;
  };
}

function watchWorkspace(workspace: string, notify: Listener) {
  const watches = new Map<string, FSWatcher>();
  const pending = new Set<CanvasSyncScope>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  function changed(...scopes: CanvasSyncScope[]) {
    if (closed) return;
    for (const scope of scopes) pending.add(scope);
    timer ??= setTimeout(() => {
      timer = undefined;
      if (closed) return;
      const scopes = [...pending];
      pending.clear();
      notify(scopes);
    }, 75);
  }

  function attach(folder: "" | "canvas" | "assets") {
    watches.get(folder)?.close();
    watches.delete(folder);
    if (closed) return;
    try {
      const directory = path.join(workspace, folder);
      if (!lstatSync(directory).isDirectory()) return;
      const watcher = watch(directory, { recursive: !!folder, persistent: false }, (event, filename) => {
        if (closed) return;
        if (!filename) {
          if (!folder) { attach("canvas"); attach("assets"); }
          changed(...all);
          return;
        }
        const name = filename.replaceAll("\\", "/");
        if (!folder) {
          if (name === "canvas" || name === "assets") {
            if (event === "rename") attach(name);
            if (name === "canvas") changed(...all);
            else changed("workspace");
          }
        } else if (folder === "assets") changed("workspace");
        else if (name === "jobs.json") changed("jobs");
        else if (/^(boards|editor)(\/[^/]+\.json)?$/.test(name)) changed("board");
        else if (/^(documents|tables)(\/[^/]+\.(md|json))?$/.test(name) || name === "assets.json" || name === "index.json") changed("workspace");
      });
      watches.set(folder, watcher);
      watcher.on("error", () => {
        watcher.close();
        if (closed) return;
        changed(...all);
      });
    } catch { /* Missing directories can appear later. The client also reconciles periodically. */ }
  }
  attach("");
  attach("canvas");
  attach("assets");
  return () => {
    closed = true;
    clearTimeout(timer);
    timer = undefined;
    for (const watcher of watches.values()) watcher.close();
    watches.clear();
  };
}
