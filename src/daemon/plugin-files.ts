import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { access, chmod, link, lstat, mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { mediaFileInfo } from "../shared/media-files.js";
import { PROJECT_FILE_NAME } from "../shared/project-file.js";
import { checkpointCoverage } from "./checkpoints.js";
import { workspaceEntryName } from "./projects.js";
import { resolveWorkspaceDirectory, resolveWorkspaceEntry, WorkspaceError } from "./workspace.js";

// What a plugin's page may do with its project's files, given `project.files`.
// A page is sandboxed and runs no code of its own outside it, so these rules
// also keep the capability from becoming more than it says: hidden files hold
// secrets and tools' settings, some of which run commands, and the project
// file names which plugins the project uses. Native code isn't bound by this.
//
// Each change is one the person can undo, so a page changes only what the
// project's snapshots keep, and a folder it moves or deletes holds nothing
// else. The checks guard against the page; the daemon's own writers wait for
// a page's change, and another program on the computer has the person's
// access to these files already.

/** The most a page may write at once; the daemon holds it in memory. */
export const PLUGIN_FILE_MAX_BYTES = 200 * 1024 * 1024;
/** How many entries a listing returns before it says it stopped short. */
const LIST_MAX_ENTRIES = 10_000;
/** A recursive listing doesn't go into what tools generate; a listing of one of these still shows it. */
const GENERATED_DIRECTORIES = new Set(["build", "dist", "node_modules", "out"]);
/** Names a moved or deleted folder may hold although they are hidden: no secret or setting, and kept or meant to be lost. */
const HARMLESS_HIDDEN = new Set([".ds_store", ".gitignore", ".gitkeep", ".keep"]);
/** What tells an agent how to work; a page changing it would be telling the agent what to do. */
// Agents also read variants of them, such as Codex's AGENTS.override.md and Claude Code's CLAUDE.local.md.
const isAgentInstructions = (name: string) => /^(?:agents|claude|gemini)(?:\.[^.]+)*\.md$/i.test(name);

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
  if (isAgentInstructions(parts.at(-1)!))
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
  const relative = readablePath(requested);
  const { absolutePath } = await resolveWorkspaceEntry(workspacePath, relative);
  // A pipe would wait for a writer, and hold the workspace while it waits.
  if (!(await stat(absolutePath)).isFile()) throw new PluginFileError("Path is not a file");
  // What is read is what was checked: the file opened is the one the path names now, no link on the way.
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new PluginFileError("Path is not a file");
    // Another name of the same file may be hidden, or outside the project.
    if (opened.nlink > 1) throw new PluginFileError("Pages can't read a file that has other names", 403);
    const now = await stat((await resolveWorkspaceEntry(workspacePath, relative)).absolutePath);
    if (now.ino !== opened.ino || now.dev !== opened.dev) throw new PluginFileError("The file changed while it was opened", 409);
    return {
      size: opened.size,
      contentType: mediaFileInfo(absolutePath)?.contentType ?? "application/octet-stream",
      stream: () => handle.createReadStream(),
    };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

const NOT_KEPT = "Undo can't bring this back, as the project's snapshots leave it out (a .gitignore, node_modules or build output), so a page can't change it";

/** Refuses an entry Undo couldn't bring back as it is: a link, a pipe or the like, a file with other names, or one that can't be read. */
async function assertKept(absolute: string, shown: string, stats: Stats): Promise<void> {
  if (stats.isSymbolicLink() || !(stats.isFile() || stats.isDirectory())) throw new PluginFileError(`${shown} is a link or not a plain file, so a page can't change it`, 403);
  // Undo would bring back another name's contents as a file of its own, which the page could then read.
  if (stats.isFile() && stats.nlink > 1) throw new PluginFileError(`${shown} has other names, so a page can't change it`, 403);
  // A snapshot leaves out what it can't read, so Undo couldn't bring it back.
  try {
    await access(absolute, constants.R_OK);
  } catch {
    throw new PluginFileError(`${shown} can't be read, so Undo couldn't bring it back`, 403);
  }
}

/**
 * Refuses a change to `relative`, or to anything in it when it is a folder,
 * that Undo couldn't take back or that touches what a page may not. Says what
 * is there: nothing, or its details and, for a folder, the paths inside it.
 */
async function assertChangeable(workspacePath: string, relative: string, covers: ReturnType<typeof checkpointCoverage>): Promise<{ stats: Stats; inside: string[] } | undefined> {
  let absolutePath: string;
  try {
    ({ absolutePath } = await resolveWorkspaceEntry(workspacePath, relative));
  } catch (cause) {
    if (cause instanceof WorkspaceError && cause.code === "ENOENT") {
      if (!(await covers(relative, false))) throw new PluginFileError(NOT_KEPT, 403);
      return undefined;
    }
    throw cause;
  }
  const stats = await lstat(absolutePath);
  await assertKept(absolutePath, relative, stats);
  if (!(await covers(relative, stats.isDirectory()))) throw new PluginFileError(NOT_KEPT, 403);
  if (!stats.isDirectory()) return { stats, inside: [] };
  const inside: string[] = [];
  const visit = async (absolute: string, prefix: string) => {
    for (const item of await readdir(absolute, { withFileTypes: true })) {
      if (inside.length >= LIST_MAX_ENTRIES) throw new PluginFileError("This folder holds too much to change from a page", 413);
      const child = prefix ? `${prefix}/${item.name}` : item.name;
      const shown = `${relative}/${child}`;
      const name = item.name.toLowerCase();
      if (item.name.startsWith(".") && !HARMLESS_HIDDEN.has(name)) throw new PluginFileError(`${relative} holds hidden files, so a page can't change it`, 403);
      if (isAgentInstructions(name)) throw new PluginFileError(`${relative} holds an agent's instructions, so a page can't change it`, 403);
      const entry = path.join(absolute, item.name);
      const details = await lstat(entry);
      // Junk the system leaves needn't come back.
      if (name !== ".ds_store") {
        await assertKept(entry, shown, details);
        if (!(await covers(shown, details.isDirectory()))) throw new PluginFileError(`${shown}: ${NOT_KEPT}`, 403);
      } else if (!details.isFile()) throw new PluginFileError(`${shown} is a link or not a plain file, so a page can't change this folder`, 403);
      inside.push(child);
      if (details.isDirectory()) await visit(entry, child);
    }
  };
  await visit(absolutePath, "");
  return { stats, inside };
}

export async function writePluginFile(workspacePath: string, requested: string, contents: Buffer): Promise<string> {
  const relative = writablePath(requested);
  // A link is refused; writing would otherwise replace it, and a folder can't be replaced by a file.
  const existing = await assertChangeable(workspacePath, relative, checkpointCoverage(workspacePath));
  if (existing?.stats.isDirectory()) throw new PluginFileError("Path is not a file");
  const parent = path.posix.dirname(relative);
  if (parent !== ".") await ensureFolder(workspacePath, parent);
  const { absolutePath } = await parentOf(workspacePath, relative);
  // A script stays runnable, and a private file private.
  const mode = existing ? existing.stats.mode & 0o7777 : undefined;
  // Written beside it and moved into place, so the file is the old one or the new one, never half of either.
  // The name is short, so that a file whose own name is near the limit still has one.
  const temporary = path.join(path.dirname(absolutePath), `.omg-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, absolutePath);
  } finally {
    await rm(temporary, { force: true });
  }
  return relative;
}

export async function createPluginFolder(workspacePath: string, requested: string): Promise<string> {
  const relative = writablePath(requested);
  // A folder that is there already doesn't change, so only the new one needs to be kept.
  if (!(await checkpointCoverage(workspacePath)(relative, true))) throw new PluginFileError(NOT_KEPT, 403);
  await ensureFolder(workspacePath, relative);
  return relative;
}

/** Codes for a file system without hard links, where a move checks first instead. */
const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EMLINK"]);

export async function movePluginFile(workspacePath: string, from: string, to: string): Promise<string> {
  const source = writablePath(from);
  const target = writablePath(to);
  if (target === source || target.startsWith(`${source}/`)) throw new PluginFileError("A folder can't move into itself");
  const { absolutePath: origin } = await resolveWorkspaceEntry(workspacePath, source);
  const covers = checkpointCoverage(workspacePath);
  const found = await assertChangeable(workspacePath, source, covers);
  if (!found) throw new WorkspaceError("File not found", "ENOENT");
  const folder = found.stats.isDirectory();
  const { inside } = found;
  // Where it goes must be kept too, everything in it included.
  if (!(await covers(target, folder))) throw new PluginFileError(`${target}: ${NOT_KEPT}`, 403);
  for (const child of inside) if (!(await covers(`${target}/${child}`, false))) throw new PluginFileError(`${target}/${child}: ${NOT_KEPT}`, 403);
  const parent = path.posix.dirname(target);
  if (parent !== ".") await ensureFolder(workspacePath, parent);
  const { absolutePath: destination } = await parentOf(workspacePath, target);
  const taken = () => new PluginFileError(`${target} already exists`, 409);
  if (await exists(destination)) throw taken();
  if (!folder) {
    // A new name for the file, which fails if the name is taken, then the old one goes: nothing is replaced.
    let linked = false;
    try {
      await link(origin, destination);
      linked = true;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw taken();
      if (!code || !NO_LINKS.has(code)) throw cause;
    }
    if (linked) {
      try {
        await unlink(origin);
      } catch (cause) {
        // The old name stays, so the new one goes: a move leaves one name or the other.
        await unlink(destination).catch(() => {});
        throw cause;
      }
      return target;
    }
  }
  // A folder moved onto a name taken meanwhile replaces at most an empty folder, and only where the system allows.
  await rename(origin, destination);
  return target;
}

export async function deletePluginFile(workspacePath: string, requested: string): Promise<void> {
  const relative = writablePath(requested);
  const { absolutePath } = await resolveWorkspaceEntry(workspacePath, relative);
  await assertChangeable(workspacePath, relative, checkpointCoverage(workspacePath));
  await rm(absolutePath, { recursive: true });
}
