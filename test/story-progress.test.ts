import { describe, expect, it } from "vitest";
import { createStoryCheckpoint, createStoryDocument } from "../src/shared/story.js";
import { clearStoryProgress, loadStoryProgress, saveStoryProgress, storyProgressKey, storySignature, type StoryProgressStorage } from "../src/renderer/story-progress.js";

describe("story progress storage", () => {
  it("isolates keys by scope and chapter", () => {
    expect(storyProgressKey("project:one", "chapter")).not.toBe(storyProgressKey("project:two", "chapter"));
    expect(storyProgressKey("project:one", "chapter")).not.toBe(storyProgressKey("project:one", "other"));
  });

  it("hashes story content deterministically", async () => {
    const story = createStoryDocument();
    expect(await storySignature(story)).toBe(await storySignature(structuredClone(story)));
    story.chapters[0]!.title = "Changed";
    expect(await storySignature(story)).not.toBe(await storySignature(createStoryDocument()));
  });

  it("saves, loads, clears, and discards invalid progress", () => {
    const values = new Map<string, string>();
    const storage: StoryProgressStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push({ id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "End", description: "" } });
    chapter.edges.push({ id: "start-ending", source: chapter.nodes[0]!.id, target: "ending" });
    const state = { mode: "playing" as const, chapterId: chapter.id, nodeId: "ending", variables: {}, visibleOverlayIds: [] };
    const key = storyProgressKey("project:test", chapter.id);

    saveStoryProgress(storage, key, createStoryCheckpoint("signature", state));
    expect(loadStoryProgress(storage, key, "signature", chapter, [], [])).toMatchObject(state);
    expect(loadStoryProgress(storage, key, "changed", chapter, [], [])).toBeUndefined();
    expect(values.has(key)).toBe(false);
    values.set(key, "not json");
    expect(loadStoryProgress(storage, key, "signature", chapter, [], [])).toBeUndefined();
    expect(values.has(key)).toBe(false);
    saveStoryProgress(storage, key, createStoryCheckpoint("signature", state));
    clearStoryProgress(storage, key);
    expect(values.has(key)).toBe(false);
  });
});
