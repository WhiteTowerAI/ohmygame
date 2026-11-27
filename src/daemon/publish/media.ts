import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, deflate, inflate } from "node:zlib";
import { PUBLISH_ARTIFACT_MAX_BYTES } from "../../shared/publish-v1.js";
import { PNG_SIGNATURE } from "../image-format.js";

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** Recompress PNG scanlines without changing pixels, animation, or metadata. */
export async function compressPublishPng(bytes: Buffer): Promise<Buffer> {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return bytes;
  const chunks: { type: string; bytes: Buffer }[] = [];
  const data: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) return bytes;
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) return bytes;
    const chunk = bytes.subarray(offset, end);
    if (crc32(chunk.subarray(4, -4)) !== chunk.readUInt32BE(chunk.length - 4))
      return bytes;
    const type = chunk.toString("ascii", 4, 8);
    chunks.push({ type, bytes: chunk });
    if (type === "IDAT") data.push(chunk.subarray(8, -4));
    offset = end;
  }
  if (!data.length || chunks.at(-1)?.type !== "IEND") return bytes;
  try {
    const raw = await inflateAsync(Buffer.concat(data), {
      maxOutputLength: MAX_IMAGE_BYTES,
    });
    const compressed = await deflateAsync(raw, { level: 9 });
    const idat = Buffer.alloc(compressed.length + 12);
    idat.writeUInt32BE(compressed.length);
    idat.write("IDAT", 4, "ascii");
    compressed.copy(idat, 8);
    idat.writeUInt32BE(crc32(idat.subarray(4, -4)), idat.length - 4);
    const output: Buffer[] = [PNG_SIGNATURE];
    let written = false;
    for (const chunk of chunks) {
      if (chunk.type !== "IDAT") output.push(chunk.bytes);
      else if (!written) {
        output.push(idat);
        written = true;
      }
    }
    const result = Buffer.concat(output);
    return result.length < bytes.length ? result : bytes;
  } catch {
    return bytes;
  }
}

/** Exif, XMP and IPTC: where a camera or editor records place, device and author. */
const JPEG_METADATA = [
  { marker: 0xe1, prefix: Buffer.from("Exif\0\0", "latin1") },
  { marker: 0xe1, prefix: Buffer.from("http://ns.adobe.com/xap/1.0/", "latin1") },
  { marker: 0xe1, prefix: Buffer.from("http://ns.adobe.com/xmp/extension/", "latin1") },
  { marker: 0xed, prefix: Buffer.from("Photoshop 3.0\0", "latin1") },
];

/**
 * Drop a JPEG's Exif, XMP and IPTC metadata without touching its image data,
 * colour profile or Adobe colour transform. A rotated photo keeps only its
 * Exif orientation, which browsers turn it by.
 */
export function stripPublishJpegMetadata(bytes: Buffer): Buffer {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const output: Buffer[] = [bytes.subarray(0, 2)];
  let removed = false;
  let orientation = 1;
  for (let offset = 2; ;) {
    // A marker may follow any number of fill bytes, which are dropped.
    while (bytes[offset] === 0xff && bytes[offset + 1] === 0xff) offset++;
    if (offset + 4 > bytes.length || bytes[offset] !== 0xff) return bytes;
    const marker = bytes[offset + 1]!;
    // Start of scan: the image data and what follows are kept as they are.
    if (marker === 0xda) {
      output.push(bytes.subarray(offset));
      break;
    }
    const end = offset + 2 + bytes.readUInt16BE(offset + 2);
    if (end > bytes.length) return bytes;
    const segment = bytes.subarray(offset, end);
    const payload = segment.subarray(4);
    if (JPEG_METADATA.some((kind) => kind.marker === marker && payload.subarray(0, kind.prefix.length).equals(kind.prefix))) {
      if (marker === 0xe1 && payload.subarray(0, 6).equals(JPEG_METADATA[0]!.prefix)) orientation = exifOrientation(payload.subarray(6)) ?? orientation;
      removed = true;
    } else output.push(segment);
    offset = end;
  }
  if (!removed) return bytes;
  if (orientation !== 1) output.splice(1, 0, orientationSegment(orientation));
  return Buffer.concat(output);
}

/** The orientation an Exif block's first image directory gives, if any. */
function exifOrientation(tiff: Buffer): number | undefined {
  try {
    const little = tiff.toString("latin1", 0, 2) === "II";
    if (!little && tiff.toString("latin1", 0, 2) !== "MM") return undefined;
    const read16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
    const directory = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
    const count = read16(directory);
    for (let index = 0; index < count; index++) {
      const entry = directory + 2 + index * 12;
      if (read16(entry) === 0x0112) {
        const value = read16(entry + 8);
        return value >= 1 && value <= 8 ? value : undefined;
      }
    }
  } catch {
    // A short or damaged block names no orientation.
  }
  return undefined;
}

/** An Exif segment holding nothing but an orientation. */
function orientationSegment(orientation: number): Buffer {
  const segment = Buffer.alloc(36);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(34, 2);
  segment.write("Exif\0\0MM\0*", 4, "latin1");
  segment.writeUInt32BE(8, 14); // The directory follows the TIFF header.
  segment.writeUInt16BE(1, 18);
  segment.writeUInt16BE(0x0112, 20);
  segment.writeUInt16BE(3, 22); // SHORT
  segment.writeUInt32BE(1, 24);
  segment.writeUInt16BE(orientation, 28);
  return segment; // The next directory's offset, 0, ends it.
}

/** Temporary publish copies only; the workspace always retains originals. */
export class PublishMediaOptimizer {
  readonly #files = new Map<string, string>();
  #temporary?: string;
  async optimize(source: string): Promise<string> {
    const cached = this.#files.get(source);
    if (cached) return cached;
    const extension = path.extname(source).toLowerCase();
    if (extension === ".jpg" || extension === ".jpeg") return this.#stripJpeg(source);
    if (extension !== ".png") return source;
    const { size } = await stat(source);
    if (size < 256 * 1024 || size > MAX_IMAGE_BYTES) return source;
    const original = await readFile(source);
    const compressed = await compressPublishPng(original);
    let result = source;
    if (compressed.length < original.length) {
      this.#temporary ??= await mkdtemp(path.join(tmpdir(), "ohmygame-publish-media-"));
      result = path.join(this.#temporary, `${this.#files.size}.png`);
      await writeFile(result, compressed);
    }
    this.#files.set(source, result);
    return result;
  }

  async #stripJpeg(source: string): Promise<string> {
    const { size } = await stat(source);
    let result = source;
    // Anything larger can't publish.
    if (size <= PUBLISH_ARTIFACT_MAX_BYTES) {
      const original = await readFile(source);
      const stripped = stripPublishJpegMetadata(original);
      if (stripped !== original) {
        this.#temporary ??= await mkdtemp(path.join(tmpdir(), "ohmygame-publish-media-"));
        result = path.join(this.#temporary, `${this.#files.size}.jpg`);
        await writeFile(result, stripped);
      }
    }
    this.#files.set(source, result);
    return result;
  }

  async close(): Promise<void> {
    if (this.#temporary)
      await rm(this.#temporary, { recursive: true, force: true });
  }

}
