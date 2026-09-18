import { Plus, RefreshCw } from "./icons.js";
import { useEffect, useState } from "react";
import type { PluginMention, ProjectState, ProjectType, PromptImage, PromptMode } from "../shared/contracts.js";
import { deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import { PROJECT_TYPES, ProjectTypeIcon } from "./project-types.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import dialogueDirector from "./assets/home/dialogue-director.svg";

interface HomeProps {
  onNavigate: (page: AppNavigationTarget) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode) => void;
  onOpen: (projectId: string) => void;
}

const RECENT_PROJECT_LIMIT = 4;
const WHATS_NEW_ITEM = {
  title: "Interactive Drama is here",
  image: dialogueDirector,
  page: "interactive-drama" as SidebarPage,
};

export function Home({ onNavigate, onCreate, onOpen }: HomeProps) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [projectActionError, setProjectActionError] = useState<string>();
  const [projectType, setProjectType] = useState<ProjectType>("interactive-drama");
  const [createOpen, setCreateOpen] = useState(false);

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

  const visibleProjects = showAllProjects ? projects : projects.slice(0, RECENT_PROJECT_LIMIT);

  return (
    <main className="home-shell">
      <AppSidebar active="home" onNavigate={onNavigate} />

      <section className="home-content">
        <WindowDragRegion />
        <div className="home-start">
          <h1>What are we making today?</h1>
          <fieldset className="home-category-control">
            <legend className="visually-hidden">Project type</legend>
            {PROJECT_TYPES.map(({ label, value }) => (
              <label
                className={value === projectType ? "is-active" : ""}
                key={value}
              >
                <input
                  className="visually-hidden"
                  type="radio"
                  name="home-project-type"
                  value={value}
                  checked={value === projectType}
                  onChange={() => setProjectType(value)}
                />
                <ProjectTypeIcon type={value} />
                {label}
              </label>
            ))}
          </fieldset>
          <ProjectPromptCreator
            projectType={projectType}
            placeholder="Describe the game you want to create..."
            onProjectTypeChange={setProjectType}
            onCreate={onCreate}
          />
          <button className="home-start-blank" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />Start blank
          </button>
        </div>

        <section className="home-discover" aria-labelledby="whats-new-heading">
          <div className="home-section-heading">
            <h2 id="whats-new-heading">What's New</h2>
          </div>
          <div className="home-whats-new-grid">
            <button className="home-whats-new-item" type="button" onClick={() => onNavigate(WHATS_NEW_ITEM.page)}>
              <span className="home-whats-new-icon"><img src={WHATS_NEW_ITEM.image} alt="" /></span>
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
            ) : projects.length > RECENT_PROJECT_LIMIT ? (
              <button className="home-show-all" type="button" onClick={() => setShowAllProjects((current) => !current)}>
                {showAllProjects ? "Show less" : "Show all"}
              </button>
            ) : null}
          </div>

          {phase === "loading" ? <ProjectGridSkeleton /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{loadError}</p> : null}
          {phase === "ready" && projects.length === 0 ? (
            <p className="home-project-state">No projects yet</p>
          ) : null}
          {phase === "ready" && projects.length > 0 ? (
            <div className="home-project-grid">
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
      {createOpen ? <ProjectCreateDialog initialType={projectType} onClose={() => setCreateOpen(false)} onCreated={(project) => {
        setCreateOpen(false);
        onOpen(project.id);
      }} /> : null}
    </main>
  );
}

function ProjectGridSkeleton() {
  return (
    <div className="home-project-grid" aria-label="Loading projects">
      {[0, 1, 2, 3].map((item) => <div className="project-card home-project-skeleton" key={item} />)}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
