import { Box, Film, Image, LoaderCircle, Plus, RefreshCw, type IconComponent } from "./icons.js";
import { useEffect, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import type { AssetCanvasStarter } from "../shared/asset-canvas.js";
import { deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ASSET_CANVAS_QUICK_STARTS, createAssetCanvasQuickStart, loadQuickStartModels, QuickStartModelUnavailableError, type AssetCanvasQuickStart } from "./asset-canvas-quick-start.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import type { AppNavigationTarget } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";

const QUICK_START_ICONS: Record<AssetCanvasStarter, IconComponent> = {
  image: Image,
  video: Film,
  "model-3d": Box,
};

export function AssetCanvasHome({ onNavigate, onOpenProject }: {
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string, initialNodeId?: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [creatingStarter, setCreatingStarter] = useState<string>();
  const [quickStartError, setQuickStartError] = useState<{ message: string; manageProviders: boolean }>();

  async function load() {
    setPhase("loading");
    try {
      await waitForRuntime();
      setProjects(recentAssetCanvasProjects(await listProjects()));
      setError(undefined);
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  // Picks up providers connected since the last visit, so a starter click rarely waits.
  useEffect(() => { void loadQuickStartModels(); }, []);

  async function action(run: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await run();
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  async function quickStart(item: AssetCanvasQuickStart): Promise<void> {
    if (creatingStarter) return;
    setCreatingStarter(item.key);
    setQuickStartError(undefined);
    try {
      const { project, nodeId } = await createAssetCanvasQuickStart(item);
      setCreatingStarter(undefined);
      onOpenProject(project.id, nodeId);
    } catch (cause) {
      setCreatingStarter(undefined);
      const manageProviders = cause instanceof QuickStartModelUnavailableError;
      setQuickStartError({ message: errorMessage(cause), manageProviders });
      if (!manageProviders) await load();
    }
  }

  return <main className="home-shell">
    <AppSidebar active="asset-canvas" onNavigate={onNavigate} />
    <section className="home-content asset-canvas-home">
      <WindowDragRegion />
      <div className="asset-canvas-home-inner">
        <button className="asset-canvas-primary-create" type="button" disabled={creatingStarter !== undefined} onClick={() => setCreateOpen(true)}>
          <span className="asset-canvas-primary-icon"><Plus size={24} /></span>
          <span><strong>New asset canvas</strong><small>Start with an empty workflow</small></span>
        </button>

        <section className="asset-canvas-quick-start" aria-labelledby="asset-canvas-quick-start-heading">
          <h2 id="asset-canvas-quick-start-heading">Quick start</h2>
          <div className="asset-canvas-quick-grid">
            {ASSET_CANVAS_QUICK_STARTS.map((item) => {
              const Icon = QUICK_START_ICONS[item.type];
              const creating = creatingStarter === item.key;
              return <button key={item.key} type="button" disabled={creatingStarter !== undefined} aria-busy={creating} onClick={() => void quickStart(item)}>
                <span className="asset-canvas-quick-icon">{creating ? <LoaderCircle className="spin" size={20} /> : <Icon size={20} />}</span>
                <strong title={item.label}>{item.label}</strong>
              </button>;
            })}
          </div>
          {quickStartError ? <p className="home-notice" role="alert">
            {quickStartError.message}
            {quickStartError.manageProviders ? <button type="button" onClick={() => onNavigate("settings")}>Manage providers</button> : null}
          </p> : null}
        </section>

        <section className="home-discover asset-canvas-recent" aria-labelledby="recent-asset-canvases-heading">
          <div className="home-section-heading">
            <h2 id="recent-asset-canvases-heading">Recent canvases</h2>
            {phase === "error" ? <button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button> : null}
          </div>
          {phase === "loading" ? <AssetCanvasRecentSkeleton /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{error}</p> : null}
          {phase === "ready" && !projects.length ? <div className="asset-canvas-empty"><Image size={18} /><span>No asset canvases yet</span></div> : null}
          {phase === "ready" && projects.length ? <div className="home-project-grid">
            {projects.map((project, index) => <ProjectCard
              key={project.id}
              project={project}
              fallback={index % 4}
              onOpen={() => onOpenProject(project.id)}
              actions={{
                onRename: () => {
                  const name = window.prompt("Rename project", project.name)?.trim();
                  if (name && name !== project.name) void action(() => renameProject(project.id, name));
                },
                onDuplicate: () => void action(() => duplicateProject(project.id)),
                onDelete: () => {
                  if (window.confirm(projectDeletionConfirmation(project))) void action(() => deleteProject(project.id));
                },
              }}
            />)}
          </div> : null}
          {actionError ? <p className="home-notice" role="alert">{actionError}</p> : null}
        </section>
      </div>
    </section>
    {createOpen ? <ProjectCreateDialog fixedType="asset-canvas" onClose={() => setCreateOpen(false)} onCreated={(project) => { setCreateOpen(false); onOpenProject(project.id); }} /> : null}
  </main>;
}

function AssetCanvasRecentSkeleton() {
  return <div className="home-project-grid" aria-label="Loading asset canvases">
    {Array.from({ length: 4 }, (_, index) => <div className="project-card home-project-skeleton" key={index} />)}
  </div>;
}

export function recentAssetCanvasProjects(projects: readonly ProjectState[]): ProjectState[] {
  return projects.filter((project) => project.type === "asset-canvas").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 8);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
