import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ASSET_METADATA_FILE = path.join(".data", "assets.json");

interface AssetMetadata {
  version: 1;
  prompts: Record<string, string>;
  previews: Record<string, string>;
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
  values: { prompt?: string; previewPath?: string },
): Promise<void> {
  const metadata = await readAssetMetadata(workspacePath);
  if (values.prompt) metadata.prompts[assetPath] = values.prompt;
  if (values.previewPath) metadata.previews[assetPath] = values.previewPath;
  await writeMetadata(workspacePath, metadata);
}

export async function renameAssetMetadata(workspacePath: string, from: string, to: string): Promise<void> {
  const metadata = await readAssetMetadata(workspacePath);
  if (!metadata.prompts[from] && !metadata.previews[from]) return;
  if (metadata.prompts[from]) metadata.prompts[to] = metadata.prompts[from];
  if (metadata.previews[from]) metadata.previews[to] = metadata.previews[from];
  delete metadata.prompts[from];
  delete metadata.previews[from];
  await writeMetadata(workspacePath, metadata);
}

export async function deleteAssetMetadata(workspacePath: string, assetPath: string): Promise<string | undefined> {
  const metadata = await readAssetMetadata(workspacePath);
  const previewPath = metadata.previews[assetPath];
  if (!metadata.prompts[assetPath] && !previewPath) return undefined;
  delete metadata.prompts[assetPath];
  delete metadata.previews[assetPath];
  await writeMetadata(workspacePath, metadata);
  return previewPath;
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
  return { version: 1, prompts: {}, previews: {} };
}

function parseAssetMetadata(value: unknown): AssetMetadata | undefined {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return undefined;
  const prompts = (value as { prompts?: unknown }).prompts;
  const previews = (value as { previews?: unknown }).previews;
  if (prompts === null || typeof prompts !== "object" || !Object.entries(prompts).every(([assetPath, prompt]) => (
    Boolean(assetPath) && typeof prompt === "string" && Boolean(prompt.trim())
  ))) return undefined;
  if (previews !== undefined && (previews === null || typeof previews !== "object" || !Object.entries(previews).every(([assetPath, previewPath]) => (
      Boolean(assetPath) && typeof previewPath === "string" && /^\.data\/asset-previews\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpg)$/.test(previewPath)
  )))) return undefined;
  return { version: 1, prompts: prompts as Record<string, string>, previews: (previews ?? {}) as Record<string, string> };
}
