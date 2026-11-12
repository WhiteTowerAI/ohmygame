import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { isNewerPluginVersion, isPluginVersion, NPM_PLUGIN_PACKAGE, type MarketPlugin, type PluginMarketListing } from "../shared/plugins.js";
import { OHMYGAME_PUBLISHER, PERSONAL_PUBLISHER, PLUGIN_CATEGORIES, PLUGIN_KEYWORDS_MAX, PLUGIN_SCREENSHOT_MAX_BYTES, type PluginCategory } from "../shared/plugin-manifest.js";
import { PLUGIN_ICON_MAX_BYTES, PLUGIN_ICON_MEDIA_TYPES } from "../shared/plugin-icons.js";
import { sniffImageType } from "./image-format.js";
import { validatePluginIconImage } from "./plugin-icons.js";

// The market: the index built by WhiteTowerAI/ohmygame-plugins, which lists the
// plugins published on npm. Listing and blocking rest on the index alone. A
// package's contents don't: the index carries npm's own signature over each
// version's checksum, so an index or a mirror that lies about a package can't
// get it installed (PluginSources checks the download against that checksum).
//
// The person can read the main index from somewhere else (a mirror), and add
// more indexes. The main one decides first: a plugin it lists shows as it says,
// and a version it lists is allowed or refused as it says. Another index adds
// only what the main one doesn't list, without its marks (featured, a verified
// source, an avatar), which only the main one can give.

/** The index the ohmygame-plugins job publishes; `OHMYGAME_PLUGIN_INDEX_URL` replaces it, and an empty one turns the market off. */
export const PLUGIN_INDEX_URL = "https://plugins.ohmygame.ai/plugins/index.json";

const POINTER_MAX_BYTES = 4 * 1024;
const INDEX_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/** The index job runs every 30 minutes. */
const REFRESH_MS = 30 * 60_000;
/** GitHub serves an avatar at 96 pixels in a few kilobytes. */
const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR = /^https:\/\/avatars\.githubusercontent\.com\/u\/([0-9]{1,12})(?:\?v=[0-9]{1,4})?$/;
const DAY_MS = 24 * 60 * 60_000;
/** About a page of cards' icons, and a few plugins' screenshots. */
const IMAGE_CACHE_LIMIT = 128;
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
  /** npm's `dist.unpackedSize`. */
  unpackedSize: Type.Optional(Type.Integer({ minimum: 0 })),
  rejected: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }))),
  plugin: Type.Optional(Type.Object({
    id: Type.String({ maxLength: 256 }),
    displayName: Localized,
    description: Localized,
    grants: Type.Array(Type.String({ maxLength: 1024 })),
    adds: Type.Record(Type.String(), Type.Number()),
    // Since index schema 1 gained them; an older index has none.
    categories: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 10 })),
    // Since the index job read them (plugin API 2.5.0).
    keywords: Type.Optional(Type.Array(Localized, { maxItems: 10 })),
    /** The titles of the model providers and agents it adds. */
    names: Type.Optional(Type.Array(Localized, { maxItems: 100 })),
    appliesTo: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 })),
    beta: Type.Optional(Type.Boolean()),
    longDescription: Type.Optional(Localized),
    /**
     * The manifest's icon and screenshots, which the index job copies out of the
     * package to the index's own storage, by their paths below the index's folder
     * (`assets/<sha256>.<ext>`: named by their contents, so they never change).
     */
    icon: Type.Optional(Type.String({ maxLength: 500 })),
    screenshots: Type.Optional(Type.Array(Type.Object({ path: Type.String({ maxLength: 500 }), caption: Type.Optional(Localized) }), { maxItems: 10 })),
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

/** Indexes besides the main one, at most. */
export const PLUGIN_MARKET_EXTRA_MAX = 5;

/** Where the market reads from: the main index, then the others in order. */
export interface PluginMarketSources {
  url: string | undefined;
  extra: readonly string[];
}

export interface PluginMarketOptions {
  /** `index.json`; without one there is no market and nothing is fetched. */
  url?: string | undefined;
  /** More indexes, after the main one. */
  extra?: readonly string[];
  /** Keeps the last index, for when the network is down. */
  directory: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Replaces npm's keys, for tests. */
  keys?: Record<string, { key: string; expires?: string }>;
}

/** One index, and its last copy on disk for when the network is down. */
class MarketSource {
  index: { digest: string; data: MarketIndex } | undefined;
  /** The last try failed, so what's shown may be old. */
  stale = false;
  #checkedAt: number | undefined;
  #refreshing: Promise<void> | undefined;
  /** Read once, so a slow read can't replace what a refresh brought. */
  #saved: Promise<void> | undefined;

