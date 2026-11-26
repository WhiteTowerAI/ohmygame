// compat: since beta.5.12, remove from beta.7 and 2026-12-27. Before stories
// had a web runtime their graphs could refer directly to this computer's Library.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@ohmygame/game-sdk/protocol";
import { assetDigest, type AssetLibrary } from "./asset-library.js";
import { realFolders } from "./project-layout.js";

/** Commit the graph only after every referenced asset has a complete project copy. */
export async function localizeStoryAssets(folder: string, library?: AssetLibrary): Promise<void> {
  const file = path.join(folder, "graph.json");
  const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!entry) return;
  if (!entry.isFile()) throw new Error("graph.json is not a regular file");
  const original = await readFile(file, "utf8");
  const graph: unknown = JSON.parse(original);
  if (!isRecord(graph) || (graph.version !== undefined && graph.version !== 1) ||
      (graph.assets !== undefined && !isRecord(graph.assets))) throw new Error("Unrecognized graph.json");
  const copies = new Map<string, string>();
  for (const asset of Object.values(graph.assets ?? {})) {
    if (!isRecord(asset) || !isRecord(asset.source) || asset.source.kind !== "library") continue;
    const id = asset.source.assetId;
    if (!library || typeof id !== "string") throw new Error("Cannot resolve a Library reference");
    let relative = copies.get(id);
    if (!relative) {
      const { asset: stored, absolutePath } = await library.content(id);
      relative = await copyStoryAsset(folder, absolutePath, path.extname(stored.name));
      copies.set(id, relative);
    }
    const { assetId: _oldId, ...source } = asset.source;
    asset.source = { ...source, kind: "workspace", path: relative };
  }
  if (!copies.size) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, { flag: "wx" });
    if (await readFile(file, "utf8") !== original) throw new Error("graph.json changed during migration");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function copyStoryAsset(folder: string, source: string, extension: string): Promise<string> {
  const directory = "assets/library";
  if (!await realFolders(folder, directory)) throw new Error(`${directory} is not a project directory`);
  await mkdir(path.join(folder, directory), { recursive: true });
  const digest = await assetDigest(source);
  const ext = /^\.[a-z0-9]+$/i.test(extension) ? extension.toLowerCase() : "";
  // Reuse complete copies on retry. Even a pre-existing, edited file is never replaced.
  for (let i = 0; ; i++) {
    const relative = `${directory}/${digest}${i ? `-${i}` : ""}${ext}`;
    const destination = path.join(folder, relative);
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      return relative;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await lstat(destination)).isFile() && await assetDigest(destination) === digest) return relative;
    }
  }
}
