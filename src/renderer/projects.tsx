import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Archive, FilePlus, Import, LayoutGrid, List, LoaderCircle, Plus, RefreshCw } from "./icons.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectState, ProjectType } from "../shared/contracts.js";
import { importProject, listProjects, waitForRuntime } from "./api.js";
import { PROJECT_ARCHIVE_MAX_BYTES } from "../shared/project-archive.js";
import { hasTransferredFiles } from "./file-transfer.js";
import { ProjectCard, ProjectRow, useProjectActions } from "./project-card.js";
import { pickProjectFolder, ProjectCreateDialog } from "./project-create-dialog.js";
import { createdProjectView, type AppNavigationTarget, type ProjectListFilters, type ProjectSort } from "./routes.js";
import { publishRecentProjects, takeProjectSearchFocus } from "./app-sidebar.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { PROJECT_TYPES } from "./project-types.js";
import { useProjectActivity } from "./use-project-activity.js";
import { Button, DropdownMenu, SearchInput, SegmentedControl, Select, Tooltip, type MenuEntry } from "./ui/index.js";
import { t } from "./i18n.js";
import "./projects.css";

interface ProjectsPageProps {
  projectType?: ProjectType | "all";
  query?: string;
  sort?: ProjectSort;
  onFiltersChange: (filters: ProjectListFilters, replace?: boolean) => void;
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string, view?: "design") => void;
}

type Layout = "grid" | "list";
const LAYOUT_STORAGE_KEY = "ohmygame:projects-layout";

/** What the new-project dialog opens with, if it is open. */
interface CreateRequest {
  workspacePath?: string;
}

