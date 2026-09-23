import { Image, Plus, RefreshCw } from "./icons.js";
import { useEffect, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import type { AppNavigationTarget } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";

export function AssetCanvasHome({ onNavigate, onOpenProject }: { onNavigate: (page: AppNavigationTarget) => void; onOpenProject: (projectId: string) => void }) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);

  async function load() {
    setPhase("loading");
    try {
      await waitForRuntime();
      setProjects(recentAssetCanvasProjects(await listProjects()));
      setError(undefined);
      setPhase("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    }
  }
  useEffect(() => { void load(); }, []);

  async function action(run: () => Promise<unknown>) {
    setActionError(undefined);
    try { await run(); await load(); } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <main className="home-shell">
    <AppSidebar active="asset-canvas" onNavigate={onNavigate} />
    <section className="home-content asset-canvas-home">
      <WindowDragRegion />
      <div className="home-start asset-canvas-start">
        <h1>What are we making today?</h1>
        <p className="home-start-subtitle">Build reusable assets and generation workflows on a canvas.</p>
        <button className="home-start-blank asset-canvas-create" type="button" onClick={() => setCreateOpen(true)}><Plus size={14} />New asset canvas</button>
      </div>
      <section className="home-discover asset-canvas-recent" aria-labelledby="recent-asset-canvases-heading">
        <div className="home-section-heading"><h2 id="recent-asset-canvases-heading">Recent asset canvases</h2>{phase === "error" ? <button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button> : null}</div>
        {phase === "loading" ? <p className="home-project-state">Loading asset canvases</p> : null}
        {phase === "error" ? <p className="home-project-state" role="alert">{error}</p> : null}
        {phase === "ready" && !projects.length ? <div className="asset-canvas-empty"><Image size={18} /><span>No asset canvases yet</span></div> : null}
        {phase === "ready" && projects.length ? <div className="home-project-grid">{projects.map((project, index) => <ProjectCard key={project.id} project={project} fallback={index % 4} onOpen={() => onOpenProject(project.id)} actions={{ onRename: () => { const name = window.prompt("Rename project", project.name)?.trim(); if (name && name !== project.name) void action(() => renameProject(project.id, name)); }, onDuplicate: () => void action(() => duplicateProject(project.id)), onDelete: () => { if (window.confirm(projectDeletionConfirmation(project))) void action(() => deleteProject(project.id)); } }} />)}</div> : null}
        {actionError ? <p className="home-notice" role="alert">{actionError}</p> : null}
      </section>
    </section>
    {createOpen ? <ProjectCreateDialog fixedType="asset-canvas" onClose={() => setCreateOpen(false)} onCreated={(project) => { setCreateOpen(false); onOpenProject(project.id); }} /> : null}
  </main>;
}

export function recentAssetCanvasProjects(projects: readonly ProjectState[]): ProjectState[] {
  return projects.filter((project) => project.type === "asset-canvas").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 8);
}
