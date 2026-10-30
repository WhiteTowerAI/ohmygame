import type { ProjectState } from "../shared/contracts.js";
import { projectRemovalKeepsFiles } from "./api.js";
import { t } from "./i18n.js";

/**
 * The confirmation for taking a project out of OhMyGame, and what happens to
 * its files: a folder the person chose stays; in the desktop app a project in
 * OhMyGame's storage goes to the Trash; elsewhere it is deleted for good.
 */
export function projectRemoval(project: ProjectState): { title: string; description: string; deletes: boolean } {
  const title = t("projects.removeTitle", { name: project.name });
  if (project.workspaceLocation === "external") return { title, description: t("projects.removeKeepsFolder", { path: project.workspacePath }), deletes: false };
  if (projectRemovalKeepsFiles()) {
    const recycleBin = typeof window !== "undefined" && window.ohMyGameDesktop?.platform === "win32";
    return { title, description: t(recycleBin ? "projects.removeToRecycleBin" : "projects.removeToTrash"), deletes: false };
  }
  return { title, description: t("projects.removeDeletes"), deletes: true };
}
