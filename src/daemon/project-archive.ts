import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { ProjectCoverMode, ProjectState } from "../shared/contracts.js";
import {
  PROJECT_ARCHIVE_COVER,
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_MANIFEST,
  PROJECT_ARCHIVE_VERSION,
  PROJECT_ARCHIVE_WORKSPACE,
  projectArchiveSettings,
  type ProjectArchiveManifest,
} from "../shared/project-archive.js";
import type { AssetLibrary } from "./asset-library.js";
import { compressArchiveFile } from "./archive-compression.js";
import {
  exportPathKey,
  MissingLibraryAssetError,
  packLibraryAssets,
  type PackedLibraryAsset,
} from "./library-asset-packing.js";

const GRAPH_FILE = "graph.json";

// Dependencies and version control are left out wherever they are, as are
// environment files, which usually hold secrets. Build output, caches and
// OhMyGame's agent data are left out at the workspace root only, like in
// checkpoints. The rest of `.data/` is kept: asset metadata and previews must
// travel with the assets they describe.
const EXCLUDED_ANYWHERE = new Set(["node_modules", ".git"]);
const EXCLUDED_AT_ROOT = new Set([
  "dist",
  "build",
  "out",
  ".godot",
  ".ohmygame",
  ".ohmygame-install-pending",
  ".data/agent-attachments",
  "canvas/jobs.json",
]);

export class ProjectArchiveError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** Whether a workspace-relative path stays out of project archives. */
export function excludedFromProjectArchive(relativePath: string): boolean {
  if (EXCLUDED_AT_ROOT.has(relativePath)) return true;
  // Many file systems ignore case, and there `.Git` is the same folder as `.git`.
  const name = path.posix.basename(relativePath).toLowerCase();
  return EXCLUDED_ANYWHERE.has(name) || name.startsWith(".env");
}

/**
 * Streams a project as an archive that imports as a new project elsewhere.
 * Anything that can fail is checked before the stream is returned, so a
 * caller can still report it; a file that becomes unreadable while streaming
 * destroys the stream.
 */
export async function exportProjectArchive(
  project: ProjectState,
  options: {
    library?: AssetLibrary;
    cover?: { contents: Buffer; mode: ProjectCoverMode };
  } = {},
): Promise<Readable> {
  if (project.workspaceAvailable === false) {
    throw new ProjectArchiveError("The project folder is not available.", 409);
  }
  const files = await archiveFiles(project.workspacePath);
  const { graph, copies } = await packStoryGraph(
    project,
    files,
    options.library,
  );

  const manifest: ProjectArchiveManifest = {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    project: projectArchiveSettings(project),
    ...(options.cover ? { cover: { mode: options.cover.mode } } : {}),
  };
  const zip = new ZipFile();
  const entry = {
    mtime: new Date(1980, 0, 2),
    forceDosTimestamp: true,
  } as const;
  const workspaceEntry = (file: string) =>
    `${PROJECT_ARCHIVE_WORKSPACE}/${file}`;
  zip.addBuffer(
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    PROJECT_ARCHIVE_MANIFEST,
    entry,
  );
  if (options.cover) {
    zip.addBuffer(options.cover.contents, PROJECT_ARCHIVE_COVER, {
      ...entry,
      compress: false,
    });
  }
  for (const file of files) {
    if (graph !== undefined && file === GRAPH_FILE) {
      zip.addBuffer(Buffer.from(graph, "utf8"), workspaceEntry(file), entry);
      continue;
    }
    zip.addFile(
      path.join(project.workspacePath, ...file.split("/")),
      workspaceEntry(file),
      { ...entry, compress: compressArchiveFile(file) },
    );
  }
  for (const copy of copies) {
    zip.addFile(copy.absolutePath, workspaceEntry(copy.path), {
      ...entry,
      compress: compressArchiveFile(copy.path),
    });
  }
  const output = zip.outputStream as Readable;
  // yazl reports a file it cannot read on the ZipFile and then never ends the output.
  zip.on("error", (error: Error) => output.destroy(error));
  zip.end();
  return output;
}

/**
 * Copies an Interactive Story's Library assets into the archive, as the story
 * export does. Returns the rewritten graph.json when an asset was packed.
 */
async function packStoryGraph(
  project: ProjectState,
  files: string[],
  library: AssetLibrary | undefined,
): Promise<{ graph?: string; copies: PackedLibraryAsset[] }> {
  if (project.type !== "interactive-story" || !library) return { copies: [] };
  if (!files.includes(GRAPH_FILE)) return { copies: [] };
  let graph: unknown;
  try {
    graph = JSON.parse(
      await readFile(path.join(project.workspacePath, GRAPH_FILE), "utf8"),
    );
  } catch (cause) {
    // A damaged graph travels as it is, for the agent to repair after import.
    if (cause instanceof SyntaxError) return { copies: [] };
    throw cause;
  }
  let copies: PackedLibraryAsset[];
  try {
    copies = await packLibraryAssets(
      graph,
      new Set(files.map(exportPathKey)),
      library,
    );
  } catch (cause) {
    if (cause instanceof MissingLibraryAssetError) {
      throw new ProjectArchiveError(cause.message, 409);
    }
    throw cause;
  }
  if (!copies.length) return { copies };
  return { graph: `${JSON.stringify(graph, null, 2)}\n`, copies };
}

async function archiveFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || excludedFromProjectArchive(child)) continue;
    if (entry.isDirectory()) files.push(...(await archiveFiles(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}
