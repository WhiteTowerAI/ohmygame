import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";
import {
  PLUGIN_ARCHIVE_MAX_BYTES,
  PLUGIN_ARCHIVE_MAX_ENTRIES,
} from "../shared/plugins.js";
import { isNewerPluginVersion, isPluginVersion } from "../shared/plugins.js";
import { extractArchive } from "./archive-extraction.js";
import { indexPluginPackage, type PluginIndex, type PluginIndexEntry } from "./plugin-index.js";
import type { PluginServices } from "./plugin-services.js";

// Format 2 plugins from a catalog. A release is a ZIP of the package with a
// record that names its id, version, digest and a publisher key's signature.
// The app trusts a few keys, each for its own publishers; a release installs
// only when its key may sign for its publisher, its bytes match the digest,
// the signature checks, and the package inside says the same id and version.
//
// Versions install side by side under `<plugin-store>/packages/`, so an
// update never changes a project by itself: each project keeps the version
// its `ohmygame.json` pins until the person moves it, and moving back is the
// rollback.

const Release = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    version: Type.String({ minLength: 5, maxLength: 256 }),
    url: Type.String({ pattern: "^https://", maxLength: 2048 }),
    size: Type.Integer({ minimum: 1, maximum: PLUGIN_ARCHIVE_MAX_BYTES }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    key: Type.String({ pattern: "^[a-z0-9-]{1,64}$" }),
    signature: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

const Catalog = Type.Object(
  {
    schema: Type.Literal(1),
    plugins: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          releases: Type.Array(Release, { maxItems: 200 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 5000 },
    ),
  },
  { additionalProperties: true },
);

export type PluginRelease = Static<typeof Release>;
export type PluginCatalog = Static<typeof Catalog>;

/** Keys the app trusts, by id: an Ed25519 public key (SPKI, base64) and the publishers it signs for. */
export type PluginReleaseKeys = Record<string, { publicKey: string; publishers: readonly string[] }>;

export class PluginReleaseError extends Error {
  readonly statusCode = 400;
}

/** The bytes a release's signature covers. */
export function releaseMessage(release: Pick<PluginRelease, "id" | "version" | "sha256">): Buffer {
  return Buffer.from(`ohmygame-plugin-release:1\n${release.id}\n${release.version}\n${release.sha256}`);
}

export function readCatalog(value: unknown): PluginCatalog {
  const errors = [...Errors(Catalog, value)];
  if (errors.length)
    throw new PluginReleaseError(
      `The plugin catalog is invalid: ${errors.slice(0, 3).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`,
    );
  return value as PluginCatalog;
}

/** Releases newer than what is installed, newest per plugin. */
export function availableUpdates(catalog: PluginCatalog, index: PluginIndex): PluginRelease[] {
  const updates: PluginRelease[] = [];
  for (const plugin of catalog.plugins) {
    const installed = index.get(plugin.id);
    if (!installed) continue;
    const newest = plugin.releases
      .filter((release) => release.id === plugin.id)
      .reduce<PluginRelease | undefined>(
        (best, release) => (!best || isNewerPluginVersion(release.version, best.version) ? release : best),
        undefined,
      );
    if (newest && isNewerPluginVersion(newest.version, installed.version)) updates.push(newest);
  }
  return updates;
}

/** Checks the record's signature with a key that may sign for its publisher. */
export function verifyReleaseSignature(release: PluginRelease, keys: PluginReleaseKeys): void {
  const key = keys[release.key];
  const publisher = release.id.split("/")[0]!;
  if (!key) throw new PluginReleaseError(`${release.id} is signed with a key this app doesn't know`);
  if (!key.publishers.includes(publisher))
    throw new PluginReleaseError(`The key ${release.key} doesn't sign for ${publisher}`);
  let ok = false;
  try {
    ok = verify(
      null,
      releaseMessage(release),
      createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" }),
      Buffer.from(release.signature, "base64"),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new PluginReleaseError(`${release.id} ${release.version} has an invalid signature`);
}

export interface InstallReleaseOptions {
  release: unknown;
  keys: PluginReleaseKeys;
  services: PluginServices;
  /** `<plugin-store>/packages`. */
  directory: string;
  /** Saves the release's archive to a file, at most `maxBytes`. */
  download: (url: string, file: string, maxBytes: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

/** Installs of one release in flight, so two requests share one install. */
const installing = new Map<string, Promise<PluginIndexEntry>>();

/**
 * Downloads, verifies and installs one release. Returns the index entry; the
 * person's consent to what it asks for is a separate step, as for any install.
 */
export function installRelease(options: InstallReleaseOptions): Promise<PluginIndexEntry> {
  const errors = [...Errors(Release, options.release)];
  if (errors.length)
    return Promise.reject(new PluginReleaseError(
      `The release is invalid: ${errors.slice(0, 3).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`,
    ));
  const release = options.release as PluginRelease;
  if (!isPluginVersion(release.version))
    return Promise.reject(new PluginReleaseError(`${release.version} isn't a version`));
  const key = `${release.id}@${release.version}`;
  const pending = installing.get(key);
  if (pending) return pending;
  const install = installVerified(release, options).finally(() => installing.delete(key));
  installing.set(key, install);
  return install;
}

async function installVerified(release: PluginRelease, options: InstallReleaseOptions): Promise<PluginIndexEntry> {
  // The signature is checked before anything is downloaded.
  verifyReleaseSignature(release, options.keys);
  await options.services.ready();
  const installed = options.services.index.get(release.id, release.version);
  if (installed) return installed;

  const [publisher, name] = release.id.split("/") as [string, string];
  const directory = path.resolve(options.directory);
  const target = path.join(directory, publisher, name, release.version);
  const inside = path.relative(directory, target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside))
    throw new PluginReleaseError(`${release.id} ${release.version} doesn't fit in the plugin store`);
  const staging = path.join(directory, `.staging-${randomUUID()}`);
  const archive = `${staging}.zip`;
  await mkdir(staging, { recursive: true });
  try {
    await options.download(release.url, archive, release.size, options.signal);
    const { size } = await stat(archive);
    if (size !== release.size)
      throw new PluginReleaseError(`${release.id} ${release.version} is ${size} bytes, not the ${release.size} its release says`);
    const hash = createHash("sha256");
    await pipeline(createReadStream(archive), hash);
    if (hash.digest("hex") !== release.sha256)
      throw new PluginReleaseError(`${release.id} ${release.version} doesn't match its digest`);
    // A package holds what a folder install would, dotfiles such as a
    // template's `.gitignore` included. Only the manifest folder has a fixed
    // place: the top of the package, or inside the one folder it was zipped with.
    let wrapped = false;
    await extractArchive(archive, staging, {
      maxEntries: PLUGIN_ARCHIVE_MAX_ENTRIES,
      maxBytes: PLUGIN_ARCHIVE_MAX_BYTES,
      include: (relative) => {
        const parts = relative.split("/").filter(Boolean);
        parts.forEach((part, index) => {
          if (part !== ".ohmygame-plugin" || index === 0) return;
          if (index === 1 && !parts[0]!.startsWith(".")) {
            wrapped = true;
            return;
          }
          throw new PluginReleaseError(`${release.id} has a manifest folder outside its package: ${relative}`);
        });
        return true;
      },
      error: (reason) => new PluginReleaseError(`${release.id} ${release.version}'s archive is unusable (${reason})`),
    });
    // A package zipped with its folder unwraps to that folder.
    const items = await readdir(staging);
    const root = items.length === 1 && !items[0]!.startsWith(".") && (await stat(path.join(staging, items[0]!))).isDirectory()
      ? path.join(staging, items[0]!)
      : staging;
    if (wrapped && root === staging)
      throw new PluginReleaseError(`${release.id} has a manifest folder outside its package`);
    // The package is checked where it was unpacked, before the index or
    // anything else sees it, so a release can't replace another plugin.
    const checked = await indexPluginPackage(root);
    if (!checked.ok)
      throw new PluginReleaseError(
        `${release.id} ${release.version} isn't a valid plugin: ${checked.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      );
    if (checked.entry.id !== release.id || checked.entry.version !== release.version)
      throw new PluginReleaseError(
        `The package is ${checked.entry.id} ${checked.entry.version}, not the ${release.id} ${release.version} its release names`,
      );
    // A folder left by an install that failed partway isn't in the index.
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await rename(root, target);
    const result = await options.services.install(target);
    if (!result.ok) {
      await rm(target, { recursive: true, force: true });
      throw new PluginReleaseError(
        `${release.id} ${release.version} isn't a valid plugin: ${result.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      );
    }
    return result.entry;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
}

/** Downloads over HTTPS with a size limit; used by the app, replaced in tests. */
export async function downloadRelease(url: string, file: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
  if (!url.startsWith("https://")) throw new PluginReleaseError("Releases download over HTTPS only");
  const response = await fetch(url, { redirect: "follow", ...(signal ? { signal } : {}) });
  if (!response.ok || !response.body) throw new PluginReleaseError(`The download failed (${response.status})`);
  if (!response.url.startsWith("https://")) throw new PluginReleaseError("The download left HTTPS");
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.byteLength;
      if (received > maxBytes) done(new PluginReleaseError("The download is larger than allowed"));
      else done(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    limit,
    createWriteStream(file, { flags: "wx" }),
    ...(signal ? [{ signal }] : []),
  );
}
