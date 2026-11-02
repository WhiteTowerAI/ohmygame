import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { mediaFileInfo } from "../shared/media-files.js";
import { PROJECT_FILE_NAME } from "../shared/project-file.js";
import { workspaceEntryName } from "./projects.js";
import { resolveWorkspaceDirectory, resolveWorkspaceEntry, WorkspaceError } from "./workspace.js";

// What a plugin's page may do with its project's files, given `project.files`.
// A page is sandboxed and runs no code of its own outside it, so these rules
// also keep the capability from becoming more than it says: hidden files hold
// secrets and tools' settings, some of which run commands, and the project
// file names which plugins the project uses. Native code isn't bound by this.

/** The most a page may write at once; the daemon holds it in memory. */
export const PLUGIN_FILE_MAX_BYTES = 200 * 1024 * 1024;
/** How many entries a listing returns before it says it stopped short. */
const LIST_MAX_ENTRIES = 10_000;
/** A recursive listing doesn't go into what tools generate; a listing of one of these still shows it. */
const GENERATED_DIRECTORIES = new Set(["build", "dist", "node_modules", "out"]);
/** What tells an agent how to work; a page changing it would be telling the agent what to do. */
const AGENT_INSTRUCTIONS = new Set(["agents.md", "claude.md", "gemini.md"]);

export class PluginFileError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface PluginFileEntry {
  /** Relative to the project, with forward slashes. */
  path: string;
  kind: "file" | "folder";
  /** A file's size in bytes. */
  size?: number;
  /** When it last changed, as an ISO date. */
  modified: string;
  /** A media file's type, such as `image/png`. */
  mediaType?: string;
}

/** Splits a path a page gave, refusing what no page may reach. */
function readablePath(value: string): string {
  const parts = value.replaceAll("\\", "/").split("/");
  for (const part of parts) {
    // Windows drops a name's trailing spaces, so "AGENTS.md " is AGENTS.md there.
    if (workspaceEntryName(part) !== part) throw new PluginFileError("Invalid file or folder name");
    if (part.startsWith(".")) throw new PluginFileError("Pages can't use hidden files and folders", 403);
    // A Windows short name such as CLAUDE~1 can be another name for a hidden or protected entry.
    if (/~\d/.test(part)) throw new PluginFileError("Pages can't use short file names", 403);
  }
  return parts.join("/");
}

/** The same for a path a page wants to change. */
function writablePath(value: string): string {
  const normalized = readablePath(value);
  const parts = normalized.split("/");
  // Many file systems ignore case, and there Canvas is the canvas folder.
  if (parts[0]!.toLowerCase() === "canvas") throw new PluginFileError("Manage Canvas documents and boards in Design", 403);
  if (normalized.toLowerCase() === PROJECT_FILE_NAME.toLowerCase())
    throw new PluginFileError("Pages can't change the project file", 403);
  if (AGENT_INSTRUCTIONS.has(parts.at(-1)!.toLowerCase()))
    throw new PluginFileError("Pages can't change an agent's instructions", 403);
  return normalized;
}

const exists = (target: string) =>
  lstat(target).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return false;
      throw cause;
    },
  );

/** Makes `relative`'s folders one at a time, so a link in the way is refused rather than followed. */
async function ensureFolder(workspacePath: string, relative: string): Promise<void> {
  let current = "";
  for (const part of relative.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    try {
      await resolveWorkspaceDirectory(workspacePath, current);
    } catch (cause) {
      if (!(cause instanceof WorkspaceError) || cause.code !== "ENOENT") throw cause;
      const { absolutePath } = await parentOf(workspacePath, current);
      await mkdir(absolutePath);
    }
  }
}

/** Where a new entry at `relative` goes, in a folder known to be inside the workspace. */
async function parentOf(workspacePath: string, relative: string): Promise<{ absolutePath: string }> {
  const parent = path.posix.dirname(relative);
  const directory = await resolveWorkspaceDirectory(workspacePath, parent === "." ? "" : parent);
  return { absolutePath: path.join(directory, path.posix.basename(relative)) };
}

