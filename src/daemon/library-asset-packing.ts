import path from "node:path";
import { AssetLibraryError, type AssetLibrary } from "./asset-library.js";

const LIBRARY_ASSET_DIRECTORY = "assets/library";

export class MissingLibraryAssetError extends Error {
  constructor(readonly graphAssetId: string) {
    super(`Asset "${graphAssetId}" is missing from the Library.`);
  }
}

export interface PackedLibraryAsset {
  /** Workspace-relative path of the copy inside the archive. */
  path: string;
  absolutePath: string;
}

/**
 * Points each Library asset of an Interactive Story graph at a workspace copy
 * so the archive opens the same on another computer. The graph is changed in
 * place; `taken` holds the `exportPathKey` of every archive path and gains
 * the copies' keys.
 */
export async function packLibraryAssets(
  graph: unknown,
  taken: Set<string>,
  library: AssetLibrary,
): Promise<PackedLibraryAsset[]> {
  const copies = new Map<string, PackedLibraryAsset>();
  const assets = isRecord(graph) && isRecord(graph.assets) ? graph.assets : {};
  for (const [id, asset] of Object.entries(assets)) {
    if (!isRecord(asset) || !isRecord(asset.source)) continue;
    if (asset.source.kind !== "library") continue;
    const libraryId = asset.source.assetId;
    if (typeof libraryId !== "string") continue;
    let copy = copies.get(libraryId);
    if (!copy) {
      let content: Awaited<ReturnType<AssetLibrary["content"]>>;
      try {
        content = await library.content(libraryId);
      } catch (cause) {
        if (cause instanceof AssetLibraryError) {
          throw new MissingLibraryAssetError(id);
        }
        throw cause;
      }
      copy = {
        path: freePath(taken, content.asset.name),
        absolutePath: content.absolutePath,
      };
      taken.add(exportPathKey(copy.path));
      copies.set(libraryId, copy);
    }
    asset.source = { kind: "workspace", path: copy.path };
  }
  return [...copies.values()];
}

function freePath(taken: Set<string>, name: string): string {
  const extension = path.extname(name).toLowerCase();
  const stem =
    path
      .basename(name, path.extname(name))
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "asset";
  for (let index = 1; ; index += 1) {
    const candidate = `${LIBRARY_ASSET_DIRECTORY}/${stem}${index > 1 ? `-${index}` : ""}${extension}`;
    if (!taken.has(exportPathKey(candidate))) return candidate;
  }
}

/** Keys an archive path so that copies also extract on case-insensitive filesystems. */
export function exportPathKey(filePath: string): string {
  // Reserve canonical spellings and case variants such as σ/ς, s/ſ and ß/ẞ.
  // This key may merge extra names; the actual exported spelling stays intact.
  return filePath.normalize("NFD").toLowerCase().toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
