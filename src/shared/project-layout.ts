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

/** What `.ohmygame/.gitignore` leaves out of a project's repository. */
export const PROJECT_DATA_GITIGNORE = "local/\nbuild/\n";
