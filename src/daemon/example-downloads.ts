import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  EXAMPLE_ARCHIVE_MAX_BYTES,
  EXAMPLE_ARCHIVE_MAX_ENTRIES,
  exampleArchiveKey,
  isExampleArchive,
  type ExampleArchive,
  type ExampleArchiveKind,
} from "../shared/examples.js";
import { extractArchive } from "./archive-extraction.js";

const DOWNLOADS = "https://updates.ohmygame.ai/desktop/examples-v1/";
const MANIFEST_MAX_BYTES = 32 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** One daemon per profile owns these writes; requests only wait for the shared download. */
export class ExampleDownloads {
  readonly #controller = new AbortController();
  readonly #pending = new Map<string, Promise<string>>();

  constructor(private readonly directory: string) {}

  get(commit: string, id: string, kind: ExampleArchiveKind, entrypoint: string): Promise<string> {
    const key = exampleArchiveKey(id, kind);
    const downloadKey = `${commit}/${key}`;
    const pending = this.#pending.get(downloadKey);
    if (pending) return pending;
    const result = this.#get(commit, key, entrypoint).finally(() => this.#pending.delete(downloadKey));
    this.#pending.set(downloadKey, result);
    return result;
  }

  async removeOtherRevisions(current: string): Promise<void> {
    // This profile owns the cache. Only commit directories are disposable.
    const entries = await readdir(this.directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== current && /^[0-9a-f]{40}$/.test(entry.name)) {
        await rm(path.join(this.directory, entry.name), { recursive: true, force: true });
      }
    }
  }

  stop(): void {
    this.#controller.abort();
  }

  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled(this.#pending.values());
  }

  async #get(commit: string, key: string, entrypoint: string): Promise<string> {
    const destination = path.join(this.directory, commit, key);
    if (await hasExampleEntrypoint(destination, entrypoint)) return destination;
    const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
    const staging = `${destination}.download`;
    // A previous process may have exited before cleaning a partial download.
    await rm(staging, { recursive: true, force: true });
    try {
      signal.throwIfAborted();
      await mkdir(staging, { recursive: true });
      const base = new URL(`${commit}/`, DOWNLOADS);
      const record = await readArchiveRecord(base, commit, key, signal);
      const archivePath = path.join(staging, "archive.zip");
      const response = await exampleResponse(new URL(`${record.sha256}.zip`, base), signal);
      const hash = createHash("sha256");
      let bytes = 0;
      await pipeline(response, new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.byteLength;
          if (bytes > record.bytes) return done(new Error("Example archive exceeds its declared size"));
          hash.update(chunk);
          done(null, chunk);
        },
      }), createWriteStream(archivePath, { flags: "wx" }), { signal });
      if (bytes !== record.bytes || hash.digest("hex") !== record.sha256) {
        throw new Error("Example archive does not match its release record");
      }
      const extracted = path.join(staging, "payload");
      await mkdir(extracted);
      await extractArchive(archivePath, extracted, {
        maxBytes: EXAMPLE_ARCHIVE_MAX_BYTES,
        maxEntries: EXAMPLE_ARCHIVE_MAX_ENTRIES,
        error: (reason) => new Error(`Invalid example archive (${reason})`),
      });
      if (!await hasExampleEntrypoint(extracted, entrypoint)) throw new Error(`Example archive is missing ${entrypoint}`);
      signal.throwIfAborted();
      await rm(destination, { recursive: true, force: true });
      await rename(extracted, destination);
      return destination;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function hasExampleEntrypoint(directory: string, entrypoint: string): Promise<boolean> {
  try {
    return (await stat(path.join(directory, entrypoint))).isFile();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw cause;
  }
}

async function readArchiveRecord(base: URL, commit: string, key: string, signal: AbortSignal): Promise<ExampleArchive> {
  const stream = await exampleResponse(new URL("manifest.json", base), signal);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    bytes += chunk.byteLength;
    if (bytes > MANIFEST_MAX_BYTES) throw new Error("Example download manifest is too large");
    chunks.push(chunk);
  }
  const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { version?: unknown; commit?: unknown; archives?: Record<string, unknown> } | null;
  const record = manifest?.archives?.[key];
  if (manifest?.version !== 1 || manifest.commit !== commit || !isExampleArchive(record)) {
    throw new Error(`No valid download for ${key} at ${commit}`);
  }
  return record;
}

async function exampleResponse(url: URL, signal: AbortSignal): Promise<Readable> {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Example download returned HTTP ${response.status}`);
  }
  return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
}
