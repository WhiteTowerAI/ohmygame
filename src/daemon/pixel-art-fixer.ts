import sharp from "sharp";
import type { GeneratedImageMediaType } from "./openai-image.js";

/** Local, deterministic pixel-grid snapper used after pixel-art generation. */
export async function fixPixelArtBytes(bytes: Buffer): Promise<{ bytes: Buffer; mediaType: GeneratedImageMediaType }> {
  const source = sharp(bytes, { limitInputPixels: 100_000_000 }).ensureAlpha();
  const metadata = await source.metadata();
  const width = metadata.width ?? 0, height = metadata.height ?? 0;
  if (width < 32 || height < 32) return { bytes, mediaType: "image/png" };
  const scale = Math.min(1, 256 / Math.max(width, height));
  const probe = await source.clone().resize({ width: Math.max(32, Math.round(width * scale)), height: Math.max(32, Math.round(height * scale)), fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  // Pixel Art Fixer works even when the source has no obvious grid. In that
  // case use a conservative logical canvas instead of returning the input
  // unchanged (which made the toolbar appear to do nothing).
  const step = detectStep(probe.data, probe.info.width, probe.info.height) ?? fallbackStep(probe.info.width, probe.info.height);
  const { data } = await source.raw().toBuffer({ resolveWithObject: true });
  const snapped = Buffer.from(data);
  const cellW = Math.max(1, Math.round(step / scale));
  const cellH = cellW;
  for (let top = 0; top < height; top += cellH) for (let left = 0; left < width; left += cellW) {
    const right = Math.min(width, left + cellW), bottom = Math.min(height, top + cellH);
    const colors = new Map<string, { count: number; sum: number[] }>();
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const o = (y * width + x) * 4;
      // Bucket colours before choosing the cell representative. Generated
      // images rarely contain identical neighbouring RGB values, while pixel
      // art relies on a small, stable palette.
      const alpha = data[o + 3]!;
      const key = `${Math.round(data[o]! / 16)}:${Math.round(data[o + 1]! / 16)}:${Math.round(data[o + 2]! / 16)}:${Math.round(alpha / 16)}`;
      const entry = colors.get(key) ?? { count: 0, sum: [0, 0, 0, 0] };
      entry.count += alpha === 0 ? 0.25 : 1;
      for (let c = 0; c < 4; c++) entry.sum[c]! += data[o + c]!;
      colors.set(key, entry);
    }
    const winner = [...colors.values()].sort((a, b) => b.count - a.count)[0];
    if (!winner) continue;
    const color = winner.sum.map((value) => Math.round(value / winner.count));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { const o = (y * width + x) * 4; for (let c = 0; c < 4; c++) snapped[o + c] = color[c]!; }
  }
  return { bytes: await sharp(snapped, { raw: { width, height, channels: 4 } }).png().toBuffer(), mediaType: "image/png" };
}

function fallbackStep(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (longest >= 1024) return 8;
  if (longest >= 512) return 4;
  if (longest >= 64) return 2;
  return 1;
}

function detectStep(data: Buffer, width: number, height: number): number | undefined {
  const scores: Array<{ step: number; score: number }> = [];
  for (let step = 2; step <= Math.min(24, Math.floor(Math.min(width, height) / 3)); step++) {
    let edge = 0, inside = 0, edgeN = 0, insideN = 0;
    for (let y = 0; y < height; y++) for (let x = 1; x < width; x++) {
      const a = (y * width + x - 1) * 4, b = a + 4;
      const delta = Math.abs(data[a]! - data[b]!) + Math.abs(data[a + 1]! - data[b + 1]!) + Math.abs(data[a + 2]! - data[b + 2]!);
      if (x % step === 0) { edge += delta; edgeN++; } else { inside += delta; insideN++; }
    }
    for (let y = 1; y < height; y++) for (let x = 0; x < width; x++) {
      const a = ((y - 1) * width + x) * 4, b = a + width * 4;
      const delta = Math.abs(data[a]! - data[b]!) + Math.abs(data[a + 1]! - data[b + 1]!) + Math.abs(data[a + 2]! - data[b + 2]!);
      if (y % step === 0) { edge += delta; edgeN++; } else { inside += delta; insideN++; }
    }
    scores.push({ step, score: edge / edgeN - inside / insideN });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores[0] && scores[0].score > 10 ? scores[0].step : undefined;
}
