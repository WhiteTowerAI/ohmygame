import { Plus, RefreshCw } from "./icons.js";
import { useEffect, useState } from "react";
import type { ProjectState, PromptImage, PromptMode } from "../shared/contracts.js";
import { deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";

const RECENT_DRAMA_LIMIT = 4;

export function InteractiveDramaHome({ onNavigate, onCreate, onOpenProject }: {
  onNavigate: (page: AppNavigationTarget) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, images: PromptImage[], mode: PromptMode) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);

  async function load(): Promise<void> {
    setPhase("loading");
    setLoadError(undefined);
    try {
      await waitForRuntime();
      setProjects(recentInteractiveDramaProjects(await listProjects()));
      setPhase("ready");
    } catch (cause) {
      setLoadError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setActionError(undefined);
    try {
      await action();
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  function rename(project: ProjectState): void {
    const name = window.prompt("Rename project", project.name)?.trim();
    if (!name || name === project.name) return;
    void runAction(() => renameProject(project.id, name));
  }

  function duplicate(project: ProjectState): void {
    void runAction(() => duplicateProject(project.id));
  }

  function remove(project: ProjectState): void {
    if (!window.confirm(`Delete “${project.name}”? This cannot be undone.`)) return;
    void runAction(() => deleteProject(project.id));
  }

  return (
    <main className="home-shell">
      <AppSidebar active="interactive-drama" onNavigate={onNavigate} />
      <section className="home-content interactive-drama-home">
        <WindowDragRegion />
        <div className="home-start">
          <h1>What story are we making today?</h1>
          <ProjectPromptCreator
            projectType="interactive-drama"
            placeholder="Describe the interactive drama you want to create..."
            onCreate={onCreate}
          />
          <button className="interactive-drama-start-blank" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />Start blank
          </button>
        </div>

        <section className="home-discover interactive-drama-recent" aria-labelledby="recent-dramas-heading">
          <div className="home-section-heading">
            <h2 id="recent-dramas-heading">Recent dramas</h2>
            {phase === "error" ? (
              <button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button>
            ) : null}
          </div>
          {phase === "loading" ? <DramaGridSkeleton /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{loadError}</p> : null}
          {phase === "ready" && projects.length === 0 ? <p className="home-project-state">No dramas yet</p> : null}
          {phase === "ready" && projects.length > 0 ? (
            <div className="home-project-grid">
              {projects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  fallback={index % 4}
                  onOpen={() => onOpenProject(project.id)}
                  actions={{ onRename: () => rename(project), onDuplicate: () => duplicate(project), onDelete: () => remove(project) }}
                />
              ))}
            </div>
          ) : null}
          {actionError ? <p className="home-notice" role="alert">{actionError}</p> : null}
        </section>
      </section>
      {createOpen ? <ProjectCreateDialog fixedType="interactive-drama" onClose={() => setCreateOpen(false)} onCreated={(project) => {
        setCreateOpen(false);
        onOpenProject(project.id);
      }} /> : null}
    </main>
  );
}

export function recentInteractiveDramaProjects(projects: readonly ProjectState[]): ProjectState[] {
  return projects
    .filter((project) => project.type === "interactive-drama")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RECENT_DRAMA_LIMIT);
}

function DramaGridSkeleton() {
  return (
    <div className="home-project-grid" aria-label="Loading dramas">
      {[0, 1, 2, 3].map((item) => <div className="project-card home-project-skeleton" key={item} />)}
    </div>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
