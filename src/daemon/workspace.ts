import { isUtf8 } from "node:buffer";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFile, WorkspaceFileContent } from "../shared/contracts.js";
import { readAssetMetadata } from "./asset-metadata.js";

const IGNORED_DIRECTORIES = new Set([".data", ".git", ".ohmygame", "build", "dist", "node_modules", "out"]);
const MAX_FILE_BYTES = 256 * 1024;
const MEDIA_TYPES: Record<string, { mediaType: NonNullable<WorkspaceFile["mediaType"]>; contentType: string }> = {
  ".avif": { mediaType: "image", contentType: "image/avif" },
  ".gif": { mediaType: "image", contentType: "image/gif" },
  ".jpeg": { mediaType: "image", contentType: "image/jpeg" },
  ".jpg": { mediaType: "image", contentType: "image/jpeg" },
  ".png": { mediaType: "image", contentType: "image/png" },
  ".svg": { mediaType: "image", contentType: "image/svg+xml" },
  ".webp": { mediaType: "image", contentType: "image/webp" },
  ".m4a": { mediaType: "audio", contentType: "audio/mp4" },
  ".mp3": { mediaType: "audio", contentType: "audio/mpeg" },
  ".ogg": { mediaType: "audio", contentType: "audio/ogg" },
  ".wav": { mediaType: "audio", contentType: "audio/wav" },
  ".mp4": { mediaType: "video", contentType: "video/mp4" },
  ".mov": { mediaType: "video", contentType: "video/quicktime" },
  ".webm": { mediaType: "video", contentType: "video/webm" },
  ".glb": { mediaType: "model", contentType: "model/gltf-binary" },
};

export class WorkspaceError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export async function listWorkspaceFiles(workspacePath: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  await visit(workspacePath, "", files);
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
    const length = Math.min(fileStat.size, MAX_FILE_BYTES + 1);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    const content = bytes.subarray(0, bytesRead);
    const truncated = fileStat.size > MAX_FILE_BYTES;
    const visible = truncated ? withoutPartialCharacter(content.subarray(0, MAX_FILE_BYTES)) : content;
    const binary = visible.includes(0) || !isUtf8(visible);
    return {
      path: relativePath,
      size: fileStat.size,
      binary,
      ...(!binary ? { content: visible.toString("utf8") } : {}),
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

async function visit(root: string, relativeDirectory: string, files: WorkspaceFile[]): Promise<boolean> {
  const directory = path.join(root, ...relativeDirectory.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  let containsEntries = false;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (!(await visit(root, relativePath, files))) files.push({ path: relativePath, size: 0, directory: true });
      containsEntries = true;
      continue;
    }
    if (!entry.isFile()) continue;
    const media = workspaceMediaInfo(entry.name);
    files.push({
      path: relativePath,
      size: (await stat(path.join(directory, entry.name))).size,
      ...(media ? { mediaType: media.mediaType } : {}),
    });
    containsEntries = true;
  }
  return containsEntries;
}

export function workspaceMediaInfo(filePath: string): (typeof MEDIA_TYPES)[string] | undefined {
  return MEDIA_TYPES[path.extname(filePath).toLowerCase()];
}

export async function resolveWorkspaceEntry(workspacePath: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
  const normalized = requestedPath.replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === ".." || !part)) {
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

// Drops a UTF-8 character that the end of the buffer cuts short, so bounded text still decodes.
function withoutPartialCharacter(bytes: Buffer): Buffer {
  for (let index = bytes.length - 1; index >= Math.max(0, bytes.length - 3); index -= 1) {
    const byte = bytes[index];
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return index + length > bytes.length ? bytes.subarray(0, index) : bytes;
  }
  return bytes;
}
