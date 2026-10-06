import type { LibraryAsset as StoredLibraryAsset } from "../shared/contracts.js";
import type { BrowsableAsset } from "./asset-browser.js";
import { getLibraryAsset, listLibraryAssets, waitForRuntime } from "./api.js";

export interface LibraryAsset extends StoredLibraryAsset, BrowsableAsset { assetId: string; path: string }

export async function loadLibraryAssets(): Promise<LibraryAsset[]> {
  await waitForRuntime();
  return (await listLibraryAssets()).map((asset) => ({ ...asset, assetId: asset.id, path: asset.name }));
}

/** Saves a Library asset under its name, adding the extension its content implies when a rename dropped it. */
export async function downloadLibraryAsset(assetId: string, name: string): Promise<void> {
  const blob = await getLibraryAsset(assetId);
  const extension = DOWNLOAD_EXTENSIONS[blob.type];
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = extension && !/\.[a-z0-9]+$/i.test(name) ? `${name}.${extension}` : name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "model/gltf-binary": "glb",
};
