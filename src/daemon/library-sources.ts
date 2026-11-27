import { open, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { LibraryAssetSourcing, LibrarySource, LibrarySourceItem, LibrarySourceResults, LibrarySourceSearchRequest, LibraryUploadMediaType } from "../shared/contracts.js";
import { ASSET_SOURCE_MEDIA } from "../shared/plugin-manifest.js";
import type { PluginLocale } from "./plugin-index.js";
import type { PluginServices } from "./plugin-services.js";
import { isMediaOfType } from "./media-routes.js";
import type { ProjectManager } from "./projects.js";
import { workspaceMediaInfo } from "./workspace.js";
import { LIBRARY_UPLOAD_MAX_BYTES } from "../shared/media-files.js";
import { embedOf } from "../shared/library-embeds.js";

/** A source's call that failed, with the status the page hears. */
export class AssetSourceError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

const Optional = (maxLength: number) => Type.Optional(Type.String({ minLength: 1, maxLength }));
const HttpsUrl = Type.Optional(Type.String({ pattern: "^https://", maxLength: 2000 }));

/** What a source's `search` returns; fields beyond these are left out. */
const SearchResults = Type.Object({
  items: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 500 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    mediaType: Type.Union(ASSET_SOURCE_MEDIA.map((media) => Type.Literal(media))),
    thumbnail: Type.Optional(Type.String({ pattern: "^(?:https://|data:image/(?:png|jpeg|webp|gif);base64,)", maxLength: 1_000_000 })),
    // Played before it is added, so it is a sound the page can play: from the web, or carried in the result.
    preview: Type.Optional(Type.String({ pattern: "^(?:https://|data:audio/(?:wav|mpeg|ogg|mp4);base64,)", maxLength: 4_000_000 })),
    width: Type.Optional(Type.Integer({ minimum: 1 })),
    height: Type.Optional(Type.Integer({ minimum: 1 })),
    duration: Type.Optional(Type.Number({ minimum: 0 })),
    author: Optional(200),
    license: Optional(200),
    url: HttpsUrl,
    // Kept only from a site its plugin asks to connect to; see `embedOf`.
    embed: Optional(2000),
  }), { maxItems: 100 }),
  next: Optional(2000),
});

/** What a source's `fetch` returns: a file it saved in its data folder, which the project takes. */
const FetchResult = Type.Object({
  file: Type.String({ minLength: 1, maxLength: 1000 }),
  name: Optional(200),
  author: Optional(200),
  license: Optional(200),
  url: HttpsUrl,
});

/**
 * Plugins' asset sources: their searches, checked before a project's Assets
 * shows them, and what the person or an agent adds, taken from the plugin's
 * data folder into the project's media.
 */
export class LibrarySources {
  /** Each plugin's adds, one at a time: a source may save every fetch under the same name. */
  readonly #adding = new Map<string, Promise<unknown>>();

  constructor(
    private readonly plugins: PluginServices,
    private readonly projects: Pick<ProjectManager, "addMedia" | "sourcedMedia">,
  ) {}

  list(locale?: PluginLocale): Promise<LibrarySource[]> {
    return this.plugins.assetSources(locale);
  }

