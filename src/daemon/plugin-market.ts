import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { isNewerPluginVersion, isOfficialRepository, isPluginVersion, PROVIDER_KINDS, type MarketPlugin, type PluginDownloadSource, type PluginMarketListing, type PluginOrigin } from "../shared/plugins.js";
import { OHMYGAME_PUBLISHER, PLUGIN_CATEGORIES, PLUGIN_KEYWORDS_MAX, PLUGIN_SCREENSHOT_MAX_BYTES, RESERVED_PUBLISHERS, type PluginCategory } from "../shared/plugin-manifest.js";
import { PLUGIN_ICON_MAX_BYTES, PLUGIN_ICON_MEDIA_TYPES } from "../shared/plugin-icons.js";
import { sniffImageType } from "./image-format.js";
import { validatePluginIconImage } from "./plugin-icons.js";
import { MARKET_RELEASE_KEYS, PluginReleaseError, Release, verifyReleaseSignature, type PluginRelease, type PluginReleaseKeys } from "./plugin-releases.js";

// The market: the index built by WhiteTowerAI/ohmygame-plugins, which lists the
// plugins released on GitHub. Listing and blocking rest on the index alone. A
// package's contents don't: each version carries the market's signed record of
// its archive's digest, checked with the key this app carries, so an index, a
// mirror or a proxy that lies about a package can't get it installed
// (PluginSources checks the download against that digest).
//
// The person can read the main index from somewhere else (a mirror), and add
// more indexes. The main one decides first: a plugin it lists shows as it says,
// and a version it lists is allowed or refused as it says. Another index adds
// only what the main one doesn't list, without its marks (featured, a verified
// source, an avatar), which only the main one can give.

/** The index the ohmygame-plugins job publishes; `OHMYGAME_PLUGIN_INDEX_URL` replaces it, and an empty one turns the market off. */
export const PLUGIN_INDEX_URL = "https://plugins.ohmygame.ai/plugins/v2/index.json";

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
/** How recent a read must be for an update nobody reviews to rely on it. */
const FRESH_MS = 60_000;

/** Time zones of mainland China, where GitHub is slow to reach, so `auto` downloads from the mirror first. */
const MAINLAND_TIME_ZONES = new Set(["Asia/Shanghai", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Urumqi", "Asia/Kashgar", "PRC"]);

const Localized = Type.Record(Type.String(), Type.String());
const REPOSITORY = "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$";
const IndexedVersion = Type.Object({
  /** `owner/repo`, as GitHub spells it. */
  repository: Type.String({ pattern: REPOSITORY, maxLength: 200 }),
  tag: Type.String({ maxLength: 256 }),
  commit: Type.String({ maxLength: 64 }),
  version: Type.String({ maxLength: 256 }),
  publishedAt: Type.Optional(Type.String({ maxLength: 64 })),
  rejected: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }))),
  /** The market's signed record, for a version that can be installed; a field added later is passed over. */
  release: Type.Optional(Type.Object(Release.properties)),
  /** The same archive on GitHub, for a release that attaches it; a tag's source is on the mirror alone. */
  github: Type.Optional(Type.String({ pattern: "^https://", maxLength: 2048 })),
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
    /** What its model providers make, from its manifest; kinds this app doesn't know are skipped. */
    providerKinds: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 10 })),
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
const RepositoryFacts = Type.Object({
  stars: Type.Optional(Type.Integer({ minimum: 0 })),
  /** The repository owner's GitHub avatar, `avatar_url` from GitHub's API; shown only from the main index. */
  // Any other address is passed over, not the whole index.
  avatar: Type.Optional(Type.String({ maxLength: 500 })),
  /** When the repository was made. */
  createdAt: Type.Optional(Type.String({ maxLength: 64 })),
});
const MarketIndex = Type.Object({
  schemaVersion: Type.Literal(2),
  versions: Type.Array(IndexedVersion),
  /** By `owner/repo`. */
  repositories: Type.Record(Type.String(), RepositoryFacts),
  featured: Type.Array(Type.String()),
});
type MarketIndex = Static<typeof MarketIndex>;
type IndexedVersion = Static<typeof IndexedVersion>;

