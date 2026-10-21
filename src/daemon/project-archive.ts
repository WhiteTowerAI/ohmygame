import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import type { ProjectCoverMode, ProjectState } from "../shared/contracts.js";
import {
  PROJECT_ARCHIVE_COVER,
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_MANIFEST,
  PROJECT_ARCHIVE_MAX_BYTES,
  PROJECT_ARCHIVE_MAX_ENTRIES,
  PROJECT_ARCHIVE_SETTING_KEYS,
  PROJECT_ARCHIVE_VERSION,
  PROJECT_ARCHIVE_WORKSPACE,
  projectArchiveSettings,
  type ProjectArchiveManifest,
  type ProjectArchiveSettings,
} from "../shared/project-archive.js";
import { defaultProjectName } from "../shared/project-names.js";
import { isProjectType } from "../shared/project-runtime.js";
import {
  extractArchive,
  type ArchiveExtractionFailure,
} from "./archive-extraction.js";
import type { AssetLibrary } from "./asset-library.js";
import { compressArchiveFile } from "./archive-compression.js";
import {
  exportPathKey,
  MissingLibraryAssetError,
  packLibraryAssets,
  type PackedLibraryAsset,
} from "./library-asset-packing.js";
import { sniffImageType } from "./image-format.js";
import { ensureNodeCodebaseContract } from "./playable-codebase.js";
import type { ProjectManager } from "./projects.js";

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
const SKIPPED_ON_IMPORT_AT_ROOT = new Set([
  ".ohmygame",
  ".ohmygame-install-pending",
  ".data/agent-attachments",
]);

const EXTRACTION_ERRORS: Record<ArchiveExtractionFailure, string> = {
  "invalid-zip": "The file is not a valid ZIP archive.",
  unreadable: "The project archive could not be read.",
  "too-large": "The project archive is too large.",
  "invalid-path": "The project archive contains an invalid path.",
  "symbolic-link": "The project archive contains a symbolic link.",
};

export interface ProjectArchiveLimits {
  maxBytes: number;
  maxEntries: number;
}

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
  return matchesPath(relativePath, EXCLUDED_AT_ROOT, true);
}

/**
 * Whether an import skips a workspace-relative path. Only version control,
 * dependencies and agent data are skipped: whatever else a hand-made archive
 * holds was put there on purpose.
 */
function skippedOnImport(relativePath: string): boolean {
  return matchesPath(relativePath, SKIPPED_ON_IMPORT_AT_ROOT, false);
}

function matchesPath(
  relativePath: string,
  atRoot: ReadonlySet<string>,
  environmentFiles: boolean,
): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  return segments.some((segment, index) => {
    // Many file systems ignore case, and there `.Git` is the same folder as `.git`.
    const name = segment.toLowerCase();
    return (
      EXCLUDED_ANYWHERE.has(name) ||
      (environmentFiles && name.startsWith(".env")) ||
      atRoot.has(segments.slice(0, index + 1).join("/"))
    );
  });
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

/**
 * Creates a new managed project from an uploaded archive. The upload and its
 * files are staged on disk, never held in memory. Unsafe paths and symbolic
 * links reject the archive. Nothing of a failed import remains.
 */
