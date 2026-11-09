import { mapConcurrent } from "./map-concurrent.js";
import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFile, WorkspaceFileContent } from "../shared/contracts.js";
import { mediaFileInfo as workspaceMediaInfo } from "../shared/media-files.js";
import { PROJECT_DATA_DIRECTORY, PROJECT_PANELS_DIRECTORY } from "../shared/project-layout.js";
import { readAssetMetadata } from "./asset-metadata.js";

const IGNORED_DIRECTORIES = new Set([".git", PROJECT_DATA_DIRECTORY, "build", "dist", "node_modules", "out"]);
const MAX_FILE_BYTES = 256 * 1024;

export class WorkspaceError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

/** With a directory, list only its immediate children; omission retains the complete asset/search index. */
export async function listWorkspaceFiles(workspacePath: string, directory?: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  if (directory === undefined) await visit(workspacePath, "", files);
  else {
    const normalized = directory.replaceAll("\\", "/");
    if (excludedDirectory(normalized)) throw new WorkspaceError("Directory is excluded from the file browser");
    const absolute = await resolveWorkspaceDirectory(workspacePath, normalized);
    files.push(...await directoryEntries(absolute, normalized));
  }
  const metadata = await readAssetMetadata(workspacePath);
  for (const file of files) {
    if (file.directory) continue;
    const prompt = metadata.prompts[file.path];
    if (prompt) file.prompt = prompt;
    const previewPath = metadata.previews[file.path];
    if (previewPath) file.previewPath = previewPath;
    const libraryAssetId = metadata.libraryAssets[file.path];
    if (libraryAssetId) file.libraryAssetId = libraryAssetId;
    if (metadata.origins[file.path]) file.origin = metadata.origins[file.path];
    if (metadata.purposes[file.path]) file.purpose = metadata.purposes[file.path];
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readWorkspaceFile(workspacePath: string, requestedPath: string): Promise<WorkspaceFileContent> {
  const { absolutePath, relativePath } = await resolveWorkspaceEntry(workspacePath, requestedPath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new WorkspaceError("Path is not a file");

  const handle = await open(absolutePath, "r");
  try {
    const length = Math.min(fileStat.size, MAX_FILE_BYTES);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    const content = bytes.subarray(0, bytesRead);
    const truncated = fileStat.size > MAX_FILE_BYTES;
    let text: string | undefined;
    if (!content.includes(0)) {
      try {
        // Streaming leaves an incomplete final character pending; fatal decoding still rejects invalid bytes.
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content, { stream: truncated });
      } catch {
        // Invalid UTF-8 is presented as binary.
      }
    }
    const binary = text === undefined;
    return {
      path: relativePath,
      size: fileStat.size,
      binary,
      ...(!binary ? { content: text } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function validateWorkspaceFile(workspacePath: string, requestedPath: string): Promise<string> {
  const { relativePath } = await resolveWorkspaceFile(workspacePath, requestedPath);
  return relativePath;
}

export async function locateWorkspaceEntry(workspacePath: string, requestedPath: string): Promise<string> {
  if (requestedPath === ".") return resolveWorkspaceDirectory(workspacePath);
  const { absolutePath } = await resolveWorkspaceEntry(workspacePath, requestedPath);
  const entryStat = await stat(absolutePath);
  if (!entryStat.isFile() && !entryStat.isDirectory()) throw new WorkspaceError("Path is not a file or directory");
  return absolutePath;
}

export async function getWorkspaceMedia(
  workspacePath: string,
  requestedPath: string,
): Promise<{ absolutePath: string; relativePath: string; contentType: string; mediaType: NonNullable<WorkspaceFile["mediaType"]>; size: number }> {
  const { absolutePath, relativePath } = await resolveWorkspaceEntry(workspacePath, requestedPath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new WorkspaceError("Path is not a file");
  const media = workspaceMediaInfo(requestedPath);
  if (!media) throw new WorkspaceError("File is not a supported media asset");
  return { absolutePath, relativePath, contentType: media.contentType, mediaType: media.mediaType, size: fileStat.size };
}

/**
 * OhMyGame's own folder stays out of the file browser, all but the project's
 * panels: pages the agent writes, which the person may want to read first.
 * It shows at the root only once a panel folder is there.
 */
function excludedDirectory(relativeDirectory: string): boolean {
  if (relativeDirectory === PROJECT_DATA_DIRECTORY || relativeDirectory === PROJECT_PANELS_DIRECTORY) return false;
  const inside = relativeDirectory.startsWith(`${PROJECT_PANELS_DIRECTORY}/`);
  const parts = (inside ? relativeDirectory.slice(PROJECT_PANELS_DIRECTORY.length + 1) : relativeDirectory).split("/");
  return parts.some((part) => IGNORED_DIRECTORIES.has(part));
}

/** The entries of `directory`, at `relativeDirectory` in the workspace, that the file browser shows. */
async function shownEntries(directory: string, relativeDirectory: string): Promise<Dirent[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  // Within OhMyGame's folder, only the panels show.
  if (relativeDirectory === PROJECT_DATA_DIRECTORY) return entries.filter((entry) => entry.isDirectory() && `${relativeDirectory}/${entry.name}` === PROJECT_PANELS_DIRECTORY);
  const panels = !relativeDirectory && entries.some((entry) => entry.isDirectory() && entry.name === PROJECT_DATA_DIRECTORY)
    && await stat(path.join(directory, ...PROJECT_PANELS_DIRECTORY.split("/"))).then((found) => found.isDirectory(), () => false);
  return entries.filter((entry) => {
    if (entry.isFile()) return true;
    if (!entry.isDirectory()) return false;
    if (!relativeDirectory && entry.name === PROJECT_DATA_DIRECTORY) return panels;
    return !excludedDirectory(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
  });
}

async function visit(root: string, relativeDirectory: string, files: WorkspaceFile[]): Promise<boolean> {
  const directory = path.join(root, ...relativeDirectory.split("/").filter(Boolean));
  const entries = await shownEntries(directory, relativeDirectory);
  const regular = entries.filter((entry) => entry.isFile());
  const details = await mapConcurrent(regular, 8, async (entry) => {
    const media = workspaceMediaInfo(entry.name);
    const entryStat = await stat(path.join(directory, entry.name));
    return {
      path: relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      size: entryStat.size,
      ...(media ? { mediaType: media.mediaType, modifiedAt: entryStat.mtime.toISOString() } : {}),
    };
  });
  for (const detail of details) files.push(detail);
  const directories = entries.filter((entry) => entry.isDirectory());
  for (const entry of directories) {
    const child = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (!(await visit(root, child, files))) files.push({ path: child, size: 0, directory: true });
  }
  return regular.length + directories.length > 0;
}

async function directoryEntries(directory: string, relativeDirectory: string): Promise<WorkspaceFile[]> {
  const visible = await shownEntries(directory, relativeDirectory);
  return mapConcurrent(visible, 8, async (entry): Promise<WorkspaceFile> => {
    const entryPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return { path: entryPath, size: 0, directory: true };
    const media = workspaceMediaInfo(entry.name);
    return { path: entryPath, size: (await stat(path.join(directory, entry.name))).size, ...(media ? { mediaType: media.mediaType } : {}) };
  });
}

export { workspaceMediaInfo };

export async function resolveWorkspaceEntry(workspacePath: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
  const normalized = requestedPath.replaceAll("\\", "/");
  // A drive letter makes a Windows path absolute (C:/x) or relative to that drive's own folder (C:x).
  if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === ".." || !part)) {
    throw new WorkspaceError("Invalid workspace path");
  }
  const root = await realpath(workspacePath);
  const candidate = path.resolve(root, ...normalized.split("/"));
  let target: string;
  try {
    target = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceError("File not found", "ENOENT");
    throw error;
  }
  if (target !== candidate) throw new WorkspaceError("Symbolic links cannot be opened");
  const relativePath = path.relative(root, target);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new WorkspaceError("Path leaves the workspace");
  }
  return { absolutePath: target, relativePath: relativePath.split(path.sep).join("/") };
}

export async function resolveWorkspaceDirectory(workspacePath: string, requestedPath = ""): Promise<string> {
  const directory = requestedPath ? (await resolveWorkspaceEntry(workspacePath, requestedPath)).absolutePath : await realpath(workspacePath);
  if (!(await stat(directory)).isDirectory()) throw new WorkspaceError("Path is not a directory");
  return directory;
}

async function resolveWorkspaceFile(workspacePath: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
  const resolved = await resolveWorkspaceEntry(workspacePath, requestedPath);
  if (!(await stat(resolved.absolutePath)).isFile()) throw new WorkspaceError("Path is not a file");
  return resolved;
}