export interface MarketImage { bytes: Buffer; mediaType: string; revision: string }

/**
 * How well a plugin is doing, from 0 to 1, for the market's recommended
 * order. Stars count most, but not alone: a plugin kept up to date, with a
 * verified source and a page that says what it does, ranks above one that was
 * only starred a lot once. The index has no download counts.
 *
 * - 0.40 GitHub stars, on a log scale against the market's most;
 * - 0.30 how recently it was updated: full within a month, none after a year;
 * - 0.30 its page: a verified source, a long description, screenshots and a
 *   category, a quarter each.
 *
 * A beta keeps 85% of its score.
 */
export function marketScore(plugin: MarketPlugin, most: { stars: number }, now: number): number {
  const scale = (value: number | undefined, max: number) => (max > 0 ? Math.log1p(value ?? 0) / Math.log1p(max) : 0);
  const updated = plugin.publishedAt ? Date.parse(plugin.publishedAt) : Number.NaN;
  const age = Number.isNaN(updated) ? Infinity : (now - updated) / DAY_MS;
  const fresh = Math.min(1, Math.max(0, (365 - age) / (365 - 30)));
  const page = [plugin.sourceVerified, plugin.longDescription, plugin.screenshots?.length, plugin.categories?.length].filter(Boolean).length / 4;
  const score = 0.4 * scale(plugin.stars, most.stars) + 0.3 * fresh + 0.3 * page;
  return plugin.beta ? score * 0.85 : score;
}

export class PluginMarketError extends Error {
  readonly statusCode = 400;
}

/** A version the index lets someone install, once its signature checks. */
export interface MarketRelease {
  /** The market's signed record, which the download must match. */
  release: PluginRelease;
  /** Where to download it, in the order to try. */
  urls: string[];
  /** The GitHub release it is, which becomes the plugin's origin. */
  origin: Extract<PluginOrigin, { type: "github" }>;
}

/** Where market plugins download from, as the person set it. */
export interface PluginDownloadSettings {
  download: PluginDownloadSource;
  /** For `proxy`: put before the GitHub address, ending in `/`. */
  proxy: string;
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
  /** Replaces the market's key, for tests. */
  keys?: PluginReleaseKeys;
  /** The system's time zone, which `auto` downloads go by; for tests. */
  timeZone?: string;
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

