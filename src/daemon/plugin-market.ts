import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { isNewerPluginVersion, isPluginVersion, NPM_PLUGIN_PACKAGE, type MarketPlugin, type PluginMarketListing } from "../shared/plugins.js";
import { PERSONAL_PUBLISHER, PLUGIN_CATEGORIES, type PluginCategory } from "../shared/plugin-manifest.js";
import { sniffImageType } from "./image-format.js";

// The market: the index built by WhiteTowerAI/ohmygame-plugins, which lists the
// plugins published on npm. Listing and blocking rest on the index alone. A
// package's contents don't: the index carries npm's own signature over each
// version's checksum, so an index or a mirror that lies about a package can't
// get it installed (PluginSources checks the download against that checksum).

/** The index the ohmygame-plugins job publishes; `OHMYGAME_PLUGIN_INDEX_URL` replaces it, and an empty one turns the market off. */
export const PLUGIN_INDEX_URL = "https://plugins.ohmygame.ai/plugins/index.json";

const POINTER_MAX_BYTES = 4 * 1024;
const INDEX_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/** The index job runs every 30 minutes. */
const REFRESH_MS = 30 * 60_000;
/** A plugin's screenshots are each at most 1 MB in its package. */
const IMAGE_MAX_BYTES = 1024 * 1024;
/** GitHub serves an avatar at 96 pixels in a few kilobytes. */
const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR = /^https:\/\/avatars\.githubusercontent\.com\/u\/([0-9]{1,12})(?:\?v=[0-9]{1,4})?$/;
const DAY_MS = 24 * 60 * 60_000;
const IMAGE_CACHE_LIMIT = 64;
const RETRY_MS = 2 * 60_000;

/** npm's registry keys when this app was built; `registryKey` asks npm for one it doesn't know. */
const NPM_KEYS: Record<string, { key: string; expires?: string }> = {
  "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U": {
    key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==",
  },
};
const NPM_KEYS_URL = "https://registry.npmjs.org/-/npm/v1/keys";

const Localized = Type.Record(Type.String(), Type.String());
const IndexedVersion = Type.Object({
  package: Type.String({ maxLength: 214 }),
  version: Type.String({ maxLength: 256 }),
  integrity: Type.String({ maxLength: 1024 }),
  signatures: Type.Array(Type.Object({ keyid: Type.String({ maxLength: 256 }), sig: Type.String({ maxLength: 1024 }) }), { maxItems: 16 }),
  publisher: Type.Optional(Type.String({ maxLength: 256 })),
  provenance: Type.Optional(Type.String({ maxLength: 2048 })),
  publishedAt: Type.Optional(Type.String({ maxLength: 64 })),
  rejected: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }))),
  plugin: Type.Optional(Type.Object({
    id: Type.String({ maxLength: 256 }),
    displayName: Localized,
    description: Localized,
    grants: Type.Array(Type.String({ maxLength: 1024 })),
    adds: Type.Record(Type.String(), Type.Number()),
    // Since index schema 1 gained them; an older index has none.
    categories: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 10 })),
    appliesTo: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 })),
    beta: Type.Optional(Type.Boolean()),
    longDescription: Type.Optional(Localized),
    /** Screenshots the index job copied out of the package, by path from the index's folder. */
    images: Type.Optional(Type.Object({
      screenshots: Type.Optional(Type.Array(Type.Object({ path: Type.String({ maxLength: 500 }), caption: Type.Optional(Localized) }), { maxItems: 10 })),
    })),
  })),
});
const PackageFacts = Type.Object({
  repository: Type.Optional(Type.String({ pattern: "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" })),
  sourceVerified: Type.Optional(Type.Literal(true)),
  stars: Type.Optional(Type.Integer({ minimum: 0 })),
  weeklyDownloads: Type.Optional(Type.Integer({ minimum: 0 })),
  /** The repository owner's GitHub avatar, `avatar_url` from GitHub's API; shown only when the source is verified. */
  // Any other address is passed over, not the whole index.
  avatar: Type.Optional(Type.String({ maxLength: 500 })),
  /** When the package was first published. */
  createdAt: Type.Optional(Type.String({ maxLength: 64 })),
});
const MarketIndex = Type.Object({
  schemaVersion: Type.Literal(1),
  versions: Type.Array(IndexedVersion),
  packages: Type.Record(Type.String(), PackageFacts),
  featured: Type.Array(Type.String()),
});
type MarketIndex = Static<typeof MarketIndex>;
type IndexedVersion = Static<typeof IndexedVersion>;

