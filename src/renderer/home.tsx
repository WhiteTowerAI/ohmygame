import { ChevronLeft, ChevronRight, RefreshCw } from "./icons.js";
import { useEffect, useRef, useState } from "react";
import type { PluginMention, ProjectState, ProjectType, PromptImage, PromptMode } from "../shared/contracts.js";
import { deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ProjectCard } from "./project-card.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import { PROJECT_TYPES, ProjectTypeIcon } from "./project-types.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import playableCanvas from "./assets/home/playable-canvas.svg";
import cozyTown from "./assets/home/cozy-town.svg";
import dialogueDirector from "./assets/home/dialogue-director.svg";
import creatorWeek from "./assets/home/creator-week.svg";
import neonDrift from "./assets/home/neon-drift.svg";

interface HomeProps {
  onNavigate: (page: AppNavigationTarget) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode) => void;
  onOpen: (projectId: string) => void;
}

const RECENT_PROJECT_LIMIT = 4;
const WHATS_NEW = [
  { title: "Playable Canvas is here", image: playableCanvas, page: "home" as SidebarPage },
  { title: "Cozy Town Starter Kit", image: cozyTown, page: "library" as SidebarPage },
  { title: "Dialogue Director", image: dialogueDirector, page: "interactive-drama" as SidebarPage },
  { title: "Creator Week rewards", image: creatorWeek, page: "games" as SidebarPage },
  { title: "Neon Drift", image: neonDrift, page: "games" as SidebarPage },
];

export function Home({ onNavigate, onCreate, onOpen }: HomeProps) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [projectActionError, setProjectActionError] = useState<string>();
  const [projectType, setProjectType] = useState<ProjectType>("web-game");
  const [whatsNewScroll, setWhatsNewScroll] = useState({ canGoBack: false, canGoForward: false });
  const whatsNewRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => {
    const carousel = whatsNewRef.current;
    if (!carousel) return;
    const updateScrollState = () => {
      const maxScrollLeft = carousel.scrollWidth - carousel.clientWidth;
      const canGoBack = carousel.scrollLeft > 1;
      const canGoForward = carousel.scrollLeft < maxScrollLeft - 1;
      setWhatsNewScroll((current) => (
        current.canGoBack === canGoBack && current.canGoForward === canGoForward
          ? current
          : { canGoBack, canGoForward }
      ));
    };
    updateScrollState();
    carousel.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    return () => {
      carousel.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
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
    if (!window.confirm(`Delete “${project.name}”? This cannot be undone.`)) return;
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
        </div>

        <section className="home-discover" aria-labelledby="whats-new-heading">
          <div className="home-section-heading">
            <h2 id="whats-new-heading">What's New</h2>
            <div className="home-carousel-controls">
              <button type="button" aria-label="Previous What's New items" disabled={!whatsNewScroll.canGoBack} onClick={() => whatsNewRef.current?.scrollBy({ left: -244, behavior: "smooth" })}>
                <ChevronLeft size={14} />
              </button>
              <button type="button" aria-label="Next What's New items" disabled={!whatsNewScroll.canGoForward} onClick={() => whatsNewRef.current?.scrollBy({ left: 244, behavior: "smooth" })}>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <div className="home-whats-new-grid" ref={whatsNewRef}>
            {WHATS_NEW.map(({ title, image, page }) => (
              <button className="home-whats-new-item" key={title} type="button" onClick={() => onNavigate(page)}>
                <span className="home-whats-new-icon"><img src={image} alt="" /></span>
                <span className="home-whats-new-copy">
                  <strong>{title}</strong>
                </span>
              </button>
            ))}
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
