import sharp from "sharp";
import { expect, it } from "vitest";
import { fixPixelArt } from "../src/daemon/pixel-art-fixer.js";
import { refineGrid } from "../src/daemon/perfect-pixel.js";

function scaledPixelGrid(columns: number, rows: number): Buffer {
  const source = Buffer.alloc(columns * rows * 4);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const at = (y * columns + x) * 4;
      source[at] = (x * 31) % 256;
      source[at + 1] = (y * 47) % 256;
      source[at + 2] = ((x + y) * 23) % 256;
      source[at + 3] = (x + y) % 7 === 0 ? 0 : 255;
    }
  return source;
}

it("rebuilds a regular scaled pixel grid at an integral pixel scale", async () => {
  const columns = 16;
  const rows = 12;
  const scale = 8;
  const source = scaledPixelGrid(columns, rows);
  const input = await sharp(source, {
    raw: { width: columns, height: rows, channels: 4 },
  })
    .resize(columns * scale, rows * scale, { kernel: "nearest" })
    .png()
    .toBuffer();

  const result = await fixPixelArt(input);
  expect(result).toMatchObject({
    mediaType: "image/png",
    width: columns * scale,
    height: rows * scale,
  });
  const decoded = await sharp(result.bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(decoded.info).toMatchObject({
    width: columns * scale,
    height: rows * scale,
    channels: 4,
  });
  for (let y = 0; y < decoded.info.height; y += scale)
    for (let x = 0; x < decoded.info.width; x += scale) {
      const first = decoded.data.subarray((y * decoded.info.width + x) * 4, (y * decoded.info.width + x + 1) * 4);
      for (let insideY = y; insideY < y + scale; insideY++)
        for (let insideX = x; insideX < x + scale; insideX++)
          expect(decoded.data.subarray((insideY * decoded.info.width + insideX) * 4, (insideY * decoded.info.width + insideX + 1) * 4)).toEqual(first);
    }
});

it("recovers an uneven grid like the ones in generated pixel art", async () => {
  // 24×24 logical pixels drawn with cells 11, 12 or 13 source pixels wide.
  const logical = 24;
  const widths = Array.from({ length: logical }, (_, index) => [11, 12, 13, 12][index % 4]!);
  const edges = widths.reduce<number[]>((all, width) => [...all, all.at(-1)! + width], [0]);
  const size = edges.at(-1)!;
  let state = 0x2468ace;
  const colours = Array.from({ length: logical * logical }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return [(state >>> 8) & 0xe0, (state >>> 16) & 0xe0, (state >>> 24) & 0xe0, 255];
  });
  const cell = (position: number) => edges.findIndex((edge, index) => position >= edge && position < edges[index + 1]!);
  const source = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) source.set(colours[cell(y) * logical + cell(x)]!, (y * size + x) * 4);
  const input = await sharp(source, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();

  const result = await fixPixelArt(input);
  const scale = result.width / logical;
  expect(Number.isInteger(scale)).toBe(true);
  expect(result.height).toBe(result.width);
  const decoded = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let matching = 0;
  for (let y = 0; y < logical; y++)
    for (let x = 0; x < logical; x++) {
      const at = ((y * scale) * decoded.info.width + x * scale) * 4;
      if (decoded.data.subarray(at, at + 4).equals(Buffer.from(colours[y * logical + x]!))) matching++;
    }
  expect(matching).toBe(logical * logical);
});

it("refuses an image without a pixel grid", async () => {
  const input = await sharp({ create: { width: 256, height: 192, channels: 4, background: "#45648c" } }).png().toBuffer();
  await expect(fixPixelArt(input)).rejects.toMatchObject({ statusCode: 422 });
});

it("merges colours that differ only by noise and keeps distinct ones", async () => {
  // 16×16 cells of four colours, every source pixel jittered by up to ±4 per channel.
  const base = [[200, 60, 60], [40, 40, 160], [230, 220, 200], [20, 20, 20]];
  let state = 99;
  const jitter = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return ((state >>> 24) % 9) - 4;
  };
  const size = 128;
  const source = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const colour = base[(Math.floor(x / 8) * 7 + Math.floor(y / 8) * 3) % 4]!;
      source.set([...colour.map((value) => value + jitter()), 255], (y * size + x) * 4);
    }
  const input = await sharp(source, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const decoded = await sharp((await fixPixelArt(input)).bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const colours = new Set<string>();
  for (let at = 0; at < decoded.data.length; at += 4) colours.add(decoded.data.subarray(at, at + 3).toString("hex"));
  expect(colours.size).toBe(4);
});

it("places grid lines up to the left edge when cells are smaller than estimated", () => {
  // Cells are 11 pixels wide, but the estimate is 12 (55 cells across 660 pixels).
  const gradient = new Float64Array(660);
  for (let at = 0; at < gradient.length; at++) gradient[at] = 1 + 0.001 * at + (at % 11 === 0 ? 100 : 0);
  const lines = refineGrid(660, 55, gradient);
  expect(lines[0]).toBeLessThanOrEqual(0);
  expect(lines.at(-1)).toBeGreaterThanOrEqual(660);
});

/** Blocks of random colours with slightly soft edges, like generated pixel art. */
async function softBlocks(columns: number, rows: number, cell: number): Promise<Buffer> {
  let state = 11;
  const colours = Array.from({ length: columns * rows }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return [(state >>> 8) & 0xe0, (state >>> 16) & 0xe0, (state >>> 24) & 0xe0, 255];
  });
  const width = columns * cell;
  const height = rows * cell;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(colours[Math.floor(y / cell) * columns + Math.floor(x / cell)]!, (y * width + x) * 4);
  return sharp(data, { raw: { width, height, channels: 4 } }).blur(1.2).png().toBuffer();
}

it("keeps coarse pixel art whose cells are larger than the spectrum allows", async () => {
  // 32×32 logical pixels on a 1024 canvas: 32-pixel cells.
  const result = await fixPixelArt(await softBlocks(32, 32, 32));
  expect(result.width / 32).toBe(Math.round(result.width / 32));
  expect(result.width / Math.round(result.width / 32)).toBe(32);
});

it("refuses a grid with too few cells, such as panels of a character sheet", async () => {
  await expect(fixPixelArt(await softBlocks(12, 9, 128))).rejects.toMatchObject({ statusCode: 422 });
});
