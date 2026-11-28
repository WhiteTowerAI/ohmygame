import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { CANVAS_ASSETS_SCHEMA, type CanvasAsset, type CanvasAssetManifest, type CanvasAssetCatalogEntry, type UnavailableCanvasAsset } from "../shared/canvas-assets.js";
import type { AudioAssetData } from "../shared/audio.js";
import type { ProjectManager } from "./projects.js";
import type { ProjectState } from "../shared/contracts.js";
import { getWorkspaceMedia } from "./workspace.js";
import { readAssetMetadata } from "./asset-metadata.js";
import type { ToolMediaFiles } from "./tools.js";
import { readMediaDimensions } from "./media-dimensions.js";
import { CanvasError, parseCanvasJson, readCanvasFile, writeCanvasJson } from "./canvas-files.js";

export async function readCanvasAssets(workspace: string): Promise<CanvasAssetManifest> {
  const text = await readCanvasFile(workspace, "assets.json");
  const manifest = text === undefined ? { version: 1 as const, assets: {} } : parseCanvasJson<CanvasAssetManifest>(text, "assets.json", CANVAS_ASSETS_SCHEMA);
  return { ...manifest, assets: Object.assign(Object.create(null), manifest.assets) };
}

/** A project's media file as a tool reads it, with what the canvas keeps of a 3D model, such as which way it faces. */
export function projectToolMedia(projects: Pick<ProjectManager, "get">): ToolMediaFiles {
  return async (projectId, filePath) => {
    const project = projects.get(projectId);
    if (!project) throw new Error("Project not found");
    const media = await getWorkspaceMedia(project.workspacePath, filePath);
    // A model the agent made outside a canvas keeps which way it faces in the project's asset records.
    const model3d = media.mediaType === "model"
      ? Object.values((await readCanvasAssets(project.workspacePath).catch(() => undefined))?.assets ?? {}).find((asset) => asset.path === media.relativePath)?.model3d
        ?? axisOnly((await readAssetMetadata(project.workspacePath)).axes[media.relativePath])
      : undefined;
    return { name: path.basename(media.relativePath), absolutePath: media.absolutePath, mediaType: media.mediaType, contentType: media.contentType, size: media.size, ...(model3d ? { model3d } : {}) };
  };
}

const axisOnly = (forwardAxis?: "+X" | "+Z") => forwardAxis ? { forwardAxis } : undefined;

/** Every asset a board names must be in the manifest; one an older board already named stays editable when its file is gone. */
export function requireCanvasAssets(manifest: CanvasAssetManifest, ids: readonly string[], existingIds: readonly string[] = []): void {
  for (const id of new Set(ids)) {
    if (!manifest.assets[id] && !existingIds.includes(id)) throw new CanvasError(`canvas/assets.json: asset ${id} is not registered`);
  }
}

/** Adds a media file to the project and to the canvas, returning its canvas id. */
export async function addCanvasAsset(
  project: ProjectState,
  projects: Pick<ProjectManager, "addMedia">,
  name: string,
  source: { file: string } | { bytes: Uint8Array },
  details: Omit<CanvasAsset, "name" | "path" | "libraryAssetId"> & { origin?: "generated" | "imported" } = {},
): Promise<{ id: string; asset: CanvasAsset }> {
  const { origin, ...described } = details;
  const file = await projects.addMedia(project.id, name, source, { origin, ...(described.prompt ? { prompt: described.prompt } : {}), ...(described.audio ? { audio: described.audio as AudioAssetData } : {}) });
  return registerCanvasAsset(project.workspacePath, { ...described, name: path.basename(file), path: file });
}

/** Names a file already in the project on the canvas; a file it names already keeps its id. */
export async function registerCanvasAsset(workspace: string, asset: CanvasAsset): Promise<{ id: string; asset: CanvasAsset }> {
  // The manifest takes names of up to 200 characters; a longer file name keeps its start and extension.
  const characters = [...asset.name];
  if (characters.length > 200) {
    const extension = [...path.extname(asset.name)].slice(0, 20).join("");
    asset = { ...asset, name: characters.slice(0, 200 - [...extension].length).join("") + extension };
  }
  const manifest = await readCanvasAssets(workspace);
  const existing = Object.entries(manifest.assets).find(([, candidate]) => candidate.path === asset.path);
  if (existing) return { id: existing[0], asset: existing[1] };
  const id = randomUUID();
  manifest.assets[id] = asset;
  await writeCanvasJson(workspace, "assets.json", manifest);
  return { id, asset };
}

export async function canvasAssetCatalog(workspace: string, manifest: CanvasAssetManifest, ids: readonly string[] = Object.keys(manifest.assets)): Promise<CanvasAssetCatalogEntry[]> {
  return Promise.all([...new Set(ids)].map(async (id) => {
    const asset = manifest.assets[id];
    if (!asset) throw new CanvasError(`canvas/assets.json: asset ${id} is not registered`);
    try {
      return await resolveCanvasAsset(workspace, id, asset);
    } catch (cause) { throw new CanvasError(`canvas/assets.json /assets/${id}/path: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }));
}

export async function inspectCanvasAssets(workspace: string, manifest: CanvasAssetManifest): Promise<{ assets: CanvasAssetCatalogEntry[]; unavailableAssets: UnavailableCanvasAsset[] }> {
  const results = await Promise.all(Object.entries(manifest.assets).map(async ([id, asset]) => {
    try { return { asset: await resolveCanvasAsset(workspace, id, asset) }; }
    catch (cause) {
      const status = (cause as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
      return { issue: { ...asset, id, status, message: cause instanceof Error ? cause.message : String(cause) } satisfies UnavailableCanvasAsset };
    }
  }));
  return { assets: results.flatMap((result) => result.asset ? [result.asset] : []), unavailableAssets: results.flatMap((result) => result.issue ? [result.issue] : []) };
}

async function resolveCanvasAsset(workspace: string, id: string, asset: CanvasAsset): Promise<CanvasAssetCatalogEntry> {
  const file = await getWorkspaceMedia(workspace, asset.path), info = await stat(file.absolutePath);
  const dimensions = file.mediaType === "image" || file.mediaType === "video" ? await readMediaDimensions(file.absolutePath) : undefined;
  return { ...asset, id, contentType: file.contentType, mediaType: file.mediaType, size: info.size, createdAt: info.mtime.toISOString(), ...dimensions };
}

/** The project file a canvas asset names, for a generation that reads it. */
export async function canvasAssetFile(workspace: string, id: string): Promise<CanvasAsset> {
  const asset = (await readCanvasAssets(workspace)).assets[id];
  if (!asset) throw new CanvasError(`canvas/assets.json: asset ${id} is not registered`);
  await getWorkspaceMedia(workspace, asset.path);
  return asset;
}
