import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryAssetOrigin, LibraryAssetPurpose } from "../shared/contracts.js";

const ASSET_METADATA_FILE = path.join(".data", "assets.json");

interface AssetMetadata {
  version: 1;
  prompts: Record<string, string>;
  previews: Record<string, string>;
  libraryAssets: Record<string, string>;
  origins: Record<string, LibraryAssetOrigin>;
  purposes: Record<string, LibraryAssetPurpose>;
}

export async function readAssetMetadata(workspacePath: string): Promise<AssetMetadata> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(workspacePath, ASSET_METADATA_FILE), "utf8"));
    return parseAssetMetadata(parsed) ?? emptyMetadata();
  } catch {
    return emptyMetadata();
  }
}

export async function writeAssetMetadata(
  workspacePath: string,
  assetPath: string,
  values: { prompt?: string; previewPath?: string; libraryAssetId?: string; origin?: LibraryAssetOrigin; purpose?: LibraryAssetPurpose },
): Promise<void> {
  const metadata = await readAssetMetadata(workspacePath);
  if (values.prompt) metadata.prompts[assetPath] = values.prompt;
  if (values.previewPath) metadata.previews[assetPath] = values.previewPath;
  if (values.libraryAssetId) metadata.libraryAssets[assetPath] = values.libraryAssetId;
  if (values.origin) metadata.origins[assetPath] = values.origin;
  if (values.purpose) metadata.purposes[assetPath] = values.purpose;
  await writeMetadata(workspacePath, metadata);
}

export async function renameAssetMetadata(workspacePath: string, from: string, to: string): Promise<void> {
  const metadata = await readAssetMetadata(workspacePath);
  let changed = false;
  const records: Record<string, string>[] = [metadata.prompts, metadata.previews, metadata.libraryAssets, metadata.origins, metadata.purposes];
  for (const entries of records) {
    for (const assetPath of Object.keys(entries)) {
      if (assetPath !== from && !assetPath.startsWith(`${from}/`)) continue;
      entries[`${to}${assetPath.slice(from.length)}`] = entries[assetPath];
      delete entries[assetPath];
      changed = true;
    }
  }
  if (!changed) return;
  await writeMetadata(workspacePath, metadata);
}

export async function deleteAssetMetadata(workspacePath: string, assetPath: string): Promise<string[]> {
  const metadata = await readAssetMetadata(workspacePath);
  const previews = Object.entries(metadata.previews).filter(([entry]) => entry === assetPath || entry.startsWith(`${assetPath}/`)).map(([, preview]) => preview);
  let changed = false;
  const records: Record<string, string>[] = [metadata.prompts, metadata.previews, metadata.libraryAssets, metadata.origins, metadata.purposes];
  for (const entries of records) {
    for (const entry of Object.keys(entries)) {
      if (entry !== assetPath && !entry.startsWith(`${assetPath}/`)) continue;
      delete entries[entry];
      changed = true;
    }
  }
  if (!changed) return [];
  await writeMetadata(workspacePath, metadata);
  return previews;
}

async function writeMetadata(workspacePath: string, metadata: AssetMetadata): Promise<void> {
  const destination = path.join(workspacePath, ASSET_METADATA_FILE);
  const directory = path.dirname(destination);
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Unsafe asset metadata path: ${directory}`);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function emptyMetadata(): AssetMetadata {
  return { version: 1, prompts: {}, previews: {}, libraryAssets: {}, origins: {}, purposes: {} };
}

function parseAssetMetadata(value: unknown): AssetMetadata | undefined {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return undefined;
  const prompts = (value as { prompts?: unknown }).prompts;
  const previews = (value as { previews?: unknown }).previews;
  const libraryAssets = (value as { libraryAssets?: unknown }).libraryAssets ?? {};
  const origins = (value as { origins?: unknown }).origins ?? {};
  const purposes = (value as { purposes?: unknown }).purposes ?? {};
  if (!validEntries(origins, ["generated", "uploaded", "workspace", "builtin", "unknown"]) || !validEntries(purposes, ["asset", "reference"])) return undefined;
  if (prompts === null || typeof prompts !== "object" || !Object.entries(prompts).every(([assetPath, prompt]) => (
    Boolean(assetPath) && typeof prompt === "string" && Boolean(prompt.trim())
  ))) return undefined;
  if (previews !== undefined && (previews === null || typeof previews !== "object" || !Object.entries(previews).every(([assetPath, previewPath]) => (
      Boolean(assetPath) && typeof previewPath === "string" && /^\.data\/asset-previews\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpg)$/.test(previewPath)
  )))) return undefined;
  if (libraryAssets === null || typeof libraryAssets !== "object" || !Object.entries(libraryAssets).every(([assetPath, assetId]) => (
    Boolean(assetPath) && typeof assetId === "string" && Boolean(assetId)
  ))) return undefined;
  return {
    version: 1,
    prompts: prompts as Record<string, string>,
    previews: (previews ?? {}) as Record<string, string>,
    libraryAssets: libraryAssets as Record<string, string>,
    origins: origins as Record<string, LibraryAssetOrigin>,
    purposes: purposes as Record<string, LibraryAssetPurpose>,
  };
}

function validEntries(value: unknown, allowed: string[]): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([entry, item]) => entry && typeof item === "string" && allowed.includes(item)));
}
