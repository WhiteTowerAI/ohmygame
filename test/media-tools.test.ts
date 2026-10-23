import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  resizeImage,
  cropImage,
  outlineImage,
  brushRetouchImage,
  removeGreenScreen,
  removeBlueScreen,
  removeWhiteBackground,
  cutoutImage,
  sortFrames,
  stitchImages,
  extractGifFrames,
  composeGif,
  composeImageLayers,
  splitImageGrid,
  composeVideo,
  extractVideoStrip,
} from "../src/daemon/media-tools.js";

async function fixturePath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-media-tools-"));
  return path.join(directory, name);
}

function sumBefore(values: number[], index: number): number {
  return values.slice(0, index).reduce((sum, value) => sum + value, 0);
}

describe("media tools", () => {
  it("composites ordered image layers with alpha, offsets, and clipping", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-layers-"));
    try {
      const red = path.join(directory, "red.png");
      const blue = path.join(directory, "blue.png");
      await sharp({ create: { width: 4, height: 4, channels: 4, background: "red" } }).png().toFile(red);
      await sharp({ create: { width: 2, height: 2, channels: 4, background: "blue" } }).png().toFile(blue);
      const result = await composeImageLayers({ inputPaths: [red, blue], width: 4, height: 4, layers: [
        { x: 0, y: 0, scale: 1, opacity: 1, visible: true },
        { x: 1, y: 1, scale: 1, opacity: 0.5, visible: true },
      ] });
      const { data, info } = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info).toMatchObject({ width: 4, height: 4 });
      expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
      expect([...data.subarray((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)]).toEqual([126, 0, 128, 255]);
      const reordered = await composeImageLayers({ inputPaths: [blue, red], width: 4, height: 4, layers: [
        { x: 1, y: 1, scale: 1, opacity: 1, visible: true },
        { x: 0, y: 0, scale: 1, opacity: 1, visible: true },
      ] });
      const reorderedPixels = await sharp(reordered.bytes).ensureAlpha().raw().toBuffer();
      expect([...reorderedPixels.subarray((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)]).toEqual([255, 0, 0, 255]);
      const clipped = await composeImageLayers({ inputPaths: [blue], width: 2, height: 2, layers: [
        { x: -1, y: -1, scale: 1, opacity: 1, visible: true },
      ] });
      const clippedPixels = await sharp(clipped.bytes).ensureAlpha().raw().toBuffer();
      expect([...clippedPixels.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
      expect(clippedPixels[7]).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exports only selected grid cells in source order", async () => {
    const inputPath = await fixturePath("selected-grid.png");
    const pixels = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(inputPath);
    const frames = await splitImageGrid({ inputPath, columns: 2, rows: 2, selectedFrames: [0, 3] });
    expect(frames.map((frame) => frame.name)).toEqual(["frame-0000.png", "frame-0003.png", "manifest.json"]);
    expect([...await sharp(frames[0]!.bytes).ensureAlpha().raw().toBuffer()]).toEqual([255, 0, 0, 255]);
    expect([...await sharp(frames[1]!.bytes).ensureAlpha().raw().toBuffer()]).toEqual([255, 255, 0, 255]);
    expect(JSON.parse(frames[2]!.bytes.toString()).selectedFrames).toEqual([0, 3]);
    await expect(splitImageGrid({ inputPath, columns: 2, rows: 2, selectedFrames: [3, 0] })).rejects.toThrow("ascending order");
  });
  it.each([
    [removeGreenScreen, [0, 255, 0, 255]],
    [removeBlueScreen, [0, 0, 255, 255]],
    [removeWhiteBackground, [255, 255, 255, 255]],
  ] as const)("removes the keyed background and keeps subject alpha", async (remove, background) => {
    const inputPath = await fixturePath("background.png");
    await sharp(Buffer.from([...background, 255, 0, 0, 128]), { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(inputPath);
    const output = await remove({ inputPath });
    const pixels = await sharp(output.bytes).raw().toBuffer();
    expect(pixels[3]).toBe(0);
    expect(pixels[7]).toBe(128);
    await expect(remove({ inputPath, format: "jpeg" })).rejects.toThrow("transparency");
  });

  it("adds an outline only around the subject and preserves distant transparency", async () => {
    const inputPath = await fixturePath("outline.png");
    const pixels = Buffer.alloc(9 * 9 * 4);
    pixels.set([255, 0, 0, 255], (4 * 9 + 4) * 4);
    await sharp(pixels, { raw: { width: 9, height: 9, channels: 4 } }).png().toFile(inputPath);
    const output = await outlineImage({ inputPath, thickness: 1, color: "#00ff00" });
    expect(await sharp(output.bytes).metadata()).toMatchObject({ width: 11, height: 11 });
    const data = await sharp(output.bytes).raw().toBuffer();
    expect([...data.subarray((5 * 11 + 5) * 4, (5 * 11 + 5) * 4 + 4)]).toEqual([255, 0, 0, 255]);
    expect([...data.subarray((5 * 11 + 4) * 4, (5 * 11 + 4) * 4 + 4)]).toEqual([0, 255, 0, 255]);
    expect(data[3]).toBe(0);
  });

  it("draws a visible outline outside an opaque image, including every edge", async () => {
    const inputPath = await fixturePath("opaque-outline.png");
    await sharp({ create: { width: 4, height: 3, channels: 4, background: "white" } }).png().toFile(inputPath);
    const output = await outlineImage({ inputPath, thickness: 2, color: "#00ff00" });
    const { data, info } = await sharp(output.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 8, height: 7 });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
    expect(pixel(2, 2)).toEqual([255, 255, 255, 255]);
    expect(pixel(0, 2)).toEqual([0, 255, 0, 255]);
    expect(pixel(2, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(7, 2)).toEqual([0, 255, 0, 255]);
    expect(pixel(2, 6)).toEqual([0, 255, 0, 255]);
  });

  it("crops by source pixels and retains only the polygon region", async () => {
    const inputPath = await fixturePath("crop.png");
    await sharp({ create: { width: 10, height: 10, channels: 4, background: "red" } }).png().toFile(inputPath);
    const crop = await cropImage({ inputPath, left: 2, top: 1, width: 5, height: 4 });
    expect(await sharp(crop.bytes).metadata()).toMatchObject({ width: 5, height: 4 });
    const cutout = await cutoutImage({ inputPath, points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }] });
    const data = await sharp(cutout.bytes).raw().toBuffer();
    expect(data[3]).toBe(0);
    expect(data[(4 * 10 + 4) * 4 + 3]).toBe(255);
  });

  it("retouches strokes while preserving pixels outside them and source alpha", async () => {
    const inputPath = await fixturePath("brush.png");
    const pixels = Buffer.alloc(20 * 20 * 4);
    for (let index = 0; index < 400; index++) pixels.set([index % 2 ? 255 : 0, 0, 0, 128], index * 4);
    await sharp(pixels, { raw: { width: 20, height: 20, channels: 4 } }).png().toFile(inputPath);
    const output = await brushRetouchImage({ inputPath, strokes: [[{ x: 8, y: 8 }, { x: 12, y: 8 }], [{ x: 3, y: 16 }]], radius: 2, strength: 20 });
    const data = await sharp(output.bytes).raw().toBuffer();
    expect([...data.subarray(0, 4)]).toEqual([...pixels.subarray(0, 4)]);
    expect(data[(8 * 20 + 10) * 4]).toBeGreaterThan(0);
    expect(data[(8 * 20 + 10) * 4 + 3]).toBe(128);
    expect(data[(16 * 20 + 3) * 4]).toBeLessThan(255);
  });

  it("visibly softens textured pixels with default brush strength", async () => {
    const inputPath = await fixturePath("brush-default.png");
    const width = 128;
    const pixels = Buffer.alloc(width * width * 4);
    for (let y = 0; y < width; y += 1)
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels.fill((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 255 : 0, offset, offset + 3);
        pixels[offset + 3] = 255;
      }
    await sharp(pixels, { raw: { width, height: width, channels: 4 } }).png().toFile(inputPath);
    const output = await brushRetouchImage({ inputPath, strokes: [[{ x: 64, y: 64 }]], radius: 12 });
    const data = await sharp(output.bytes).raw().toBuffer();
    expect(data[(64 * width + 64) * 4]).toBeGreaterThan(80);
    expect(data[0]).toBe(pixels[0]);
  });

  it("saves explicit frame order and stitches without cropping mixed sizes", async () => {
    const red = await fixturePath("red.png");
    const blue = await fixturePath("blue.png");
    await sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } }).png().toFile(red);
    await sharp({ create: { width: 2, height: 4, channels: 4, background: "blue" } }).png().toFile(blue);
    const frames = await sortFrames([blue, red]);
    expect(frames.map((frame) => frame.name)).toEqual(["frame-0000.png", "frame-0001.png"]);
    expect([...(await sharp(frames[0]!.bytes).raw().toBuffer()).subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    const stitched = await stitchImages({ inputPaths: [red, blue], direction: "horizontal" });
    expect(await sharp(stitched.bytes).metadata()).toMatchObject({ width: 5, height: 4 });
    const data = await sharp(stitched.bytes).raw().toBuffer();
    expect([...data.subarray(3 * 4, 4 * 4)]).toEqual([0, 0, 255, 255]);
    expect(data[(3 * 5) * 4 + 3]).toBe(0);
  });

  it("extracts all animated GIF pages in order and rejects other image formats", async () => {
    const inputPath = await fixturePath("animated.gif");
    await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100, 100], loop: 0 }).toFile(inputPath);
    const frames = await extractGifFrames({ inputPath });
    expect(frames).toHaveLength(2);
    expect([...(await sharp(frames[1]!.bytes).raw().toBuffer()).subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    const png = await fixturePath("not-a-gif.png");
    await sharp(frames[0]!.bytes).toFile(png);
    await expect(extractGifFrames({ inputPath: png })).rejects.toThrow("GIF");
  });
  it("uses both requested dimensions when no resize fit is supplied", async () => {
    const inputPath = await fixturePath("edit-square-input.png");
    await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 220, g: 80, b: 40, alpha: 1 },
      },
    })
      .png()
      .toFile(inputPath);

    const output = await resizeImage({ inputPath, width: 512, height: 512 });
    const metadata = await sharp(output.bytes).metadata();
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
    const { data, info } = await sharp(output.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    expect(
      data[((info.height / 2) * info.width + info.width / 2) * 4 + 3],
    ).toBe(255);
  });

  it("splits a sprite sheet in row-major order and emits an index", async () => {
    const inputPath = await fixturePath("grid-input.png");
    const pixels = Buffer.alloc(4 * 2 * 4);
    for (let index = 0; index < 2; index += 1) {
      const color = [255, 0, 0, 255, 0, 255, 0, 255].slice(
        index * 4,
        index * 4 + 4,
      );
      for (let y = 0; y < 2; y += 1)
        for (let x = 0; x < 2; x += 1) {
          const offset = (y * 4 + index * 2 + x) * 4;
          pixels.set(color, offset);
        }
    }
    await sharp(pixels, { raw: { width: 4, height: 2, channels: 4 } })
      .png()
      .toFile(inputPath);

    const outputs = await splitImageGrid({ inputPath, columns: 2, rows: 1 });
    expect(outputs.map((output) => output.name)).toEqual([
      "frame-0000.png",
      "frame-0001.png",
      "manifest.json",
    ]);
    const first = await sharp(outputs[0]!.bytes).metadata();
    expect(first.width).toBe(2);
    expect(first.height).toBe(2);
    expect(JSON.parse(outputs[2]!.bytes.toString())).toMatchObject({
      columns: 2,
      rows: 1,
      cellWidth: 2,
      cellHeight: 2,
      frames: 2,
    });
  });

  it("preserves every pixel when grid dimensions are not evenly divisible", async () => {
    const inputPath = await fixturePath("uneven-grid.png");
    const width = 5;
    const height = 4;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = x + 1;
        pixels[offset + 1] = y + 1;
        pixels[offset + 3] = 255;
      }
    }
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(inputPath);

    const outputs = await splitImageGrid({
      inputPath,
      columns: 3,
      rows: 2,
      includeManifest: true,
    });
    const frames = outputs.filter((output) => output.name.startsWith("frame-"));
    const manifest = JSON.parse(
      outputs
        .find((output) => output.name === "manifest.json")!
        .bytes.toString(),
    );
    expect(manifest.columnWidths).toEqual([2, 1, 2]);
    expect(manifest.rowHeights).toEqual([2, 2]);
    expect(
      await Promise.all(
        frames.map(async (frame) => {
          const metadata = await sharp(frame.bytes).metadata();
          return [metadata.width, metadata.height];
        }),
      ),
    ).toEqual([
      [2, 2],
      [1, 2],
      [2, 2],
      [2, 2],
      [1, 2],
      [2, 2],
    ]);
    const pixelsInFrames = await Promise.all(
      frames.map(async (frame) => {
        const { data } = await sharp(frame.bytes).raw().toBuffer({
          resolveWithObject: true,
        });
        return data.length / 4;
      }),
    );
    expect(pixelsInFrames.reduce((sum, count) => sum + count, 0)).toBe(
      width * height,
    );
    const reconstructed = Buffer.alloc(width * height * 4);
    let frameIndex = 0;
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const frame = frames[frameIndex++]!;
        const { data, info } = await sharp(frame.bytes)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        for (let y = 0; y < info.height; y += 1) {
          const sourceOffset = y * info.width * 4;
          const targetOffset =
            ((sumBefore(manifest.rowHeights, row) + y) * width +
              sumBefore(manifest.columnWidths, column)) *
            4;
          for (let x = 0; x < info.width; x += 1) {
            const sourcePixel = sourceOffset + x * 4;
            const targetPixel = targetOffset + x * 4;
            reconstructed.set(
              data.subarray(sourcePixel, sourcePixel + 4),
              targetPixel,
            );
          }
        }
      }
    }
    expect(reconstructed).toEqual(pixels);
  });

  it("splits images using their displayed EXIF orientation", async () => {
    const inputPath = await fixturePath("oriented-grid.jpg");
    await sharp({
      create: { width: 2, height: 4, channels: 3, background: "red" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(inputPath);

    const outputs = await splitImageGrid({
      inputPath,
      columns: 2,
      rows: 1,
      includeManifest: false,
    });
    const dimensions = await Promise.all(
      outputs.map(async (output) => {
        const metadata = await sharp(output.bytes).metadata();
        return [metadata.width, metadata.height];
      }),
    );
    expect(dimensions).toEqual([
      [2, 2],
      [2, 2],
    ]);
  });

  it("normalizes mismatched frame dimensions without cropping them", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-ffmpeg-normalize-"),
    );
    const ffmpeg = path.join(directory, "ffmpeg");
    const firstPath = await fixturePath("compose-a.png");
    const secondPath = await fixturePath("compose-b.png");
    await sharp({
      create: { width: 5, height: 3, channels: 4, background: "red" },
    })
      .png()
      .toFile(firstPath);
    await sharp({
      create: { width: 4, height: 4, channels: 4, background: "blue" },
    })
      .png()
      .toFile(secondPath);
    await writeFile(
      ffmpeg,
      `#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const input = args[args.indexOf("-i") + 1];
const directory = path.dirname(input);
const names = (await readdir(directory)).filter((name) => /^frame-\\d{6}\\.png$/.test(name)).sort();
const dimensions = [];
for (const name of names) {
  const bytes = await readFile(path.join(directory, name));
  dimensions.push([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]);
}
await writeFile(args.at(-1), JSON.stringify(dimensions));
`,
    );
    await chmod(ffmpeg, 0o755);
    const originalFfmpeg = process.env.OHMYGAME_FFMPEG_PATH;
    process.env.OHMYGAME_FFMPEG_PATH = ffmpeg;
    try {
      const output = await composeVideo({
        framePaths: [firstPath, secondPath],
        format: "mp4",
      });
      expect(JSON.parse(output.bytes.toString())).toEqual([
        [6, 4],
        [6, 4],
      ]);
    } finally {
      if (originalFfmpeg === undefined) delete process.env.OHMYGAME_FFMPEG_PATH;
      else process.env.OHMYGAME_FFMPEG_PATH = originalFfmpeg;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("encodes MP4 and GIF with the installed FFmpeg binary", async () => {
    const first = await fixturePath("encode-first.png");
    const second = await fixturePath("encode-second.png");
    await sharp({ create: { width: 16, height: 16, channels: 4, background: "red" } }).png().toFile(first);
    await sharp({ create: { width: 10, height: 8, channels: 4, background: "blue" } }).png().toFile(second);

    const mp4 = await composeVideo({ framePaths: [first, second], format: "mp4" });
    expect(mp4.mediaType).toBe("video/mp4");
    expect(mp4.bytes.toString("ascii", 4, 8)).toBe("ftyp");

    const gif = await composeGif([first, second]);
    expect(gif.mediaType).toBe("image/gif");
    expect((await sharp(gif.bytes, { animated: true }).metadata()).pages).toBe(2);
  });

  it("exports only selected video frames with their original indices", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-selected-video-"));
    try {
      const frames = await Promise.all(["red", "green", "blue"].map(async (color, index) => {
        const file = path.join(directory, `source-${index}.png`);
        await sharp({ create: { width: 16, height: 16, channels: 4, background: color } }).png().toFile(file);
        return file;
      }));
      const video = await composeVideo({ framePaths: frames, fps: 2 });
      const inputPath = path.join(directory, "source.mp4");
      await writeFile(inputPath, video.bytes);
      const outputs = await extractVideoStrip({ inputPath, fps: 2, selectedFrames: [0, 2] });
      expect(outputs.map((output) => output.name)).toEqual(["frame-0000.png", "frame-0002.png", "manifest.json"]);
      expect(JSON.parse(outputs[2]!.bytes.toString()).frames.map((frame: { i: number }) => frame.i)).toEqual([0, 2]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps all three GIF frames in the selected order", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-gif-frames-"));
    try {
      const paths = await Promise.all(["red", "green", "blue"].map(async (color) => {
        const file = path.join(directory, `${color}.png`);
        await sharp({ create: { width: 16, height: 16, channels: 4, background: color } }).png().toFile(file);
        return file;
      }));
      const gif = await composeGif(paths, 2);
      const metadata = await sharp(gif.bytes, { animated: true }).metadata();
      const { data, info } = await sharp(gif.bytes, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.pages).toBe(3);
      expect(metadata.delay).toEqual([500, 500, 500]);
      const frameBytes = data.length / 3;
      expect([0, 1, 2].map((frame) => [...data.subarray(frame * frameBytes, frame * frameBytes + 3)])).toEqual([
        [255, 0, 0], [0, 128, 0], [0, 0, 255],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["mp4", "gif"] as const)("starts %s input sequences at the first generated frame without start_number", async (format) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-ffmpeg-fixture-"),
    );
    const ffmpeg = path.join(directory, "ffmpeg");
    const firstPath = path.join(directory, "first.png");
    const secondPath = path.join(directory, "second.png");
    await sharp({
      create: { width: 4, height: 4, channels: 4, background: "red" },
    })
      .png()
      .toFile(firstPath);
    await sharp({
      create: { width: 4, height: 4, channels: 4, background: "blue" },
    })
      .png()
      .toFile(secondPath);
    await writeFile(
      ffmpeg,
      `#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const input = args[args.indexOf("-i") + 1];
if (args.includes("-start_number")) process.exit(2);
await access(input.replace("%06d", "000001"));
await access(input.replace("%06d", "000002"));
await writeFile(args.at(-1), Buffer.from("fixture"));
`,
    );
    await chmod(ffmpeg, 0o755);
    const originalFfmpeg = process.env.OHMYGAME_FFMPEG_PATH;
    process.env.OHMYGAME_FFMPEG_PATH = ffmpeg;
    try {
      const output = format === "gif"
        ? await composeGif([firstPath, secondPath])
        : await composeVideo({ framePaths: [firstPath, secondPath], format });
      expect(output.bytes.toString()).toBe("fixture");
    } finally {
      if (originalFfmpeg === undefined) delete process.env.OHMYGAME_FFMPEG_PATH;
      else process.env.OHMYGAME_FFMPEG_PATH = originalFfmpeg;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
