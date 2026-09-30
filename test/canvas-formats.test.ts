import { describe, expect, it } from "vitest";
import {
  canvasFormatForViewport,
  canvasFormatPreset,
  canvasFormatSummary,
  viewportRatio,
} from "../src/shared/canvas-formats.js";

describe("canvas formats", () => {
  it("maps presets to their logical viewport", () => {
    expect(canvasFormatPreset("landscape").viewport).toEqual({
      width: 1280,
      height: 720,
    });
    expect(canvasFormatPreset("portrait").viewport).toEqual({
      width: 720,
      height: 1280,
    });
    expect(canvasFormatPreset("square").viewport).toEqual({
      width: 1080,
      height: 1080,
    });
  });

  it("derives stable ratios and summaries from the viewport", () => {
    expect(viewportRatio({ width: 1280, height: 720 })).toBe("16:9");
    expect(canvasFormatForViewport({ width: 720, height: 1280 })?.id).toBe(
      "portrait",
    );
    expect(canvasFormatSummary({ width: 1024, height: 768 })).toBe(
      "Custom 4:3 · 1024 x 768",
    );
  });
});
