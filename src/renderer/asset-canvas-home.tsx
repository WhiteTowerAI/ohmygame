import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Image, Plus, RefreshCw } from "./icons.js";
import { useEffect, useRef, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { ProjectRenameDialog } from "./project-rename-dialog.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import type { AppNavigationTarget } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { useProjectActivity } from "./use-project-activity.js";
import { t } from "./i18n.js";

export function AssetCanvasHome({ onNavigate, onOpenProject }: {
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string, initialNodeId?: string) => void;
}) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const activity = useProjectActivity(phase === "ready" && projects.length > 0, setProjects);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectState>();
  const renameTrigger = useRef<HTMLElement | null>(null);

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

  useEffect(() => { void load(); }, [serviceGeneration]);

  async function action(run: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await run();
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  return <main className="home-shell">
    <AppSidebar active="asset-canvas" onNavigate={onNavigate} />
    <section className="home-content asset-canvas-home">
      <WindowDragRegion />
      <div className="asset-canvas-home-inner">
        <button className="asset-canvas-primary-create" type="button" onClick={() => setCreateOpen(true)}>
          <span className="asset-canvas-primary-icon"><Plus size={24} /></span>
          <span><strong>{t("assetCanvasHome.new")}</strong><small>{t("assetCanvasHome.newHint")}</small></span>
        </button>

        <section className="home-discover asset-canvas-recent" aria-labelledby="recent-asset-canvases-heading">
          <div className="home-section-heading">
            <h2 id="recent-asset-canvases-heading">{t("assetCanvasHome.recent")}</h2>
            {phase === "error" ? <button type="button" onClick={() => void load()}><RefreshCw size={14} />{t("common.retry")}</button> : null}
          </div>
          {phase === "loading" ? <AssetCanvasRecentSkeleton /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{error}</p> : null}
          {phase === "ready" && !projects.length ? <div className="asset-canvas-empty"><Image size={18} /><span>{t("assetCanvasHome.none")}</span></div> : null}
          {phase === "ready" && projects.length ? <div className="home-project-grid home-recent-projects-grid">
            {projects.map((project) => <ProjectCard
              key={project.id}
              project={project}
              agentStatus={activity.get(project.id)}
              onOpen={() => onOpenProject(project.id)}
              actions={{
                onRename: () => {
                  renameTrigger.current = document.querySelector<HTMLElement>('.project-card-menu[aria-expanded="true"]');
                  setRenameTarget(project);
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
    {renameTarget ? <ProjectRenameDialog name={renameTarget.name} returnFocus={renameTrigger.current} onClose={() => setRenameTarget(undefined)} onConfirm={(input) => {
      const project = renameTarget;
      setRenameTarget(undefined);
      const name = input.trim();
      if (name && name !== project.name) void action(() => renameProject(project.id, name));
    }} /> : null}
    {createOpen ? <ProjectCreateDialog fixedType="asset-canvas" onClose={() => setCreateOpen(false)} onCreated={(project) => { setCreateOpen(false); onOpenProject(project.id); }} /> : null}
  </main>;
}

function AssetCanvasRecentSkeleton() {
  return <div className="home-project-grid home-recent-projects-grid" aria-label={t("assetCanvasHome.loading")}>
    {Array.from({ length: 4 }, (_, index) => <div className="project-card home-project-skeleton" key={index} />)}
  </div>;
}

export function recentAssetCanvasProjects(projects: readonly ProjectState[]): ProjectState[] {
  return projects.filter((project) => project.type === "asset-canvas").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 8);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