export async function importProjectArchive(
  projects: ProjectManager,
  upload: Buffer | AsyncIterable<Buffer | string>,
  options: {
    /** Names a project from an archive without a manifest, usually after its file. */
    name?: string;
    limits?: ProjectArchiveLimits;
  } = {},
): Promise<ProjectState> {
  const limits = options.limits ?? {
    maxBytes: PROJECT_ARCHIVE_MAX_BYTES,
    maxEntries: PROJECT_ARCHIVE_MAX_ENTRIES,
  };
  const staging = await projects.createImportStaging();
  let project: ProjectState;
  let cover: { contents: Buffer; mode: ProjectCoverMode } | undefined;
  try {
    const archivePath = path.join(staging, "upload.zip");
    await writeUpload(upload, archivePath, limits.maxBytes);
    const root = path.join(staging, "archive");
    await mkdir(root);
    await extractArchive(archivePath, root, {
      ...limits,
      include: (relative) => {
        if (relative === PROJECT_ARCHIVE_MANIFEST) return true;
        if (relative === PROJECT_ARCHIVE_COVER) return true;
        const [top, ...rest] = relative.split("/");
        if (top === PROJECT_ARCHIVE_WORKSPACE)
          return !skippedOnImport(rest.join("/"));
        // Kept for an archive without a manifest, whose root is the workspace.
        return !skippedOnImport(relative);
      },
      error: (reason) =>
        new ProjectArchiveError(
          EXTRACTION_ERRORS[reason],
          reason === "too-large" ? 413 : 400,
        ),
    });
    await rm(archivePath);
    const manifest =
      (await readManifest(root)) ??
      (await legacyStoryManifest(root, options.name));
    const workspace = manifest.legacy
      ? root
      : path.join(root, PROJECT_ARCHIVE_WORKSPACE);
    await mkdir(workspace, { recursive: true });
    if (manifest.cover) {
      const contents = await readFile(
        path.join(root, PROJECT_ARCHIVE_COVER),
      ).catch(() => undefined);
      // A missing or damaged cover is replaced by the next automatic capture.
      if (contents && sniffImageType(contents) === "image/webp") {
        cover = { contents, mode: manifest.cover.mode };
      }
    }
    project = await projects.import(workspace, manifest.project);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  try {
    // Agent instructions and schemas follow this app version, not the archive.
    if (project.type === "interactive-story") {
      await ensureNodeCodebaseContract(project.workspacePath);
    }
    if (cover) await projects.setCover(project.id, cover.contents, cover.mode);
    return await projects.refreshPreviewReadiness(project.id);
  } catch (error) {
    await projects.delete(project.id);
    throw error;
  }
}

/**
 * Earlier versions export only Interactive Stories, as their bare workspace
 * with graph.json at the root of the archive.
 */
async function legacyStoryManifest(
  root: string,
  name: string | undefined,
): Promise<ProjectArchiveManifest & { legacy: true }> {
  try {
    if (!(await stat(path.join(root, GRAPH_FILE))).isFile()) throw new Error();
  } catch {
    throw new ProjectArchiveError(
      "The file is not an OhMyGame project archive.",
    );
  }
  return {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    project: {
      name: name?.trim() || defaultProjectName("interactive-story"),
      type: "interactive-story",
    },
    legacy: true,
  };
}

async function readManifest(
  root: string,
): Promise<(ProjectArchiveManifest & { legacy?: false }) | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(root, PROJECT_ARCHIVE_MANIFEST), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProjectArchiveError("The project manifest is not valid JSON.");
  }
  if (!isRecord(value) || value.format !== PROJECT_ARCHIVE_FORMAT) {
    throw new ProjectArchiveError(
      "The file is not an OhMyGame project archive.",
    );
  }
  if (
    typeof value.version === "number" &&
    value.version > PROJECT_ARCHIVE_VERSION
  ) {
    throw new ProjectArchiveError(
      "This project was exported by a newer version of OhMyGame. Update OhMyGame to import it.",
    );
  }
  if (value.version !== PROJECT_ARCHIVE_VERSION || !isRecord(value.project)) {
    throw new ProjectArchiveError("The project manifest is invalid.");
  }
  const settings = value.project;
  if (!isProjectType(settings.type)) {
    throw new ProjectArchiveError("The project type is not supported.");
  }
  // Settings are checked like saved project settings when the project is created.
  const project = Object.fromEntries(
    PROJECT_ARCHIVE_SETTING_KEYS.filter(
      (key) => settings[key] !== undefined,
    ).map((key) => [key, settings[key]]),
  ) as unknown as ProjectArchiveSettings;
  const mode = isRecord(value.cover) ? value.cover.mode : undefined;
  return {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    project,
    ...(mode === "auto" || mode === "custom" ? { cover: { mode } } : {}),
  };
}

async function writeUpload(
  upload: Buffer | AsyncIterable<Buffer | string>,
  destination: string,
  maxBytes: number,
): Promise<void> {
  let size = 0;
  const limit = new Transform({
    transform(value: Buffer | string, _encoding, callback) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) {
        callback(
          new ProjectArchiveError("The project archive is too large.", 413),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.from(Buffer.isBuffer(upload) ? [upload] : upload),
    limit,
    createWriteStream(destination, { flags: "wx" }),
  );
  if (size === 0)
    throw new ProjectArchiveError("Choose a project archive to import.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
