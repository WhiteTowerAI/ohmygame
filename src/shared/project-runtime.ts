import type { ProjectState, ProjectType } from "./contracts.js";

/** These workspaces can use the platform's Web runtime when configured. */
export function isWebRuntimeProjectType(type: ProjectType): boolean {
  return type === "web-game" || type === "general";
}

/** General games expose Web controls only after a runnable preview is found. */
export function supportsWebPreview(
  project?: Pick<ProjectState, "type" | "preview">,
): boolean {
  return (
    project?.type === "web-game" ||
    (project?.type === "general" && project.preview.status !== "waiting")
  );
}
