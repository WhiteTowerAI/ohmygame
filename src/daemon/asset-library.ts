import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssetPublicationState, LibraryAsset } from "../shared/contracts.js";
import { workspaceMediaInfo } from "./workspace.js";

interface StoredLibrary {
  version: 1;
  assets: LibraryAsset[];
  sources: Record<string, string>;
}

export class AssetLibraryError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export class AssetLibrary {
  readonly #filesDirectory: string;
  readonly #metadataFile: string;
  #state: StoredLibrary = emptyLibrary();
  #mutationChain = Promise.resolve();

  constructor(dataDirectory: string) {
    const directory = path.join(dataDirectory, "library");
    this.#filesDirectory = path.join(directory, "files");
    this.#metadataFile = path.join(directory, "assets.json");
  }

  async load(): Promise<void> {
    await mkdir(this.#filesDirectory, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#metadataFile, "utf8"));
      const stored = parseLibrary(parsed);
      if (!stored) throw new Error("Invalid Library metadata");
      this.#state = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): LibraryAsset[] {
    return [...this.#state.assets].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(id: string): LibraryAsset | undefined {
    return this.#state.assets.find((asset) => asset.id === id);
  }

  async add(
    fileName: string,
    contents: Uint8Array,
    options: { prompt?: string; sourceKey?: string; publication?: AssetPublicationState } = {},
  ): Promise<LibraryAsset> {
    return this.#mutate(async () => {
      const existing = this.#existing(options.sourceKey);
      if (existing) return existing;
      const media = workspaceMediaInfo(fileName);
      if (!media) throw new AssetLibraryError("File is not a supported media asset", 400);
      const id = randomUUID();
      const destination = this.#contentPath(id, fileName);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, { flag: "wx" });
        await rename(temporary, destination);
        return await this.#record(id, fileName, contents.byteLength, media, options);
      } catch (error) {
        await rm(destination, { force: true });
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async addFile(
    fileName: string,
    sourcePath: string,
    options: { prompt?: string; sourceKey?: string; publication?: AssetPublicationState } = {},
  ): Promise<LibraryAsset> {
    return this.#mutate(async () => {
      const existing = this.#existing(options.sourceKey);
      if (existing) return existing;
      const media = workspaceMediaInfo(fileName);
      if (!media) throw new AssetLibraryError("File is not a supported media asset", 400);
      const id = randomUUID();
      const destination = this.#contentPath(id, fileName);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await copyFile(sourcePath, temporary);
        await rename(temporary, destination);
        return await this.#record(id, fileName, (await stat(destination)).size, media, options);
      } catch (error) {
        await rm(destination, { force: true });
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async content(id: string): Promise<{ asset: LibraryAsset; absolutePath: string }> {
    const asset = this.get(id);
    if (!asset) throw new AssetLibraryError("Library asset not found", 404);
    const absolutePath = this.#contentPath(asset.id, asset.name);
    try {
      if (!(await lstat(absolutePath)).isFile()) throw new AssetLibraryError("Library asset content not found", 404);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AssetLibraryError("Library asset content not found", 404);
      throw error;
    }
    return { asset, absolutePath };
  }

  async rename(id: string, name: string): Promise<LibraryAsset> {
    return this.#mutate(async () => {
      const asset = this.get(id);
      if (!asset) throw new AssetLibraryError("Library asset not found", 404);
      const trimmed = name.trim();
      const extension = path.extname(asset.name);
      if (!trimmed || /[\\/]/.test(trimmed)) throw new AssetLibraryError("Invalid asset name", 400);
      const updated = { ...asset, name: `${trimmed}${extension}` };
      const state = { ...this.#state, assets: this.#state.assets.map((candidate) => candidate.id === id ? updated : candidate) };
      await this.#write(state);
      this.#state = state;
      return updated;
    });
  }

  async setPublication(id: string, publication: AssetPublicationState): Promise<LibraryAsset> {
    return this.#mutate(async () => {
      const asset = this.get(id);
      if (!asset) throw new AssetLibraryError("Library asset not found", 404);
      const updated = { ...asset, publication };
      const state = { ...this.#state, assets: this.#state.assets.map((candidate) => candidate.id === id ? updated : candidate) };
      await this.#write(state);
      this.#state = state;
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.#mutate(async () => {
      const asset = this.get(id);
      if (!asset) throw new AssetLibraryError("Library asset not found", 404);
      const sources = Object.fromEntries(Object.entries(this.#state.sources).filter(([, assetId]) => assetId !== id));
      const state = { ...this.#state, assets: this.#state.assets.filter((candidate) => candidate.id !== id), sources };
      await this.#write(state);
      this.#state = state;
      await rm(this.#contentPath(asset.id, asset.name), { force: true });
    });
  }

  #existing(sourceKey?: string): LibraryAsset | undefined {
    const id = sourceKey ? this.#state.sources[sourceKey] : undefined;
    return id ? this.get(id) : undefined;
  }

  async #record(
    id: string,
    fileName: string,
    size: number,
    media: { mediaType: LibraryAsset["mediaType"]; contentType: string },
    options: { prompt?: string; sourceKey?: string; publication?: AssetPublicationState },
  ): Promise<LibraryAsset> {
    const asset: LibraryAsset = {
      id,
      name: path.basename(fileName),
      size,
      ...media,
      createdAt: new Date().toISOString(),
      ...(options.prompt?.trim() ? { prompt: options.prompt.trim() } : {}),
      ...(options.publication ? { publication: options.publication } : {}),
    };
    const state = {
      ...this.#state,
      assets: [...this.#state.assets, asset],
      sources: options.sourceKey ? { ...this.#state.sources, [options.sourceKey]: id } : this.#state.sources,
    };
    await this.#write(state);
    this.#state = state;
    return asset;
  }

  #contentPath(id: string, fileName: string): string {
    return path.join(this.#filesDirectory, `${id}${path.extname(fileName).toLowerCase()}`);
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.#mutationChain.catch(() => undefined).then(operation);
    this.#mutationChain = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  async #write(state: StoredLibrary): Promise<void> {
    const temporary = `${this.#metadataFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
      await rename(temporary, this.#metadataFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function emptyLibrary(): StoredLibrary {
  return { version: 1, assets: [], sources: {} };
}

function parseLibrary(value: unknown): StoredLibrary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as Partial<StoredLibrary>;
  if (stored.version !== 1 || !Array.isArray(stored.assets) || !stored.sources || typeof stored.sources !== "object" || Array.isArray(stored.sources)) return undefined;
  const ids = new Set<string>();
  if (!stored.assets.every((asset) => isLibraryAsset(asset) && !ids.has(asset.id) && Boolean(ids.add(asset.id)))) return undefined;
  if (!Object.entries(stored.sources).every(([source, id]) => Boolean(source) && typeof id === "string" && ids.has(id))) return undefined;
  return stored as StoredLibrary;
}

function isLibraryAsset(value: unknown): value is LibraryAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<LibraryAsset>;
  return typeof asset.id === "string" && Boolean(asset.id) && typeof asset.name === "string" && Boolean(asset.name) &&
    typeof asset.size === "number" && asset.size >= 0 &&
    (asset.mediaType === "image" || asset.mediaType === "video" || asset.mediaType === "audio" || asset.mediaType === "model") &&
    typeof asset.contentType === "string" && typeof asset.createdAt === "string" && Number.isFinite(Date.parse(asset.createdAt)) &&
    (asset.prompt === undefined || typeof asset.prompt === "string") &&
    (asset.publication === undefined || isPublication(asset.publication));
}

function isPublication(value: unknown): value is AssetPublicationState {
  if (!value || typeof value !== "object") return false;
  const publication = value as Partial<AssetPublicationState>;
  return typeof publication.assetId === "string" && Boolean(publication.assetId) &&
    typeof publication.releaseId === "string" && Boolean(publication.releaseId) &&
    typeof publication.publishedAt === "string" && Number.isFinite(Date.parse(publication.publishedAt)) &&
    (publication.status === "listed" || publication.status === "unlisted");
}
