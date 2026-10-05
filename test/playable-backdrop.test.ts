import { describe, expect, it } from "vitest";
import { PLAYABLE_PRESETS } from "../src/daemon/playable-presets.js";
import { playableBackdrop, setPlayableBackdrop } from "../src/shared/playable-backdrop.js";

describe("setPlayableBackdrop", () => {
  it("sets the background of every Template", () => {
    for (const { id } of PLAYABLE_PRESETS) {
      const { html } = PLAYABLE_PRESETS.find((preset) => preset.id === id)!.source("Opening");
      expect(playableBackdrop(html)).toBe("missing");
      const edited = setPlayableBackdrop(html, "opening", "video")!;
      expect(edited).toMatch(/<div class="backdrop[^"]*" data-media="backdrop" data-asset="opening" data-type="video">/);
      expect(playableBackdrop(edited)).toBe("set");
      // Everything but the background tag stays as it was.
      expect(edited.replace(/<div class="backdrop[^>]*>/, "")).toBe(html.replace(/<div class="backdrop[^>]*>/, ""));
    }
  });

  it("replaces the Asset it showed before", () => {
    const html = `<main><div data-type='video' class="backdrop" data-asset="old" data-media='backdrop'/></main>`;
    expect(setPlayableBackdrop(html, "still", "image")).toBe(
      `<main><div class="backdrop" data-media='backdrop' data-asset="still" data-type="image"/></main>`,
    );
  });

  it("leaves HTML without a single background alone", () => {
    expect(playableBackdrop("<main><h1>Title</h1></main>")).toBeUndefined();
    expect(setPlayableBackdrop("<main></main>", "a", "image")).toBeUndefined();
    const two = '<div data-media="backdrop"></div><div data-media="backdrop"></div>';
    expect(setPlayableBackdrop(two, "a", "image")).toBeUndefined();
  });
});
