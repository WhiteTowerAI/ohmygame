import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlayableThumbnailManifest } from "../shared/playable-editor.js";

/**
 * Node thumbnails are editor cache under `.ohmygame/thumbnails/`: one WebP
 * screenshot per Node, plus the hash of the compiled Node it shows. They are
 * never part of the graph, the layout, or a published project.
 */
const THUMBNAIL_DIRECTORY = ".ohmygame/thumbnails";
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HASH_PATTERN = /^[0-9a-f]{8,64}$/;

export class PlayableThumbnailError extends Error {
  override readonly name = "PlayableThumbnailError";
}

function isPlayableThumbnailHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

export async function listPlayableThumbnails(workspacePath: string): Promise<PlayableThumbnailManifest> {
  const directory = await thumbnailDirectory(workspacePath, false);
  if (!directory) return {};
  const manifest: PlayableThumbnailManifest = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const nodeId = entry.name.slice(0, -".json".length);
    if (!NODE_ID_PATTERN.test(nodeId)) continue;
    try {
      const value = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as unknown;
      if (isRecord(value) && isPlayableThumbnailHash(value.hash) && typeof value.capturedAt === "string") {
        manifest[nodeId] = { hash: value.hash, capturedAt: value.capturedAt };
      }
    } catch {
      // A broken cache entry is the same as a missing one.
    }
  }
  return manifest;
}

export async function readPlayableThumbnail(workspacePath: string, nodeId: string): Promise<Buffer | undefined> {
  assertNodeId(nodeId);
  const directory = await thumbnailDirectory(workspacePath, false);
  if (!directory) return undefined;
  try {
    return await readFile(path.join(directory, `${nodeId}.webp`));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

/**
 * Stores a Node's thumbnail and drops the ones of Nodes the graph no longer
 * has, so the cache never outlives the Nodes it describes.
 */
export async function writePlayableThumbnail(
  workspacePath: string,
  nodeId: string,
  hash: string,
  image: Buffer,
  nodeIds: ReadonlySet<string>,
): Promise<{ hash: string; capturedAt: string }> {
  assertNodeId(nodeId);
  if (!isPlayableThumbnailHash(hash)) throw new PlayableThumbnailError("Thumbnail hash is invalid");
  if (!nodeIds.has(nodeId)) throw new PlayableThumbnailError(`Node "${nodeId}" is not in graph.json`);
  const directory = (await thumbnailDirectory(workspacePath, true))!;
  const entry = { hash, capturedAt: new Date().toISOString() };
  await replaceFile(path.join(directory, `${nodeId}.webp`), image);
  await replaceFile(path.join(directory, `${nodeId}.json`), `${JSON.stringify(entry)}\n`);
  for (const file of await readdir(directory)) {
    const owner = file.replace(/\.(json|webp)$/, "");
    if (owner !== file && !nodeIds.has(owner)) await rm(path.join(directory, file), { force: true });
  }
  return entry;
}

/**
 * The Node IDs graph.json declares. Only the IDs matter here, so a graph with
 * other problems still keeps its thumbnails.
 */
export async function readGraphNodeIds(workspacePath: string): Promise<Set<string>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(workspacePath, "graph.json"), "utf8"));
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new PlayableThumbnailError("graph.json is not valid JSON.");
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new PlayableThumbnailError("This project has no graph.json.");
    throw cause;
  }
  const nodes = isRecord(value) && Array.isArray(value.nodes) ? value.nodes : [];
  return new Set(nodes.flatMap((node) => isRecord(node) && typeof node.id === "string" ? [node.id] : []));
}

/**
 * The real cache directory, or `undefined` when it does not exist yet. Each
 * level is checked before anything is created in it, so a linked `.ohmygame`
 * never leads a write outside the workspace.
 */
async function thumbnailDirectory(workspacePath: string, create: boolean): Promise<string | undefined> {
  let directory = await realpath(workspacePath);
  for (const segment of THUMBNAIL_DIRECTORY.split("/")) {
    directory = path.join(directory, segment);
    try {
      const stats = await lstat(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new PlayableThumbnailError("The thumbnail cache must be a directory inside the workspace");
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      if (!create) return undefined;
      // Two captures can create the cache at the same time.
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    }
  }
  return directory;
}

async function replaceFile(target: string, content: Buffer | string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function assertNodeId(nodeId: string): void {
  if (!NODE_ID_PATTERN.test(nodeId) || nodeId.length > 120) throw new PlayableThumbnailError("Node ID is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
