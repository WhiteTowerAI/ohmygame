import { Check, ChevronRight, FolderOpen, LoaderCircle, Search } from "./icons.js";
import { useEffect, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { addLibraryAssetToProject, listProjects } from "./api.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";
import { projectHash } from "./routes.js";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string; retry: () => void }
  | { kind: "ready" }
  | { kind: "sending"; projectId: string }
  | { kind: "sent"; project: ProjectState; path: string };

/** Picks a game project and copies a Library asset into its `assets/` folder. */
export function SendToProjectDialog({ assetId, name, onClose }: { assetId: string; name: string; onClose: () => void }) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  async function load(): Promise<void> {
    setPhase({ kind: "loading" });
    try {
      const items = await listProjects();
      setProjects(items.filter((project) => project.type !== "asset-canvas").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setPhase({ kind: "ready" });
    } catch (cause) {
      setPhase({ kind: "error", message: errorMessage(cause), retry: () => void load() });
    }
  }

  async function send(project: ProjectState): Promise<void> {
    setPhase({ kind: "sending", projectId: project.id });
    try {
      const result = await addLibraryAssetToProject(project.id, assetId);
      setPhase({ kind: "sent", project, path: result.path });
    } catch (cause) {
      setPhase({ kind: "error", message: `Could not add to ${project.name}: ${errorMessage(cause)}`, retry: () => setPhase({ kind: "ready" }) });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleProjects = projects.filter((project) => !normalizedQuery || project.name.toLowerCase().includes(normalizedQuery));
  // React Flow ignores key presses inside .nokey, so typing in the search never edits the canvas behind the dialog.
  return <div className="library-dialog-backdrop nokey" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="project-switcher-popover send-to-project-dialog" role="dialog" aria-modal="true" aria-labelledby="send-to-project-title">
      <div className="plugin-try-heading">
        <strong id="send-to-project-title">Add “{name}” to a project</strong>
        <span>The file is copied into the project’s assets folder.</span>
      </div>
      {phase.kind === "sent" ? <>
        <div className="project-switcher-state send-to-project-result" role="status">
          <Check size={14} />
          <span>Added to <strong>{phase.project.name}</strong> as <code>{phase.path}</code></span>
        </div>
        <div className="project-switcher-footer">
          <button type="button" onClick={() => { window.location.hash = projectHash(phase.project.id); }}><FolderOpen size={14} />Open {phase.project.name}</button>
        </div>
      </> : <>
        <label className="project-switcher-search">
          <Search size={13} />
          <input value={query} autoFocus placeholder="Search projects" aria-label="Search projects" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="project-switcher-list">
          {phase.kind === "loading" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />Loading projects</div> : null}
          {phase.kind === "error" ? <div className="project-switcher-state is-error"><span>{phase.message}</span><button type="button" onClick={phase.retry}>Retry</button></div> : null}
          {phase.kind === "ready" || phase.kind === "sending" ? visibleProjects.map((project) => <button
            className="project-switcher-item"
            type="button"
            key={project.id}
            disabled={phase.kind === "sending"}
            onClick={() => void send(project)}
          >
            <ProjectTypeIcon type={project.type} />
            <span><strong>{project.name}</strong><small>{projectTypeLabel(project.type)}</small></span>
            {phase.kind === "sending" && phase.projectId === project.id ? <LoaderCircle className="spin" size={13} /> : <ChevronRight size={13} />}
          </button>) : null}
          {phase.kind === "ready" && !visibleProjects.length ? <div className="project-switcher-state">{normalizedQuery ? "No matching projects" : "No game projects yet"}</div> : null}
        </div>
      </>}
    </div>
  </div>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
