import { Copy, Download, FolderOpen, LoaderCircle, MoreHorizontal, Pencil, Play, Trash2 } from "./icons.js";
import { useEffect, useState, type ReactNode } from "react";
import type { ProjectAgentActivity, ProjectState } from "../shared/contracts.js";
import { deleteProject, duplicateProject, exportProject, getProjectCover, renameProject } from "./api.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";
import { projectDeletionConfirmation } from "./project-deletion.js";
import { ProjectRenameDialog } from "./project-rename-dialog.js";
import { Button, ContextMenu, Dialog, DropdownMenu, IconButton, Tooltip, type MenuEntry } from "./ui/index.js";
import { language, t } from "./i18n.js";
import { ProjectPlaceholder } from "./project-placeholder.js";
import "./project-card.css";

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

/**
 * The menu every project has wherever it is listed: open, rename, copy, open
 * the folder, export and delete. `error` is the last failure from an item
 * that runs here (open folder, export).
 */
function useProjectMenu(project: ProjectState, onOpen: () => void, actions?: ProjectCardActions): { menu?: MenuEntry[]; error?: string } {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const openProjectFile = typeof window !== "undefined" ? window.ohMyGameDesktop?.openProjectFile : undefined;

  async function openFolder(): Promise<void> {
    if (!openProjectFile) return;
    setError(undefined);
    try {
      await openProjectFile(project.id, ".", "default");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function exportArchive(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setError(undefined);
    try {
      const archive = await exportProject(project.id);
      const url = URL.createObjectURL(archive);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.name}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  }

  const menu: MenuEntry[] | undefined = actions ? [
    { label: t("projectCard.openItem"), icon: <Play size={14} />, onSelect: onOpen },
    { label: t("common.rename"), icon: <Pencil size={14} />, onSelect: actions.onRename },
    { label: t("common.duplicate"), icon: <Copy size={14} />, onSelect: actions.onDuplicate },
    ...(openProjectFile ? [{ label: t("projectCard.openFolder"), icon: <FolderOpen size={14} />, onSelect: () => void openFolder() }] : []),
    { label: exporting ? t("projectCard.exporting") : t("projectCard.export"), icon: <Download size={14} />, disabled: exporting, onSelect: () => void exportArchive() },
    "separator",
    {
      label: project.workspaceLocation === "external" ? t("projectCard.remove") : t("common.delete"),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: actions.onDelete,
    },
  ] : undefined;
  return { menu, error };
}

function ProjectMenuButton({ project, menu }: { project: ProjectState; menu: MenuEntry[] }) {
  return (
    <DropdownMenu placement="bottom-end" items={menu} trigger={(props) => (
      <IconButton {...props} size="sm" className="project-card-menu" label={t("projectCard.actions", { name: project.name })}>
        <MoreHorizontal size={16} />
      </IconButton>
    )} />
  );
}

/** When the project was edited, or that its agent is working right now. */
function ProjectStatus({ project, agentStatus }: { project: ProjectState; agentStatus?: ProjectAgentActivity["status"] }) {
  if (!agentStatus) return <span className="project-card-time">{projectTime(project.updatedAt)}</span>;
  return (
    <span className="project-card-activity" role="status">
      <LoaderCircle className="spin" size={11} aria-hidden="true" />
      {agentStatus === "cancelling" ? t("projectCard.stopping") : t("projectCard.working")}
    </span>
  );
}

// The cover is the card and the text sits under it. One menu, from the "…"
// that shows on hover and from a right-click.
export function ProjectCard({ project, onOpen, actions, agentStatus }: ProjectCardProps) {
  const { menu, error } = useProjectMenu(project, onOpen, actions);
  const card = (
    <article className="project-card">
      <div className="project-card-body">
      <button className="project-card-open" type="button" onClick={onOpen} aria-label={t("projectCard.open", { name: project.name })}>
        <ProjectCover projectId={project.id} />
        <span className="project-card-meta">
          <ProjectTypeMark type={project.type} />
          <span className="project-card-copy">
            <span className="project-card-name" title={project.name}>{project.name}</span>
            <span className="project-card-details" title={projectTimestamp(project.updatedAt)}>
              <ProjectStatus project={project} agentStatus={agentStatus} />
            </span>
          </span>
        </span>
      </button>
      {menu ? <span className="project-card-actions"><ProjectMenuButton project={project} menu={menu} /></span> : null}
      </div>
      {error ? <p className="project-card-error" role="alert">{error}</p> : null}
    </article>
  );
  return menu ? <ContextMenu items={menu}>{card}</ContextMenu> : card;
}

/** A project as a row of the Projects list: cover, name, type and when it was edited, with the same menu as its card. */
export function ProjectRow({ project, onOpen, actions, agentStatus }: ProjectCardProps) {
  const { menu, error } = useProjectMenu(project, onOpen, actions);
  const row = (
    <div className="project-row">
      <button className="project-row-open" type="button" onClick={onOpen} aria-label={t("projectCard.open", { name: project.name })}>
        <ProjectCover projectId={project.id} />
        <span className="project-card-name" title={project.name}>{project.name}</span>
        <span className="project-row-type">
          <ProjectTypeIcon type={project.type} size={14} />
          {projectTypeLabel(project.type)}
        </span>
        <span className="project-row-time" title={projectTimestamp(project.updatedAt)}>
          <ProjectStatus project={project} agentStatus={agentStatus} />
        </span>
      </button>
      {menu ? <span className="project-row-actions"><ProjectMenuButton project={project} menu={menu} /></span> : null}
      {error ? <p className="project-card-error" role="alert">{error}</p> : null}
    </div>
  );
  return menu ? <ContextMenu items={menu}>{row}</ContextMenu> : row;
}

/** The project's type as an icon, named in a tooltip. */
function ProjectTypeMark({ type }: { type: ProjectState["type"] }) {
  const label = projectTypeLabel(type);
  return (
    <Tooltip content={label}>
      <span className="project-card-type" aria-label={label} role="img">
        <ProjectTypeIcon type={type} size={14} />
      </span>
    </Tooltip>
  );
}

/**
 * Rename, copy and delete for any list of project cards. `reload` runs after
 * each change; `error` is the last failure, for the page to show.
 */
export function useProjectActions(reload: () => Promise<unknown>): {
  actionsFor: (project: ProjectState) => ProjectCardActions;
  dialogs: ReactNode;
  error?: string;
} {
  const [renaming, setRenaming] = useState<ProjectState>();
  const [removing, setRemoving] = useState<ProjectState>();
  const [error, setError] = useState<string>();

  async function run(action: () => Promise<unknown>): Promise<void> {
    setError(undefined);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const actionsFor = (project: ProjectState): ProjectCardActions => ({
    onRename: () => setRenaming(project),
    onDuplicate: () => void run(() => duplicateProject(project.id)),
    onDelete: () => setRemoving(project),
  });

  const external = removing?.workspaceLocation === "external";
  const dialogs = (
    <>
      {renaming ? <ProjectRenameDialog name={renaming.name} returnFocus={null} onClose={() => setRenaming(undefined)} onConfirm={(input) => {
        const project = renaming;
        setRenaming(undefined);
        const name = input.trim();
        if (name && name !== project.name) void run(() => renameProject(project.id, name));
      }} /> : null}
      <Dialog open={!!removing} onClose={() => setRemoving(undefined)} size="sm"
        title={removing ? projectDeletionConfirmation(removing) : ""}
        footer={<>
          <Button onClick={() => setRemoving(undefined)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            const project = removing!;
            setRemoving(undefined);
            void run(() => deleteProject(project.id));
          }}>{external ? t("projectCard.removeConfirm") : t("common.delete")}</Button>
        </>} />
    </>
  );
  return { actionsFor, dialogs, error };
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
