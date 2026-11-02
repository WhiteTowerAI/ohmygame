import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { deleteProject, projectRemovalKeepsFiles } from "./api.js";
import { Download, LoaderCircle, Trash2, X } from "./icons.js";
import { downloadProjectArchive, type ProjectSelection } from "./project-card.js";
import { Button, Dialog, IconButton, useToast } from "./ui/index.js";
import { t } from "./i18n.js";

/**
 * Selecting several projects on the Projects page, and what can be done to
 * them at once: export and remove. There is no separate mode: ticking a
 * cover's checkbox (or a ⌘/Ctrl- or Shift-click) starts it, and it ends when
 * nothing is selected. It only ever holds projects the current search and
 * filters show.
 */
export function useProjectsSelection(visible: ProjectState[], reload: () => Promise<unknown>): {
  selecting: boolean;
  selectionFor: (project: ProjectState) => ProjectSelection;
  bar: ReactNode;
  dialogs: ReactNode;
} {
  const toast = useToast();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [work, setWork] = useState<{ kind: "export" | "remove"; done: number; total: number }>();
  const anchor = useRef<string>(undefined);
  const chosen = visible.filter((project) => selected.has(project.id));
  const selecting = chosen.length > 0;

  // Searching or filtering drops what is no longer shown, so an action never reaches a hidden project.
  useEffect(() => {
    setSelected((current) => {
      const shown = new Set(visible.map((project) => project.id));
      const next = new Set([...current].filter((id) => shown.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visible]);

  function exit(): void {
    setSelected(new Set());
    anchor.current = undefined;
  }

  function selectAll(): void {
    setSelected(new Set(visible.map((project) => project.id)));
  }

  function toggle(id: string, range: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      const from = anchor.current ? visible.findIndex((project) => project.id === anchor.current) : -1;
      const to = visible.findIndex((project) => project.id === id);
      if (range && from >= 0 && to >= 0) {
        for (const project of visible.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(project.id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  }

  // Esc leaves selecting and ⌘/Ctrl+A selects every shown project, except while typing or in a dialog.
  useEffect(() => {
    if (!selecting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || work || confirmRemove) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        exit();
      } else if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        selectAll();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selecting, visible, work, confirmRemove]);

  async function exportChosen(): Promise<void> {
    const projects = chosen;
    const failed: string[] = [];
    setWork({ kind: "export", done: 0, total: projects.length });
    for (const [index, project] of projects.entries()) {
      try {
        await downloadProjectArchive(project);
      } catch {
        failed.push(project.name);
      }
      setWork({ kind: "export", done: index + 1, total: projects.length });
    }
    setWork(undefined);
    const exported = projects.length - failed.length;
    if (exported) toast({ title: t("projects.exportedMany", { count: exported }), tone: "success" });
    if (failed.length) toast({ title: t("projects.exportFailed", { names: failed.join(", ") }), tone: "danger" });
  }

  async function removeChosen(): Promise<void> {
    const projects = chosen;
    const failed: ProjectState[] = [];
    setConfirmRemove(false);
    setWork({ kind: "remove", done: 0, total: projects.length });
    for (const [index, project] of projects.entries()) {
      try {
        await deleteProject(project.id);
      } catch {
        failed.push(project);
      }
      setWork({ kind: "remove", done: index + 1, total: projects.length });
    }
    await reload().catch(() => {});
    setWork(undefined);
    const removed = projects.length - failed.length;
    if (removed) toast({ title: t("projects.removedMany", { count: removed }), tone: "success" });
    if (failed.length) {
      // What could not be removed stays selected, to try again or look at.
      setSelected(new Set(failed.map((project) => project.id)));
      toast({ title: t("projects.removeFailed", { names: failed.map((project) => project.name).join(", ") }), tone: "danger" });
    } else exit();
  }

  const selectionFor = (project: ProjectState): ProjectSelection => ({
    selecting,
    selected: selected.has(project.id),
    onToggle: (range) => {
      if (work) return;
      toggle(project.id, range);
    },
  });

  const allShown = chosen.length === visible.length && visible.length > 0;
  const bar = selecting ? (
    <div className="projects-selection-bar" role="toolbar" aria-label={t("projects.selectionActions")}>
      <span className="projects-selection-count" aria-live="polite">
        {work
          ? t(work.kind === "export" ? "projects.exportingProgress" : "projects.removingProgress", { done: work.done, total: work.total })
          : t("projects.selectedCount", { count: chosen.length })}
      </span>
      {allShown ? null : <Button size="sm" variant="ghost" disabled={!!work} onClick={selectAll}>
        {t("projects.selectAll", { count: visible.length })}
      </Button>}
      <span className="projects-selection-divider" aria-hidden="true" />
      <Button size="sm" icon={work?.kind === "export" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
        disabled={!!work} onClick={() => void exportChosen()}>{t("projects.exportSelected")}</Button>
      <Button size="sm" className="projects-selection-remove" icon={work?.kind === "remove" ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
        disabled={!!work} onClick={() => setConfirmRemove(true)}>{t("projects.removeSelected")}</Button>
      <IconButton size="sm" label={t("projects.clearSelection")} disabled={!!work} onClick={exit}><X size={16} /></IconButton>
    </div>
  ) : null;

  const removal = confirmRemove ? batchRemoval(chosen) : undefined;
  const dialogs = (
    <Dialog open={!!removal} onClose={() => setConfirmRemove(false)} size="sm"
      title={removal?.title ?? ""}
      footer={<>
        <Button onClick={() => setConfirmRemove(false)}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => void removeChosen()}>{removal?.deletes ? t("common.delete") : t("projectCard.removeConfirm")}</Button>
      </>}>
      {removal ? <ul className="projects-remove-outcomes">{removal.outcomes.map((line) => <li key={line}>{line}</li>)}</ul> : null}
    </Dialog>
  );

  return { selecting, selectionFor, bar, dialogs };
}

/**
 * The confirmation for removing several projects, grouped by what happens to
 * their files, as `projectRemoval` says for one.
 */
export function batchRemoval(projects: ProjectState[]): { title: string; outcomes: string[]; deletes: boolean } {
  const external = projects.filter((project) => project.workspaceLocation === "external").length;
  const stored = projects.length - external;
  const keepsFiles = projectRemovalKeepsFiles();
  const recycleBin = typeof window !== "undefined" && window.ohMyGameDesktop?.platform === "win32";
  const outcomes: string[] = [];
  if (stored) {
    const key = keepsFiles ? (recycleBin ? "projects.removeManyToRecycleBin" : "projects.removeManyToTrash") : "projects.removeManyDeletes";
    outcomes.push(t(key, { count: stored }));
  }
  if (external) outcomes.push(t("projects.removeManyKeepsFolders", { count: external }));
  return { title: t("projects.removeManyTitle", { count: projects.length }), outcomes, deletes: !!stored && !keepsFiles };
}
