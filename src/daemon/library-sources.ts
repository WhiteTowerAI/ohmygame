import { open, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { LibraryAsset, LibrarySource, LibrarySourceItem, LibrarySourceResults, LibrarySourceSearchRequest, LibraryUploadMediaType } from "../shared/contracts.js";
import { ASSET_SOURCE_MEDIA } from "../shared/plugin-manifest.js";
import type { PluginLocale } from "./plugin-index.js";
import type { PluginServices } from "./plugin-services.js";
import { AssetLibraryError, type AssetLibrary } from "./asset-library.js";
import { isLibraryMediaOfType } from "./library-routes.js";
import { workspaceMediaInfo } from "./workspace.js";

/** The largest file a source may add, as for an upload. */
export const LIBRARY_SOURCE_MAX_BYTES = 200 * 1024 * 1024;
const Optional = (maxLength: number) => Type.Optional(Type.String({ minLength: 1, maxLength }));
const HttpsUrl = Type.Optional(Type.String({ pattern: "^https://", maxLength: 2000 }));

/** What a source's `search` returns; fields beyond these are left out. */
const SearchResults = Type.Object({
  items: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 500 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    mediaType: Type.Union(ASSET_SOURCE_MEDIA.map((media) => Type.Literal(media))),
    thumbnail: Type.Optional(Type.String({ pattern: "^(?:https://|data:image/(?:png|jpeg|webp|gif);base64,)", maxLength: 1_000_000 })),
    width: Type.Optional(Type.Integer({ minimum: 1 })),
    height: Type.Optional(Type.Integer({ minimum: 1 })),
    duration: Type.Optional(Type.Number({ minimum: 0 })),
    author: Optional(200),
    license: Optional(200),
    url: HttpsUrl,
  }), { maxItems: 100 }),
  next: Optional(2000),
});

/** What a source's `fetch` returns: a file it saved in its data folder, which the Library takes. */
const FetchResult = Type.Object({
  file: Type.String({ minLength: 1, maxLength: 1000 }),
  name: Optional(200),
  author: Optional(200),
  license: Optional(200),
  url: HttpsUrl,
});

/**
 * The Library's sources from plugins: their searches, checked before the
 * page shows them, and what the person adds, taken from the plugin's data
 * folder into the Library.
 */
export class LibrarySources {
  /** Each plugin's adds, one at a time: a source may save every fetch under the same name. */
  readonly #adding = new Map<string, Promise<unknown>>();

  constructor(
    private readonly plugins: PluginServices,
    private readonly library: AssetLibrary,
  ) {}

  list(locale?: PluginLocale): Promise<LibrarySource[]> {
    return this.plugins.assetSources(locale);
  }

  async search(request: LibrarySourceSearchRequest, signal?: AbortSignal): Promise<LibrarySourceResults> {
    const source = await this.#source(request.source);
    if (request.media && !source.media.includes(request.media)) throw new AssetLibraryError(`${source.title} has no ${request.media}`, 400);
    const value = await this.#run(source.id, "search", { query: request.query, ...(request.media ? { media: request.media } : {}), ...(request.cursor ? { cursor: request.cursor } : {}) }, signal);
    if (!Check(SearchResults, value)) throw new AssetLibraryError(`${source.title} returned results the Library can't read`, 502);
    const results = value as Static<typeof SearchResults>;
    return {
      items: results.items.filter((item) => source.media.includes(item.mediaType)).map(pickItem),
      ...(results.next ? { next: results.next } : {}),
    };
  }