  constructor(
    readonly url: string,
    readonly file: string,
    private readonly network: { read(url: string, maxBytes: number): Promise<Buffer>; now(): number },
    /** The copy from before each index had its own file, read when this one has none. */
    private readonly legacy?: string,
  ) {}

  /** The index, read at most every half hour, or sooner after a failure; the last one when the network is down. */
  async current(): Promise<MarketIndex | undefined> {
    await (this.#saved ??= this.#readSaved());
    const due = this.#checkedAt === undefined || this.network.now() - this.#checkedAt >= (this.stale ? RETRY_MS : REFRESH_MS);
    if (due) {
      this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = undefined; });
      // Someone waiting for a first index has nothing else to show.
      if (!this.index) await this.#refreshing;
      else void this.#refreshing;
    }
    return this.index?.data;
  }

  async #readSaved(): Promise<void> {
    const text = await readFile(this.file).catch(() => this.legacy ? readFile(this.legacy).catch(() => undefined) : undefined);
    if (!text) return;
    try {
      const data: unknown = JSON.parse(text.toString("utf8"));
      if (Check(MarketIndex, data)) this.index = { digest: sha256(text), data };
    } catch {
      // A damaged copy is only a cache.
    }
  }

  async #refresh(): Promise<void> {
    try {
      const pointer = JSON.parse((await this.network.read(this.url, POINTER_MAX_BYTES)).toString("utf8")) as { latest?: unknown; sha256?: unknown };
      const digest = typeof pointer.latest === "string" ? /^index\.([0-9a-f]{64})\.json$/.exec(pointer.latest)?.[1] : undefined;
      if (!digest) throw new Error("The index pointer is malformed");
      if (this.index?.digest !== digest) {
        const bytes = await this.network.read(new URL(pointer.latest as string, this.url).href, INDEX_MAX_BYTES);
        // The name is the hash, and only then is it worth parsing.
        if (sha256(bytes) !== digest) throw new Error("The index doesn't match its checksum");
        const data: unknown = JSON.parse(bytes.toString("utf8"));
        if (!Check(MarketIndex, data)) throw new Error("The index is malformed");
        await this.#save(bytes);
        if (this.legacy) await rm(this.legacy, { force: true }).catch(() => undefined);
        this.index = { digest, data };
      }
      this.stale = false;
    } catch {
      this.stale = true;
    }
    this.#checkedAt = this.network.now();
  }

  async #save(bytes: Buffer): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export class PluginMarket {
  readonly #directory: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #keys: Map<string, { key: KeyObject; expires?: number }>;
  /** The main index first; none when there is no market. */
  #sources: MarketSource[] = [];
  #images = new Map<string, Promise<MarketImage>>();

  constructor(options: PluginMarketOptions) {
    this.#directory = options.directory;
    this.#fetch = options.fetch ?? ((...request) => fetch(...request));
    this.#now = options.now ?? Date.now;
    this.#keys = new Map(Object.entries(options.keys ?? NPM_KEYS).map(([keyid, item]) => [keyid, readKey(item)]));
    this.setSources({ url: options.url, extra: options.extra ?? [] }, path.join(options.directory, "market-index.json"));
  }

  /**
   * Reads from these indexes from now on. An address that isn't HTTPS (or HTTP
   * on this computer) is passed over; without a main index there is no market.
   * An index read before keeps what it read.
   */
  // compat: since beta.5.8, remove `legacy` from beta.7 and 2026-12-31. Before each index had its own file, the main one's copy was market-index.json.
  setSources(sources: PluginMarketSources, legacy?: string): void {
    const main = sources.url && isIndexUrl(sources.url) ? sources.url : undefined;
    const urls = main ? [...new Set([main, ...sources.extra.filter(isIndexUrl).slice(0, PLUGIN_MARKET_EXTRA_MAX)])] : [];
    const known = new Map(this.#sources.map((source) => [source.url, source]));
    const network = { read: (url: string, maxBytes: number) => this.#read(url, maxBytes), now: () => this.#now() };
    this.#sources = urls.map((url) => known.get(url)
      ?? new MarketSource(url, path.join(this.#directory, `market-index-${sha256(Buffer.from(url)).slice(0, 16)}.json`), network, url === main ? legacy : undefined));
    this.#images.clear();
  }

  /** What Browse shows, in `locale`. Reserved publishers are left out, as they can't be added. */
  async listing(locale: string | undefined): Promise<PluginMarketListing> {
    const sources = this.#sources;
    if (!sources.length) return { status: "off", plugins: [], blocked: [] };
    const indexes = await Promise.all(sources.map((source) => source.current()));
    const language = locale === "zh-CN" ? "zh-CN" : "en";
    const plugins: MarketPlugin[] = [];
    const seen = new Set<string>();
    indexes.forEach((index, at) => {
      if (!index) return;
      // The main index decides about a plugin it lists; another adds only what it doesn't.
      for (const plugin of listed(index, sources[at]!.url, language, at === 0)) {
        if (seen.has(plugin.id)) continue;
        seen.add(plugin.id);
        plugins.push(plugin);
      }
    });
    const featured = indexes[0]?.featured ?? [];
    const featuredAt = (plugin: MarketPlugin) => featured.indexOf(plugin.id);
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
    // Any index's block holds: a version stays out of reach whichever list the person found it in.
    const blocked = indexes.flatMap((index) => (index?.versions ?? []).flatMap((version) => {
      const reason = version.rejected?.find((item) => item.startsWith("blocked: "));
      return reason ? [{ package: version.package, version: version.version, reason: reason.slice("blocked: ".length) }] : [];
    }));
    const statusOf = (source: MarketSource, index: MarketIndex | undefined) => !index ? "unavailable" as const : source.stale ? "stale" as const : "ready" as const;
    return {
      status: statusOf(sources[0]!, indexes[0]),
      plugins,
      blocked,
      sources: sources.map((source, at) => ({ url: source.url, status: statusOf(source, indexes[at]) })),
    };
  }

  /**
   * An icon or a screenshot an index lists (the main one, or `from`), read from
   * beside that index through the daemon, so it uses the app's network
   * settings. An icon is checked as an installed plugin's would be, and must be
   * the type its name says; a screenshot must be a PNG, JPEG or WebP. They're
   * named by their contents, so one read is kept.
   */
  async image(file: string, role: "icon" | "screenshot", from?: string): Promise<MarketImage | undefined> {
    const source = from === undefined ? this.#sources[0] : this.#sources.find((item) => item.url === from);
    const index = await source?.current();
    const url = index && indexImage(source!.url, file);
    if (!url) return undefined;
    // Named by its contents, one file may be one plugin's icon and another's screenshot; each is checked as asked for.
    const icon = role === "icon";
    if (!index.versions.some(({ plugin }) => icon ? plugin?.icon === file : plugin?.screenshots?.some((shot) => shot.path === file))) return undefined;
    const expected = icon ? PLUGIN_ICON_MEDIA_TYPES[file.slice(file.lastIndexOf(".") + 1).toLowerCase() as keyof typeof PLUGIN_ICON_MEDIA_TYPES] : undefined;
    if (icon && !expected) return undefined;
    // Not followed elsewhere: the image has to come from the index's host.
    return this.#picture(`${icon ? "icon" : "screenshot"}:${url}`, url, icon ? PLUGIN_ICON_MAX_BYTES : PLUGIN_SCREENSHOT_MAX_BYTES,
      icon ? (bytes) => validatePluginIconImage(bytes, expected) : undefined);
  }

  /**
   * A publisher's GitHub avatar, by GitHub's id for them. Only one the main
   * index gives a package whose source is verified, from GitHub's avatar host
   * and nowhere it redirects to.
   */
  async avatar(id: string): Promise<MarketImage | undefined> {
    const index = await this.#sources[0]?.current();
    const listed = index && Object.values(index.packages).some((facts) => facts.sourceVerified && facts.avatar && AVATAR.exec(facts.avatar)?.[1] === id);
    if (!listed) return undefined;
    // It changes rarely, so the copy read while the app runs is kept.
    return this.#picture(`avatar:${id}`, `https://avatars.githubusercontent.com/u/${id}?s=96`, AVATAR_MAX_BYTES);
  }

  #picture(key: string, url: string, maxBytes: number, check?: (bytes: Buffer) => Promise<MarketImage>): Promise<MarketImage> {
    let read = this.#images.get(key);
    if (!read) {
      read = this.#read(url, maxBytes, "error").then((bytes) => {
        if (check) return check(bytes);
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
   * What the indexes say about one published version: a release to pin to,
   * after checking npm's signature; undefined when none lists that version. The
   * first index that lists it decides, the main one first. A version it
   * rejected, blocked or not, can't be added, wherever the person found its name.
   */
  async release(name: string, version: string): Promise<MarketRelease | undefined> {
    for (const [at, source] of this.#sources.entries()) {
      const index = await source.current();
      // Without the main index there's no knowing whether it blocks a version, so no other index vouches for one.
      if (!index && at === 0) return undefined;
      const entry = index?.versions.find((item) => item.package === name && item.version === version);
      if (!entry) continue;
      if (entry.rejected?.length) {
        const blocked = entry.rejected.find((item) => item.startsWith("blocked: "));
        throw new PluginMarketError(blocked
          ? `${name} ${version} was blocked: ${blocked.slice("blocked: ".length)}`
          : `${name} ${version} can't be added: ${entry.rejected[0]}`);
      }
      await this.#checkSignature(entry);
      return { package: name, version, integrity: entry.integrity };
    }
    return undefined;
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

  async #read(url: string, maxBytes: number, redirect: RequestRedirect = "follow"): Promise<Buffer> {
    const response = await this.#fetch(url, { redirect, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readLimited(response, maxBytes);
  }
}

/**
 * The plugins one index lists, by their newest version. `main` is whether it is
 * the main index: only that one's featured list, verified sources, avatars,
 * stars and downloads are taken at its word. Another's plugins say which
 * index they come from.
 */
function listed(index: MarketIndex, url: string, language: "en" | "zh-CN", main: boolean): MarketPlugin[] {
  const newest = new Map<string, IndexedVersion>();
  for (const version of index.versions) {
    const id = version.plugin?.id;
    // The index reads npmjs, where only OhMyGame publishes to `@ohmygame`.
    if (!id || id.startsWith(`${PERSONAL_PUBLISHER}/`)) continue;
    // OhMyGame's own plugins carry its seal, so only the main index lists them.
    if (!main && id.startsWith(`${OHMYGAME_PUBLISHER}/`)) continue;
    // Installing looks for exactly this name and version, and what it can't find
    // isn't held to a signature. Anything else mustn't reach a card.
    if (!NPM_PLUGIN_PACKAGE.test(version.package) || !isPluginVersion(version.version)) continue;
    const current = newest.get(id);
    if (!current || isNewerListing(version.version, current.version)) newest.set(id, version);
  }
  return [...newest.values()].map((version): MarketPlugin => {
    const plugin = version.plugin!;
    const facts = main ? index.packages[version.package] : undefined;
    const text = (values: Record<string, string>) => values[language] ?? values.en ?? "";
    const file = (value: string | undefined) => (value && indexImage(url, value) ? value : undefined);
    // The repository is proven to be the package's, so its owner's face is the publisher's.
    const avatar = facts?.sourceVerified ? facts.avatar && AVATAR.exec(facts.avatar)?.[1] : undefined;
    const icon = file(plugin.icon);
    const screenshots = (plugin.screenshots ?? []).flatMap((shot) => {
      const caption = shot.caption && text(shot.caption);
      return file(shot.path) ? [{ path: shot.path, ...(caption ? { caption } : {}) }] : [];
    });
    const categories = plugin.categories?.filter((category): category is PluginCategory => (PLUGIN_CATEGORIES as readonly string[]).includes(category));
    const longDescription = plugin.longDescription && text(plugin.longDescription);
    const words = (values: Record<string, string>[] | undefined) => [...new Set((values ?? []).map(text).filter(Boolean))];
    const keywords = words(plugin.keywords).slice(0, PLUGIN_KEYWORDS_MAX);
    const names = words(plugin.names);
    const repository = main ? facts?.repository : index.packages[version.package]?.repository;
    return {
      id: plugin.id,
      package: version.package,
      version: version.version,
      displayName: text(plugin.displayName) || plugin.id,
      description: text(plugin.description),
      asks: plugin.grants,
      adds: plugin.adds,
      ...(categories?.length ? { categories } : {}),
      ...(keywords.length ? { keywords } : {}),
      ...(names.length ? { names } : {}),
      ...(plugin.appliesTo?.length ? { appliesTo: plugin.appliesTo } : {}),
      ...(plugin.beta ? { beta: true } : {}),
      ...(longDescription ? { longDescription } : {}),
      ...(icon ? { icon } : {}),
      ...(avatar ? { avatar } : {}),
      ...(screenshots.length ? { screenshots } : {}),
      ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}),
      ...(facts?.createdAt ? { createdAt: facts.createdAt } : {}),
      ...(version.unpackedSize !== undefined ? { size: version.unpackedSize } : {}),
      ...(repository ? { repository } : {}),
      sourceVerified: facts?.sourceVerified === true,
      ...(facts?.stars !== undefined ? { stars: facts.stars } : {}),
      ...(facts?.weeklyDownloads !== undefined ? { weeklyDownloads: facts.weeklyDownloads } : {}),
      featured: main && index.featured.includes(plugin.id),
      ...(main ? {} : { source: url }),
    };
  });
}

/** HTTPS, or plain HTTP on this computer. */
export function isIndexUrl(value: string): boolean {
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
 * An image the index lists, as an address below the index's folder on its own
 * host: plain names, no `.` or `..`, so an index can't point the app at
 * someone else's server. The index's own address is HTTPS, or HTTP on this
 * computer (`isIndexUrl`), and so is the image's.
 */
export function indexImage(indexUrl: string, file: string): string | undefined {
  if (file.length > 500 || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(file) || file.split("/").some((part) => part === "." || part === "..")) return undefined;
  return new URL(file, indexUrl).href;
}
