import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { AssetLibraryError, type AssetLibrary } from "./asset-library.js";

const GRAPH_FILE = "graph.json";
const LIBRARY_ASSET_DIRECTORY = "assets/library";

export class PlayableProjectExportError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

/**
 * Packs an Interactive Story's workspace as an editable project: its source
 * files, with each Library asset copied in and graph.json pointing at the copy,
 * so the project opens the same on another computer. Dependencies, version
 * control, and OhMyGame's own folders such as `.data/` stay behind.
 */
export async function exportPlayableProject(
  workspacePath: string,
  library: AssetLibrary,
): Promise<Buffer> {
  const files = await projectFiles(workspacePath);
  if (!files.includes(GRAPH_FILE)) throw new PlayableProjectExportError("This project has no graph.json.");
  const graphText = await readFile(path.join(workspacePath, GRAPH_FILE), "utf8");
  let graph: unknown;
  try {
    graph = JSON.parse(graphText);
  } catch {
    throw new PlayableProjectExportError("graph.json is not valid JSON.");
  }

  const taken = new Set(files);
  const copies = new Map<string, { path: string; absolutePath: string }>();
  for (const [id, asset] of Object.entries(isRecord(graph) && isRecord(graph.assets) ? graph.assets : {})) {
    if (!isRecord(asset) || !isRecord(asset.source) || asset.source.kind !== "library") continue;
    const libraryId = asset.source.assetId;
    if (typeof libraryId !== "string") continue;
    let copy = copies.get(libraryId);
    if (!copy) {
      let content: Awaited<ReturnType<AssetLibrary["content"]>>;
      try {
        content = await library.content(libraryId);
      } catch (cause) {
        if (cause instanceof AssetLibraryError) {
          throw new PlayableProjectExportError(`Asset "${id}" is missing from the Library.`);
        }
        throw cause;
      }
      copy = { path: freePath(taken, content.asset.name), absolutePath: content.absolutePath };
      taken.add(copy.path);
      copies.set(libraryId, copy);
    }
    asset.source = { kind: "workspace", path: copy.path };
  }

  const zip = new ZipFile();
  const options = { mtime: new Date(1980, 0, 2), forceDosTimestamp: true } as const;
  for (const file of files) {
    if (file === GRAPH_FILE) continue;
    zip.addFile(path.join(workspacePath, ...file.split("/")), file, options);
  }
  zip.addBuffer(
    Buffer.from(copies.size ? `${JSON.stringify(graph, null, 2)}\n` : graphText, "utf8"),
    GRAPH_FILE,
    options,
  );
  for (const copy of copies.values()) zip.addFile(copy.absolutePath, copy.path, options);
  return zipBuffer(zip);
}

async function projectFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(path.join(root, ...relative.split("/").filter(Boolean)), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await projectFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function freePath(taken: Set<string>, name: string): string {
  const extension = path.extname(name).toLowerCase();
  const stem = path.basename(name, path.extname(name)).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "asset";
  for (let index = 1; ; index += 1) {
    const candidate = `${LIBRARY_ASSET_DIRECTORY}/${stem}${index > 1 ? `-${index}` : ""}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function zipBuffer(zip: ZipFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const output = zip.outputStream as Readable;
  const completed = new Promise<Buffer>((resolve, reject) => {
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    output.once("error", reject);
    // yazl reports a file it cannot read on the ZipFile and then never ends the output.
    zip.on("error", reject);
    output.once("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  return completed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
