import type { ProjectState } from "../shared/contracts.js";
import { t } from "./i18n.js";

export function projectDeletionConfirmation(project: ProjectState): string {
  if (project.workspaceLocation === "external") {
    return t("projects.confirmRemove", { name: project.name, path: project.workspacePath });
  }
  return t("projects.confirmDelete", { name: project.name });
}
