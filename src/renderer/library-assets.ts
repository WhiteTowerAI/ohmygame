import type { LibraryAsset as StoredLibraryAsset, LibraryAssetOrigin, LibraryAssetProject } from "../shared/contracts.js";
import type { BrowsableAsset, MediaFilter } from "./asset-browser.js";
import { getLibraryAsset, listLibraryAssets, waitForRuntime } from "./api.js";

export interface LibraryAsset extends StoredLibraryAsset, BrowsableAsset { assetId: string; path: string }

export interface LibraryAssetFilters {
  origin?: "all" | "saved" | LibraryAssetOrigin;
  projectId?: string;
  includeReferences?: boolean;
}

export function filterLibraryAssets(assets: readonly LibraryAsset[], media: MediaFilter, query: string, filters: LibraryAssetFilters = {}): LibraryAsset[] {
  const normalized = query.trim().toLowerCase();
  const origin = filters.origin ?? "saved";
  return assets.filter((asset) => (
    (media === "all" || asset.mediaType === media) &&
    (filters.includeReferences || !(asset.referenceOnly ?? asset.purpose === "reference")) &&
    (origin === "saved" ? (asset.saved ?? asset.origin !== "workspace") : origin === "all" || (asset.origin ?? "unknown") === origin) &&
    (!filters.projectId || (filters.projectId === "unassigned" ? !asset.projects?.length : asset.projects?.some((project) => project.id === filters.projectId))) &&
    (!normalized || `${asset.path} ${asset.prompt ?? ""} ${asset.projectName ?? ""} ${asset.projects?.map((project) => project.name).join(" ") ?? ""}`.toLowerCase().includes(normalized))
  ));
}

export function libraryAssetProjects(assets: readonly LibraryAsset[]): LibraryAssetProject[] {
  const projects = new Map<string, LibraryAssetProject>();
  for (const asset of assets) for (const project of asset.projects ?? []) projects.set(project.id, project);
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadLibraryAssets(): Promise<LibraryAsset[]> {
  await waitForRuntime();
  return (await listLibraryAssets()).map((asset) => ({ ...asset, assetId: asset.id, path: asset.name }));
}

/** Names a canvas download without renaming its shared Library asset or workspace file. */
export function canvasAssetDownloadName(title: string | undefined, originalName: string, contentType = ""): string {
  const extension = originalName.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? (DOWNLOAD_EXTENSIONS[contentType] ? `.${DOWNLOAD_EXTENSIONS[contentType]}` : "");
  const stem = (name: string) => {
    const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "").trim();
    return (extension && clean.toLowerCase().endsWith(extension.toLowerCase()) ? clean.slice(0, -extension.length) : clean).replace(/^[.\s]+|[.\s]+$/g, "");
  };
  let name = stem(title ?? "") || stem(originalName) || "asset";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  // Reserve space for the real extension and avoid splitting Unicode characters.
  const encoder = new TextEncoder();
  let truncated = "", length = encoder.encode(extension).length;
  for (const character of name) {
    length += encoder.encode(character).length;
    if (length > 200) break;
    truncated += character;
  }
  return `${truncated.replace(/[.\s]+$/g, "")}${extension}`;
}

/** Saves a Library asset under its name, adding the extension its content implies when a rename dropped it. */
export async function downloadLibraryAsset(assetId: string, name: string): Promise<void> {
  downloadAssetBlob(await getLibraryAsset(assetId), name);
}

export function downloadAssetBlob(blob: Blob, name: string): void {
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
