import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { PUBLISH_ARTIFACT_MAX_BYTES } from "../shared/publish-v1.js";

export interface ArtifactLimits {
  compressedBytes: number;
  expandedBytes: number;
  fileBytes: number;
  files: number;
}

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = {
  compressedBytes: PUBLISH_ARTIFACT_MAX_BYTES,
  expandedBytes: 100 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
  files: 2_000,
};

export class ArtifactError extends Error {
  constructor(message: string, readonly code: "artifact_invalid" | "artifact_too_large" = "artifact_invalid") {
    super(message);
  }
}

export class ArtifactStore {
  readonly #artifactsDirectory: string;
  readonly #temporaryDirectory: string;

  constructor(
    dataDirectory: string,
    private readonly limits: ArtifactLimits = DEFAULT_ARTIFACT_LIMITS,
  ) {
    this.#artifactsDirectory = path.join(dataDirectory, "artifacts");
    this.#temporaryDirectory = path.join(dataDirectory, "temporary");
  }

  async load(deploymentIds: ReadonlySet<string>): Promise<void> {
    await mkdir(this.#artifactsDirectory, { recursive: true });
    for (const entry of await readdir(this.#artifactsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || deploymentIds.has(entry.name)) continue;
      await rm(path.join(this.#artifactsDirectory, entry.name), { recursive: true, force: true });
    }
    await rm(this.#temporaryDirectory, { recursive: true, force: true });
    await mkdir(this.#temporaryDirectory, { recursive: true });
  }

  temporaryZip(id: string): string {
    return path.join(this.#temporaryDirectory, `${id}.zip`);
  }

  async receive(stream: Readable, destination: string): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash("sha256");
    let bytes = 0;
    const inspect = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length;
        if (bytes > this.limits.compressedBytes) {
          callback(new ArtifactError("Artifact is too large", "artifact_too_large"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(stream, inspect, createWriteStream(destination, { flags: "wx" }));
    return { sha256: hash.digest("hex"), bytes };
  }

  async install(zipPath: string, deploymentId: string): Promise<void> {
    const temporary = path.join(this.#temporaryDirectory, deploymentId);
    const destination = path.join(this.#artifactsDirectory, deploymentId);
    await mkdir(temporary, { recursive: false });
    try {
      await extractZip(zipPath, temporary, this.limits);
      const index = path.join(temporary, "index.html");
      const indexStat = await stat(index).catch(() => undefined);
      if (!indexStat?.isFile() || indexStat.size === 0) {
        throw new ArtifactError("Artifact root must contain a non-empty index.html");
      }
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError("Artifact is not a valid ZIP archive");
    } finally {
      await rm(zipPath, { force: true });
    }
  }

  async remove(deploymentId: string): Promise<void> {
    await rm(path.join(this.#artifactsDirectory, deploymentId), { recursive: true, force: true });
  }

  async file(deploymentId: string, requestPath: string): Promise<string | undefined> {
    const relative = safeRequestPath(requestPath);
    if (relative === undefined) return undefined;
    const root = path.join(this.#artifactsDirectory, deploymentId);
    const candidate = path.join(root, relative || "index.html");
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile()) return candidate;
    if (info?.isDirectory()) {
      const index = path.join(candidate, "index.html");
      if ((await stat(index).catch(() => undefined))?.isFile()) return index;
    }
    return undefined;
  }

  async exists(deploymentId: string): Promise<boolean> {
    try {
      await access(path.join(this.#artifactsDirectory, deploymentId, "index.html"));
      return true;
    } catch {
      return false;
    }
  }
}

async function extractZip(zipPath: string, destination: string, limits: ArtifactLimits): Promise<void> {
  const zip = await openZip(zipPath);
  let entries = 0;
  let expandedBytes = 0;
  const paths = new Set<string>();
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      entries += 1;
      if (entries > limits.files) throw new ArtifactError("Artifact contains too many entries", "artifact_too_large");
      const normalized = validEntryPath(entry);
      if (paths.has(normalized)) throw new ArtifactError("Artifact contains duplicate paths");
      paths.add(normalized);
      if (entry.uncompressedSize > limits.fileBytes) {
        throw new ArtifactError("Artifact contains a file that is too large", "artifact_too_large");
      }
      expandedBytes += entry.uncompressedSize;
      if (expandedBytes > limits.expandedBytes) {
        throw new ArtifactError("Expanded artifact is too large", "artifact_too_large");
      }
      if (normalized.endsWith("/")) {
        await mkdir(path.join(destination, normalized), { recursive: true });
        continue;
      }
      const target = path.join(destination, normalized);
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(await openEntry(zip, entry), createWriteStream(target, { flags: "wx" }));
    }
  } finally {
    zip.close();
  }
}

function validEntryPath(entry: Entry): string {
  const name = entry.fileName;
  if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ArtifactError("Artifact contains an invalid path");
  }
  const segments = name.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw new ArtifactError("Artifact contains an invalid path");
  }
  if (segments.some((segment) => segment.startsWith(".") || segment === "node_modules")) {
    throw new ArtifactError("Artifact contains private project files");
  }
  const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (fileType === 0xa000) throw new ArtifactError("Artifact contains a symbolic link");
  return `${segments.join("/")}${name.endsWith("/") ? "/" : ""}`;
}

function safeRequestPath(value: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.split("?", 1)[0]);
  } catch {
    return undefined;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return undefined;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) return undefined;
  return segments.join("/");
}

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(new ArtifactError("Artifact is not a valid ZIP archive"));
      else resolve(zip);
    });
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(undefined); };
    const onError = () => { cleanup(); reject(new ArtifactError("Artifact is not a valid ZIP archive")); };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(new ArtifactError("Artifact could not be read"));
      else resolve(stream);
    });
  });
}

export function contentType(file: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return types[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
