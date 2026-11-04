import type { CanvasSyncScope } from "../shared/canvas-workspace.js";
import { streamSnapshots } from "./api.js";
import { isDesktopClosing } from "./desktop-save.js";

type Listener = (scopes: CanvasSyncScope[]) => void;
const projects = new Map<string, { controller: AbortController; listeners: Set<Listener> }>();

export function followCanvasChanges(projectId: string, scope: CanvasSyncScope, refresh: () => Promise<void>) {
  let active = true;
  let running = false;
  let dirty = false;
  // Loading a workspace also restores its drafts, including in a background window.
  let needsInitialLoad = scope === "workspace";
  const reconcile = async () => {
    dirty = true;
    if (running) return;
    running = true;
    try {
      while (active && dirty && (needsInitialLoad || !document.hidden) && !isDesktopClosing()) {
        needsInitialLoad = false;
        dirty = false;
        await refresh().catch(() => {});
      }
    } finally { running = false; }
  };
  const listener: Listener = (scopes) => { if (scopes.includes(scope)) void reconcile(); };
  let project = projects.get(projectId);
  if (!project) {
    const listeners = new Set<Listener>();
    const controller = new AbortController();
    project = { controller, listeners };
    projects.set(projectId, project);
    void streamSnapshots<CanvasSyncScope[]>(`/projects/${encodeURIComponent(projectId)}/canvas/events`, controller.signal,
      (scopes) => { for (const notify of listeners) notify(scopes); });
  }
  project.listeners.add(listener);
  void reconcile();
  const timer = window.setInterval(reconcile, 60_000);
  document.addEventListener("visibilitychange", reconcile);
  return () => {
    active = false;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", reconcile);
    project.listeners.delete(listener);
    if (!project.listeners.size) {
      project.controller.abort();
      projects.delete(projectId);
    }
  };
}