export interface MarketImage { bytes: Buffer; mediaType: string; revision: string }

/**
 * How well a plugin is doing, from 0 to 1, for the market's recommended
 * order. Downloads count most, but not alone: a plugin kept up to date, with
 * a verified source and a page that says what it does, ranks above one that
 * was only downloaded a lot once.
 *
 * - 0.50 weekly downloads, and 0.15 GitHub stars, each on a log scale against
 *   the market's most;
 * - 0.15 how recently it was updated: full within a month, none after a year;
 * - 0.20 its page: a verified source, a long description, screenshots and a
 *   category, a quarter each.
 *
 * A beta keeps 85% of its score.
 */
export function marketScore(plugin: MarketPlugin, most: { downloads: number; stars: number }, now: number): number {
  const scale = (value: number | undefined, max: number) => (max > 0 ? Math.log1p(value ?? 0) / Math.log1p(max) : 0);
  const updated = plugin.publishedAt ? Date.parse(plugin.publishedAt) : Number.NaN;
  const age = Number.isNaN(updated) ? Infinity : (now - updated) / DAY_MS;
  const fresh = Math.min(1, Math.max(0, (365 - age) / (365 - 30)));
  const page = [plugin.sourceVerified, plugin.longDescription, plugin.screenshots?.length, plugin.categories?.length].filter(Boolean).length / 4;
  const score = 0.5 * scale(plugin.weeklyDownloads, most.downloads) + 0.15 * scale(plugin.stars, most.stars) + 0.15 * fresh + 0.2 * page;
  return plugin.beta ? score * 0.85 : score;
}

export class PluginMarketError extends Error {
  readonly statusCode = 400;
}

/** A version the index lets someone install, once its signature checks. */
export interface MarketRelease {
  package: string;
  version: string;
  integrity: string;
}

export interface PluginMarketOptions {
  /** `index.json`; without one there is no market and nothing is fetched. */
  url?: string | undefined;
  /** Keeps the last index, for when the network is down. */
  directory: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Replaces npm's keys, for tests. */
  keys?: Record<string, { key: string; expires?: string }>;
}

export class PluginMarket {
  readonly #url: string | undefined;
  readonly #file: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #keys: Map<string, { key: KeyObject; expires?: number }>;
  #index: { digest: string; data: MarketIndex } | undefined;
  #checkedAt: number | undefined;
  /** The last try failed, so what's shown may be old. */
  #stale = false;
  #refreshing: Promise<void> | undefined;
  /** Read once, so a slow read can't replace what a refresh brought. */
  #saved: Promise<void> | undefined;
  #images = new Map<string, Promise<MarketImage>>();

  constructor(options: PluginMarketOptions) {
    this.#url = options.url && isIndexUrl(options.url) ? options.url : undefined;
    this.#file = path.join(options.directory, "market-index.json");
    this.#fetch = options.fetch ?? ((...request) => fetch(...request));
    this.#now = options.now ?? Date.now;
    this.#keys = new Map(Object.entries(options.keys ?? NPM_KEYS).map(([keyid, item]) => [keyid, readKey(item)]));
  }

