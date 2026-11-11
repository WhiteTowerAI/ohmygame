import sharp from "sharp";
import { expect, it } from "vitest";
import { fixPixelArt } from "../src/daemon/pixel-art-fixer.js";

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