  /** Fetches one result and puts it in the Library; adding it again finds the same asset. */
  async add(sourceId: string, item: { id: string; mediaType: LibraryAsset["mediaType"] }, signal?: AbortSignal): Promise<LibraryAsset> {
    const source = await this.#source(sourceId);
    const before = this.#adding.get(source.plugin) ?? Promise.resolve();
    const added = before.then(() => this.#add(source, item, signal));
    const settled = added.catch(() => undefined);
    this.#adding.set(source.plugin, settled);
    void settled.then(() => { if (this.#adding.get(source.plugin) === settled) this.#adding.delete(source.plugin); });
    return added;
  }

  async #add(source: LibrarySource, item: { id: string; mediaType: LibraryAsset["mediaType"] }, signal?: AbortSignal): Promise<LibraryAsset> {
    if (!source.media.includes(item.mediaType)) throw new AssetLibraryError(`${source.title} has no ${item.mediaType}`, 400);
    const value = await this.#run(source.id, "fetch", { id: item.id, mediaType: item.mediaType }, signal);
    if (!Check(FetchResult, value)) throw new AssetLibraryError(`${source.title} returned a file the Library can't read`, 502);
    const fetched = value as Static<typeof FetchResult>;
    const file = await this.#fileInDataFolder(source, fetched.file);
    try {
      const name = path.basename(fetched.name ?? fetched.file);
      const media = workspaceMediaInfo(name);
      if (!media || media.mediaType !== item.mediaType) throw new AssetLibraryError(`${source.title} returned ${name}, which isn't ${item.mediaType}`, 502);
      const { size } = await stat(file);
      if (size === 0 || size > LIBRARY_SOURCE_MAX_BYTES) throw new AssetLibraryError(`${source.title} returned a file that is empty or larger than 200 MB`, 502);
      // An SVG is checked whole, as text; other kinds by their first bytes.
      const head = media.contentType === "image/svg+xml" ? await readFile(file) : await readHead(file);
      if (!isLibraryMediaOfType(head, media.contentType as LibraryUploadMediaType)) throw new AssetLibraryError(`${source.title} returned ${name}, whose data isn't ${media.contentType}`, 502);
      const asset = await this.library.addFile(name, file, {
        origin: "uploaded",
        saved: true,
        sourceKey: `library-source:${source.id}:${item.id}`,
        sourcedFrom: {
          source: source.id,
          item: item.id,
          ...(fetched.author ? { author: fetched.author } : {}),
          ...(fetched.license ? { license: fetched.license } : {}),
          ...(fetched.url ? { url: fetched.url } : {}),
        },
      });
      // Added before and since removed from the Library: adding it again puts it back.
      return asset.saved ? asset : await this.library.save(asset.id);
    } finally {
      await rm(file, { force: true });
    }
  }

  async #source(id: string): Promise<LibrarySource> {
    const source = (await this.plugins.assetSources()).find((candidate) => candidate.id === id);
    if (!source) throw new AssetLibraryError("This source isn't available: its plugin is off, removed or not allowed what it asks for", 404);
    return source;
  }

  async #run(source: string, handler: "search" | "fetch", input: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.plugins.runAssetSource(source, handler, { input, ...(signal ? { signal } : {}) });
    } catch (cause) {
      if (cause instanceof AssetLibraryError) throw cause;
      throw new AssetLibraryError(cause instanceof Error ? cause.message : String(cause), 502);
    }
  }

  /** The plugin's file, refused when it leads out of the plugin's data folder. */
  async #fileInDataFolder(source: LibrarySource, file: string): Promise<string> {
    const folder = await realpath(this.plugins.dataFolder(source.plugin)).catch(() => undefined);
    const resolved = folder ? await realpath(path.resolve(folder, file)).catch(() => undefined) : undefined;
    if (!folder || !resolved || !resolved.startsWith(`${folder}${path.sep}`)) throw new AssetLibraryError(`${source.title} returned a file outside its data folder`, 502);
    if (!(await stat(resolved)).isFile()) throw new AssetLibraryError(`${source.title} returned something that isn't a file`, 502);
    return resolved;
  }
}

function pickItem(item: Static<typeof SearchResults>["items"][number]): LibrarySourceItem {
  const keys = ["id", "name", "mediaType", "thumbnail", "width", "height", "duration", "author", "license", "url"] as const;
  return Object.fromEntries(keys.flatMap((key) => item[key] === undefined ? [] : [[key, item[key]]])) as unknown as LibrarySourceItem;
}

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
