import { describe, expect, it } from "vitest";
import {
  storyFormatForViewport,
  storyFormatPreset,
  storyFormatSummary,
  storyViewportRatio,
} from "../src/shared/story-formats.js";

describe("Interactive Drama canvas formats", () => {
  it("maps presets to their logical viewport", () => {
    expect(storyFormatPreset("landscape").viewport).toEqual({
      width: 1280,
      height: 720,
    });
    expect(storyFormatPreset("portrait").viewport).toEqual({
      width: 720,
      height: 1280,
    });
    expect(storyFormatPreset("square").viewport).toEqual({
      width: 1080,
      height: 1080,
    });
  });

  it("derives stable ratios and summaries from the viewport", () => {
    expect(storyViewportRatio({ width: 1280, height: 720 })).toBe("16:9");
    expect(storyFormatForViewport({ width: 720, height: 1280 })?.id).toBe(
      "portrait",
    );
    expect(storyFormatSummary({ width: 1024, height: 768 })).toBe(
      "Custom 4:3 · 1024 x 768",
    );
  });
});
