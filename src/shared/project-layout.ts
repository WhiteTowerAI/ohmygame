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

/** The project's name and settings, which OhMyGame writes and reads when the folder is opened again. */
export const PROJECT_SETTINGS_FILE = ".ohmygame/settings.json";

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
