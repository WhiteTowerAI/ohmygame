import { ArrowDownUp, FolderPlus, LoaderCircle, RefreshCw, Search, X } from "./icons.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectAgentActivity, ProjectState, ProjectType } from "../shared/contracts.js";
import { deleteProject, duplicateProject, listProjectActivity, listProjects, renameProject, waitForRuntime } from "./api.js";
import { ProjectCard } from "./project-card.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { ProjectRenameDialog } from "./project-rename-dialog.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import { projectsHash, type AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { PROJECT_TYPES } from "./project-types.js";

interface ProjectsPageProps {
  projectType?: ProjectType | "all";
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string, view?: "design") => void;
}

type ProjectSort = "updated" | "name";

export function ProjectsPage({ projectType = "all", onNavigate, onOpenProject }: ProjectsPageProps) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [activity, setActivity] = useState<ProjectAgentActivity[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("updated");
  const [sortOpen, setSortOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectState>();
  const renameTrigger = useRef<HTMLElement | null>(null);
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
    if (phase !== "ready") return;
    const controller = new AbortController();
    let pending = false;
    async function refreshActivity(): Promise<void> {
      if (pending || document.hidden || controller.signal.aborted) return;
      pending = true;
      try {
        const current = await listProjectActivity(controller.signal);
        if (!controller.signal.aborted) setActivity((previous) => (
          previous.length === current.length && previous.every((item, index) => (
            item.projectId === current[index]?.projectId && item.status === current[index]?.status
          )) ? previous : current
        ));
      } catch {
        // Keep the last state during a temporary runtime disconnect.
      } finally {
        pending = false;
      }
    }
    void refreshActivity();
    const timer = window.setInterval(() => { void refreshActivity(); }, 2_000);
    const refresh = () => { void refreshActivity(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [phase]);
  useEffect(() => {
    if (!sortOpen) return;
    const close = (event: MouseEvent) => {
      if (!sortControl.current?.contains(event.target as Node)) setSortOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sortOpen]);

  const visibleProjects = useMemo(() => filterAndSortProjects(projects, query, sort, projectType), [projects, query, sort, projectType]);

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setActionError(undefined);
    try {
      await action();
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  function rename(project: ProjectState, input: string): void {
    const name = input.trim();
    if (!name || name === project.name) return;
    void runAction(() => renameProject(project.id, name));
  }

  function duplicate(project: ProjectState): void {
    void runAction(() => duplicateProject(project.id));
  }

  function remove(project: ProjectState): void {
    if (!window.confirm(projectDeletionConfirmation(project))) return;
    void runAction(() => deleteProject(project.id));
  }

  return (
    <SidebarPageLayout active="projects" onNavigate={onNavigate}>
      <SidebarPageHeader
        title="Projects"
        actions={(
          <div className="projects-controls">
            <select className="projects-type-filter" aria-label="Project type" value={projectType} onChange={(event) => {
              const type = event.target.value as ProjectType | "all";
              window.location.hash = projectsHash(type === "all" ? undefined : type);
            }}>
              <option value="all">All types</option>
              {PROJECT_TYPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>
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
        )}
      />

      {phase === "loading" ? <ProjectState><LoaderCircle className="spin" size={18} />Loading projects</ProjectState> : null}
      {phase === "error" ? <ProjectState error><X size={18} />{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button></ProjectState> : null}
      {phase === "ready" ? (
        <div className="projects-grid">
          <button className="project-card project-card-new" type="button" onClick={() => setCreateOpen(true)}>
            <span className="project-card-new-art"><FolderPlus size={24} /></span>
            <span className="project-card-copy"><strong>New project</strong><span>Start from an idea</span></span>
          </button>
          {visibleProjects.map((project, index) => (
            <ProjectCard
              key={project.id}
              project={project}
              agentStatus={activity.find((item) => item.projectId === project.id)?.status}
              fallback={index % 4}
              onOpen={() => onOpenProject(project.id)}
              actions={{ onRename: () => {
                renameTrigger.current = document.querySelector<HTMLElement>('.project-card-menu[aria-expanded="true"]');
                setRenameTarget(project);
              }, onDuplicate: () => duplicate(project), onDelete: () => remove(project), ...(project.type !== "asset-canvas" ? { onDesign: () => onOpenProject(project.id, "design") } : {}) }}
            />
          ))}
        </div>
      ) : null}
      {phase === "ready" && projects.length > 0 && visibleProjects.length === 0 ? <ProjectState><FolderPlus size={18} />No projects match your search</ProjectState> : null}
      {actionError ? <p className="projects-notice" role="alert">{actionError}</p> : null}
      {renameTarget ? <ProjectRenameDialog name={renameTarget.name} returnFocus={renameTrigger.current} onClose={() => setRenameTarget(undefined)} onConfirm={(name) => {
        const project = renameTarget;
        setRenameTarget(undefined);
        rename(project, name);
      }} /> : null}
      {createOpen ? <ProjectCreateDialog initialType={projectType === "all" ? "web-game" : projectType} onClose={() => setCreateOpen(false)} onCreated={(project) => {
        setCreateOpen(false);
        onOpenProject(project.id);
      }} /> : null}
    </SidebarPageLayout>
  );
}

export function filterAndSortProjects(projects: ProjectState[], query: string, sort: ProjectSort, type: ProjectType | "all" = "all"): ProjectState[] {
  const normalized = query.trim().toLowerCase();
  return projects
    .filter((project) => type === "all" || project.type === type)
    .filter((project) => !normalized || project.name.toLowerCase().includes(normalized))
    .sort((left, right) => sort === "name"
      ? left.name.localeCompare(right.name)
      : right.updatedAt.localeCompare(left.updatedAt));
}

function ProjectState({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <div className={`projects-state${error ? " projects-state-error" : ""}`} role={error ? "alert" : undefined}>{children}</div>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
