import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PLUGIN_FILE_MIRROR } from "../shared/plugins.js";

// Where the market's icons and screenshots come from: a CDN that serves npm
// packages' files, jsDelivr unless the person picks another (unpkg, or their
// own proxy of either). Each is read at the exact version the index lists.

/** A base address: HTTPS, or plain HTTP on this computer, ending in `/`, without a query. */
export function normalizePluginFileMirror(value: string): string {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Enter the CDN's address, like https://cdn.jsdelivr.net/npm/");
  }
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("The CDN's address must start with https://");
  if (url.username || url.password || /[?#]/.test(text) || text.length > 500)
    throw new Error("The CDN's address can't hold a user name, a query or a #");
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

/** A file in a package as the market lists it (`./assets/icon.svg` or `assets/icon.svg`), as a path below the package. */
export function packageFilePath(file: string): string | undefined {
  const relative = file.startsWith("./") ? file.slice(2) : file;
  const parts = relative.split("/");
  if (relative.length > 500 || parts.some((part) => !part || part === "." || part === ".." || /[\\?#%\u0000-\u001f]/.test(part))) return undefined;
  return parts.join("/");
}

/** The address of `file` in `name@version` on the mirror at `base`. */
export function pluginFileUrl(base: string, name: string, version: string, file: string): string | undefined {
  const relative = packageFilePath(file);
  return relative ? `${base}${name}@${encodeURIComponent(version)}/${relative.split("/").map(encodeURIComponent).join("/")}` : undefined;
}

export class PluginFileMirror {
  readonly #file: string;
  #base = DEFAULT_PLUGIN_FILE_MIRROR;
  /** A file this app couldn't read, perhaps a newer one's, isn't replaced. */
  #unreadable = false;

  constructor(dataDirectory: string) {
    this.#file = path.join(dataDirectory, "plugin-file-mirror.json");
  }

  /** A file this app can't read is left as it is, and the default is used. */
  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.#file, "utf8")) as { version?: unknown; base?: unknown };
      if (stored.version !== 1 || typeof stored.base !== "string") throw new Error("Unsupported plugin file mirror");
      this.#base = normalizePluginFileMirror(stored.base);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.#unreadable = true;
    }
  }

  get(): string {
    return this.#base;
  }

  async set(value: string): Promise<string> {
    if (this.#unreadable) throw new Error(`${this.#file} can't be read by this version of OhMyGame, so it isn't replaced`);
    const base = normalizePluginFileMirror(value);
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, base }, null, 2)}\n`, { flag: "wx" });
      await rename(temporary, this.#file);
      this.#base = base;
    } finally {
      await rm(temporary, { force: true });
    }
    return base;
  }
}
