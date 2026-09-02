import { MoreHorizontal } from "./icons.js";
import { useEffect, useRef, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { getProjectCover } from "./api.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";

export interface ProjectCardActions {
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

interface ProjectCardProps {
  project: ProjectState;
  fallback: number;
  onOpen: () => void;
  actions?: ProjectCardActions;
}

export function ProjectCard({ project, fallback, onOpen, actions }: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!card.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <article className="project-card" ref={card}>
      <button className="project-card-open" type="button" onClick={onOpen} aria-label={`Open ${project.name}`}>
        <ProjectCover projectId={project.id} fallback={fallback} />
        <span className="project-card-meta">
          <span className="project-card-copy">
            <span className="project-card-name" title={project.name}>{project.name}</span>
            <span className="project-card-details" title={`${projectTypeLabel(project.type)} · ${projectTimestamp(project.updatedAt) ?? projectTime(project.updatedAt)}`}>
              <ProjectTypeIcon type={project.type} size={12} />
              <span>{projectTypeLabel(project.type)}</span>
              <i aria-hidden="true">·</i>
              <span className="project-card-time">{projectTime(project.updatedAt)}</span>
            </span>
          </span>
        </span>
      </button>
      {actions ? (
        <div className="project-card-actions">
          <button
            className="project-card-menu"
            type="button"
            aria-label={`Project actions for ${project.name}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen ? (
            <div className="project-card-actions-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); actions.onRename(); }}>Rename</button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); actions.onDuplicate(); }}>Duplicate</button>
              <button className="project-card-actions-delete" type="button" role="menuitem" onClick={() => { setMenuOpen(false); actions.onDelete(); }}>Delete</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ProjectCover({ projectId, fallback }: { projectId: string; fallback: number }) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    let objectUrl: string | undefined;
    let disposed = false;
    void getProjectCover(projectId).then((cover) => {
      if (!cover || disposed) return;
      objectUrl = URL.createObjectURL(cover);
      setUrl(objectUrl);
    }).catch(() => {});
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId]);

  return (
    <span className={`project-card-preview project-card-preview-${fallback}`} aria-hidden="true">
      {url ? <img src={url} alt="" /> : null}
    </span>
  );
}

export function projectTime(value: string, now = new Date()): string {
  const updatedAt = new Date(value);
  const elapsed = now.getTime() - updatedAt.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "Edited just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Edited ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Edited ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Edited ${days}d ago`;
  const includeYear = updatedAt.getFullYear() !== now.getFullYear();
  return `Edited ${updatedAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  })}`;
}

function projectTimestamp(value: string): string | undefined {
  const updatedAt = new Date(value);
  if (!Number.isFinite(updatedAt.getTime())) return undefined;
  return updatedAt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
