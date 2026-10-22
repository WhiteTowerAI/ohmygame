import type { ProjectCoverMode, ProjectState } from "./contracts.js";
import { PREVIEW_SETTING_KEYS } from "./preview-settings.js";

/**
 * A project archive is a ZIP file holding this manifest at its root, the
 * project's workspace below `workspace/` and, when the project has one, its
 * cover as `cover.webp`.
 */
export const PROJECT_ARCHIVE_MANIFEST = "ohmygame-project.json";
export const PROJECT_ARCHIVE_WORKSPACE = "workspace";
export const PROJECT_ARCHIVE_COVER = "cover.webp";
export const PROJECT_ARCHIVE_FORMAT = "ohmygame-project";
export const PROJECT_ARCHIVE_VERSION = 1;

/** Request body type for importing an archive, streamed instead of buffered. */
export const PROJECT_ARCHIVE_CONTENT_TYPE =
  "application/vnd.ohmygame.project-archive";
/** Limits for both the uploaded file and the files it extracts to. */
export const PROJECT_ARCHIVE_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const PROJECT_ARCHIVE_MAX_ENTRIES = 200_000;

/** Project settings that travel with an archive. */
export const PROJECT_ARCHIVE_SETTING_KEYS = [
  "name",
  "type",
  "integration",
  "webPreviewEnabled",
  "startupDirectory",
  "startupScript",
  "packageManager",
  "previewPath",
  "previewViewport",
  "mediaModelDefaults",
  ...PREVIEW_SETTING_KEYS,
] as const satisfies readonly (keyof ProjectState)[];

export type ProjectArchiveSettings = Pick<ProjectState, "name" | "type"> &
  Partial<Pick<ProjectState, (typeof PROJECT_ARCHIVE_SETTING_KEYS)[number]>>;

export interface ProjectArchiveManifest {
  format: typeof PROJECT_ARCHIVE_FORMAT;
  version: typeof PROJECT_ARCHIVE_VERSION;
  project: ProjectArchiveSettings;
  /** Present when the archive holds a cover; says whether it was chosen by hand. */
  cover?: { mode: ProjectCoverMode };
}

export function projectArchiveSettings(
  project: ProjectState,
): ProjectArchiveSettings {
  return Object.fromEntries(
    PROJECT_ARCHIVE_SETTING_KEYS.filter(
      (key) => project[key] !== undefined,
    ).map((key) => [key, structuredClone(project[key])]),
  ) as ProjectArchiveSettings;
}
