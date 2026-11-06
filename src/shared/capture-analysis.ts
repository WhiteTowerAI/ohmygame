import type { PlaytestCapture } from "./playtest.js";

/**
 * Whether a capture is likely blank: almost nothing opaque, or almost no
 * variation in brightness. Reads about 10,000 pixels of a 4-byte-per-pixel
 * bitmap, BGRA as Electron gives it or RGBA as sharp does.
 */
export function analyzeBitmap(bitmap: Uint8Array, width: number, height: number, order: "bgra" | "rgba" = "bgra"): PlaytestCapture["analysis"] {
  const pixels = Math.min(width * height, Math.floor(bitmap.length / 4));
  if (pixels < 1) return { sampledPixels: 0, opaqueRatio: 0, luminanceMean: 0, luminanceVariance: 0, likelyBlank: true };
  const stride = Math.max(1, Math.floor(pixels / 10_000));
  let sampledPixels = 0;
  let opaquePixels = 0;
  let luminanceSum = 0;
  let squaredSum = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4;
    const first = bitmap[offset] ?? 0;
    const green = bitmap[offset + 1] ?? 0;
    const third = bitmap[offset + 2] ?? 0;
    const [red, blue] = order === "bgra" ? [third, first] : [first, third];
    const alpha = bitmap[offset + 3] ?? 0;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sampledPixels++;
    if (alpha > 8) opaquePixels++;
    luminanceSum += luminance;
    squaredSum += luminance * luminance;
  }
  const luminanceMean = luminanceSum / sampledPixels;
  const luminanceVariance = Math.max(0, squaredSum / sampledPixels - luminanceMean * luminanceMean);
  const opaqueRatio = opaquePixels / sampledPixels;
  return {
    sampledPixels,
    opaqueRatio: rounded(opaqueRatio),
    luminanceMean: rounded(luminanceMean),
    luminanceVariance: rounded(luminanceVariance),
    likelyBlank: opaqueRatio < 0.01 || luminanceVariance < 1,
  };
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
