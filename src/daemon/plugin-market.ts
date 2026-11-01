import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { MarketPlugin, PluginMarketListing } from "../shared/plugins.js";
import { RESERVED_PUBLISHERS } from "./plugin-services.js";

// The market: the index built by WhiteTowerAI/ohmygame-plugins, which lists the
// plugins published on npm. Listing and blocking rest on the index alone. A
// package's contents don't: the index carries npm's own signature over each
// version's checksum, so an index or a mirror that lies about a package can't
// get it installed (PluginSources checks the download against that checksum).

const POINTER_MAX_BYTES = 4 * 1024;
const INDEX_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/** The index job runs every 30 minutes. */
const REFRESH_MS = 30 * 60_000;
const RETRY_MS = 2 * 60_000;

/** npm's registry keys when this app was built; `registryKey` asks npm for one it doesn't know. */
const NPM_KEYS: Record<string, { key: string; expires?: string }> = {
  "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA": {
    key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==",
    expires: "2025-01-29T00:00:00.000Z",
  },
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
  })),
});
const PackageFacts = Type.Object({
  repository: Type.Optional(Type.String({ pattern: "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" })),
  sourceVerified: Type.Optional(Type.Literal(true)),
  stars: Type.Optional(Type.Integer({ minimum: 0 })),
  weeklyDownloads: Type.Optional(Type.Integer({ minimum: 0 })),
});
const MarketIndex = Type.Object({
  schemaVersion: Type.Literal(1),
  versions: Type.Array(IndexedVersion),
  packages: Type.Record(Type.String(), PackageFacts),
  featured: Type.Array(Type.String()),
});
type MarketIndex = Static<typeof MarketIndex>;
type IndexedVersion = Static<typeof IndexedVersion>;

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
      if (!id || RESERVED_PUBLISHERS.has(id.split("/")[0]!)) continue;
      const current = newest.get(id);
      if (!current || (version.publishedAt ?? "") >= (current.publishedAt ?? "")) newest.set(id, version);
    }
    const plugins = [...newest.values()].map((version): MarketPlugin => {
      const plugin = version.plugin!;
      const facts = index.packages[version.package];
      const text = (values: Record<string, string>) => values[language] ?? values.en ?? "";
      return {
        id: plugin.id,
        package: version.package,
        version: version.version,
        displayName: text(plugin.displayName) || plugin.id,
        description: text(plugin.description),
        asks: plugin.grants,
        adds: plugin.adds,
        ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}),
        ...(facts?.repository ? { repository: facts.repository } : {}),
        sourceVerified: facts?.sourceVerified === true,
        ...(facts?.stars !== undefined ? { stars: facts.stars } : {}),
        ...(facts?.weeklyDownloads !== undefined ? { weeklyDownloads: facts.weeklyDownloads } : {}),
        featured: index.featured.includes(plugin.id),
      };
    });
    const featuredAt = (plugin: MarketPlugin) => index.featured.indexOf(plugin.id);
    plugins.sort((a, b) =>
      Number(b.featured) - Number(a.featured) ||
      featuredAt(a) - featuredAt(b) ||
      (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0) ||
      a.displayName.localeCompare(b.displayName));
    const blocked = index.versions.flatMap((version) => {
      const reason = version.rejected?.find((item) => item.startsWith("blocked: "));
      return reason ? [{ package: version.package, version: version.version, reason: reason.slice("blocked: ".length) }] : [];
    });
    return { status: this.#stale ? "stale" : "ready", plugins, blocked };
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
    const published = entry.publishedAt ? Date.parse(entry.publishedAt) : undefined;
    for (const { keyid, sig } of entry.signatures) {
      const known = await this.#registryKey(keyid);
      if (!known) continue;
      // An expired key still vouches for what it signed while it was valid.
      if (known.expires !== undefined && (published === undefined || !(published < known.expires))) continue;
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
    if (!this.#index) await this.#readSaved();
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

  async #read(url: string, maxBytes: number): Promise<Buffer> {
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
