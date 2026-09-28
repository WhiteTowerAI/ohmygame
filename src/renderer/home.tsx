import { Plus, RefreshCw } from "./icons.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PluginMention, ProjectState, ProjectType, PromptImage, PromptMode } from "../shared/contracts.js";
import { deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import { GAME_PROJECT_TYPES, ProjectTypeIcon } from "./project-types.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";

interface HomeProps {
  onNavigate: (page: AppNavigationTarget) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode) => void;
  onOpen: (projectId: string) => void;
}

const RECENT_PROJECT_MAX_COLUMNS = 4;
const WHATS_NEW_ITEM = {
  title: "Interactive Drama is here",
  page: "interactive-drama" as SidebarPage,
};

export function Home({ onNavigate, onCreate, onOpen }: HomeProps) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [recentProjectLimit, setRecentProjectLimit] = useState(RECENT_PROJECT_MAX_COLUMNS);
  const [projectActionError, setProjectActionError] = useState<string>();
  const [projectType, setProjectType] = useState<ProjectType>("interactive-drama");
  const [createOpen, setCreateOpen] = useState(false);
  const recentProjectsSection = useRef<HTMLElement>(null);

  async function loadProjects() {
    setPhase("loading");
    setLoadError(undefined);
    try {
      await waitForRuntime();
      setProjects(await listProjects());
      setPhase("ready");
    } catch (error) {
      setLoadError(errorMessage(error));
      setPhase("error");
    }
  }

  useEffect(() => { void loadProjects(); }, []);
  useLayoutEffect(() => {
    const section = recentProjectsSection.current;
    if (!section) return;
    const updateLimit = () => {
      const styles = getComputedStyle(section);
      const minWidth = Number.parseFloat(styles.getPropertyValue("--recent-project-min-width"));
      const gap = Number.parseFloat(styles.getPropertyValue("--recent-project-gap"));
      if (!minWidth || Number.isNaN(gap)) return;
      const columns = Math.floor((section.clientWidth + gap) / (minWidth + gap));
      setRecentProjectLimit(Math.max(1, Math.min(RECENT_PROJECT_MAX_COLUMNS, columns)));
    };
    updateLimit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateLimit);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  async function rename(project: ProjectState) {
    const name = window.prompt("Rename project", project.name)?.trim();
    if (!name || name === project.name) return;
    await runProjectAction(() => renameProject(project.id, name));
  }

  async function duplicate(project: ProjectState) {
    await runProjectAction(() => duplicateProject(project.id));
  }

  async function remove(project: ProjectState) {
    if (!window.confirm(projectDeletionConfirmation(project))) return;
    await runProjectAction(() => deleteProject(project.id));
  }

  async function runProjectAction(action: () => Promise<unknown>) {
    setProjectActionError(undefined);
    try {
      await action();
      await loadProjects();
    } catch (error) {
      setProjectActionError(errorMessage(error));
    }
  }

  const visibleProjects = showAllProjects ? projects : projects.slice(0, recentProjectLimit);

  return (
    <main className="home-shell">
      <AppSidebar active="home" onNavigate={onNavigate} />

      <section className="home-content">
        <WindowDragRegion />
        <div className="home-start">
          <h1>What are we making today?</h1>
          <div className="home-category-control" role="group" aria-label="Project examples">
            {GAME_PROJECT_TYPES.map(({ label, value }) => (
              <button
                className={value === projectType ? "is-active" : ""}
                type="button"
                aria-pressed={value === projectType}
                key={value}
                onClick={() => setProjectType(value)}
              >
                <ProjectTypeIcon type={value} />
                {label}
              </button>
            ))}
          </div>
          <ProjectPromptCreator
            projectType={projectType}
            projectTypes={GAME_PROJECT_TYPES}
            placeholder="Describe the game you want to create..."
            onProjectTypeChange={setProjectType}
            onCreate={onCreate}
          />
          <button className="home-start-blank" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />Start blank
          </button>
        </div>

        <section ref={recentProjectsSection} className="home-discover" aria-labelledby="whats-new-heading">
          <div className="home-section-heading">
            <h2 id="whats-new-heading">What's New</h2>
          </div>
          <div className="home-whats-new-grid">
            <button className="home-whats-new-item" type="button" onClick={() => onNavigate(WHATS_NEW_ITEM.page)}>
              <span className="home-whats-new-icon" aria-hidden="true" />
              <span className="home-whats-new-copy">
                <strong>{WHATS_NEW_ITEM.title}</strong>
              </span>
            </button>
          </div>

          <div className="home-section-heading home-project-heading">
            <h2 id="projects-heading">Recent projects</h2>
            {phase === "error" ? (
              <button type="button" onClick={() => void loadProjects()}>
                <RefreshCw size={14} />Retry
              </button>
            ) : projects.length > recentProjectLimit ? (
              <button className="home-show-all" type="button" onClick={() => setShowAllProjects((current) => !current)}>
                {showAllProjects ? "Show less" : "Show all"}
              </button>
            ) : null}
          </div>

          {phase === "loading" ? <ProjectGridSkeleton count={recentProjectLimit} /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{loadError}</p> : null}
          {phase === "ready" && projects.length === 0 ? (
            <p className="home-project-state">No projects yet</p>
          ) : null}
          {phase === "ready" && projects.length > 0 ? (
            <div className="home-project-grid home-recent-projects-grid">
              {visibleProjects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  fallback={index % 4}
                  onOpen={() => onOpen(project.id)}
                  actions={{ onRename: () => void rename(project), onDuplicate: () => void duplicate(project), onDelete: () => void remove(project) }}
                />
              ))}
            </div>
          ) : null}
          {projectActionError ? <p className="home-notice" role="alert">{projectActionError}</p> : null}
        </section>
      </section>
      {createOpen ? <ProjectCreateDialog initialType={projectType} projectTypes={GAME_PROJECT_TYPES} onClose={() => setCreateOpen(false)} onCreated={(project) => {
        setCreateOpen(false);
        onOpen(project.id);
      }} /> : null}
    </main>
  );
}

function ProjectGridSkeleton({ count }: { count: number }) {
  return (
    <div className="home-project-grid home-recent-projects-grid" aria-label="Loading projects">
      {Array.from({ length: count }, (_, item) => <div className="project-card home-project-skeleton" key={item} />)}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
