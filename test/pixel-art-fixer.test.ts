import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fixPixelArtBytes } from "../src/daemon/pixel-art-fixer.js";

describe("pixel art fixer", () => {
  it("leaves a smooth source unchanged instead of inventing a destructive grid", async () => {
    const width = 64;
    const height = 64;
    const input = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      input[offset] = x * 4;
      input[offset + 1] = y * 4;
      input[offset + 2] = 180;
      input[offset + 3] = 255;
    }
    const source = await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const result = await fixPixelArtBytes(source);
    const metadata = await sharp(result.bytes).metadata();
    expect(result.mediaType).toBe("image/png");
    expect(metadata).toMatchObject({ width, height, format: "png" });
    expect(result.bytes.equals(source)).toBe(true);
  });

  it("keeps transparent cells transparent without overflowing their colour channels", async () => {
    const width = 64;
    const height = 64;
    const input = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      input[offset] = 255;
      input[offset + 1] = 128;
      input[offset + 2] = 64;
      input[offset + 3] = 0;
    }
    const source = await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const result = await fixPixelArtBytes(source);
    const { data } = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let offset = 0; offset < data.length; offset += 4) expect(data[offset + 3]).toBe(0);
  });
});