  async search(request: LibrarySourceSearchRequest, signal?: AbortSignal): Promise<LibrarySourceResults> {
    const source = await this.#source(request.source);
    if (request.media && !source.media.includes(request.media)) throw new AssetSourceError(`${source.title} has no ${request.media}`, 400);
    if (request.collection && !source.collections?.some((collection) => collection.id === request.collection)) throw new AssetSourceError(`${source.title} has no collection ${request.collection}`, 400);
    const value = await this.#run(source.id, "search", {
      query: request.query,
      ...(request.media ? { media: request.media } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.collection ? { collection: request.collection } : {}),
    }, signal);
    if (!Check(SearchResults, value)) throw new AssetSourceError(`${source.title} returned results OhMyGame can't read`, 502);
    const results = value as Static<typeof SearchResults>;
    return {
      items: results.items.filter((item) => source.media.includes(item.mediaType)).map((item) => pickItem(item, source.embedHosts ?? [])),
      ...(results.next ? { next: results.next } : {}),
    };
  }

  /**
   * Downloads a result into the project's media. Its credit is what the
   * source's `fetch` gives, and otherwise what the result showed when searched.
   */
  async add(sourceId: string, item: SourceItemToAdd, projectId: string, signal?: AbortSignal): Promise<SourcedAsset> {
    const source = await this.#source(sourceId);
    const before = this.#adding.get(source.plugin) ?? Promise.resolve();
    const added = before.then(() => this.#add(source, item, projectId, signal));
    const settled = added.catch(() => undefined);
    this.#adding.set(source.plugin, settled);
    void settled.then(() => { if (this.#adding.get(source.plugin) === settled) this.#adding.delete(source.plugin); });
    return added;
  }

  async #add(source: LibrarySource, item: SourceItemToAdd, projectId: string, signal?: AbortSignal): Promise<SourcedAsset> {
    if (!source.media.includes(item.mediaType)) throw new AssetSourceError(`${source.title} has no ${item.mediaType}`, 400);
    // A result added before is the file it became, with no second download.
    const key = `${source.id}#${item.id}`;
    const kept = await this.projects.sourcedMedia(projectId, key);
    if (kept) return { path: kept, name: path.basename(kept), sourcedFrom: { source: source.id, item: item.id, ...credit({}, item) } };
    const value = await this.#run(source.id, "fetch", { id: item.id, mediaType: item.mediaType }, signal);
    if (!Check(FetchResult, value)) throw new AssetSourceError(`${source.title} returned a file OhMyGame can't read`, 502);
    const fetched = value as Static<typeof FetchResult>;
    const file = await this.#fileInDataFolder(source, fetched.file);
    try {
      const name = path.basename(fetched.name ?? fetched.file);
      const media = workspaceMediaInfo(name);
      if (!media || media.mediaType !== item.mediaType) throw new AssetSourceError(`${source.title} returned ${name}, which isn't ${item.mediaType}`, 502);
      const { size } = await stat(file);
      if (size === 0 || size > LIBRARY_UPLOAD_MAX_BYTES) throw new AssetSourceError(`${source.title} returned a file that is empty or larger than 200 MB`, 502);
      // An SVG is checked whole, as text; other kinds by their first bytes.
      const head = media.contentType === "image/svg+xml" ? await readFile(file) : await readHead(file);
      if (!isMediaOfType(head, media.contentType as LibraryUploadMediaType)) throw new AssetSourceError(`${source.title} returned ${name}, whose data isn't ${media.contentType}`, 502);
      signal?.throwIfAborted();
      return {
        path: await this.projects.addMedia(projectId, name, { file }, { source: key }),
        name,
        sourcedFrom: { source: source.id, item: item.id, ...credit(fetched, item) },
      };
    } finally {
      await rm(file, { force: true });
    }
  }

  async #source(id: string): Promise<LibrarySource> {
    const source = (await this.plugins.assetSources()).find((candidate) => candidate.id === id);
    if (!source) throw new AssetSourceError("This source isn't available: its plugin is off, removed or not allowed what it asks for", 404);
    return source;
  }

  async #run(source: string, handler: "search" | "fetch", input: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.plugins.runAssetSource(source, handler, { input, ...(signal ? { signal } : {}) });
    } catch (cause) {
      if (cause instanceof AssetSourceError) throw cause;
      throw new AssetSourceError(cause instanceof Error ? cause.message : String(cause), 502);
    }
  }

  /** The plugin's file, refused when it leads out of the plugin's data folder. */
  async #fileInDataFolder(source: LibrarySource, file: string): Promise<string> {
    const folder = await realpath(this.plugins.dataFolder(source.plugin)).catch(() => undefined);
    const resolved = folder ? await realpath(path.resolve(folder, file)).catch(() => undefined) : undefined;
    if (!folder || !resolved || !resolved.startsWith(`${folder}${path.sep}`)) throw new AssetSourceError(`${source.title} returned a file outside its data folder`, 502);
    if (!(await stat(resolved)).isFile()) throw new AssetSourceError(`${source.title} returned something that isn't a file`, 502);
    return resolved;
  }
}

/** A source's result, added to a project. */
export interface SourcedAsset {
  path: string;
  name: string;
  sourcedFrom: LibraryAssetSourcing;
}

/** A result to add, with the credit it showed when searched. */
export type SourceItemToAdd = Pick<LibrarySourceItem, "id" | "mediaType" | "author" | "license" | "url">;

/**
 * Who made it, its license and its page: each from `fetch` when it gives one,
 * else from the search result, so a source that names them only in its
 * results still keeps them with the asset.
 */
function credit(fetched: Partial<Static<typeof FetchResult>>, item: SourceItemToAdd): { author?: string; license?: string; url?: string } {
  const author = fetched.author ?? item.author;
  const license = fetched.license ?? item.license;
  const url = fetched.url ?? (item.url?.startsWith("https://") ? item.url : undefined);
  return { ...(author ? { author } : {}), ...(license ? { license } : {}), ...(url ? { url } : {}) };
}

function pickItem(item: Static<typeof SearchResults>["items"][number], embedHosts: string[]): LibrarySourceItem {
  const keys = ["id", "name", "mediaType", "thumbnail", "width", "height", "duration", "author", "license", "url", "preview"] as const;
  // Only a sound has something to listen to.
  const picked = Object.fromEntries(keys.flatMap((key) => item[key] === undefined || (key === "preview" && item.mediaType !== "audio") ? [] : [[key, item[key]]])) as unknown as LibrarySourceItem;
  const embed = item.embed === undefined ? undefined : embedOf(item.embed, embedHosts);
  return embed ? { ...picked, embed } : picked;
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
