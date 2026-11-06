import type { ProjectCoverMode, ProjectState } from "./contracts.js";
import { PREVIEW_SETTING_KEYS } from "./preview-settings.js";
import { PROJECT_SETTINGS_VERSION } from "./project-layout.js";

/**
 * A project archive is a ZIP file of the project folder, with its name and
 * settings in `.ohmygame/settings.json` and its cover and logo beside them.
 *
 * Archives of the first version hold this manifest at their root, the
 * project's workspace below `workspace/` and, when the project has them, its
 * cover as `cover.webp` and its uploaded logo as `logo.webp`. They are still
 * imported.
 */
export const PROJECT_ARCHIVE_MANIFEST = "ohmygame-project.json";
export const PROJECT_ARCHIVE_WORKSPACE = "workspace";
export const PROJECT_ARCHIVE_COVER = "cover.webp";
export const PROJECT_ARCHIVE_LOGO = "logo.webp";
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
  "pluginType",
  "webPreviewEnabled",
  "startupDirectory",
  "startupScript",
  "packageManager",
  "previewPath",
  "previewViewport",
  "mediaModelDefaults",
  "appearance",
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

/** `.ohmygame/settings.json` for these settings, as OhMyGame writes it. */
export function projectSettingsFileText(settings: ProjectArchiveSettings): string {
  return `${JSON.stringify({ version: PROJECT_SETTINGS_VERSION, ...settings }, null, 2)}\n`;
}
