import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_ARCHIVE_MAX_ENTRIES, type PluginOrigin, type PluginAddSource, type PluginAddPreview, isPluginVersion } from "../shared/plugins.js";
import { extractTarball } from "./archive-extraction.js";
import { isAppWidePlugin } from "../shared/plugin-manifest.js";
import { indexPluginPackage, localizePluginString, type PluginIndexEntry } from "./plugin-index.js";
import { assertAddablePlugin, type PluginServices } from "./plugin-services.js";
import { downloadRelease } from "./plugin-releases.js";
import { capabilityGrants } from "./project-plugins.js";

// The Add plugin dialog's sources. Each gives a package in a temporary folder,
// which is read and checked but never run: npm's install scripts don't apply.
// Reviewing and adding are two requests, and adding fetches again, so it takes
// the digest the person reviewed and refuses a package that isn't that one.
//
// Approvals and settings belong to a plugin's id, so a package can only join an
// installed plugin when it comes from the same place. From anywhere else, the
// person uninstalls first, which clears them.

export class PluginSourceError extends Error {
  readonly statusCode = 400;
}

const NPM_REGISTRIES = {
  npmjs: { url: "https://registry.npmjs.org", tarballHosts: ["registry.npmjs.org"] },
  npmmirror: { url: "https://registry.npmmirror.com", tarballHosts: ["registry.npmmirror.com", "cdn.npmmirror.com"] },
} as const;
/** npm's abbreviated metadata lists every version, so even a busy package fits. */
const METADATA_MAX_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** npm drops `.gitignore` from what it publishes, so a template ships `gitignore`. */
const PUBLISHED_GITIGNORE = "gitignore";

export interface PluginSourceNetwork {
  /** Fetches metadata. */
  fetch: typeof fetch;
  /** Downloads a package over HTTPS to a new file. */
  download: (url: string, file: string, maxBytes: number, signal?: AbortSignal) => Promise<void>;
}

interface FetchedPackage {
  /** The folder holding the package; `removeAfter` goes when it has been read. */
  root: string;
  source?: PluginAddSource;
  origin?: PluginOrigin;
  /** Refuses a package that isn't what its source says. */
  check?: (entry: PluginIndexEntry) => void;
  removeAfter?: string;
}

export class PluginSources {
  #origins: Promise<Record<string, PluginOrigin>> | undefined;

  constructor(
    private readonly services: PluginServices,
    private readonly originsPath: string,
    private readonly network: PluginSourceNetwork = { fetch: (...request) => fetch(...request), download: downloadRelease },
  ) {}

  inspect(source: PluginAddSource, locale: string | undefined): Promise<PluginAddPreview> {
    return this.#reading(() => this.#fetch(source), (fetched, entry) => this.#preview(fetched, entry, locale));
  }

  install(source: PluginAddSource, digest: string): Promise<PluginIndexEntry> {
    return this.#reading(() => this.#fetch(source), (fetched, entry) => this.#install(fetched, entry, digest));
  }

  inspectFile(file: Buffer, locale: string | undefined): Promise<PluginAddPreview> {
    return this.#reading(() => this.#unpackUpload(file), (fetched, entry) => this.#preview(fetched, entry, locale));
  }

  installFile(file: Buffer, digest: string): Promise<PluginIndexEntry> {
    return this.#reading(() => this.#unpackUpload(file), (fetched, entry) => this.#install(fetched, entry, digest));
  }

  /** Where a package the person added came from; a local one has no origin. */
  async origin(id: string, version: string): Promise<PluginOrigin | undefined> {
    return (await this.#loadOrigins())[`${id}@${version}`];
  }

  async #reading<T>(fetchPackage: () => Promise<FetchedPackage>, use: (fetched: FetchedPackage, entry: PluginIndexEntry) => Promise<T>): Promise<T> {
    await this.services.ready();
    const fetched = await fetchPackage();
    try {
      const entry = await validPackage(fetched.root);
      try {
        assertAddablePlugin(entry.id);
      } catch (cause) {
        throw new PluginSourceError((cause as Error).message);
      }
      fetched.check?.(entry);
      await this.#assertCanJoin(entry, fetched.origin);
      return await use(fetched, entry);
    } finally {
      if (fetched.removeAfter) await rm(fetched.removeAfter, { recursive: true, force: true });
    }
  }

