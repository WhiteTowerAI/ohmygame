/** Whether an Interactive Story plays as its own page; one made before that must be upgraded first. */
export interface StoryUpgradeStatus {
  web: boolean;
  /** A web story's Asset IDs still in the Library; they must be in the project to publish. */
  libraryAssets?: string[];
}

export interface StoryLibraryMediaResult {
  /** Library assets copied into the project, by project Asset ID. */
  copiedAssets: string[];
  /** Library assets the Library no longer has. */
  missingAssets: string[];
  changed: string[];
}

export interface StoryUpgradeResult {
  /** Library assets copied into the project, by project Asset ID. */
  copiedAssets: string[];
  /** Library assets that could not be found; the story must replace them before publishing. */
  missingAssets: string[];
  /** Scene and shared files whose imports were rewritten for the browser. */
  rewritten: string[];
  changed: string[];
}
