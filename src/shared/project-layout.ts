/**
 * Where OhMyGame keeps its own files in a project folder. `.ohmygame/` travels
 * with the project (archives, snapshots, Git), except `local/`, which belongs
 * to this computer, and `build/`, which plugins build into. Paths are
 * relative to the workspace, with `/`.
 */
export const PROJECT_DATA_DIRECTORY = ".ohmygame";
export const PROJECT_LOCAL_DIRECTORY = ".ohmygame/local";
export const PROJECT_BUILD_DIRECTORY = ".ohmygame/build";

export const ASSET_METADATA_FILE = ".ohmygame/assets.json";
export const ASSET_PREVIEWS_DIRECTORY = ".ohmygame/asset-previews";
export const AGENT_ATTACHMENTS_DIRECTORY = ".ohmygame/local/attachments";
export const NODE_THUMBNAILS_DIRECTORY = ".ohmygame/local/thumbnails";
export const STORY_RUNTIME_UPDATES_DIRECTORY = ".ohmygame/local/story-runtime";

/** The project's own panels, one folder each; see `project-panels.ts`. */
export const PROJECT_PANELS_DIRECTORY = ".ohmygame/panels";
/** What each project panel's page failed with lately, for the agent to read. */
export const PROJECT_PANEL_ERRORS_DIRECTORY = ".ohmygame/local/panel-errors";

/** The project's name and settings, which OhMyGame writes and reads when the folder is opened again. */
export const PROJECT_SETTINGS_FILE = ".ohmygame/settings.json";
export const PROJECT_SETTINGS_VERSION = 1;

/** The last automatic cover, captured on this computer; exports carry it so an imported project has a cover. */
export const AUTOMATIC_COVER_FILE = ".ohmygame/local/cover-auto.webp";

/**
 * The project's settings, cover and logo. They travel with the project, but
 * snapshots leave them out: going back to an earlier turn keeps them as they are.
 */
export const PROJECT_IDENTITY_FILES = [
  PROJECT_SETTINGS_FILE,
  ".ohmygame/cover.webp",
  ".ohmygame/cover-frozen.webp",
  ".ohmygame/cover-state.json",
  ".ohmygame/logo.webp",
] as const;

/** What `.ohmygame/.gitignore` leaves out of a project's repository. */
export const PROJECT_DATA_GITIGNORE = "local/\nbuild/\n";
