import { LoaderCircle, MoreHorizontal } from "./icons.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { menuPlacement } from "./popover-placement.js";
import type { ProjectAgentActivity, ProjectState } from "../shared/contracts.js";
import { exportProject, getProjectCover } from "./api.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";
import { language, t } from "./i18n.js";
import { ProjectPlaceholder } from "./project-placeholder.js";

export interface ProjectCardActions {
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

interface ProjectCardProps {
  project: ProjectState;
  onOpen: () => void;
  actions?: ProjectCardActions;
  agentStatus?: ProjectAgentActivity["status"];
}

export function ProjectCard({ project, onOpen, actions, agentStatus }: ProjectCardProps) {
  const activityLabel = agentStatus === "cancelling" ? t("projectCard.stopping") : t("projectCard.working");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number }>();
  const [openingFolder, setOpeningFolder] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [menuError, setMenuError] = useState<string>();
  const openProjectFile = typeof window !== "undefined" ? window.ohMyGameDesktop?.openProjectFile : undefined;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  async function openFolder(): Promise<void> {
    if (!openProjectFile || openingFolder) return;
    setOpeningFolder(true);
    setMenuError(undefined);
    try {
      await openProjectFile(project.id, ".", "default");
      setMenuOpen(false);
    } catch (cause) {
      setMenuError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpeningFolder(false);
    }
  }

  async function exportArchive(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setMenuError(undefined);
    try {
      const archive = await exportProject(project.id);
      const url = URL.createObjectURL(archive);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.name}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setMenuOpen(false);
    } catch (cause) {
      setMenuError(cause instanceof Error ? cause.message : String(cause));
      // A large project can take a while; show the failure even if the menu was closed meanwhile.
      setMenuOpen(true);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    // The menu is fixed to the viewport, so it would drift away from its card on scroll.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPosition(undefined);
      return;
    }
    const anchor = trigger.current?.getBoundingClientRect();
    const popup = menu.current?.getBoundingClientRect();
    if (!anchor || !popup) return;
    setMenuPosition(menuPlacement(anchor, popup, { width: window.innerWidth, height: window.innerHeight }));
  }, [menuOpen, menuError]);

  return (
    <article className="project-card">
      <button className="project-card-open" type="button" onClick={onOpen} aria-label={t("projectCard.open", { name: project.name })}>
        <ProjectCover projectId={project.id} />
        <span className="project-card-meta">
          <span className="project-card-copy">
            <span className="project-card-name" title={project.name}>{project.name}</span>
            <span className="project-card-details" title={`${projectTypeLabel(project.type)} · ${agentStatus ? t("projectCard.agentStatus", { status: activityLabel }) : projectTimestamp(project.updatedAt) ?? projectTime(project.updatedAt)}`}>
              <ProjectTypeIcon type={project.type} size={12} />
              <span>{projectTypeLabel(project.type)}</span>
              <i aria-hidden="true">·</i>
              {agentStatus ? <span className="project-card-activity" role="status">
                <LoaderCircle className="spin" size={11} aria-hidden="true" />
                {activityLabel}
              </span> : <span className="project-card-time">{projectTime(project.updatedAt)}</span>}
            </span>
          </span>
        </span>
      </button>
      {actions ? (
        <div className="project-card-actions">
          <button
            ref={trigger}
            className="project-card-menu"
            type="button"
            aria-label={t("projectCard.actions", { name: project.name })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => { setMenuError(undefined); setMenuOpen((current) => !current); }}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen ? createPortal(
            // Rendered in body so scroll containers such as .home-content cannot clip it.
            <div
              ref={menu}
              className="project-card-actions-menu"
              role="menu"
              style={menuPosition ?? { top: 0, left: 0, visibility: "hidden" }}
            >
              {openProjectFile ? <button type="button" role="menuitem" disabled={openingFolder} onClick={() => void openFolder()}>{t("projectCard.openFolder")}</button> : null}
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); actions.onRename(); }}>{t("common.rename")}</button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); actions.onDuplicate(); }}>{t("common.duplicate")}</button>
              <button type="button" role="menuitem" disabled={exporting} onClick={() => void exportArchive()}>{exporting ? t("projectCard.exporting") : t("projectCard.export")}</button>
              <button className="project-card-actions-delete" type="button" role="menuitem" onClick={() => { setMenuOpen(false); actions.onDelete(); }}>
                {project.workspaceLocation === "external" ? t("projectCard.remove") : t("common.delete")}
              </button>
              {menuError ? <p className="project-card-folder-error" role="alert">{menuError}</p> : null}
            </div>,
            document.body,
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ProjectCover({ projectId }: { projectId: string }) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    setUrl(undefined);
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
    <span className="project-card-preview" aria-hidden="true">
      {url ? <img src={url} alt="" onError={() => setUrl(undefined)} /> : <ProjectPlaceholder projectId={projectId} />}
    </span>
  );
}

export function projectTime(value: string, now = new Date()): string {
  const updatedAt = new Date(value);
  const elapsed = now.getTime() - updatedAt.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return t("projectCard.editedJustNow");
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return t("projectCard.editedMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("projectCard.editedHours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("projectCard.editedDays", { count: days });
  const includeYear = updatedAt.getFullYear() !== now.getFullYear();
  return t("projectCard.editedOn", {
    date: updatedAt.toLocaleDateString(language, {
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" } : {}),
    }),
  });
}

function projectTimestamp(value: string): string | undefined {
  const updatedAt = new Date(value);
  if (!Number.isFinite(updatedAt.getTime())) return undefined;
  return updatedAt.toLocaleString(language, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
