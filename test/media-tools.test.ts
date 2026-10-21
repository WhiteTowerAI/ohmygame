import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  editImage,
  splitImageGrid,
  transformImage,
  composeVideo,
} from "../src/daemon/media-tools.js";

async function fixturePath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-media-tools-"));
  return path.join(directory, name);
}

function sumBefore(values: number[], index: number): number {
  return values.slice(0, index).reduce((sum, value) => sum + value, 0);
}

describe("media tools", () => {
  it("edits a raster image and preserves the requested output dimensions", async () => {
    const inputPath = await fixturePath("edit-input.png");
    await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 4,
        background: { r: 220, g: 80, b: 40, alpha: 1 },
      },
    })
      .png()
      .toFile(inputPath);

    const output = await editImage({
      inputPath,
      crop: { left: 0, top: 0, width: 2, height: 2 },
      width: 8,
      height: 6,
      fit: "fill",
      grayscale: true,
      pixelate: 2,
    });
    const metadata = await sharp(output.bytes).metadata();
    expect(metadata.width).toBe(8);
    expect(metadata.height).toBe(6);
    expect(output.mediaType).toBe("image/png");
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

    const output = await editImage({ inputPath, width: 512, height: 512 });
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

  it("rotates and mirrors an image as one independent operation", async () => {
    const inputPath = await fixturePath("transform-input.png");
    await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 1 },
      },
    })
      .png()
      .toFile(inputPath);
    const output = await transformImage({ inputPath, rotate: 90, flop: true });
    const metadata = await sharp(output.bytes).metadata();
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(3);
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
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
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
      process.env.PATH = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts FFmpeg input sequences at the first generated frame", async () => {
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
if (!args.includes("-start_number") || args[args.indexOf("-start_number") + 1] !== "0" || args.indexOf("-start_number") > args.indexOf("-i")) process.exit(2);
await access(input.replace("%06d", "000000"));
await writeFile(args.at(-1), Buffer.from("fixture"));
`,
    );
    await chmod(ffmpeg, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    try {
      const output = await composeVideo({
        framePaths: [firstPath, secondPath],
        format: "mp4",
      });
      expect(output.bytes.toString()).toBe("fixture");
    } finally {
      process.env.PATH = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