export async function listPluginFiles(
  workspacePath: string,
  { folder = "", recursive = false }: { folder?: string; recursive?: boolean } = {},
): Promise<{ entries: PluginFileEntry[]; truncated: boolean }> {
  const start = folder ? readablePath(folder) : "";
  const root = await resolveWorkspaceDirectory(workspacePath, start);
  const entries: PluginFileEntry[] = [];
  let truncated = false;
  const visit = async (directory: string, prefix: string) => {
    const found = await readdir(directory, { withFileTypes: true });
    found.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of found) {
      if (item.name.startsWith(".") || item.isSymbolicLink() || !(item.isFile() || item.isDirectory())) continue;
      if (entries.length >= LIST_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const absolute = path.join(directory, item.name);
      const stats = await stat(absolute).catch(() => undefined);
      if (!stats) continue; // It went away while listing.
      const mediaType = item.isFile() ? mediaFileInfo(item.name)?.contentType : undefined;
      entries.push({
        path: relative,
        kind: item.isFile() ? "file" : "folder",
        ...(item.isFile() ? { size: stats.size } : {}),
        modified: stats.mtime.toISOString(),
        ...(mediaType ? { mediaType } : {}),
      });
      if (recursive && item.isDirectory() && !GENERATED_DIRECTORIES.has(item.name)) await visit(absolute, relative);
    }
  };
  await visit(root, start);
  return { entries, truncated };
}

/** A file to send to a page, with the type a blob of it needs to show as an image or play. */
export async function openPluginFile(workspacePath: string, requested: string) {
  const { absolutePath } = await resolveWorkspaceEntry(workspacePath, readablePath(requested));
  const stats = await stat(absolutePath);
  if (!stats.isFile()) throw new PluginFileError("Path is not a file");
  return {
    size: stats.size,
    contentType: mediaFileInfo(absolutePath)?.contentType ?? "application/octet-stream",
    stream: () => createReadStream(absolutePath),
  };
}

export async function writePluginFile(workspacePath: string, requested: string, contents: Buffer): Promise<string> {
  const relative = writablePath(requested);
  const parent = path.posix.dirname(relative);
  if (parent !== ".") await ensureFolder(workspacePath, parent);
  const { absolutePath } = await parentOf(workspacePath, relative);
  if (await exists(absolutePath)) {
    // The check refuses a link; writing would otherwise replace it, and a folder can't be replaced by a file.
    const { absolutePath: existing } = await resolveWorkspaceEntry(workspacePath, relative);
    if (!(await stat(existing)).isFile()) throw new PluginFileError("Path is not a file");
  }
  // Written beside it and moved into place, so the file is the old one or the new one, never half of either.
  const temporary = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, absolutePath);
  } finally {
    await rm(temporary, { force: true });
  }
  return relative;
}

export async function createPluginFolder(workspacePath: string, requested: string): Promise<string> {
  const relative = writablePath(requested);
  await ensureFolder(workspacePath, relative);
  return relative;
}

export async function movePluginFile(workspacePath: string, from: string, to: string): Promise<string> {
  const source = writablePath(from);
  const target = writablePath(to);
  if (target === source || target.startsWith(`${source}/`)) throw new PluginFileError("A folder can't move into itself");
  const { absolutePath: origin } = await resolveWorkspaceEntry(workspacePath, source);
  const parent = path.posix.dirname(target);
  if (parent !== ".") await ensureFolder(workspacePath, parent);
  const { absolutePath: destination } = await parentOf(workspacePath, target);
  if (await exists(destination)) throw new PluginFileError(`${target} already exists`, 409);
  await rename(origin, destination);
  return target;
}

export async function deletePluginFile(workspacePath: string, requested: string): Promise<void> {
  const { absolutePath } = await resolveWorkspaceEntry(workspacePath, writablePath(requested));
  await rm(absolutePath, { recursive: true });
}
