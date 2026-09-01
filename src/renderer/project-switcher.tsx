import { Check, ChevronDown, FolderPlus, LoaderCircle, Search, Wrench, X } from "./icons.js";
import { useEffect, useRef, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { listProjects } from "./api.js";
import { ProjectCreateDialog } from "./project-create-dialog.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";

export function ProjectSwitcher({ project, compact = false, onBeforeNavigate, onSelect, onManage }: {
  project: ProjectState;
  compact?: boolean;
  onBeforeNavigate: () => boolean;
  onSelect: (projectId: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!control.current?.contains(event.target as Node)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", keyboard);
    requestAnimationFrame(() => search.current?.focus());
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", keyboard);
    };
  }, [open]);

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      const items = await listProjects();
      setProjects(items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  function toggle(): void {
    setOpen((current) => {
      if (!current) void load();
      return !current;
    });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleProjects = projects.filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery));

  return (
    <>
      <div className="project-switcher" ref={control}>
        <button className={compact ? "project-switcher-trigger is-compact" : "project-switcher-trigger"} type="button" aria-label={compact ? "Switch project" : undefined} title={compact ? "Switch project" : project.name} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
          <ProjectTypeIcon type={project.type} size={15} />
          {!compact ? <span>{project.name}</span> : null}
          <ChevronDown size={12} />
        </button>
        {open ? (
          <div className={`project-switcher-popover${compact ? " is-compact" : ""}`} role="dialog" aria-label="Switch project">
            <label className="project-switcher-search">
              <Search size={13} />
              <input ref={search} value={query} placeholder="Search projects" onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="project-switcher-list">
              {phase === "loading" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />Loading projects</div> : null}
              {phase === "error" ? <div className="project-switcher-state is-error"><X size={14} /><span>{error}</span><button type="button" onClick={() => void load()}>Retry</button></div> : null}
              {phase === "ready" ? visibleProjects.map((item) => (
                <button className="project-switcher-item" type="button" key={item.id} onClick={() => {
                  if (item.id === project.id) {
                    setOpen(false);
                    return;
                  }
                  if (!onBeforeNavigate()) return;
                  setOpen(false);
                  onSelect(item.id);
                }}>
                  <ProjectTypeIcon type={item.type} />
                  <span><strong>{item.name}</strong><small>{projectTypeLabel(item.type)}</small></span>
                  {item.id === project.id ? <Check size={14} /> : null}
                </button>
              )) : null}
              {phase === "ready" && !visibleProjects.length ? <div className="project-switcher-state">No matching projects</div> : null}
            </div>
            <div className="project-switcher-footer">
              <button type="button" onClick={() => {
                if (!onBeforeNavigate()) return;
                setOpen(false);
                setCreateOpen(true);
              }}><FolderPlus size={14} />New project</button>
              <button type="button" onClick={() => {
                if (!onBeforeNavigate()) return;
                setOpen(false);
                onManage();
              }}><Wrench size={14} />Manage projects</button>
            </div>
          </div>
        ) : null}
      </div>
      {createOpen ? <ProjectCreateDialog initialType={project.type} onClose={() => setCreateOpen(false)} onCreated={(created) => {
        setCreateOpen(false);
        onSelect(created.id);
      }} /> : null}
    </>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
