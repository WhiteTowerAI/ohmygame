import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  compressPublishPng,
  PublishMediaOptimizer,
  stripPublishJpegMetadata,
} from "../src/daemon/publish/media.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("publish media optimization", () => {
  it("preserves PNG pixels, transparency and ancillary metadata", async () => {
    const png = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0.5 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const text = Buffer.from("Author\0Game Creator");
    const chunk = Buffer.alloc(text.length + 12);
    chunk.writeUInt32BE(text.length);
    chunk.write("tEXt", 4);
    text.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const original = Buffer.concat([
      png.subarray(0, 33),
      chunk,
      png.subarray(33),
    ]);
    const compressed = await compressPublishPng(original);
    expect(compressed.length).toBeLessThan(original.length / 10);
    expect(compressed.includes(chunk)).toBe(true);
    expect(
      (await sharp(compressed).raw().toBuffer()).equals(
        await sharp(original).raw().toBuffer(),
      ),
    ).toBe(true);
    expect(
      (await compressPublishPng(original.subarray(0, -1))).equals(
        original.subarray(0, -1),
      ),
    ).toBe(true);
    expect(await compressPublishPng(Buffer.from("bad PNG"))).toEqual(
      Buffer.from("bad PNG"),
    );
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect((await compressPublishPng(corrupt)).equals(corrupt)).toBe(true);
  });

  it("drops a JPEG's Exif, XMP and IPTC but keeps its pixels, colour profile and orientation", async () => {
    const image = sharp({
      create: { width: 64, height: 32, channels: 3, background: { r: 200, g: 40, b: 10 } },
    });
    const rotated = await image
      .clone()
      .jpeg()
      .withMetadata({ orientation: 6, icc: "p3" })
      .withExifMerge({ IFD0: { Copyright: "Someone", Make: "Phone" } })
      .toBuffer();
    const stripped = stripPublishJpegMetadata(rotated);
    expect(stripped.length).toBeLessThan(rotated.length);
    expect(stripped.includes(Buffer.from("Phone"))).toBe(false);
    const before = await sharp(rotated).metadata();
    const after = await sharp(stripped).metadata();
    expect(after.orientation).toBe(6);
    expect(after.icc?.equals(before.icc!)).toBe(true);
    expect(
      (await sharp(stripped).raw().toBuffer()).equals(
        await sharp(rotated).raw().toBuffer(),
      ),
    ).toBe(true);
    // Fill bytes before a marker don't hide it.
    const padded = Buffer.concat([rotated.subarray(0, 2), Buffer.from([0xff]), rotated.subarray(2)]);
    expect(stripPublishJpegMetadata(padded).includes(Buffer.from("Phone"))).toBe(false);
    // Upright, nothing of the Exif block is left.
    const upright = await image.clone().jpeg().withExif({ IFD0: { Make: "Phone" } }).toBuffer();
    expect((await sharp(stripPublishJpegMetadata(upright)).metadata()).exif).toBeUndefined();
    // Nothing to drop, or not a JPEG it can read: the same bytes.
    const plain = await image.clone().jpeg().toBuffer();
    expect(stripPublishJpegMetadata(plain)).toBe(plain);
    expect(stripPublishJpegMetadata(rotated.subarray(0, 40))).toEqual(rotated.subarray(0, 40));
  });

  it("leaves a game's videos as they are, and strips its photos", async () => {
    const source = await video();
    const photo = path.join(path.dirname(source), "photo.JPG");
    await writeFile(photo, await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } })
      .jpeg().withExif({ IFD0: { Make: "Phone" } }).toBuffer());
    const optimizer = new PublishMediaOptimizer();
    try {
      expect(await optimizer.optimize(source)).toBe(source);
      const copy = await optimizer.optimize(photo);
      expect(copy).not.toBe(photo);
      expect((await readFile(copy)).includes(Buffer.from("Phone"))).toBe(false);
      expect((await readFile(photo)).includes(Buffer.from("Phone"))).toBe(true);
    } finally {
      await optimizer.close();
    }
  });

});

async function video(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "ohmygame-publish-media-test-"),
  );
  roots.push(root);
  const source = path.join(root, "video.mp4");
  await writeFile(source, Buffer.alloc(512 * 1024));
  return source;
}
