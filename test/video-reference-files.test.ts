import { describe, expect, it } from "vitest";
import { validateVideoReferenceCounts, validateVideoReferenceDurations, validVideoReferenceCombination } from "../src/renderer/video-reference-files.js";

describe("video reference rules", () => {
  it("enforces per-media counts", () => {
    expect(() => validateVideoReferenceCounts(Array(9).fill("image"))).not.toThrow();
    expect(() => validateVideoReferenceCounts(Array(10).fill("image"))).toThrow("up to 9");
    expect(() => validateVideoReferenceCounts(Array(4).fill("video"))).toThrow("up to 3");
    expect(() => validateVideoReferenceCounts(Array(4).fill("audio"))).toThrow("up to 3");
  });

  it("enforces aggregate video and audio duration", () => {
    expect(() => validateVideoReferenceDurations([{ type: "video", duration: 8 }], [{ type: "video", duration: 7 }])).not.toThrow();
    expect(() => validateVideoReferenceDurations([], [{ type: "video", duration: 1.9 }])).toThrow("2 to 15 seconds");
    expect(() => validateVideoReferenceDurations([], [{ type: "audio", duration: 15.1 }])).toThrow("2 to 15 seconds");
    expect(() => validateVideoReferenceDurations([{ type: "video", duration: 8 }], [{ type: "video", duration: 7.1 }])).toThrow("15 seconds");
    expect(() => validateVideoReferenceDurations([{ type: "audio", duration: 10 }], [{ type: "audio", duration: 6 }])).toThrow("15 seconds");
  });

  it("requires visual media alongside audio", () => {
    expect(validVideoReferenceCombination([{ type: "audio" }])).toBe(false);
    expect(validVideoReferenceCombination([{ type: "audio" }, { type: "image" }])).toBe(true);
    expect(validVideoReferenceCombination([{ type: "audio" }, { type: "video" }])).toBe(true);
  });
});
