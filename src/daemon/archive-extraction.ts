import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export interface ArchiveExtractionOptions {
  maxEntries: number;
  maxBytes: number;
  /**
   * Checks a safe relative path; returns false to leave the entry out or
   * throws to reject the archive.
   */
  include?: (relativePath: string, entry: Entry) => boolean;
  /** Creates each failure's error, so callers keep their own types and wording. */
  error: (reason: ArchiveExtractionFailure) => Error;
}

export type ArchiveExtractionFailure =
  | "invalid-zip"
  | "unreadable"
  | "too-large"
  | "invalid-path"
  | "symbolic-link"
  | "duplicate-path";

export interface TarballExtractionOptions {
  maxEntries: number;
  maxBytes: number;
  error: (reason: "invalid-tar" | "too-large" | "invalid-path" | "symbolic-link" | "duplicate-path") => Error;
}

// An entry whose path another entry already took, also by case on
// case-insensitive file systems, or that names a folder as a file.
const COLLISIONS = new Set(["EEXIST", "ENOTDIR", "EISDIR"]);

/**
 * Extracts a ZIP archive into an empty destination. Paths with backslashes,
 * drive letters, absolute roots or `.`/`..` segments reject the archive, as do
 * symbolic links that `include` keeps; files are created exclusively, so no
 * entry can replace another.
 */
export async function extractArchive(
  archivePath: string,
  destination: string,
  options: ArchiveExtractionOptions,
): Promise<void> {
  const zip = await openZip(archivePath, options);
  let entries = 0;
  let bytes = 0;
  try {
    while (true) {
      const entry = await nextEntry(zip, options);
      if (!entry) break;
      entries += 1;
      bytes += entry.uncompressedSize;
      if (
        entries > options.maxEntries ||
        bytes > options.maxBytes ||
        entry.uncompressedSize > options.maxBytes
      ) {
        throw options.error("too-large");
      }
      const relative = archiveEntryPath(entry, options);
      // Callers' own path rules come first, so they decide what is skipped.
      if (options.include && !options.include(relative, entry)) continue;
      const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (fileType === 0xa000) throw options.error("symbolic-link");
      try {
        if (relative.endsWith("/")) {
          await mkdir(path.join(destination, relative), { recursive: true });
          continue;
        }
        const target = path.join(destination, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await pipeline(
          await openEntry(zip, entry, options),
          createWriteStream(target, { flags: "wx" }),
        );
        if ((entry.externalFileAttributes >>> 16) & 0o111)
          await chmod(target, 0o755);
      } catch (cause) {
        if (COLLISIONS.has((cause as NodeJS.ErrnoException).code ?? "")) {
          throw options.error("duplicate-path");
        }
        throw cause;
      }
    }
  } finally {
    zip.close();
  }
}

/**
 * Extracts a gzipped tar archive, by the same rules as `extractArchive`. Only
 * files and folders come out: any kind of link or device rejects the archive.
 */
export async function extractTarball(
  archivePath: string,
  destination: string,
  options: TarballExtractionOptions,
): Promise<void> {
  const tar = await gunzipLimited(await readFile(archivePath), options);
  let offset = 0;
  let entries = 0;
  let bytes = 0;
  // A long path comes in an entry of its own, just before the one it names.
  let longPath: string | undefined;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!tarChecksumMatches(header)) throw options.error("invalid-tar");
    const size = tarNumber(header, 124, 12, options);
    const type = String.fromCharCode(header[156]!);
    const start = offset + TAR_BLOCK;
    const end = start + size;
    if (end > tar.length) throw options.error("invalid-tar");
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    const body = tar.subarray(start, end);
    if (type === "g") continue;
    if (type === "x") {
      longPath = paxPath(body, options) ?? longPath;
      continue;
    }
    if (type === "L") {
      longPath = tarString(body, 0, body.length);
      continue;
    }
    if (type === "1" || type === "2") throw options.error("symbolic-link");
    if (!["0", "\0", "7", "5"].includes(type)) throw options.error("invalid-tar");
    entries += 1;
    bytes += size;
    if (entries > options.maxEntries || bytes > options.maxBytes) throw options.error("too-large");
    // `tar -C folder .` starts every path with `./`, and lists the folder itself.
    const name = (longPath ?? tarPath(header)).replace(/^(?:\.\/)+/, "");
    longPath = undefined;
    if (type === "5" && (!name || name === ".")) continue;
    const relative = safeEntryPath(name, options);
    const target = path.join(destination, relative);
    try {
      if (type === "5" || relative.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, { flag: "wx" });
      if (tarNumber(header, 100, 8, options) & 0o111) await chmod(target, 0o755);
    } catch (cause) {
      if (COLLISIONS.has((cause as NodeJS.ErrnoException).code ?? "")) throw options.error("duplicate-path");
      throw cause;
    }
  }
}

