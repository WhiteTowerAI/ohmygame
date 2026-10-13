import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { canvasAssetCatalog } from "../src/daemon/canvas-assets.js";
import { readMediaDimensions } from "../src/daemon/media-dimensions.js";

const image = (format: "png" | "jpeg" | "webp" | "gif", options: object = {}) =>
  sharp({ create: { width: 300, height: 200, channels: 3, background: "#8a6" } })[format](options).withMetadata({ exif: { IFD0: { Copyright: "x".repeat(70_000) } } }).toBuffer();

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children), header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length); header.write(type, 4, "ascii");
  return Buffer.concat([header, body]);
}

function mp4(width: number, height: number, rotated = false): Buffer {
  const tkhd = Buffer.alloc(84);
  const matrix = rotated ? [0, 65536, 0, -65536, 0, 0, 0, 0, 0x40000000] : [65536, 0, 0, 0, 65536, 0, 0, 0, 0x40000000];
  matrix.forEach((value, index) => tkhd.writeInt32BE(value, 40 + index * 4));
  tkhd.writeUInt32BE(width * 65536, 76); tkhd.writeUInt32BE(height * 65536, 80);
  const audio = box("trak", box("tkhd", Buffer.alloc(84)));
  // moov after mdat, as in files written without fast start.
  return Buffer.concat([box("ftyp", Buffer.from("isom")), box("mdat", Buffer.alloc(32)), box("moov", box("mvhd", Buffer.alloc(100)), audio, box("trak", box("tkhd", tkhd)))]);
}

function exifTiff(orientation: number, little: boolean, ifd: number): Buffer {
  const tiff = Buffer.alloc(ifd + 18);
  const u16 = (value: number, at: number) => little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at);
  const u32 = (value: number, at: number) => little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at);
  tiff.write(little ? "II" : "MM", 0, "ascii"); u16(42, 2); u32(ifd, 4);
  u16(1, ifd); u16(0x0112, ifd + 2); u16(3, ifd + 4); u32(1, ifd + 6); u16(orientation, ifd + 10);
  return tiff;
}

function jpegWithExif(jpeg: Buffer, tiff: Buffer): Buffer {
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]), header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0); header.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, exif, jpeg.subarray(2)]);
}

describe("readMediaDimensions", () => {
  it("reads image and video headers without decoding", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-dimensions-"));
    const files: Array<[string, Buffer | Promise<Buffer>]> = [
      ["a.png", image("png")],
      ["a.jpg", image("jpeg")],
      ["lossy.webp", image("webp")],
      ["lossless.webp", image("webp", { lossless: true })],
      ["a.gif", image("gif")],
      ["a.mp4", mp4(300, 200)],
      // Signatures decide the format when an extension is wrong.
      ["jpeg-named.webp", image("jpeg")],
    ];
    for (const [name, contents] of files) {
      const file = path.join(directory, name);
      await writeFile(file, await contents);
      expect(await readMediaDimensions(file), name).toEqual({ width: 300, height: 200 });
    }
    await writeFile(path.join(directory, "portrait.mov"), mp4(1920, 1080, true));
    expect(await readMediaDimensions(path.join(directory, "portrait.mov"))).toEqual({ width: 1080, height: 1920 });
    const rotated = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#8a6" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    await writeFile(path.join(directory, "rotated.jpg"), rotated);
    expect(await readMediaDimensions(path.join(directory, "rotated.jpg"))).toEqual({ width: 200, height: 300 });
    await writeFile(path.join(directory, "broken.png"), "not an image");
    expect(await readMediaDimensions(path.join(directory, "broken.png"))).toBeUndefined();
    expect(await readMediaDimensions(path.join(directory, "missing.png"))).toBeUndefined();
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("uses the displayed PNG dimensions for EXIF orientation %i", async (orientation) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-png-orientation-"));
    const file = path.join(directory, "rotated.png");
    await writeFile(file, await sharp({ create: { width: 300, height: 200, channels: 3, background: "#8a6" } }).png().withMetadata({ orientation }).toBuffer());
    expect(await readMediaDimensions(file)).toEqual(orientation >= 5 ? { width: 200, height: 300 } : { width: 300, height: 200 });
  });

  it.each([true, false])("follows JPEG EXIF offsets beyond 4KB (little endian: %s)", async (little) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-jpeg-orientation-"));
    const file = path.join(directory, "large-exif.jpg");
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#8a6" } }).jpeg().toBuffer();
    await writeFile(file, jpegWithExif(jpeg, exifTiff(6, little, 5000)));
    expect(await readMediaDimensions(file)).toEqual({ width: 200, height: 300 });
  });

  it("ignores invalid TIFF metadata without reading outside the EXIF segment", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-invalid-exif-"));
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#8a6" } }).jpeg().toBuffer();
    const cases = [exifTiff(6, true, 5000).subarray(0, 8), exifTiff(6, true, 8).subarray(0, 20), exifTiff(9, true, 8)];
    for (const [index, tiff] of cases.entries()) {
      const file = path.join(directory, `${index}.jpg`);
      await writeFile(file, jpegWithExif(jpeg, tiff));
      expect(await readMediaDimensions(file)).toEqual({ width: 300, height: 200 });
    }
  });

  it("records dimensions for new Library assets and backfills older records", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-"));
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const asset = await library.add("boat.png", await image("png"));
    expect(asset).toMatchObject({ width: 300, height: 200 });
    const metadata = path.join(dataDirectory, "library/assets.json");
    const stored = JSON.parse(await readFile(metadata, "utf8"));
    delete stored.assets[0].width; delete stored.assets[0].height;
    await writeFile(metadata, JSON.stringify(stored));
    const restored = new AssetLibrary(dataDirectory);
    await restored.load();
    expect(restored.get(asset.id)).toMatchObject({ width: 300, height: 200 });
    expect(JSON.parse(await readFile(metadata, "utf8")).assets[0]).toMatchObject({ width: 300, height: 200 });
  });

  it("adds the current file dimensions to canvas catalog entries", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-"));
    await mkdir(path.join(workspace, "assets"));
    await writeFile(path.join(workspace, "assets/boat.png"), await image("png"));
    const [entry] = await canvasAssetCatalog(workspace, { version: 1, assets: { boat: { name: "Boat", path: "assets/boat.png" } } });
    expect(entry).toMatchObject({ id: "boat", width: 300, height: 200 });
  });
});
