import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CANVAS_ASSETS_SCHEMA, type CanvasAssetManifest, type CanvasAssetCatalogEntry } from "../shared/canvas-assets.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";
import type { ProjectState } from "../shared/contracts.js";
import { getWorkspaceMedia } from "./workspace.js";
import { CanvasError, parseCanvasJson, readCanvasFile, writeCanvasJson } from "./canvas-files.js";

export async function readCanvasAssets(workspace: string): Promise<CanvasAssetManifest> {
  const text = await readCanvasFile(workspace, "assets.json");
  const manifest = text === undefined ? { version: 1 as const, assets: {} } : parseCanvasJson<CanvasAssetManifest>(text, "assets.json", CANVAS_ASSETS_SCHEMA);
  return { ...manifest, assets: Object.assign(Object.create(null), manifest.assets) };
}

export async function ensureCanvasAssets(project: ProjectState, projects: ProjectManager, library: AssetLibrary, ids: readonly string[]): Promise<CanvasAssetManifest> {
  const manifest = await readCanvasAssets(project.workspacePath);
  let changed = false;
  for (const id of new Set(ids)) {
    if (manifest.assets[id]) continue;
    const asset = library.get(id);
    if (!asset) throw new CanvasError(`canvas/assets.json: asset ${id} is not registered`);
    const file = await projects.materializeLibraryAsset(project.id, id);
    manifest.assets[id] = { name: asset.name, path: file.path, libraryAssetId: id, ...(asset.prompt ? { prompt: asset.prompt } : {}) };
    changed = true;
  }
  if (changed) await writeCanvasJson(project.workspacePath, "assets.json", manifest);
  return manifest;
}

export async function canvasAssetCatalog(workspace: string, manifest: CanvasAssetManifest): Promise<CanvasAssetCatalogEntry[]> {
  return Promise.all(Object.entries(manifest.assets).map(async ([id, asset]) => {
    try {
      const file = await getWorkspaceMedia(workspace, asset.path), info = await stat(file.absolutePath);
      return { ...asset, id, contentType: file.contentType, mediaType: file.mediaType, size: info.size, createdAt: info.mtime.toISOString() };
    } catch (cause) { throw new CanvasError(`canvas/assets.json /assets/${id}/path: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }));
}

export async function canvasLibraryAsset(project: ProjectState, library: AssetLibrary, id: string): Promise<string> {
  const asset = (await readCanvasAssets(project.workspacePath)).assets[id];
  if (!asset) throw new CanvasError(`canvas/assets.json: asset ${id} is not registered`);
  const file = await getWorkspaceMedia(project.workspacePath, asset.path);
  const digest = await fileDigest(file.absolutePath);
  if (asset.libraryAssetId && library.get(asset.libraryAssetId)) {
    const original = await library.content(asset.libraryAssetId);
    if (await fileDigest(original.absolutePath) === digest) return asset.libraryAssetId;
  }
  return (await library.addFile(path.basename(asset.path), file.absolutePath, { origin: "workspace", prompt: asset.prompt, sourceKey: `canvas:${project.id}:${file.contentType}:${digest}` })).id;
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
