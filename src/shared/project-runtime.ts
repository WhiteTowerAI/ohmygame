import {
  PROJECT_TYPE_IDS,
  type ProjectState,
  type ProjectType,
} from "./contracts.js";

export function isProjectType(value: unknown): value is ProjectType {
  return PROJECT_TYPE_IDS.some((type) => type === value);
}

/** These workspaces can use the platform's Web runtime when configured. */
export function isWebRuntimeProjectType(type: ProjectType): boolean {
  return type === "web-game" || type === "general";
}

/** Capability is independent of the preview process's readiness or errors. */
export function supportsWebPreview(
  project?: Pick<ProjectState, "type" | "webPreviewEnabled">,
): boolean {
  return (
    project?.type === "web-game" ||
    (project?.type === "general" && project.webPreviewEnabled === true)
  );
}

export function webPreviewSettingsChanged(
  before: ProjectState,
  after: ProjectState,
): boolean {
  const mode = before.previewMode ?? "auto";
  if (
    supportsWebPreview(before) !== supportsWebPreview(after) ||
    (before.startupDirectory ?? ".") !== (after.startupDirectory ?? ".") ||
    mode !== (after.previewMode ?? "auto") ||
    before.previewPort !== after.previewPort
  )
    return true;
  if (mode === "static") return false;
  if (mode === "command")
    return (
      (before.previewCommand ?? "").trim() !==
      (after.previewCommand ?? "").trim()
    );
  return (
    (before.startupScript ?? "dev") !== (after.startupScript ?? "dev") ||
    before.packageManager !== after.packageManager ||
    JSON.stringify(before.previewArguments) !==
      JSON.stringify(after.previewArguments)
  );
}
