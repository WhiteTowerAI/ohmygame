import { describe, expect, it } from "vitest";
import { PLAYABLE_PRESETS } from "../src/daemon/playable-presets.js";
import { clearPlayableBackdrop, playableBackdrop, setPlayableBackdrop } from "../src/shared/playable-backdrop.js";

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

  it("keeps a `>` inside another attribute's value", () => {
    const html = `<main><div class="backdrop" data-media="backdrop" aria-label="Platform 3 -> the night train" data-asset="platform" data-type="image"></div></main>`;
    expect(playableBackdrop(html)).toBe("set");
    expect(setPlayableBackdrop(html, "night-train", "video")).toBe(
      `<main><div class="backdrop" data-media="backdrop" aria-label="Platform 3 -> the night train" data-asset="night-train" data-type="video"></div></main>`,
    );
    const before = `<main><div title='Platform 3 -> the night train' class="backdrop" data-media='backdrop'></div></main>`;
    expect(playableBackdrop(before)).toBe("missing");
    expect(setPlayableBackdrop(before, "night-train", "image")).toBe(
      `<main><div title='Platform 3 -> the night train' class="backdrop" data-media='backdrop' data-asset="night-train" data-type="image"></div></main>`,
    );
  });

  it("leaves HTML without a single background alone", () => {
    expect(playableBackdrop("<main><h1>Title</h1></main>")).toBeUndefined();
    expect(setPlayableBackdrop("<main></main>", "a", "image")).toBeUndefined();
    const two = '<div data-media="backdrop"></div><div data-media="backdrop"></div>';
    expect(setPlayableBackdrop(two, "a", "image")).toBeUndefined();
  });
});

describe("clearPlayableBackdrop", () => {
  it("takes the Asset off every Template's background", () => {
    for (const { source } of PLAYABLE_PRESETS) {
      const { html } = source("Opening");
      const cleared = clearPlayableBackdrop(setPlayableBackdrop(html, "opening", "video")!)!;
      expect(cleared).toBe(html);
      expect(playableBackdrop(cleared)).toBe("missing");
    }
  });

  it("keeps the background tag's other attributes", () => {
    const html = `<main><div data-type='video' class="backdrop" data-asset="old" data-media='backdrop'/></main>`;
    expect(clearPlayableBackdrop(html)).toBe(`<main><div class="backdrop" data-media='backdrop'/></main>`);
  });

  it("keeps a `>` inside another attribute's value", () => {
    const html = `<main><div class="backdrop" data-media="backdrop" aria-label="Platform 3 -> the night train" data-asset="platform" data-type="image"></div></main>`;
    expect(clearPlayableBackdrop(html)).toBe(
      `<main><div class="backdrop" data-media="backdrop" aria-label="Platform 3 -> the night train"></div></main>`,
    );
  });

  it("leaves HTML without a single background alone", () => {
    expect(clearPlayableBackdrop("<main></main>")).toBeUndefined();
    expect(clearPlayableBackdrop('<div data-media="backdrop"></div><div data-media="backdrop"></div>')).toBeUndefined();
  });
});
