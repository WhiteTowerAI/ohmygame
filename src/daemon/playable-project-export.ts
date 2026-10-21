import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { AssetLibrary } from "./asset-library.js";
import { compressArchiveFile } from "./archive-compression.js";
import { exportPathKey, MissingLibraryAssetError, packLibraryAssets, type PackedLibraryAsset } from "./library-asset-packing.js";

const GRAPH_FILE = "graph.json";

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

  // Exports must also extract safely on case-insensitive filesystems.
  let copies: PackedLibraryAsset[];
  try {
    copies = await packLibraryAssets(graph, new Set(files.map(exportPathKey)), library);
  } catch (cause) {
    if (cause instanceof MissingLibraryAssetError) throw new PlayableProjectExportError(cause.message);
    throw cause;
  }

  const zip = new ZipFile();
  const options = { mtime: new Date(1980, 0, 2), forceDosTimestamp: true } as const;
  for (const file of files) {
    if (file === GRAPH_FILE) continue;
    zip.addFile(path.join(workspacePath, ...file.split("/")), file, { ...options, compress: compressArchiveFile(file) });
  }
  zip.addBuffer(
    Buffer.from(copies.length ? `${JSON.stringify(graph, null, 2)}\n` : graphText, "utf8"),
    GRAPH_FILE,
    options,
  );
  for (const copy of copies) zip.addFile(copy.absolutePath, copy.path, { ...options, compress: compressArchiveFile(copy.path) });
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
