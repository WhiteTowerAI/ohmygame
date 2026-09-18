import type { ProjectState } from "../shared/contracts.js";

export function projectDeletionConfirmation(project: ProjectState): string {
  if (project.workspaceLocation === "external") {
    return `Remove “${project.name}” from OpenGame? Files in “${project.workspacePath}” will remain on disk.`;
  }
  return `Delete “${project.name}”? This cannot be undone.`;
}
