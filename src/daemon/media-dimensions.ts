import { open, stat, type FileHandle } from "node:fs/promises";

export interface MediaDimensions { width: number; height: number }

const cache = new Map<string, { key: string; dimensions: MediaDimensions | undefined }>();

/**
 * Reads pixel dimensions from image or video headers without decoding. The format comes from the
 * file signature, since extensions can be wrong. Unknown or malformed files yield undefined.
 */
export async function readMediaDimensions(file: string): Promise<MediaDimensions | undefined> {
  try {
    const info = await stat(file), key = `${info.size}:${info.mtimeMs}`;
    const cached = cache.get(file);
    if (cached?.key === key) return cached.dimensions;
    const handle = await open(file, "r");
    try {
      const dimensions = valid(await parse(handle, info.size));
      cache.set(file, { key, dimensions });
      return dimensions;
    } finally { await handle.close(); }
  } catch { return undefined; }
}

async function parse(handle: FileHandle, size: number): Promise<MediaDimensions | undefined> {
  const head = await read(handle, 0, 64), ascii = (start: number, end: number) => head.subarray(start, end).toString("ascii");
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && ascii(12, 16) === "IHDR") {
    return png(handle, size, { width: head.readUInt32BE(16), height: head.readUInt32BE(20) });
  }
  if (ascii(0, 3) === "GIF") return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return webp(head);
  if (head[0] === 0xff && head[1] === 0xd8) return jpeg(handle, size);
  if (["ftyp", "moov", "mdat", "free", "wide"].includes(ascii(4, 8))) return mp4(handle, size);
  return undefined;
}

async function png(handle: FileHandle, size: number, dimensions: MediaDimensions): Promise<MediaDimensions | undefined> {
  for (let offset = 8; offset + 12 <= size;) {
    const header = await read(handle, offset, 8);
    const length = header.readUInt32BE(0), type = header.subarray(4, 8).toString("ascii");
    if (offset + length + 12 > size) return undefined;
    if (type === "eXIf") return oriented(dimensions, await exifOrientation(handle, offset + 8, length));
    if (type === "IEND") return dimensions;
    offset += length + 12;
  }
  return undefined;
}

function webp(head: Buffer): MediaDimensions | undefined {
  const chunk = head.subarray(12, 16).toString("ascii");
  if (chunk === "VP8 ") return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") { const bits = head.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  if (chunk === "VP8X") return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
  return undefined;
}

async function jpeg(handle: FileHandle, size: number): Promise<MediaDimensions | undefined> {
  let offset = 2, orientation = 1;
  while (offset + 9 <= size) {
    const segment = await read(handle, offset, 9);
    if (segment[0] !== 0xff) return undefined;
    const marker = segment[1]!;
    if (marker === 0xff) { offset += 1; continue; }
    const length = segment.readUInt16BE(2);
    if (length < 2 || offset + 2 + length > size) return undefined;
    if (marker === 0xe1 && length >= 8 && (await read(handle, offset + 4, 6)).toString("latin1") === "Exif\0\0") {
      orientation = await exifOrientation(handle, offset + 10, length - 8) ?? orientation;
    }
    // SOF0-SOF15 carry the frame size; DHT (C4), JPG (C8) and DAC (CC) share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const width = segment.readUInt16BE(7), height = segment.readUInt16BE(5);
      return oriented({ width, height }, orientation);
    }
    offset += 2 + length;
  }
  return undefined;
}

/** Reads only the TIFF header and IFD table, even when EXIF contains large unrelated payloads. */
async function exifOrientation(handle: FileHandle, start: number, length: number): Promise<number | undefined> {
  if (length < 8) return undefined;
  const header = await read(handle, start, 8), byteOrder = header.subarray(0, 2).toString("ascii");
  if (header.length !== 8 || (byteOrder !== "II" && byteOrder !== "MM")) return undefined;
  const u16 = (buffer: Buffer, at: number) => byteOrder === "II" ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
  const u32 = (buffer: Buffer, at: number) => byteOrder === "II" ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
  if (u16(header, 2) !== 42) return undefined;
  const ifd = u32(header, 4);
  if (ifd < 8 || ifd + 2 > length) return undefined;
  const count = await read(handle, start + ifd, 2);
  if (count.length !== 2) return undefined;
  const bytes = u16(count, 0) * 12;
  if (ifd + 2 + bytes > length) return undefined;
  const entries = await read(handle, start + ifd + 2, bytes);
  if (entries.length !== bytes) return undefined;
  for (let at = 0; at < bytes; at += 12) {
    if (u16(entries, at) === 0x0112 && u16(entries, at + 2) === 3 && u32(entries, at + 4) === 1) {
      const orientation = u16(entries, at + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : undefined;
    }
  }
  return undefined;
}

function oriented(dimensions: MediaDimensions, orientation = 1): MediaDimensions {
  // Browsers apply EXIF orientation; 5-8 swap the displayed axes.
  return orientation >= 5 && orientation <= 8 ? { width: dimensions.height, height: dimensions.width } : dimensions;
}

async function mp4(handle: FileHandle, size: number): Promise<MediaDimensions | undefined> {
  const moov = await findBox(handle, 0, size, "moov");
  if (!moov) return undefined;
  for (let offset = moov.start; offset < moov.end;) {
    const trak = await findBox(handle, offset, moov.end, "trak");
    if (!trak) return undefined;
    const tkhd = await findBox(handle, trak.start, trak.end, "tkhd");
    if (tkhd) {
      const version = (await read(handle, tkhd.start, 1))[0];
      const matrix = await read(handle, tkhd.start + (version === 1 ? 52 : 40), 44);
      const width = Math.round(matrix.readUInt32BE(36) / 65536), height = Math.round(matrix.readUInt32BE(40) / 65536);
      // A 90° display matrix (a = 0, b = ±1) means the stored frame is shown rotated.
      const rotated = matrix.readInt32BE(0) === 0 && Math.abs(matrix.readInt32BE(4)) === 65536;
      if (width && height) return rotated ? { width: height, height: width } : { width, height };
    }
    offset = trak.end;
  }
  return undefined;
}

async function findBox(handle: FileHandle, start: number, end: number, type: string): Promise<{ start: number; end: number } | undefined> {
  for (let offset = start; offset + 8 <= end;) {
    const header = await read(handle, offset, 16);
    let length = header.readUInt32BE(0), body = 8;
    if (length === 1) { length = Number(header.readBigUInt64BE(8)); body = 16; }
    else if (length === 0) length = end - offset;
    if (length < body) return undefined;
    if (header.subarray(4, 8).toString("ascii") === type) return { start: offset + body, end: Math.min(end, offset + length) };
    offset += length;
  }
  return undefined;
}

async function read(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function valid(dimensions: MediaDimensions | undefined): MediaDimensions | undefined {
  return dimensions && Number.isInteger(dimensions.width) && Number.isInteger(dimensions.height) && dimensions.width > 0 && dimensions.height > 0 ? dimensions : undefined;
}
