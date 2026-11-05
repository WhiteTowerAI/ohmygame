import { lstat, mkdir, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_ATTACHMENTS_DIRECTORY,
  ASSET_PREVIEWS_DIRECTORY,
  NODE_THUMBNAILS_DIRECTORY,
  PROJECT_DATA_DIRECTORY,
  PROJECT_DATA_GITIGNORE,
  PROJECT_LOCAL_DIRECTORY,
  STORY_RUNTIME_UPDATES_DIRECTORY,
} from "../shared/project-layout.js";
import { migrateLegacyAssetMetadata } from "./asset-metadata.js";

// compat: since beta.5.5, remove from beta.7 and 2026-12-06. Projects kept OhMyGame's files in `.data/`, and its
// caches straight in `.ohmygame/`.
const LEGACY_DATA_DIRECTORY = ".data";
const LEGACY_MOVES: ReadonlyArray<readonly [string, string]> = [
  [".data/asset-previews", ASSET_PREVIEWS_DIRECTORY],
  [".data/agent-attachments", AGENT_ATTACHMENTS_DIRECTORY],
  [".ohmygame/thumbnails", NODE_THUMBNAILS_DIRECTORY],
  [".ohmygame/story-runtime", STORY_RUNTIME_UPDATES_DIRECTORY],
];

/**
 * Puts OhMyGame's files in a project folder where this version keeps them, and
 * gives `.ohmygame/` the `.gitignore` that keeps this computer's files out of
 * the project's repository. A folder without OhMyGame's files is left as it
 * is. Nothing is overwritten, and nothing is followed through a symbolic link.
 * Safe to run on every load.
 */
export async function migrateProjectLayout(workspacePath: string): Promise<void> {
  const dataDirectory = path.join(workspacePath, PROJECT_DATA_DIRECTORY);
  const legacy = await exists(path.join(workspacePath, LEGACY_DATA_DIRECTORY))
    || await exists(path.join(dataDirectory, "thumbnails"))
    || await exists(path.join(dataDirectory, "story-runtime"));
  if (legacy) {
    if (!(await ensureRealDirectory(dataDirectory)) || !(await ensureRealDirectory(path.join(workspacePath, PROJECT_LOCAL_DIRECTORY)))) return;
    for (const [from, to] of LEGACY_MOVES) await moveDirectory(path.join(workspacePath, from), path.join(workspacePath, to));
    await migrateLegacyAssetMetadata(workspacePath);
    await rmdir(path.join(workspacePath, LEGACY_DATA_DIRECTORY)).catch(() => {});
  }
  const data = await lstat(dataDirectory).catch(() => undefined);
  if (!data?.isDirectory()) return;
  await writeFile(path.join(dataDirectory, ".gitignore"), PROJECT_DATA_GITIGNORE, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

/** Moves a folder, or, when the destination is there already, each entry it does not have yet. */
async function moveDirectory(from: string, to: string): Promise<void> {
  const source = await lstat(from).catch(() => undefined);
  if (!source?.isDirectory()) return;
  const destination = await lstat(to).catch(() => undefined);
  if (!destination) {
    await rename(from, to);
    return;
  }
  if (!destination.isDirectory()) return;
  for (const name of await readdir(from)) {
    if (await exists(path.join(to, name))) continue;
    await rename(path.join(from, name), path.join(to, name));
  }
  await rmdir(from).catch(() => {});
}

/** Whether `directory` is a folder of its own, made if it is missing; false for a symbolic link or a file. */
async function ensureRealDirectory(directory: string): Promise<boolean> {
  await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stats = await lstat(directory);
  return stats.isDirectory() && !stats.isSymbolicLink();
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(() => true, () => false);
}
