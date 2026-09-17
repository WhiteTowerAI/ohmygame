import type { LibraryAsset as StoredLibraryAsset } from "../shared/contracts.js";
import type { BrowsableAsset } from "./asset-browser.js";
import { listLibraryAssets, waitForRuntime } from "./api.js";

export interface LibraryAsset extends StoredLibraryAsset, BrowsableAsset { assetId: string; path: string }

export async function loadLibraryAssets(): Promise<LibraryAsset[]> {
  await waitForRuntime();
  return (await listLibraryAssets()).map((asset) => ({ ...asset, assetId: asset.id, path: asset.name }));
}
