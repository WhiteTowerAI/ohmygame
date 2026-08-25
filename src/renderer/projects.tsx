import { ArrowDownUp, FolderPlus, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectState, ProjectType } from "../shared/contracts.js";
import { createProject, deleteProject, duplicateProject, listProjects, renameProject, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ProjectCard } from "./project-card.js";
import type { SidebarPage } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";

interface ProjectsPageProps {
  onNavigate: (page: SidebarPage) => void;
  onOpenProject: (projectId: string) => void;
  workspace?: ProjectType;
}

type ProjectSort = "updated" | "name";

export function ProjectsPage({ onNavigate, onOpenProject, workspace = "general" }: ProjectsPageProps) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("updated");
  const [sortOpen, setSortOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const sortControl = useRef<HTMLDivElement>(null);

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      setProjects(await listProjects());
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!sortOpen) return;
    const close = (event: MouseEvent) => {
      if (!sortControl.current?.contains(event.target as Node)) setSortOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sortOpen]);

  const workspaceProjects = useMemo(() => filterProjectsByType(projects, workspace), [projects, workspace]);
  const visibleProjects = useMemo(() => filterAndSortProjects(workspaceProjects, query, sort), [workspaceProjects, query, sort]);

  async function create(): Promise<void> {
    if (creating) return;
    setActionError(undefined);
    setCreating(true);
    try {
      const project = await createProject({ type: workspace });
      onOpenProject(project.id);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  }

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
      <AppSidebar active={workspace === "interactive-drama" ? "interactive-drama" : "projects"} onNavigate={onNavigate} />
      <section className="projects-content">
        <WindowDragRegion />
        <header className="projects-header window-drag-handle">
          <h1>{workspace === "interactive-drama" ? "Interactive Drama" : "Projects"}</h1>
          <div className="projects-controls">
            <label className="projects-search" htmlFor="projects-search-input">
              <Search size={14} aria-hidden="true" />
              <input id="projects-search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" />
            </label>
            <div className="projects-sort" ref={sortControl}>
              <button className="projects-icon-button" type="button" aria-label="Sort projects" aria-expanded={sortOpen} onClick={() => setSortOpen((current) => !current)}>
                <ArrowDownUp size={16} />
              </button>
              {sortOpen ? (
                <div className="projects-sort-menu" role="menu">
                  <button className={sort === "updated" ? "is-active" : undefined} type="button" role="menuitem" onClick={() => { setSort("updated"); setSortOpen(false); }}>Recently updated</button>
                  <button className={sort === "name" ? "is-active" : undefined} type="button" role="menuitem" onClick={() => { setSort("name"); setSortOpen(false); }}>Name</button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {phase === "loading" ? <ProjectState><LoaderCircle className="spin" size={18} />Loading projects</ProjectState> : null}
        {phase === "error" ? <ProjectState error><X size={18} />{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button></ProjectState> : null}
        {phase === "ready" ? (
          <div className="projects-grid">
            <button className="project-card project-card-new" type="button" disabled={creating} onClick={() => void create()}>
              <span className="project-card-new-art">{creating ? <LoaderCircle className="spin" size={24} /> : <FolderPlus size={24} />}</span>
              <span className="project-card-copy"><strong>New project</strong><span>Start from an idea</span></span>
            </button>
            {visibleProjects.map((project, index) => (
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
        {phase === "ready" && workspaceProjects.length > 0 && visibleProjects.length === 0 ? <ProjectState><FolderPlus size={18} />No projects match your search</ProjectState> : null}
        {actionError ? <p className="projects-notice" role="alert">{actionError}</p> : null}
      </section>
    </main>
  );
}

export function filterAndSortProjects(projects: ProjectState[], query: string, sort: ProjectSort): ProjectState[] {
  const normalized = query.trim().toLowerCase();
  return projects
    .filter((project) => !normalized || project.name.toLowerCase().includes(normalized))
    .sort((left, right) => sort === "name"
      ? left.name.localeCompare(right.name)
      : right.updatedAt.localeCompare(left.updatedAt));
}

export function filterProjectsByType(projects: ProjectState[], type: ProjectType): ProjectState[] {
  return projects.filter((project) => project.type === type);
}

function ProjectState({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <div className={`projects-state${error ? " projects-state-error" : ""}`} role={error ? "alert" : undefined}>{children}</div>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
