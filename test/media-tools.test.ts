import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  cropImage,
  extractGifFrames,
  composeGif,
  composeImageLayers,
  splitImageGrid,
  composeVideo,
  extractVideoStrip,
  withMediaTask,
} from "../src/daemon/media-tools.js";
import { MAX_MEDIA_FRAMES } from "../src/shared/media-tools.js";

async function fixturePath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-media-tools-"));
  return path.join(directory, name);
}

function sumBefore(values: number[], index: number): number {
  return values.slice(0, index).reduce((sum, value) => sum + value, 0);
}

describe("media tools", () => {
  it("runs at most two media tasks together and starts the next after one finishes", async () => {
    const release: Array<() => void> = [];
    const started: number[] = [];
    let markThirdStarted!: () => void;
    const thirdStarted = new Promise<void>((resolve) => { markThirdStarted = resolve; });
    const tasks = [1, 2, 3].map((number) => withMediaTask(async () => {
      started.push(number);
      if (number === 3) markThirdStarted();
      await new Promise<void>((resolve) => release.push(resolve));
    }));
    expect(started).toEqual([1, 2]);
    release.shift()!();
    await thirdStarted;
    expect(started).toEqual([1, 2, 3]);
    for (const done of release) done();
    await Promise.all(tasks);
  });

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

  it("rejects batches over the shared frame limit before processing", async () => {
    const inputPath = await fixturePath("frame-limit.png");
    await sharp({ create: { width: 11, height: 10, channels: 4, background: "red" } }).png().toFile(inputPath);
    await expect(splitImageGrid({ inputPath, columns: 11, rows: 10 })).rejects.toThrow(`maximum ${MAX_MEDIA_FRAMES}`);
    await expect(composeVideo({ framePaths: Array(MAX_MEDIA_FRAMES + 1).fill(inputPath) })).rejects.toThrow(`1-${MAX_MEDIA_FRAMES}`);
  });
  it("rejects an oversized image before decoding it", async () => {
    const inputPath = await fixturePath("pixel-limit.png");
    await sharp({ create: { width: 8_001, height: 8_001, channels: 4, background: "red" } }).png().toFile(inputPath);
    await expect(cropImage({ inputPath, left: 0, top: 0, width: 1, height: 1 })).rejects.toThrow("64 megapixel");
  });
  it("crops by source pixels", async () => {
    const inputPath = await fixturePath("crop.png");
    await sharp({ create: { width: 10, height: 10, channels: 4, background: "red" } }).png().toFile(inputPath);
    const crop = await cropImage({ inputPath, left: 2, top: 1, width: 5, height: 4 });
    expect(await sharp(crop.bytes).metadata()).toMatchObject({ width: 5, height: 4 });
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
    await sharp({ create: { width: 12, height: 12, channels: 4, background: "red" } })
      .extend({ top: 2, bottom: 2, left: 2, right: 2, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toFile(first);
    await sharp({ create: { width: 10, height: 8, channels: 4, background: "blue" } }).png().toFile(second);

    const mp4 = await composeVideo({ framePaths: [first, second], format: "mp4" });
    expect(mp4.mediaType).toBe("video/mp4");
    expect(mp4.bytes.toString("ascii", 4, 8)).toBe("ftyp");

    const gif = await composeGif([first, second]);
    expect(gif.mediaType).toBe("image/gif");
    expect((await sharp(gif.bytes, { animated: true }).metadata()).pages).toBe(2);
    const secondFrame = await sharp(gif.bytes, { page: 1, pages: 1 }).ensureAlpha().raw().toBuffer();
    expect(secondFrame[3]).toBe(0); // A transparent source background stays transparent.
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

  it("keeps GIF frames when uneven grid cells need transparent padding", async () => {
    const paths = [];
    for (const [index, color] of ["red", "green", "blue"].entries()) {
      const file = await fixturePath(`uneven-gif-${index}.png`);
      const subject = await sharp({ create: { width: 1, height: 1, channels: 3, background: color } }).png().toBuffer();
      await sharp({ create: { width: index === 1 ? 6 : 5, height: 5, channels: 3, background: "#999999" } })
        .composite([{ input: subject, left: 2, top: 2 }]).removeAlpha().png().toFile(file);
      paths.push(file);
    }
    const gif = await composeGif(paths, 2);
    const metadata = await sharp(gif.bytes, { animated: true }).metadata();
    expect(metadata.pages).toBe(3);
    expect(metadata.delay).toEqual([500, 500, 500]);
    const inputPath = await fixturePath("uneven-grid.gif");
    await writeFile(inputPath, gif.bytes);
    const frames = await extractGifFrames({ inputPath });
    expect(metadata.width).toBe(6);
    expect(metadata.pageHeight).toBe(5);
    // Each source region remains opaque; only the extra right column is padded.
    for (const [index, frame] of frames.entries()) {
      const { data } = await sharp(frame.bytes).extract({ left: 0, top: 0, width: index === 1 ? 6 : 5, height: 5 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([...data].filter((_, index) => index % 4 === 3).every((alpha) => alpha === 255)).toBe(true);
    }
    const colors = await Promise.all(frames.map(async (frame) => {
      const pixel = await sharp(frame.bytes).extract({ left: 2, top: 2, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      return [...pixel];
    }));
    expect(colors).toEqual([[255, 0, 0], [0, 128, 0], [0, 0, 255]]);
  });

  it("keeps the subject anchored after splitting an uneven 12-frame sheet and composing a GIF", async () => {
    const width = 37, height = 28, columns = 4, rows = 3;
    const pixels = Buffer.alloc(width * height * 4);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const left = Math.round(column * width / columns);
        const top = Math.round(row * height / rows);
        const color = (row * columns + column) * 20 + 20;
        for (let y = 5; y < 8; y++) for (let x = 3; x < 5; x++) {
          pixels.set([color, 0, 0, 255], ((top + y) * width + left + x) * 4);
        }
      }
    }
    const sheet = await fixturePath("registered-sheet.png");
    await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(sheet);
    const split = await splitImageGrid({ inputPath: sheet, columns, rows, includeManifest: false });
    const paths = await Promise.all(split.map(async (frame, index) => {
      const file = await fixturePath(`registered-frame-${index}.png`);
      await writeFile(file, frame.bytes);
      return file;
    }));
    const gif = await composeGif(paths, 12);
    const metadata = await sharp(gif.bytes, { animated: true }).metadata();
    expect(metadata.pages).toBe(12);
    expect(metadata.width).toBe(10);
    expect(metadata.pageHeight).toBe(10);
    for (let page = 0; page < 12; page++) {
      const { data, info } = await sharp(gif.bytes, { page, pages: 1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const occupied = [];
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3]) occupied.push([x, y]);
      }
      expect(occupied).toEqual([[3, 5], [4, 5], [3, 6], [4, 6], [3, 7], [4, 7]]);
      expect([...data.subarray((5 * info.width + 3) * 4, (5 * info.width + 3) * 4 + 4)]).toEqual([page * 20 + 20, 0, 0, 255]);
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