  #preview(fetched: FetchedPackage, entry: PluginIndexEntry, locale: string | undefined): Promise<PluginAddPreview> {
    const language = locale === "zh-CN" ? "zh-CN" : "en";
    return Promise.resolve({
      ...(fetched.source ? { source: fetched.source } : {}),
      digest: entry.digest,
      id: entry.id,
      version: entry.version,
      displayName: localizePluginString(entry, entry.manifest.displayName, language),
      description: localizePluginString(entry, entry.manifest.description, language),
      appWide: isAppWidePlugin(entry.manifest),
      asks: capabilityGrants(entry.manifest),
      skills: entry.skills.length,
      mcpServers: (entry.manifest.contributes?.mcpServers ?? []).map((server) => localizePluginString(entry, server.title, language)),
      settings: Boolean(entry.manifest.configuration),
      installedVersions: this.services.index.versions(entry.id).map((installed) => installed.version),
      ...(fetched.origin ? { origin: fetched.origin } : {}),
    });
  }

  async #install(fetched: FetchedPackage, entry: PluginIndexEntry, digest: string): Promise<PluginIndexEntry> {
    if (entry.digest !== digest) throw new PluginSourceError("This package changed after you reviewed it. Review it again.");
    const present = this.services.index.get(entry.id, entry.version);
    if (present?.digest === entry.digest) return present;
    const installed = await this.services.installAdded(fetched.root);
    await this.#recordOrigin(`${installed.id}@${installed.version}`, fetched.origin);
    return installed;
  }

  /**
   * The exact package already installed changes nothing, so it's always fine.
   * Other contents under one version would change what projects already run
   * and have approved, so a new release needs a new version.
   */
  async #assertCanJoin(entry: PluginIndexEntry, origin: PluginOrigin | undefined): Promise<void> {
    const present = this.services.index.get(entry.id, entry.version);
    if (present?.digest === entry.digest) return;
    for (const installed of this.services.index.versions(entry.id)) {
      const previous = await this.origin(installed.id, installed.version);
      if (!isSameSource(previous, origin))
        throw new PluginSourceError(`${entry.id} is already installed from ${sourceName(previous)}. Its approvals and settings stay with that source, so uninstall it first to add it from here.`);
    }
    if (present) throw new PluginSourceError(`Version ${entry.version} of ${entry.id} is already installed with different contents. A new release needs a new version.`);
  }

  #fetch(source: PluginAddSource): Promise<FetchedPackage> {
    if (source.type === "npm") return this.#fetchNpm(source);
    if (source.type === "github") return this.#fetchGitHub(source);
    return this.#directory(source);
  }

  async #directory(source: Extract<PluginAddSource, { type: "directory" }>): Promise<FetchedPackage> {
    if (!path.isAbsolute(source.path)) throw new PluginSourceError("Choose a folder by its full path.");
    const real = await realpath(source.path).catch(() => undefined);
    const info = real ? await stat(real).catch(() => undefined) : undefined;
    if (!real || !info?.isDirectory()) throw new PluginSourceError(`There is no folder at ${source.path}.`);
    // Checked in place first, so a huge folder stops at the package limits.
    await validPackage(real);
    // A private copy can't change between the review's checks and the install.
    return this.#inTemporaryFolder(async (folder) => {
      const root = path.join(folder, "package");
      await cp(real, root, { recursive: true, verbatimSymlinks: true });
      return { root, source };
    });
  }

  async #unpackUpload(file: Buffer): Promise<FetchedPackage> {
    return this.#inTemporaryFolder(async (folder) => {
      const archive = path.join(folder, "package.tgz");
      await writeFile(archive, file, { flag: "wx" });
      return { root: await unpack(archive, folder, { published: true }) };
    });
  }

  async #fetchNpm(source: Extract<PluginAddSource, { type: "npm" }>): Promise<FetchedPackage> {
    const { scope, name, version: named } = parseNpmName(source.name);
    const fullName = `@${scope}/${name}`;
    const registry = NPM_REGISTRIES[source.registry];
    const response = await this.#request(`${registry.url}/@${scope}%2F${name}`, { accept: "application/vnd.npm.install-v1+json" }, `Could not reach the ${source.registry} registry`);
    if (response.status === 404) throw new PluginSourceError(`${fullName} isn't on ${source.registry}.${source.registry === "npmmirror" ? " A new package can take a while to reach a mirror." : ""}`);
    if (!response.ok) throw new PluginSourceError(`The ${source.registry} registry answered ${response.status}.`);
    const metadata = await readJson(response) as NpmMetadata;
    const version = source.version ?? named ?? metadata["dist-tags"]?.latest;
    const release = version !== undefined && metadata.versions && Object.hasOwn(metadata.versions, version) ? metadata.versions[version] : undefined;
    if (!version || !release) throw new PluginSourceError(`${fullName} has no version ${version ?? "to install"}.`);
    const tarball = release.dist?.tarball;
    if (typeof tarball !== "string" || !isFromHost(tarball, registry.tarballHosts))
      throw new PluginSourceError(`${fullName} ${version} doesn't download from ${source.registry}.`);
    const integrity = sha512Integrity(release.dist?.integrity);
    if (!integrity) throw new PluginSourceError(`${fullName} ${version} has no SHA-512 checksum to verify it with.`);
    return this.#inTemporaryFolder(async (folder) => {
      const archive = path.join(folder, "package.tgz");
      await this.network.download(tarball, archive, PLUGIN_ARCHIVE_MAX_BYTES, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)).catch(downloadFailed);
      if (await fileSha512(archive) !== integrity) throw new PluginSourceError(`${fullName} ${version} doesn't match its checksum.`);
      return {
        root: await unpack(archive, folder, { published: true }),
        source: { type: "npm", name: fullName, registry: source.registry, version },
        origin: { type: "npm", package: fullName, version, registry: source.registry },
        check: (entry) => {
          // The scope is what npm vouches for, so it has to be the plugin's publisher.
          const allowed = [`${scope}/${name}`, `${scope}/${name.replace(/^ohmygame-plugin-/, "")}`];
          if (!allowed.includes(entry.id)) throw new PluginSourceError(`${fullName} holds the plugin ${entry.id}. It should hold ${allowed.at(-1)}.`);
          if (entry.version !== version) throw new PluginSourceError(`${fullName} ${version} holds version ${entry.version} of the plugin.`);
        },
      };
    });
  }

  async #fetchGitHub(source: Extract<PluginAddSource, { type: "github" }>): Promise<FetchedPackage> {
    const { repository, ref } = parseGitHubUrl(source.url);
    const commit = source.commit ?? await this.#resolveCommit(repository, ref);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new PluginSourceError(`${commit} isn't a full commit id.`);
    return this.#inTemporaryFolder(async (folder) => {
      const archive = path.join(folder, "package.tgz");
      await this.network.download(`https://codeload.github.com/${repository}/tar.gz/${commit}`, archive, PLUGIN_ARCHIVE_MAX_BYTES, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)).catch(downloadFailed);
      return {
        root: await unpack(archive, folder, { published: false }),
        source: { type: "github", url: source.url, commit },
        origin: { type: "github", repository, commit },
      };
    });
  }

  async #resolveCommit(repository: string, ref: string | undefined): Promise<string> {
    const response = await this.#request(
      `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref ?? "HEAD")}`,
      { accept: "application/vnd.github.sha", "x-github-api-version": "2022-11-28", "user-agent": "OhMyGame" },
      "Could not reach GitHub",
    );
    if (response.status === 404 || response.status === 422) throw new PluginSourceError(`Could not find ${ref ? `${ref} in ` : ""}${repository} on GitHub. Private repositories can't be added.`);
    if (response.status === 403 || response.status === 429) throw new PluginSourceError("GitHub is limiting requests right now. Try again later.");
    if (!response.ok) throw new PluginSourceError(`GitHub answered ${response.status}.`);
    return (await response.text()).trim();
  }

  async #request(url: string, headers: Record<string, string>, failure: string): Promise<Response> {
    try {
      return await this.network.fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (cause) {
      throw new PluginSourceError(`${failure}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async #inTemporaryFolder(fill: (folder: string) => Promise<FetchedPackage>): Promise<FetchedPackage> {
    const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-source-"));
    try {
      return { ...await fill(folder), removeAfter: folder };
    } catch (cause) {
      await rm(folder, { recursive: true, force: true });
      throw cause;
    }
  }

  #loadOrigins(): Promise<Record<string, PluginOrigin>> {
    // It only says where a package came from, so losing it costs just that.
    return this.#origins ??= readFile(this.originsPath, "utf8")
      .then((text) => JSON.parse(text) as Record<string, PluginOrigin>)
      .catch(() => ({}));
  }

  /** Adding the same version from elsewhere replaces it, origin included. */
  async #recordOrigin(key: string, origin: PluginOrigin | undefined): Promise<void> {
    const { [key]: _replaced, ...others } = await this.#loadOrigins();
    const next = origin ? { ...others, [key]: origin } : others;
    await mkdir(path.dirname(this.originsPath), { recursive: true });
    const temporary = `${this.originsPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
      await rename(temporary, this.originsPath);
      this.#origins = Promise.resolve(next);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function validPackage(root: string): Promise<PluginIndexEntry> {
  const checked = await indexPluginPackage(root);
  if (!checked.ok)
    throw new PluginSourceError(`This isn't a valid plugin: ${checked.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`.trim()).join("; ")}`);
  return checked.entry;
}

/** A package from this computer has no source to vouch for it, so it never counts as the same. */
function isSameSource(left: PluginOrigin | undefined, right: PluginOrigin | undefined): boolean {
  if (left?.type === "npm" && right?.type === "npm") return left.package.split("/")[0] === right.package.split("/")[0];
  if (left?.type === "github" && right?.type === "github") return left.repository.toLowerCase() === right.repository.toLowerCase();
  return false;
}

function sourceName(origin: PluginOrigin | undefined): string {
  if (origin?.type === "npm") return `npm (${origin.package})`;
  if (origin?.type === "github") return `GitHub (${origin.repository})`;
  return "another package on this computer";
}

interface NpmMetadata {
  "dist-tags"?: { latest?: string };
  versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } }>;
}

/** `@scope/name`, optionally `@version`. A plugin's publisher is its scope, so unscoped names can't be plugins. */
export function parseNpmName(input: string): { scope: string; name: string; version?: string } {
  const match = /^@([a-z0-9-]+)\/([a-z0-9][a-z0-9._-]*)(?:@(.+))?$/.exec(input.trim());
  if (!match) throw new PluginSourceError(`Enter a scoped npm package, like @publisher/plugin, not "${input.trim()}".`);
  const [, scope, name, version] = match as unknown as [string, string, string, string | undefined];
  if (version !== undefined && !isPluginVersion(version)) throw new PluginSourceError(`"${version}" isn't an exact version.`);
  return { scope, name, ...(version ? { version } : {}) };
}

/** A repository's page, optionally at a branch, tag or commit. */
export function parseGitHubUrl(input: string): { repository: string; ref?: string } {
  const text = input.trim().replace(/^(?:https:\/\/)?(?:www\.)?github\.com\//i, "");
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/(?:tree|commit)\/([A-Za-z0-9][A-Za-z0-9._-]*))?\/?$/.exec(text);
  if (!match || text === input.trim() || /^\.+$/.test(match[2]!) || match[3]?.includes(".."))
    throw new PluginSourceError(`Enter a GitHub repository, like https://github.com/publisher/plugin, not "${input.trim()}".`);
  return { repository: `${match[1]}/${match[2]}`, ...(match[3] ? { ref: match[3] } : {}) };
}

function isFromHost(url: string, hosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && hosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

function sha512Integrity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const found = value.split(/\s+/).find((item) => item.startsWith("sha512-"));
  return found ? Buffer.from(found.slice("sha512-".length).split("?")[0]!, "base64").toString("hex") : undefined;
}

async function fileSha512(file: string): Promise<string> {
  const hash = createHash("sha512");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function readJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > METADATA_MAX_BYTES) throw new PluginSourceError("The registry's answer is too large.");
  const text = await response.text();
  if (Buffer.byteLength(text) > METADATA_MAX_BYTES) throw new PluginSourceError("The registry's answer is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new PluginSourceError("The registry's answer isn't readable.");
  }
}

function downloadFailed(cause: unknown): never {
  throw new PluginSourceError(`The download failed: ${cause instanceof Error ? cause.message : String(cause)}`);
}

/** Unpacks into `folder`, returning the package's root: the one folder an archive wraps it in. */
async function unpack(archive: string, folder: string, { published }: { published: boolean }): Promise<string> {
  const destination = path.join(folder, "package");
  await mkdir(destination);
  await extractTarball(archive, destination, {
    maxEntries: PLUGIN_ARCHIVE_MAX_ENTRIES,
    maxBytes: PLUGIN_ARCHIVE_MAX_BYTES,
    error: (reason) => new PluginSourceError(`This package can't be unpacked (${reason}).`),
  });
  const items = await readdir(destination, { withFileTypes: true });
  const root = items.length === 1 && items[0]!.isDirectory() && items[0]!.name !== ".ohmygame-plugin"
    ? path.join(destination, items[0]!.name)
    : destination;
  if (published) await restoreTemplateGitignores(root);
  return root;
}

async function restoreTemplateGitignores(root: string): Promise<void> {
  const checked = await indexPluginPackage(root);
  if (!checked.ok) return;
  for (const projectType of checked.entry.manifest.contributes?.projectTypes ?? [])
    if (projectType.template) await renameGitignores(path.join(root, projectType.template));
}

async function renameGitignores(directory: string): Promise<void> {
  const items = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const names = new Set(items.map((item) => item.name));
  for (const item of items) {
    if (item.isDirectory()) await renameGitignores(path.join(directory, item.name));
    else if (item.name === PUBLISHED_GITIGNORE && !names.has(".gitignore"))
      await rename(path.join(directory, item.name), path.join(directory, ".gitignore"));
  }
}
