import { Plus, RefreshCw } from "./icons.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PluginMention, ProjectState, ProjectType, PromptAttachment, PromptImage, PromptMode } from "../shared/contracts.js";
import { deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { ExampleShelf, useExamples } from "./examples.js";
import { AppSidebar } from "./app-sidebar.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { ProjectRenameDialog } from "./project-rename-dialog.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import { GAME_PROJECT_TYPES } from "./project-types.js";
import { projectsHash, type AppNavigationTarget } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import "./studios.css";

interface HomeProps {
  onNavigate: (page: AppNavigationTarget) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments?: PromptAttachment[]) => void;
  onOpen: (projectId: string) => void;
}

const RECENT_PROJECT_LIMIT = 4;

export function Home({ onNavigate, onCreate, onOpen }: HomeProps) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [exampleLimit, setExampleLimit] = useState(RECENT_PROJECT_LIMIT);
  const [projectActionError, setProjectActionError] = useState<string>();
  const [projectType, setProjectType] = useState<ProjectType>("web-game");
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectState>();
  const renameTrigger = useRef<HTMLElement | null>(null);
  const { examples, covers: exampleCovers } = useExamples();
  const exploreSection = useRef<HTMLElement>(null);

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
    const section = exploreSection.current;
    if (!section) return;
    const updateLimit = () => {
      const styles = getComputedStyle(section);
      const minWidth = Number.parseFloat(styles.getPropertyValue("--recent-project-min-width"));
      const gap = Number.parseFloat(styles.getPropertyValue("--recent-project-gap"));
      if (!minWidth || Number.isNaN(gap)) return;
      const columns = Math.floor((section.clientWidth + gap) / (minWidth + gap));
      setExampleLimit(Math.max(1, Math.min(RECENT_PROJECT_LIMIT, columns)));
    };
    updateLimit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateLimit);
    observer.observe(section);
    return () => observer.disconnect();
  }, [examples.length]);
  async function rename(project: ProjectState, input: string) {
    const name = input.trim();
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

  const visibleProjects = projects.slice(0, RECENT_PROJECT_LIMIT);
  const visibleExamples = examples.slice(0, exampleLimit);

  return (
    <main className="home-shell">
      <AppSidebar active="home" onNavigate={onNavigate} />

      <section className="home-content home-content-fitted">
        <WindowDragRegion />
        <div className="home-start">
          <h1>What are we making today?</h1>
          <ProjectPromptCreator
            projectType={projectType}
            projectTypes={GAME_PROJECT_TYPES}
            placeholder="Describe the game you want to create..."
            onProjectTypeChange={setProjectType}
            onOpenProject={onOpen}
            onCreate={onCreate}
          />
          <button className="home-start-blank" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />Start blank
          </button>
        </div>

        <section className="home-recent studio-projects" aria-labelledby="projects-heading">
          <div className="studio-section-heading">
            <h2 id="projects-heading">Recent projects</h2>
            {phase === "error" ? (
              <button className="studio-text-link" type="button" onClick={() => void loadProjects()}>
                <RefreshCw size={14} />Retry
              </button>
            ) : projects.length > RECENT_PROJECT_LIMIT ? (
              <a className="studio-text-link" href={projectsHash()}>Show all</a>
            ) : null}
          </div>

          {phase === "loading" ? <ProjectGridSkeleton /> : null}
          {phase === "error" ? <p className="home-project-state" role="alert">{loadError}</p> : null}
          {phase === "ready" && projects.length === 0 ? (
            <p className="home-project-state">
              No projects yet
            </p>
          ) : null}
          {phase === "ready" && projects.length > 0 ? (
            <div className="studio-project-grid">
              {visibleProjects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  fallback={index % 4}
                  onOpen={() => onOpen(project.id)}
                  actions={{ onRename: () => {
                    renameTrigger.current = document.querySelector<HTMLElement>('.project-card-menu[aria-expanded="true"]');
                    setRenameTarget(project);
                  }, onDuplicate: () => void duplicate(project), onDelete: () => void remove(project) }}
                />
              ))}
            </div>
          ) : null}
          {projectActionError ? <p className="home-notice" role="alert">{projectActionError}</p> : null}
        </section>
        {visibleExamples.length > 0 ? <section ref={exploreSection} className="home-discover home-explore" aria-labelledby="home-examples-heading">
          <div className="home-section-heading"><h2 id="home-examples-heading">Explore</h2></div>
          <ExampleShelf examples={visibleExamples} covers={exampleCovers} showType onOpenProject={onOpen} />
        </section> : null}
      </section>
      {renameTarget ? <ProjectRenameDialog name={renameTarget.name} returnFocus={renameTrigger.current} onClose={() => setRenameTarget(undefined)} onConfirm={(name) => {
        const project = renameTarget;
        setRenameTarget(undefined);
        void rename(project, name);
      }} /> : null}
      {createOpen ? <ProjectCreateDialog initialType={projectType} projectTypes={GAME_PROJECT_TYPES} onClose={() => setCreateOpen(false)} onCreated={(project) => {
        setCreateOpen(false);
        onOpen(project.id);
      }} /> : null}
    </main>
  );
}

function ProjectGridSkeleton() {
  return (
    <div className="studio-project-grid" aria-label="Loading projects">
      {Array.from({ length: RECENT_PROJECT_LIMIT }, (_, item) => <div className="studio-project-skeleton" key={item} />)}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
