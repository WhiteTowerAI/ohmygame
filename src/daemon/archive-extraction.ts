import { createWriteStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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

function archiveEntryPath(
  entry: Entry,
  options: ArchiveExtractionOptions,
): string {
  const name = entry.fileName;
  if (
    !name ||
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