  /** Reads the index now, unless it was read within `maxAgeMs`, and whether that worked, so what it says is current. */
  async fresh(maxAgeMs = FRESH_MS): Promise<boolean> {
    await (this.#saved ??= this.#readSaved());
    const recent = !this.stale && this.#checkedAt !== undefined && this.network.now() - this.#checkedAt < maxAgeMs;
    if (!recent) await (this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = undefined; }));
    return !this.stale && this.index !== undefined;
  }

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
  readonly #keys: PluginReleaseKeys;
  readonly #timeZone: string;
  /** The main index first; none when there is no market. */
  #sources: MarketSource[] = [];
  #images = new Map<string, Promise<MarketImage>>();
  #download: PluginDownloadSettings = { download: "auto", proxy: "" };

  constructor(options: PluginMarketOptions) {
    this.#directory = options.directory;
    this.#fetch = options.fetch ?? ((...request) => fetch(...request));
    this.#now = options.now ?? Date.now;
    this.#keys = options.keys ?? MARKET_RELEASE_KEYS;
    this.#timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
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

  /** Where plugins download from from now on. */
  setDownload(settings: PluginDownloadSettings): void {
    this.#download = settings;
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
    const most = { stars: Math.max(0, ...plugins.map((plugin) => plugin.stars ?? 0)) };
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
      return reason ? [{ repository: version.repository, ...(version.plugin ? { id: version.plugin.id } : {}), version: version.version, reason: reason.slice("blocked: ".length) }] : [];
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
   * index gives a repository, from GitHub's avatar host and nowhere it
   * redirects to.
   */
  async avatar(id: string): Promise<MarketImage | undefined> {
    const index = await this.#sources[0]?.current();
    const listed = index && Object.values(index.repositories).some((facts) => facts.avatar && AVATAR.exec(facts.avatar)?.[1] === id);
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
   * What the indexes say about one released version: the market's record to
   * install it by, after checking its signature, and where to download it,
   * for the UI's `locale`; undefined when none lists that version. The first
   * index that lists it decides, the main one first. A version it rejected,
   * blocked or not, can't be added, wherever the person found its name.
   */
  async release(id: string, version: string, locale?: string): Promise<MarketRelease | undefined> {
    let main: MarketIndex | undefined;
    for (const [at, source] of this.#sources.entries()) {
      const index = await source.current();
      // Without the main index there's no knowing whether it blocks a version, so no other index vouches for one.
      if (!index && at === 0) return undefined;
      if (!index) continue;
      main ??= index;
      const listed = listedVersion(index, id, version);
      // What the main index turned away stays turned away wherever else it is listed.
      const rejected = (rejectedVersion(index, id, version) ?? (at > 0 ? rejectedVersion(main, id, version) : undefined))?.rejected;
      if (rejected?.length) {
        const blocked = rejected.find((item) => item.startsWith("blocked: "));
        throw new PluginMarketError(blocked
          ? `${id} ${version} was blocked: ${blocked.slice("blocked: ".length)}`
          : `${id} ${version} can't be added: ${rejected[0]}`);
      }
      if (listed) return this.#vouch(listed, locale);
    }
    return undefined;
  }

  /**
   * `release`, by indexes read just now: what an update the person doesn't
   * review may rely on. Undefined when an index can't be read now or none
   * lists the version, so such an update waits for the person.
   */
  async vouchedRelease(id: string, version: string): Promise<MarketRelease | undefined> {
    const fresh = await Promise.all(this.#sources.map((source) => source.fresh()));
    if (!fresh.length || fresh.some((ok) => !ok)) return undefined;
    // Any index that turned it away decides, as the Plugins page shows it, and the main index must list it.
    for (const source of this.#sources) {
      const index = await source.current();
      const rejected = index && rejectedVersion(index, id, version)?.rejected?.[0];
      if (rejected) throw new PluginMarketError(`${id} ${version} can't be added: ${rejected.replace(/^blocked: /, "blocked, ")}`);
    }
    const main = await this.#sources[0]!.current();
    const entry = main && listedVersion(main, id, version);
    return entry ? this.#vouch(entry) : undefined;
  }

  #vouch(entry: IndexedVersion, locale?: string): MarketRelease {
    const { id, version, url, size, sha256, key, signature } = entry.release!;
    const release = { id, version, url, size, sha256, key, signature };
    try {
      verifyReleaseSignature(release, this.#keys);
    } catch (cause) {
      if (cause instanceof PluginReleaseError) throw new PluginMarketError(`${cause.message}, so it can't be added.`);
      throw cause;
    }
    return { release, urls: this.#urls(entry, locale), origin: { type: "github", repository: entry.repository, commit: entry.commit, release: entry.tag } };
  }

  /**
   * Where a release downloads from, in the order to try: the mirror, GitHub,
   * or the person's proxy before GitHub's address. Each copy is held to the
   * signed digest, so they're all as safe. A release without a copy on GitHub
   * (its tag's source, which GitHub doesn't keep byte for byte) comes from the
   * mirror alone.
   */
  #urls(entry: IndexedVersion, locale: string | undefined): string[] {
    const mirror = entry.release!.url;
    const github = entry.github;
    if (!github) return [mirror];
    const { download, proxy } = this.#download;
    if (download === "github") return [github];
    if (download === "mirror") return [mirror];
    if (download === "proxy") return [`${proxy}${github}`];
    // In Chinese, or in mainland China, the mirror first; elsewhere GitHub. Then the other.
    return locale === "zh-CN" || MAINLAND_TIME_ZONES.has(this.#timeZone) ? [mirror, github] : [github, mirror];
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
  for (const item of index.versions) {
    const id = item.plugin?.id;
    // The entry installing would use, which a duplicate without a release isn't.
    const version = id && listedVersion(index, id, item.version);
    if (!id || !version) continue;
    // OhMyGame's own plugins carry its seal, so only the main index lists them.
    if (!main && id.startsWith(`${OHMYGAME_PUBLISHER}/`)) continue;
    const current = newest.get(id);
    if (!current || isNewerListing(version.version, current.version)) newest.set(id, version);
  }
  return [...newest.values()].map((version): MarketPlugin => {
    const plugin = version.plugin!;
    // The main index checked that the repository's owner is the publisher, so its owner's face is the publisher's.
    const facts = main ? index.repositories[version.repository] : undefined;
    const text = (values: Record<string, string>) => values[language] ?? values.en ?? "";
    const file = (value: string | undefined) => (value && indexImage(url, value) ? value : undefined);
    const avatar = facts?.avatar && AVATAR.exec(facts.avatar)?.[1];
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
    const providerKinds = PROVIDER_KINDS.filter((kind) => plugin.providerKinds?.includes(kind));
    return {
      id: plugin.id,
      version: version.version,
      displayName: text(plugin.displayName) || plugin.id,
      description: text(plugin.description),
      asks: plugin.grants,
      adds: plugin.adds,
      ...(categories?.length ? { categories } : {}),
      ...(keywords.length ? { keywords } : {}),
      ...(names.length ? { names } : {}),
      ...(providerKinds.length ? { providerKinds } : {}),
      ...(plugin.appliesTo?.length ? { appliesTo: plugin.appliesTo } : {}),
      ...(plugin.beta ? { beta: true } : {}),
      ...(longDescription ? { longDescription } : {}),
      ...(icon ? { icon } : {}),
      ...(avatar ? { avatar } : {}),
      ...(screenshots.length ? { screenshots } : {}),
      ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}),
      ...(facts?.createdAt ? { createdAt: facts.createdAt } : {}),
      size: version.release!.size,
      repository: `https://github.com/${version.repository}`,
      sourceVerified: main,
      ...(facts?.stars !== undefined ? { stars: facts.stars } : {}),
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

/**
 * The version of a plugin an index lets someone install: one with a signed
 * record naming exactly that plugin and version, from a repository of its
 * publisher. Reserved publishers but OhMyGame's can't be added, so they
 * aren't listed. A version not found this way isn't held to a signature, so
 * it mustn't reach a card.
 */
function listedVersion(index: MarketIndex, id: string, version: string): IndexedVersion | undefined {
  const publisher = id.slice(0, id.indexOf("/"));
  if (publisher !== OHMYGAME_PUBLISHER && RESERVED_PUBLISHERS.has(publisher)) return undefined;
  return index.versions.find((item) => item.plugin?.id === id && item.version === version && !item.rejected?.length
    && (publisher !== OHMYGAME_PUBLISHER || isOfficialRepository(item.repository))
    && item.release?.id === id && item.release.version === version && isPluginVersion(version) && /^[0-9a-f]{40}$/.test(item.commit));
}

/**
 * A version of a plugin the index turned away. Such a version no longer says
 * which plugin it holds, so it's the one at that version in the repository
 * the plugin's other versions come from.
 */
function rejectedVersion(index: MarketIndex, id: string, version: string): IndexedVersion | undefined {
  // A second release of a version it lists is turned away, not the version.
  if (listedVersion(index, id, version)) return undefined;
  const repositories = new Set(index.versions.filter((item) => item.plugin?.id === id).map((item) => item.repository.toLowerCase()));
  // A blocked version still says which plugin it holds, as a repository can hold several.
  return index.versions.find((item) => item.version === version && item.rejected?.length
    && (item.plugin ? item.plugin.id === id : repositories.has(item.repository.toLowerCase())));
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
