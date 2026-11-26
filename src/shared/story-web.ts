/** Whether an Interactive Story plays as its own page; one made before that can't be opened any more. */
export interface StoryStatus {
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