const TAR_BLOCK = 512;

async function gunzipLimited(
  compressed: Buffer,
  options: TarballExtractionOptions,
): Promise<Buffer> {
  try {
    // Each entry can take a few blocks of headers beyond its contents.
    return await promisify(gunzip)(compressed, {
      maxOutputLength: options.maxBytes + (options.maxEntries + 1) * TAR_BLOCK * 8,
    });
  } catch (cause) {
    throw options.error(
      (cause as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "too-large" : "invalid-tar",
    );
  }
}

function tarString(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function tarNumber(
  block: Buffer,
  start: number,
  length: number,
  options: TarballExtractionOptions,
): number {
  // The binary form is only for sizes far beyond any limit here.
  if (block[start]! & 0x80) throw options.error("too-large");
  const text = tarString(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw options.error("invalid-tar");
  return text ? Number.parseInt(text, 8) : 0;
}

function tarChecksumMatches(header: Buffer): boolean {
  const expected = Number.parseInt(tarString(header, 148, 8).trim(), 8);
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1)
    sum += index >= 148 && index < 156 ? 32 : header[index]!;
  return sum === expected;
}

function tarPath(header: Buffer): string {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 257, 6).startsWith("ustar") ? tarString(header, 345, 155) : "";
  return prefix ? `${prefix}/${name}` : name;
}

/** The `path` record of a pax header: lines of `<length> <key>=<value>\n`, where length counts bytes. */
function paxPath(
  body: Buffer,
  options: TarballExtractionOptions,
): string | undefined {
  let found: string | undefined;
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const length = space < 0 ? Number.NaN : Number(body.subarray(offset, space).toString("utf8"));
    if (!Number.isInteger(length) || length <= space - offset || offset + length > body.length)
      throw options.error("invalid-tar");
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    if (record.startsWith("path=")) found = record.slice("path=".length);
    offset += length;
  }
  return found;
}

function archiveEntryPath(
  entry: Entry,
  options: ArchiveExtractionOptions,
): string {
  return safeEntryPath(entry.fileName, options);
}

function safeEntryPath(
  name: string,
  options: { error: (reason: "invalid-path") => Error },
): string {
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw options.error("invalid-path");
  }
  const segments = name.split("/").filter(Boolean);
  if (
    !segments.length ||
    segments.some((part) => part === "." || part === "..")
  ) {
    throw options.error("invalid-path");
  }
  return `${segments.join("/")}${name.endsWith("/") ? "/" : ""}`;
}

function openZip(
  file: string,
  options: ArchiveExtractionOptions,
): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(
      file,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
      },
      (error, zip) =>
        error || !zip ? reject(options.error("invalid-zip")) : resolve(zip),
    ),
  );
}

function nextEntry(
  zip: ZipFile,
  options: ArchiveExtractionOptions,
): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = () => {
      cleanup();
      reject(options.error("invalid-zip"));
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

function openEntry(
  zip: ZipFile,
  entry: Entry,
  options: ArchiveExtractionOptions,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) =>
      error || !stream ? reject(options.error("unreadable")) : resolve(stream),
    ),
  );
}
