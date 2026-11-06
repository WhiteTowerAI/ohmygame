import type { ProjectCoverMode, ProjectState } from "./contracts.js";
import { PREVIEW_SETTING_KEYS } from "./preview-settings.js";
import { PROJECT_SETTINGS_VERSION } from "./project-layout.js";

/**
 * A project archive is a ZIP file of the project folder: its type in
 * `ohmygame.json`, its name and settings in `.ohmygame/settings.json` and its
 * cover and logo beside them.
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

/**
 * The name and settings a project folder carries in `.ohmygame/settings.json`.
 * Its type is in `ohmygame.json`; `kind` only tells the General projects that
 * the app shows as a Web game or an Asset Canvas apart.
 */
export const PROJECT_SETTING_KEYS = [
  "name",
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

/** The app's types that `ohmygame.json` names `general`. */
export const PROJECT_SETTING_KINDS = ["web-game", "asset-canvas"] as const;
export type ProjectSettingKind = (typeof PROJECT_SETTING_KINDS)[number];

export type ProjectSettings = Pick<ProjectState, "name"> &
  Partial<Pick<ProjectState, (typeof PROJECT_SETTING_KEYS)[number]>> & { kind?: ProjectSettingKind };

/** The settings of a first-version archive's manifest, which names the type too. */
export const PROJECT_ARCHIVE_SETTING_KEYS = [
  ...PROJECT_SETTING_KEYS,
  "type",
  "pluginType",
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

/** The kind a project's settings name, for the types `ohmygame.json` calls `general`. */
export function projectSettingKind(project: Pick<ProjectState, "type" | "pluginType">): ProjectSettingKind | undefined {
  return !project.pluginType && (PROJECT_SETTING_KINDS as readonly string[]).includes(project.type)
    ? project.type as ProjectSettingKind
    : undefined;
}

/** What a project's folder carries in `.ohmygame/settings.json`. */
export function projectSettings(
  project: Pick<ProjectState, "type" | "pluginType" | (typeof PROJECT_SETTING_KEYS)[number]>,
): ProjectSettings {
  const kind = projectSettingKind(project);
  return {
    ...Object.fromEntries(
      PROJECT_SETTING_KEYS.filter(
        (key) => project[key] !== undefined,
      ).map((key) => [key, structuredClone(project[key])]),
    ),
    ...(kind ? { kind } : {}),
  } as ProjectSettings;
}

/** `.ohmygame/settings.json` for these settings, as OhMyGame writes it. */
export function projectSettingsFileText(settings: ProjectSettings): string {
  return `${JSON.stringify({ version: PROJECT_SETTINGS_VERSION, ...settings }, null, 2)}\n`;
}
