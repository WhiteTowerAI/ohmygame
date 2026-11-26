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
/**
 * Images sent in a conversation, kept on this computer as references. Builds
 * leave `.ohmygame/` out, so they never ship with the game; the project's asset
 * panel lists them as references.
 */
export const CONVERSATION_REFERENCES_DIRECTORY = ".ohmygame/local/references";
/**
 * Media OhMyGame makes or copies in for a project: `generated/` and `imported/`,
 * and `files/` for the other files and folders the canvas imports. It travels
 * with the project but no build takes it: a game uses a file by copying it into
 * its own files.
 */
export const PROJECT_MEDIA_DIRECTORY = ".ohmygame/media";
// compat: since beta.5.5, remove from beta.7 and 2026-12-06. Only where older projects' caches move to (project-layout.ts).
export const NODE_THUMBNAILS_DIRECTORY = ".ohmygame/local/thumbnails";
export const STORY_RUNTIME_UPDATES_DIRECTORY = ".ohmygame/local/story-runtime";

/**
 * Plugins the project carries, each a whole package at `<publisher>/<name>/`.
 * In this project one replaces the installed plugin with its id; see `project-plugin-index.ts`.
 */
export const PROJECT_PLUGINS_DIRECTORY = ".ohmygame/plugins";

/** Whether a workspace path is in OhMyGame's own folder, which is never a project asset. */
export function isProjectDataPath(relativePath: string): boolean {
  return relativePath === PROJECT_DATA_DIRECTORY || relativePath.startsWith(`${PROJECT_DATA_DIRECTORY}/`);
}
export function isConversationReferencePath(relativePath: string): boolean {
  return relativePath.startsWith(`${CONVERSATION_REFERENCES_DIRECTORY}/`);
}
/** Whether a path is in one of OhMyGame's folders the project's asset panel shows. */
export function isProjectMediaPath(relativePath: string): boolean {
  return isConversationReferencePath(relativePath) || relativePath.startsWith(`${PROJECT_MEDIA_DIRECTORY}/`);
}
/** What the pages of each plugin the project carries failed with lately, for the agent to read; see `plugin-pages.ts`. */
export const PROJECT_PLUGIN_ERRORS_DIRECTORY = ".ohmygame/local/plugin-errors";

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
