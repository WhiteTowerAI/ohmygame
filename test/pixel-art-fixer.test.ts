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

it("pixelates a textured image even without a repeatable source grid", async () => {
  const pixels = Buffer.alloc(128 * 128 * 4);
  let state = 0x12345678;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    state = (state * 1664525 + 1013904223) >>> 0;
    pixels[offset] = state & 0xff;
    pixels[offset + 1] = (state >>> 8) & 0xff;
    pixels[offset + 2] = (state >>> 16) & 0xff;
    pixels[offset + 3] = 255;
  }
  const input = await sharp(pixels, {
    raw: { width: 128, height: 128, channels: 4 },
  })
    .png()
    .toBuffer();
  const result = await fixPixelArt(input);
  const decoded = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(result.width).toBeLessThanOrEqual(128);
  expect(result.height).toBeLessThanOrEqual(128);
  const colours = new Set<string>();
  for (let at = 0; at < decoded.data.length; at += 4)
    if (decoded.data[at + 3]) colours.add(decoded.data.subarray(at, at + 3).toString("hex"));
  expect(colours.size).toBeLessThanOrEqual(48);
});

it("uses binary alpha, a reduced palette, and nearest-neighbour enlargement", async () => {
  const input = await sharp(
    Buffer.from(`
      <svg width="256" height="192" xmlns="http://www.w3.org/2000/svg">
        <defs><radialGradient id="sky"><stop stop-color="#f8d58c"/><stop offset="1" stop-color="#45648c"/></radialGradient></defs>
        <rect width="256" height="192" fill="url(#sky)"/>
        <ellipse cx="128" cy="112" rx="70" ry="54" fill="#d8d1c8"/>
        <circle cx="104" cy="96" r="9" fill="#1c1c1c"/><circle cx="152" cy="96" r="9" fill="#1c1c1c"/>
        <path d="M96 130 Q128 150 160 130" stroke="#714650" stroke-width="8" fill="none"/>
      </svg>`),
  )
    .png()
    .toBuffer();
  const result = await fixPixelArt(input);
  const decoded = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(result.width).toBeLessThanOrEqual(256);
  expect(result.height).toBeLessThanOrEqual(192);
  const colours = new Set<string>();
  for (let at = 0; at < decoded.data.length; at += 4) {
    expect([0, 255]).toContain(decoded.data[at + 3]);
    if (decoded.data[at + 3]) colours.add(decoded.data.subarray(at, at + 3).toString("hex"));
  }
  expect(colours.size).toBeLessThanOrEqual(48);
  expect(result.bytes.equals(input)).toBe(false);
});
