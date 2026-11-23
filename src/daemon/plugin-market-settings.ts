import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DOWNLOAD_SOURCES, type PluginDownloadSource, type PluginMarketSettings } from "../shared/plugins.js";
import { isIndexUrl, PLUGIN_MARKET_EXTRA_MAX, type PluginDownloadSettings, type PluginMarketSources } from "./plugin-market.js";

export class PluginMarketSettingsError extends Error {
  readonly statusCode = 400;
}

/**
 * Where Discover reads from, as the person set it in its settings: another
 * address for the main index (a mirror), and more indexes after it; and where
 * its plugins download from. Without a file, the app's own index alone, and
 * downloads chosen by where the person is.
 */
export class PluginMarketSettingsStore {
  readonly #file: string;
  #index: string | undefined;
  #extra: string[] = [];
  #download: PluginDownloadSource = "auto";
  #proxy = "";
  /** A file that is there but can't be read is left as it is, not replaced. */
  #unreadable = false;

  constructor(dataDirectory: string, private readonly defaultIndex: string | undefined) {
    this.#file = path.join(dataDirectory, "plugin-market-sources.json");
  }

  async load(): Promise<void> {
    // `download` and `proxy` are optional, so an older app reads the file and a newer one reads an older app's.
    let stored: { version?: unknown; index?: unknown; extra?: unknown; download?: unknown; proxy?: unknown };
    try {
      stored = JSON.parse(await readFile(this.#file, "utf8")) as typeof stored;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      this.#unreadable = true;
      throw cause;
    }
    const urls = Array.isArray(stored?.extra) ? stored.extra : undefined;
    if (stored?.version !== 1 || (stored.index !== undefined && typeof stored.index !== "string") || !urls?.every((url) => typeof url === "string")
      || (stored.download !== undefined && !(PLUGIN_DOWNLOAD_SOURCES as readonly unknown[]).includes(stored.download)) || (stored.proxy !== undefined && typeof stored.proxy !== "string")) {
      this.#unreadable = true;
      throw new Error(`${this.#file} isn't a market settings file this version can read`);
    }
    this.#index = stored.index as string | undefined;
    this.#extra = urls as string[];
    this.#download = (stored.download as PluginDownloadSource | undefined) ?? "auto";
    this.#proxy = (stored.proxy as string | undefined) ?? "";
  }

  sources(): PluginMarketSources {
    return { url: this.#index ?? this.defaultIndex, extra: this.#extra };
  }

  downloads(): PluginDownloadSettings {
    return { download: this.#download, proxy: this.#proxy };
  }

  settings(): PluginMarketSettings {
    return { index: this.#index ?? this.defaultIndex ?? "", defaultIndex: this.defaultIndex ?? "", extra: [...this.#extra], download: this.#download, proxy: this.#proxy };
  }

  /**
   * Saves the main index's address (empty or the default one goes back to the
   * default), the others, and where plugins download from. A proxy is a
   * prefix put before GitHub's address, like `https://proxy.example/`.
   */
  async set(input: { index: string; extra: readonly string[]; download: PluginDownloadSource; proxy: string }): Promise<PluginMarketSettings> {
    if (this.#unreadable) throw new PluginMarketSettingsError(`${this.#file} can't be read, so it isn't replaced. Move it away to start over.`);
    const address = (value: string) => {
      const url = value.trim();
      if (!isIndexUrl(url)) throw new PluginMarketSettingsError(`${url || "An empty address"} isn't an HTTPS address of an index.json`);
      const href = new URL(url).href;
      if (href.length > 500) throw new PluginMarketSettingsError("An index's address can be at most 500 characters");
      return href;
    };
    const wanted = input.index.trim() ? address(input.index) : undefined;
    const index = wanted === undefined || wanted === this.defaultIndex ? undefined : wanted;
    const main = index ?? this.defaultIndex;
    const extra = [...new Set(input.extra.map((url) => url.trim()).filter(Boolean).map(address))].filter((url) => url !== main);
    if (extra.length > PLUGIN_MARKET_EXTRA_MAX) throw new PluginMarketSettingsError(`At most ${PLUGIN_MARKET_EXTRA_MAX} more indexes can be added`);
    const proxy = input.proxy.trim() ? proxyPrefix(input.proxy.trim()) : "";
    if (input.download === "proxy" && !proxy) throw new PluginMarketSettingsError("Enter the proxy's address to download through it");
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, ...(index ? { index } : {}), extra, ...(input.download !== "auto" ? { download: input.download } : {}), ...(proxy ? { proxy } : {}) }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
    this.#index = index;
    this.#extra = extra;
    this.#download = input.download;
    this.#proxy = proxy;
    return this.settings();
  }
}

/** A proxy's address over HTTPS, without a sign-in, query or fragment, ending in `/` so GitHub's address follows it. */
function proxyPrefix(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PluginMarketSettingsError(`${value} isn't an HTTPS address`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new PluginMarketSettingsError(`${value} isn't an HTTPS address without a sign-in or query`);
  const href = url.href.endsWith("/") ? url.href : `${url.href}/`;
  if (href.length > 500) throw new PluginMarketSettingsError("A proxy's address can be at most 500 characters");
  return href;
}
