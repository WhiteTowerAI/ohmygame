import type { StoryChapter, StoryDocument, StoryVariable } from "../shared/contracts.js";
import { restoreStoryCheckpoint, type PlayingRuntimeState, type StorySaveDataV1 } from "../shared/story.js";

export interface StoryProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function storyProgressKey(scope: string, chapterId: string): string {
  return `ohmygame:story-progress:v1:${scope}:${chapterId}`;
}

export async function storySignature(story: StoryDocument): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(story));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function loadStoryProgress(
  storage: StoryProgressStorage,
  key: string,
  signature: string,
  chapter: StoryChapter,
  variables: readonly StoryVariable[],
): PlayingRuntimeState | undefined {
  let serialized: string | null;
  try {
    serialized = storage.getItem(key);
  } catch {
    return undefined;
  }
  if (serialized === null) return undefined;
  try {
    const checkpoint = restoreStoryCheckpoint(JSON.parse(serialized), signature, chapter, variables);
    if (checkpoint) return checkpoint;
  } catch {
    // Invalid local progress is discarded below.
  }
  clearStoryProgress(storage, key);
  return undefined;
}

export function saveStoryProgress(storage: StoryProgressStorage, key: string, save: StorySaveDataV1): void {
  storage.setItem(key, JSON.stringify(save));
}

export function clearStoryProgress(storage: StoryProgressStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
