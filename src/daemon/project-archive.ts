import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { MAX_PROJECT_COVER_BYTES } from "./project-covers.js";
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
  "duplicate-path": "The project archive contains the same path twice.",
};

export interface ProjectArchiveLimits {
  maxBytes: number;
  maxEntries: number;
}

const DEFAULT_LIMITS: ProjectArchiveLimits = {
  maxBytes: PROJECT_ARCHIVE_MAX_BYTES,
  maxEntries: PROJECT_ARCHIVE_MAX_ENTRIES,
};
const SIZE_CHECK_CONCURRENCY = 32;

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

interface ArchiveFile {
  path: string;
  /** A generated file's contents, or an existing file's absolute path. */
  source: Buffer | string;
}

interface PreparedArchiveFile extends ArchiveFile {
  size: number;
  mode?: number;
}

/** Builds an archive on disk before downloading, so both import size limits
 * are checked before returning a response. The temporary copy is removed
 * when the download ends or is cancelled. */
export async function exportProjectArchive(
  project: ProjectState,
  options: {
    library?: AssetLibrary;
    cover?: { contents: Buffer; mode: ProjectCoverMode };
    limits?: ProjectArchiveLimits;
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
  const workspaceEntry = (file: string) =>
    `${PROJECT_ARCHIVE_WORKSPACE}/${file}`;
  const entries: ArchiveFile[] = [
    {
      path: PROJECT_ARCHIVE_MANIFEST,
      source: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    },
  ];
  if (options.cover) {
    entries.push({
      path: PROJECT_ARCHIVE_COVER,
      source: options.cover.contents,
    });
  }
  for (const file of files) {
    entries.push({
      path: workspaceEntry(file),
      source:
        graph !== undefined && file === GRAPH_FILE
          ? Buffer.from(graph, "utf8")
          : path.join(project.workspacePath, ...file.split("/")),
    });
  }
  for (const copy of copies) {
    entries.push({
      path: workspaceEntry(copy.path),
      source: copy.absolutePath,
    });
  }
  const limits = options.limits ?? DEFAULT_LIMITS;
  const prepared = await prepareArchiveFiles(entries, limits);
  const staging = await mkdtemp(
    path.join(tmpdir(), "ohmygame-project-export-"),
  );
  try {
    const zip = new ZipFile();
    const output = zip.outputStream as Readable;
    // yazl reports unreadable files on the ZipFile instead of its output.
    zip.on("error", (error: Error) => output.destroy(error));
    const archivePath = path.join(staging, "project.zip");
    const written = pipeline(
      output,
      byteLimit(limits.maxBytes, exportTooLarge),
      createWriteStream(archivePath, { flags: "wx" }),
    );
    // Await the pipeline even if adding an entry fails synchronously.
    try {
      for (const file of prepared) {
        const { source } = file;
        const entry = {
          mtime: new Date(1980, 0, 2),
          forceDosTimestamp: true,
          compress: compressArchiveFile(file.path),
          mode: file.mode,
        };
        if (Buffer.isBuffer(source)) zip.addBuffer(source, file.path, entry);
        // Enforce the size inspected above if a file changes during export.
        else
          zip.addReadStreamLazy(
            file.path,
            { ...entry, size: file.size },
            (done) => {
              const input = createReadStream(source);
              input.once("error", (error: Error) => output.destroy(error));
              const cancel = () => input.destroy();
              output.once("close", cancel);
              input.once("close", () => output.off("close", cancel));
              done(null, input);
            },
          );
      }
      zip.end();
    } catch (cause) {
      output.destroy(cause as Error);
    }
    await written;
    const download = createReadStream(archivePath);
    download.once("close", () => {
      void rm(staging, { recursive: true, force: true }).catch(() => {});
    });
    return download;
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
}

/**
 * Copies an Interactive Story's Library assets into the archive.
 * Returns the rewritten graph.json when an asset was packed.
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

/**
 * Refuses an export that no import would accept, before anything is streamed.
 * Count generated contents, including the manifest and rewritten graph,
 * exactly as the importer counts extracted files.
 */
async function prepareArchiveFiles(
  files: ArchiveFile[],
  limits: ProjectArchiveLimits,
): Promise<PreparedArchiveFile[]> {
  if (files.length > limits.maxEntries) throw exportTooLarge();
  const prepared: PreparedArchiveFile[] = [];
  let bytes = 0;
  for (let index = 0; index < files.length; index += SIZE_CHECK_CONCURRENCY) {
    const batch = await Promise.all(
      files.slice(index, index + SIZE_CHECK_CONCURRENCY).map(async (file) => {
        if (Buffer.isBuffer(file.source))
          return { ...file, size: file.source.length };
        const stats = await stat(file.source);
        return { ...file, size: stats.size, mode: stats.mode };
      }),
    );
    for (const file of batch) {
      bytes += file.size;
      prepared.push(file);
    }
    if (bytes > limits.maxBytes) throw exportTooLarge();
  }
  return prepared;
}

function exportTooLarge(): ProjectArchiveError {
  return new ProjectArchiveError(
    "This project is too large to export: a project archive holds up to 200,000 files and 10 GB.",
    409,
  );
}

// Children are added to one list: spreading a large folder's files into
// push() would exceed the engine's argument limit.
async function archiveFiles(
  root: string,
  relative = "",
  files: string[] = [],
): Promise<string[]> {
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || excludedFromProjectArchive(child)) continue;
    if (entry.isDirectory()) await archiveFiles(root, child, files);
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
  const limits = options.limits ?? DEFAULT_LIMITS;
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
      // A missing, oversized or damaged cover is replaced by the next automatic capture.
      const coverPath = path.join(root, PROJECT_ARCHIVE_COVER);
      const size = await stat(coverPath).then(
        (stats) => (stats.isFile() ? stats.size : Infinity),
        () => Infinity,
      );
      const contents =
        size <= MAX_PROJECT_COVER_BYTES ? await readFile(coverPath) : undefined;
      if (contents && sniffImageType(contents) === "image/webp") {
        cover = { contents, mode: manifest.cover.mode };
      }
    }
    project = await projects.import(workspace, manifest.project);
  } finally {
    // The project may already exist, so a failed cleanup must not fail the
    // import; the next start removes what is left of the staging folder.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
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
  await pipeline(
    Readable.from(Buffer.isBuffer(upload) ? [upload] : upload),
    byteLimit(
      maxBytes,
      () => new ProjectArchiveError("The project archive is too large.", 413),
      () => new ProjectArchiveError("Choose a project archive to import."),
    ),
    createWriteStream(destination, { flags: "wx" }),
  );
}

/** Counts actual bytes without buffering the stream. */
function byteLimit(
  maxBytes: number,
  error: () => Error,
  emptyError?: () => Error,
): Transform {
  let size = 0;
  return new Transform({
    transform(value: Buffer | string, _encoding, callback) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) {
        callback(error());
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      callback(size === 0 ? emptyError?.() : undefined);
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
