import { describe, expect, it } from "vitest";
import { createStoryDocument, createStorySave } from "../src/shared/story.js";
import { clearStoryProgress, loadStoryProgress, saveStoryProgress, storyProgressKey, storySignature, type StoryProgressStorage } from "../src/renderer/story-progress.js";
import { createPlayableStoryDocument } from "./story-fixture.js";

describe("story progress storage", () => {
  it("isolates keys by scope and chapter", () => {
    expect(storyProgressKey("project:one", "chapter")).not.toBe(storyProgressKey("project:two", "chapter"));
    expect(storyProgressKey("project:one", "chapter")).not.toBe(storyProgressKey("project:one", "other"));
  });

  it("hashes story content deterministically", async () => {
    const story = createStoryDocument();
    expect(await storySignature(story)).toBe(await storySignature(structuredClone(story)));
    story.chapter.title = "Changed";
    expect(await storySignature(story)).not.toBe(await storySignature(createStoryDocument()));
  });

  it("saves, loads, clears, and discards invalid progress", () => {
    const values = new Map<string, string>();
    const storage: StoryProgressStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const story = createPlayableStoryDocument();
    const chapter = story.chapter;
    const ending = chapter.nodes.find((node) => node.type === "ending")!;
    const state = { mode: "playing" as const, chapterId: chapter.id, nodeId: ending.id, variables: {} };
    const key = storyProgressKey("project:test", chapter.id);

    saveStoryProgress(storage, key, createStorySave("signature", undefined, state));
    expect(loadStoryProgress(storage, key, "signature", chapter, [])?.checkpoint).toMatchObject(state);
    const oldCheckpoint = { ...createStorySave("signature", undefined, state), checkpoint: { ...state, visibleOverlayIds: [] } };
    values.set(key, JSON.stringify(oldCheckpoint));
    expect(loadStoryProgress(storage, key, "signature", chapter, [])).toBeUndefined();
    expect(loadStoryProgress(storage, key, "changed", chapter, [])).toBeUndefined();
    expect(values.has(key)).toBe(false);
    values.set(key, "not json");
    expect(loadStoryProgress(storage, key, "signature", chapter, [])).toBeUndefined();
    expect(values.has(key)).toBe(false);
    const discoveries = { visitedNodeIds: [ending.id], selectedOptionIds: [], unlockedEndingIds: [ending.id] };
    saveStoryProgress(storage, key, createStorySave("signature", discoveries));
    expect(loadStoryProgress(storage, key, "signature", chapter, [])).toEqual({ discoveries });
    clearStoryProgress(storage, key);
    expect(values.has(key)).toBe(false);
  });
});
