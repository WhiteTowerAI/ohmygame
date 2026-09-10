import { isUtf8 } from "node:buffer";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFile, WorkspaceFileContent } from "../shared/contracts.js";
import { readAssetMetadata } from "./asset-metadata.js";

const IGNORED_DIRECTORIES = new Set([".data", ".git", "build", "dist", "node_modules", "out"]);
const MAX_FILE_BYTES = 256 * 1024;
const MEDIA_TYPES: Record<string, { mediaType: NonNullable<WorkspaceFile["mediaType"]>; contentType: string }> = {
  ".avif": { mediaType: "image", contentType: "image/avif" },
  ".gif": { mediaType: "image", contentType: "image/gif" },
  ".jpeg": { mediaType: "image", contentType: "image/jpeg" },
  ".jpg": { mediaType: "image", contentType: "image/jpeg" },
  ".png": { mediaType: "image", contentType: "image/png" },
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

export class WorkspaceError extends Error {}

export async function listWorkspaceFiles(workspacePath: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  await visit(workspacePath, "", files);
  const metadata = await readAssetMetadata(workspacePath);
  for (const file of files) {
    const prompt = metadata.prompts[file.path];
    if (prompt) file.prompt = prompt;
    const previewPath = metadata.previews[file.path];
    if (previewPath) file.previewPath = previewPath;
    const publication = metadata.publications[file.path];
    if (publication) file.publication = publication;
    const libraryAssetId = metadata.libraryAssets[file.path];
    if (libraryAssetId) file.libraryAssetId = libraryAssetId;
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readWorkspaceFile(workspacePath: string, requestedPath: string): Promise<WorkspaceFileContent> {
  const { absolutePath, relativePath } = await resolveFile(workspacePath, requestedPath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new WorkspaceError("Path is not a file");

  const handle = await open(absolutePath, "r");
  try {
    const length = Math.min(fileStat.size, MAX_FILE_BYTES + 1);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    const content = bytes.subarray(0, bytesRead);
    const truncated = fileStat.size > MAX_FILE_BYTES;
    const visible = truncated ? content.subarray(0, MAX_FILE_BYTES) : content;
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
  const { absolutePath, relativePath } = await resolveFile(workspacePath, requestedPath);
  if (!(await stat(absolutePath)).isFile()) throw new WorkspaceError("Path is not a file");
  return relativePath;
}

export async function getWorkspaceMedia(
  workspacePath: string,
  requestedPath: string,
): Promise<{ absolutePath: string; relativePath: string; contentType: string; mediaType: NonNullable<WorkspaceFile["mediaType"]>; size: number }> {
  const { absolutePath, relativePath } = await resolveFile(workspacePath, requestedPath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new WorkspaceError("Path is not a file");
  const media = workspaceMediaInfo(requestedPath);
  if (!media) throw new WorkspaceError("File is not a supported media asset");
  return { absolutePath, relativePath, contentType: media.contentType, mediaType: media.mediaType, size: fileStat.size };
}

async function visit(root: string, relativeDirectory: string, files: WorkspaceFile[]): Promise<void> {
  const directory = path.join(root, ...relativeDirectory.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(root, relativePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const media = workspaceMediaInfo(entry.name);
    files.push({
      path: relativePath,
      size: (await stat(path.join(directory, entry.name))).size,
      ...(media ? { mediaType: media.mediaType } : {}),
    });
  }
}

export function workspaceMediaInfo(filePath: string): (typeof MEDIA_TYPES)[string] | undefined {
  return MEDIA_TYPES[path.extname(filePath).toLowerCase()];
}

async function resolveFile(workspacePath: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceError("File not found");
    throw error;
  }
  if (target !== candidate) throw new WorkspaceError("Symbolic links cannot be opened");
  const relativePath = path.relative(root, target);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new WorkspaceError("Path leaves the workspace");
  }
  return { absolutePath: target, relativePath: relativePath.split(path.sep).join("/") };
}
