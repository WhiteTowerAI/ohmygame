import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryAsset, LibraryAssetOrigin, LibraryAssetPurpose } from "../shared/contracts.js";
import { workspaceMediaInfo } from "./workspace.js";

interface StoredLibrary {
  version: 1;
  assets: LibraryAsset[];
  sources: Record<string, string>;
}

interface AddAssetOptions {
  prompt?: string;
  sourceKey?: string;
  duration?: number;
  origin?: LibraryAssetOrigin;
  purpose?: LibraryAssetPurpose;
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
      if (JSON.stringify(stored) !== JSON.stringify(parsed)) await this.#write(stored);
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
    options: AddAssetOptions = {},
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
    options: AddAssetOptions = {},
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

  async save(id: string): Promise<LibraryAsset> {
    return this.#mutate(async () => {
      const asset = this.get(id);
      if (!asset) throw new AssetLibraryError("Library asset not found", 404);
      if (asset.purpose === "asset" && asset.saved) return asset;
      const updated = { ...asset, purpose: "asset" as const, saved: true };
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
    options: AddAssetOptions,
  ): Promise<LibraryAsset> {
    const origin = options.origin ?? originFromSource(options.sourceKey);
    const asset: LibraryAsset = {
      id,
      name: path.basename(fileName),
      size,
      ...media,
      createdAt: new Date().toISOString(),
      origin,
      purpose: options.purpose ?? "asset",
      saved: origin !== "workspace",
      ...(options.duration !== undefined ? { duration: options.duration } : {}),
      ...(options.prompt?.trim() ? { prompt: options.prompt.trim() } : {}),
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
  const sources = new Map<string, string[]>();
  for (const [source, id] of Object.entries(stored.sources)) {
    const keys = sources.get(id) ?? [];
    keys.push(source);
    sources.set(id, keys);
  }
  return {
    ...(stored as StoredLibrary),
    assets: stored.assets.map((asset) => {
      const keys = sources.get(asset.id) ?? [];
      const inferred = keys.map(originFromSource);
      const known = inferred.find((origin) => origin === "generated") ?? inferred.find((origin) => origin !== "unknown");
      // Legacy source-less records were created by the upload endpoints.
      const origin = asset.origin && asset.origin !== "unknown" ? asset.origin : known ?? asset.origin ?? (keys.length ? "unknown" : "uploaded");
      return {
        ...asset,
        origin,
        purpose: asset.purpose ?? (keys.some((key) => key.startsWith("conversation-image:")) ? "reference" : "asset"),
        saved: asset.saved ?? origin !== "workspace",
      };
    }),
  };
}

function originFromSource(source?: string): LibraryAssetOrigin {
  if (source?.startsWith("tool:")) return "generated";
  if (source?.startsWith("conversation-image:")) return "uploaded";
  if (source?.startsWith("builtin:")) return "builtin";
  if (source?.startsWith("project:") || source?.startsWith("canvas:")) return "workspace";
  return "unknown";
}

function isLibraryAsset(value: unknown): value is LibraryAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<LibraryAsset>;
  return typeof asset.id === "string" && Boolean(asset.id) && typeof asset.name === "string" && Boolean(asset.name) &&
    typeof asset.size === "number" && asset.size >= 0 &&
    (asset.mediaType === "image" || asset.mediaType === "video" || asset.mediaType === "audio" || asset.mediaType === "model") &&
    typeof asset.contentType === "string" && typeof asset.createdAt === "string" && Number.isFinite(Date.parse(asset.createdAt)) &&
    (asset.duration === undefined || typeof asset.duration === "number" && Number.isFinite(asset.duration) && asset.duration >= 0) &&
    (asset.prompt === undefined || typeof asset.prompt === "string") &&
    (asset.origin === undefined || ["generated", "uploaded", "workspace", "builtin", "unknown"].includes(asset.origin)) &&
    (asset.purpose === undefined || asset.purpose === "asset" || asset.purpose === "reference") &&
    (asset.saved === undefined || typeof asset.saved === "boolean");
}