// Every project, as covers or as a list. Search, type and sort live in the
// route; the layout is the person's and stays in this browser.
export function ProjectsPage({ projectType = "all", query = "", sort = "updated", onFiltersChange, onNavigate, onOpenProject }: ProjectsPageProps) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const activity = useProjectActivity(phase === "ready" && projects.length > 0, setProjects);
  // Renames, removals and automatic names reach the sidebar too.
  useEffect(() => { if (phase === "ready") publishRecentProjects(projects); }, [phase, projects]);
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [focusSearch] = useState(takeProjectSearchFocus);
  const search = useRef<HTMLDivElement>(null);
  const [actionError, setActionError] = useState<string>();
  const [creating, setCreating] = useState<CreateRequest>();
  const [importing, setImporting] = useState(false);
  // Block another import before React commits the busy state.
  const importPending = useRef(false);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const importInput = useRef<HTMLInputElement>(null);
  const projectActions = useProjectActions(load);
  const canImportFolder = !!window.ohMyGameDesktop?.selectProjectDirectory;

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      const loaded = await listProjects();
      setProjects(loaded);
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, [serviceGeneration]);
  useEffect(() => {
    if (focusSearch) search.current?.querySelector("input")?.focus();
  }, [focusSearch]);

  const visibleProjects = useMemo(() => filterAndSortProjects(projects, query, sort, projectType), [projects, query, sort, projectType]);
  const filters = { projectType: projectType === "all" ? undefined : projectType, query, sort };
  const filtered = !!query.trim() || projectType !== "all";

  function changeLayout(next: Layout): void {
    setLayout(next);
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, next); } catch {}
  }

  async function importArchive(file: File): Promise<void> {
    if (importPending.current) return;
    if (!/\.zip$/i.test(file.name)) {
      setActionError(t("projects.importChooseZip"));
      return;
    }
    if (file.size > PROJECT_ARCHIVE_MAX_BYTES) {
      setActionError(t("projects.importTooLarge"));
      return;
    }
    importPending.current = true;
    setImporting(true);
    setActionError(undefined);
    try {
      await importProject(file);
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      importPending.current = false;
      setImporting(false);
    }
  }

  // An existing folder opens its project if it has one, or becomes a new project's workspace.
  async function importFolder(): Promise<void> {
    setActionError(undefined);
    try {
      const picked = await pickProjectFolder();
      if (!picked) return;
      if ("owner" in picked) onOpenProject(picked.owner.id);
      else setCreating({ workspacePath: picked.path });
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  const newMenu: MenuEntry[] = [
    { label: t("projects.newItem"), icon: <FilePlus size={14} />, onSelect: () => setCreating({}) },
    ...(canImportFolder ? [{ label: t("projects.importFolder"), icon: <Import size={14} />, onSelect: () => void importFolder() }] : []),
    {
      label: importing ? t("projects.importing") : t("projects.importArchive"),
      description: t("projects.importHint"),
      icon: importing ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />,
      disabled: importing,
      onSelect: () => importInput.current?.click(),
    },
  ];

  const lists = layout === "grid" ? (
    <div className="projects-grid">
      {visibleProjects.map((project) => (
        <ProjectCard key={project.id} project={project} agentStatus={activity.get(project.id)}
          onOpen={() => onOpenProject(project.id)} actions={projectActions.actionsFor(project)} />
      ))}
    </div>
  ) : (
    <div className="projects-list" role="list" aria-label={t("projects.title")}>
      <div className="projects-list-head" aria-hidden="true">
        <span />
        <span>{t("common.name")}</span>
        <span>{t("projects.type")}</span>
        <span>{t("projects.updated")}</span>
      </div>
      {visibleProjects.map((project) => (
        <div key={project.id} role="listitem">
          <ProjectRow project={project} agentStatus={activity.get(project.id)}
            onOpen={() => onOpenProject(project.id)} actions={projectActions.actionsFor(project)} />
        </div>
      ))}
    </div>
  );

  return (
    <SidebarPageLayout active="projects" onNavigate={onNavigate}>
      <div
        className="projects-import-region"
        onDragEnter={(event) => {
          if (!hasTransferredFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current++;
          if (!importPending.current) setDropActive(true);
        }}
        onDragOver={(event) => {
          if (!hasTransferredFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = importPending.current ? "none" : "copy";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDropActive(false);
        }}
        onDrop={(event) => {
          if (!hasTransferredFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDropActive(false);
          if (importPending.current) return;
          const { files, items } = event.dataTransfer;
          const directory = [...items].some((item) => item.webkitGetAsEntry?.()?.isDirectory);
          if (files.length !== 1 || directory) {
            setActionError(t("projects.importChooseZip"));
            return;
          }
          void importArchive(files[0]!);
        }}
      >
        <SidebarPageHeader
          title={t("projects.title")}
          actions={(
            <div className="projects-controls">
              <div className="projects-search" ref={search}>
                {/* The sidebar's Search focuses this field by its id. */}
                <SearchInput id="projects-search-input" value={query} label={t("projects.search")} placeholder={t("projects.search")}
                  onChange={(value) => onFiltersChange({ ...filters, query: value }, true)} />
              </div>
              <Select<ProjectType | "all"> label={t("creator.projectType")} value={projectType}
                onChange={(type) => onFiltersChange({ ...filters, projectType: type === "all" ? undefined : type })}
                options={[{ value: "all", label: t("projects.allTypes") }, ...PROJECT_TYPES.map(({ value, label }) => ({ value, label }))]} />
              <Select<ProjectSort> label={t("projects.sort")} value={sort}
                onChange={(next) => onFiltersChange({ ...filters, sort: next }, true)}
                options={[{ value: "updated", label: t("projects.recentlyUpdated") }, { value: "name", label: t("common.name") }]} />
              <SegmentedControl<Layout> label={t("projects.layout")} value={layout} onChange={changeLayout}
                options={[
                  { value: "grid", label: <LayoutIcon label={t("projects.grid")}><LayoutGrid size={14} /></LayoutIcon> },
                  { value: "list", label: <LayoutIcon label={t("projects.list")}><List size={14} /></LayoutIcon> },
                ]} />
              <DropdownMenu placement="bottom-end" items={newMenu} trigger={(props) => (
                <Button {...props} variant="primary" icon={<Plus size={14} />}>{t("projects.new")}</Button>
              )} />
              <input ref={importInput} type="file" accept=".zip,application/zip" hidden aria-label={t("projects.importArchive")} onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importArchive(file);
              }} />
            </div>
          )}
        />

        {actionError || projectActions.error ? <p className="projects-notice" role="alert">{actionError ?? projectActions.error}</p> : null}
        {phase === "loading" && !projects.length ? (
          <div className="projects-grid" aria-busy="true" aria-label={t("projects.loading")}>
            {Array.from({ length: 8 }, (_, index) => <span className="projects-skeleton" key={index} />)}
          </div>
        ) : null}
        {phase === "error" ? (
          <div className="projects-empty" role="alert">
            <p>{error}</p>
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>{t("common.retry")}</Button>
          </div>
        ) : null}
        {phase === "ready" && visibleProjects.length === 0 ? (
          <div className="projects-empty">
            <p>{projects.length ? t("projects.noMatch") : t("projects.none")}</p>
            {projects.length && filtered
              ? <Button size="sm" onClick={() => onFiltersChange({ sort })}>{t("projects.clearFilters")}</Button>
              : <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating({})}>{t("projects.new")}</Button>}
          </div>
        ) : null}
        {phase !== "error" && visibleProjects.length > 0 ? lists : null}
        {dropActive ? <div className="projects-drop-overlay" role="status"><div className="projects-drop-message"><Import size={28} /><span>{t("projects.importDropHint")}</span></div></div> : null}
      </div>
      {projectActions.dialogs}
      {creating ? <ProjectCreateDialog
        initialType={projectType === "all" ? "web-game" : projectType}
        initialWorkspacePath={creating.workspacePath}
        onClose={() => setCreating(undefined)}
        onOpenProject={(projectId) => { setCreating(undefined); onOpenProject(projectId); }}
        onCreated={(project) => {
          setCreating(undefined);
          onOpenProject(project.id, createdProjectView(project.type));
        }}
      /> : null}
    </SidebarPageLayout>
  );
}

/** An icon-only segment, named for screen readers and in a tooltip. */
function LayoutIcon({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip content={label}><span className="projects-layout-icon" role="img" aria-label={label}>{children}</span></Tooltip>;
}

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