  /** What Browse shows, in `locale`. Reserved publishers are left out, as they can't be added. */
  async listing(locale: string | undefined): Promise<PluginMarketListing> {
    if (!this.#url) return { status: "off", plugins: [], blocked: [] };
    const index = await this.#current();
    if (!index) return { status: "unavailable", plugins: [], blocked: [] };
    const language = locale === "zh-CN" ? "zh-CN" : "en";
    const newest = new Map<string, IndexedVersion>();
    for (const version of index.versions) {
      const id = version.plugin?.id;
      // The index reads npmjs, where only OhMyGame publishes to `@ohmygame`.
      if (!id || id.startsWith(`${PERSONAL_PUBLISHER}/`)) continue;
      // Installing looks for exactly this name and version, and what it can't find
      // isn't held to a signature. Anything else mustn't reach a card.
      if (!NPM_PLUGIN_PACKAGE.test(version.package) || !isPluginVersion(version.version)) continue;
      const current = newest.get(id);
      if (!current || isNewerListing(version.version, current.version)) newest.set(id, version);
    }
    const plugins = [...newest.values()].map((version): MarketPlugin => {
      const plugin = version.plugin!;
      const facts = index.packages[version.package];
      const text = (values: Record<string, string>) => values[language] ?? values.en ?? "";
      const image = (file: string | undefined) => (file && indexImage(this.#url!, file) ? file : undefined);
      // The repository is proven to be the package's, so its owner's face is the publisher's.
      const avatar = facts?.sourceVerified ? facts.avatar && AVATAR.exec(facts.avatar)?.[1] : undefined;
      const screenshots = (plugin.images?.screenshots ?? []).flatMap((shot) => {
        const caption = shot.caption && text(shot.caption);
        return image(shot.path) ? [{ path: shot.path, ...(caption ? { caption } : {}) }] : [];
      });
      const categories = plugin.categories?.filter((category): category is PluginCategory => (PLUGIN_CATEGORIES as readonly string[]).includes(category));
      const longDescription = plugin.longDescription && text(plugin.longDescription);
      return {
        id: plugin.id,
        package: version.package,
        version: version.version,
        displayName: text(plugin.displayName) || plugin.id,
        description: text(plugin.description),
        asks: plugin.grants,
        adds: plugin.adds,
        ...(categories?.length ? { categories } : {}),
        ...(plugin.appliesTo?.length ? { appliesTo: plugin.appliesTo } : {}),
        ...(plugin.beta ? { beta: true } : {}),
        ...(longDescription ? { longDescription } : {}),
        ...(avatar ? { avatar } : {}),
        ...(screenshots.length ? { screenshots } : {}),
        ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}),
        ...(facts?.createdAt ? { createdAt: facts.createdAt } : {}),
        ...(facts?.repository ? { repository: facts.repository } : {}),
        sourceVerified: facts?.sourceVerified === true,
        ...(facts?.stars !== undefined ? { stars: facts.stars } : {}),
        ...(facts?.weeklyDownloads !== undefined ? { weeklyDownloads: facts.weeklyDownloads } : {}),
        featured: index.featured.includes(plugin.id),
      };
    });
    const featuredAt = (plugin: MarketPlugin) => index.featured.indexOf(plugin.id);
    const most = {
      downloads: Math.max(0, ...plugins.map((plugin) => plugin.weeklyDownloads ?? 0)),
      stars: Math.max(0, ...plugins.map((plugin) => plugin.stars ?? 0)),
    };
    const now = this.#now();
    const scores = new Map(plugins.map((plugin) => [plugin.id, marketScore(plugin, most, now)]));
    plugins.sort((a, b) =>
      Number(b.featured) - Number(a.featured) ||
      featuredAt(a) - featuredAt(b) ||
      scores.get(b.id)! - scores.get(a.id)! ||
      a.displayName.localeCompare(b.displayName));
    const blocked = index.versions.flatMap((version) => {
      const reason = version.rejected?.find((item) => item.startsWith("blocked: "));
      return reason ? [{ package: version.package, version: version.version, reason: reason.slice("blocked: ".length) }] : [];
    });
    return { status: this.#stale ? "stale" : "ready", plugins, blocked };
  }

  /**
   * A screenshot the index lists for a plugin, read through the daemon so it
   * uses the app's network settings. Only the newest index's, each checked to
   * be a PNG, JPEG or WebP; they're named by their contents, so one read is kept.
   */
  async image(file: string): Promise<MarketImage | undefined> {
    const index = this.#url ? await this.#current() : undefined;
    const url = index && indexImage(this.#url!, file);
    if (!url || !index.versions.some(({ plugin }) => plugin?.images?.screenshots?.some((shot) => shot.path === file))) return undefined;
    // Not followed elsewhere: the image has to come from the index's host.
    return this.#picture(`image:${file}`, url, IMAGE_MAX_BYTES);
  }

  /**
   * A publisher's GitHub avatar, by GitHub's id for them. Only one the newest
   * index gives a package whose source is verified, from GitHub's avatar host
   * and nowhere it redirects to.
   */
  async avatar(id: string): Promise<MarketImage | undefined> {
    const index = this.#url ? await this.#current() : undefined;
    const listed = index && Object.values(index.packages).some((facts) => facts.sourceVerified && facts.avatar && AVATAR.exec(facts.avatar)?.[1] === id);
    if (!listed) return undefined;
    // It changes rarely, so the copy read while the app runs is kept.
    return this.#picture(`avatar:${id}`, `https://avatars.githubusercontent.com/u/${id}?s=96`, AVATAR_MAX_BYTES);
  }

  #picture(key: string, url: string, maxBytes: number): Promise<MarketImage> {
    let read = this.#images.get(key);
    if (!read) {
      read = this.#read(url, maxBytes, "error").then((bytes) => {
        const mediaType = sniffImageType(bytes);
        if (!mediaType) throw new Error("The image isn't a PNG, JPEG or WebP");
        return { bytes, mediaType, revision: sha256(bytes) };
      });
      this.#images.set(key, read);
      // A failed read is tried again next time.
      read.catch(() => this.#images.delete(key));
      if (this.#images.size > IMAGE_CACHE_LIMIT) this.#images.delete(this.#images.keys().next().value!);
    }
    return read;
  }

  /**
   * What the index says about one published version: a release to pin to, after
   * checking npm's signature; undefined when it doesn't list that version. A
   * version it rejected, blocked or not, can't be added, wherever the person
   * found its name.
   */
  async release(name: string, version: string): Promise<MarketRelease | undefined> {
    if (!this.#url) return undefined;
    const entry = (await this.#current())?.versions.find((item) => item.package === name && item.version === version);
    if (!entry) return undefined;
    if (entry.rejected?.length) {
      const blocked = entry.rejected.find((item) => item.startsWith("blocked: "));
      throw new PluginMarketError(blocked
        ? `${name} ${version} was blocked: ${blocked.slice("blocked: ".length)}`
        : `${name} ${version} can't be added: ${entry.rejected[0]}`);
    }
    await this.#checkSignature(entry);
    return { package: name, version, integrity: entry.integrity };
  }

  async #checkSignature(entry: IndexedVersion): Promise<void> {
    const label = `${entry.package} ${entry.version}`;
    const payload = `${entry.package}@${entry.version}:${entry.integrity}`;
    for (const { keyid, sig } of entry.signatures) {
      const known = await this.#registryKey(keyid);
      // Nothing signed vouches for when a package was published, so an expired key vouches for nothing.
      if (!known || (known.expires !== undefined && known.expires <= this.#now())) continue;
      try {
        if (verify("sha256", Buffer.from(payload), known.key, Buffer.from(sig, "base64"))) return;
      } catch {
        // An unreadable signature proves nothing; another may still check.
      }
    }
    throw new PluginMarketError(`${label} has no valid npm signature, so it can't be added.`);
  }

  async #registryKey(keyid: string): Promise<{ key: KeyObject; expires?: number } | undefined> {
    const known = this.#keys.get(keyid);
    if (known) return known;
    try {
      const response = await this.#fetch(NPM_KEYS_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) return undefined;
      const { keys } = JSON.parse((await readLimited(response, POINTER_MAX_BYTES * 4)).toString("utf8")) as { keys: { keyid: string; key: string; expires?: string | null }[] };
      for (const item of keys)
        if (!this.#keys.has(item.keyid)) this.#keys.set(item.keyid, readKey({ key: item.key, ...(item.expires ? { expires: item.expires } : {}) }));
    } catch {
      return undefined;
    }
    return this.#keys.get(keyid);
  }

  /** The index, read at most every half hour, or sooner after a failure; the last one when the network is down. */
  async #current(): Promise<MarketIndex | undefined> {
    await (this.#saved ??= this.#readSaved());
    const due = this.#checkedAt === undefined || this.#now() - this.#checkedAt >= (this.#stale ? RETRY_MS : REFRESH_MS);
    if (due) {
      this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = undefined; });
      // Someone waiting for a first index has nothing else to show.
      if (!this.#index) await this.#refreshing;
      else void this.#refreshing;
    }
    return this.#index?.data;
  }

  async #readSaved(): Promise<void> {
    const text = await readFile(this.#file).catch(() => undefined);
    if (!text) return;
    try {
      const data: unknown = JSON.parse(text.toString("utf8"));
      if (Check(MarketIndex, data)) this.#index = { digest: sha256(text), data };
    } catch {
      // A damaged copy is only a cache.
    }
  }

  async #refresh(): Promise<void> {
    try {
      const pointer = JSON.parse((await this.#read(this.#url!, POINTER_MAX_BYTES)).toString("utf8")) as { latest?: unknown; sha256?: unknown };
      const digest = typeof pointer.latest === "string" ? /^index\.([0-9a-f]{64})\.json$/.exec(pointer.latest)?.[1] : undefined;
      if (!digest) throw new Error("The index pointer is malformed");
      if (this.#index?.digest !== digest) {
        const bytes = await this.#read(new URL(pointer.latest as string, this.#url!).href, INDEX_MAX_BYTES);
        // The name is the hash, and only then is it worth parsing.
        if (sha256(bytes) !== digest) throw new Error("The index doesn't match its checksum");
        const data: unknown = JSON.parse(bytes.toString("utf8"));
        if (!Check(MarketIndex, data)) throw new Error("The index is malformed");
        await this.#save(bytes);
        this.#index = { digest, data };
      }
      this.#stale = false;
    } catch {
      this.#stale = true;
    }
    this.#checkedAt = this.#now();
  }

  async #read(url: string, maxBytes: number, redirect: RequestRedirect = "follow"): Promise<Buffer> {
    const response = await this.#fetch(url, { redirect, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readLimited(response, maxBytes);
  }

  async #save(bytes: Buffer): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** HTTPS, or plain HTTP on this computer. */
function isIndexUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
  } catch {
    return false;
  }
}

function readKey({ key, expires }: { key: string; expires?: string }): { key: KeyObject; expires?: number } {
  return {
    key: createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }),
    ...(expires ? { expires: Date.parse(expires) } : {}),
  };
}

/** A release always beats a prerelease, whatever the numbers say; a prerelease shows only when there's nothing else. */
function isNewerListing(candidate: string, current: string): boolean {
  const [candidateRelease, currentRelease] = [candidate, current].map((version) => !version.split("+")[0]!.includes("-"));
  return candidateRelease === currentRelease ? isNewerPluginVersion(candidate, current) : candidateRelease!;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (let next = await reader?.read(); next && !next.done; next = await reader?.read()) {
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader?.cancel();
      throw new Error("The answer is larger than allowed");
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

/**
 * An image the index lists, as an address on the index's own host: it is a
 * path below the index's folder there, so an index can't point the app at
 * someone else's server. The index's own address is HTTPS, or HTTP on this
 * computer (`isIndexUrl`), and so is the image's.
 */
export function indexImage(indexUrl: string, file: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(file) || file.split("/").some((part) => part === "." || part === "..")) return undefined;
  const url = new URL(file, indexUrl);
  return url.origin === new URL(indexUrl).origin ? url.href : undefined;
}
