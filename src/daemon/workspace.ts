import { isUtf8 } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceChange, WorkspaceChanges, WorkspaceFile, WorkspaceFileContent } from "../shared/contracts.js";

const execFileAsync = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([".data", ".git", "build", "dist", "node_modules", "out"]);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const GIT_DIFF_PATHS = [
  ".",
  ...[...IGNORED_DIRECTORIES].map((directory) => `:(exclude,glob)**/${directory}/**`),
];

export class WorkspaceError extends Error {}

export async function listWorkspaceFiles(workspacePath: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  await visit(workspacePath, "", files);
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

export async function getWorkspaceChanges(workspacePath: string): Promise<WorkspaceChanges> {
  const files = await listWorkspaceFiles(workspacePath);
  const gitRoot = await findLocalGitRoot(workspacePath);
  if (!gitRoot) return changesForUntrackedWorkspace(workspacePath, files);

  const records = await gitStatus(workspacePath);
  const visibleRecords = records.filter((record) => !isIgnoredPath(record.path));
  const trackedDiff = await gitDiff(workspacePath);
  const untracked = visibleRecords.filter((record) => record.status === "added");
  const untrackedFiles = files.filter((file) => untracked.some((record) => record.path === file.path));
  const combined = [trackedDiff.text, await addedFilesDiff(workspacePath, untrackedFiles)].filter(Boolean).join("\n");
  const bounded = boundText(combined, MAX_DIFF_BYTES);
  return { files: visibleRecords, diff: bounded.text, truncated: trackedDiff.truncated || bounded.truncated };
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
    files.push({ path: relativePath, size: (await stat(path.join(directory, entry.name))).size });
  }
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

async function findLocalGitRoot(workspacePath: string): Promise<string | undefined> {
  try {
    const [{ stdout }, root] = await Promise.all([
      execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], { encoding: "utf8" }),
      realpath(workspacePath),
    ]);
    return await realpath(stdout.trim()) === root ? root : undefined;
  } catch {
    return undefined;
  }
}

async function gitStatus(workspacePath: string): Promise<WorkspaceChange[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspacePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "buffer", maxBuffer: MAX_DIFF_BYTES },
  );
  const parts = stdout.toString("utf8").split("\0");
  const changes: WorkspaceChange[] = [];
  for (let index = 0; index < parts.length;) {
    const record = parts[index++];
    if (!record) continue;
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    if (code.includes("R")) {
      const previousPath = parts[index++] || undefined;
      changes.push({ path: filePath, status: "renamed", ...(previousPath ? { previousPath } : {}) });
    } else {
      changes.push({ path: filePath, status: changeStatus(code) });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function changeStatus(code: string): WorkspaceChange["status"] {
  if (code.includes("?") || code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  return "modified";
}

function isIgnoredPath(filePath: string): boolean {
  return filePath.split("/").some((part) => IGNORED_DIRECTORIES.has(part));
}

async function gitDiff(workspacePath: string): Promise<{ text: string; truncated: boolean }> {
  try {
    return await readBoundedProcess(
      "git",
      ["-C", workspacePath, "diff", "--no-ext-diff", "--no-color", "HEAD", "--", ...GIT_DIFF_PATHS],
      MAX_DIFF_BYTES,
    );
  } catch {
    return { text: "", truncated: false };
  }
}

async function changesForUntrackedWorkspace(workspacePath: string, files: WorkspaceFile[]): Promise<WorkspaceChanges> {
  const combined = await addedFilesDiff(workspacePath, files);
  const bounded = boundText(combined, MAX_DIFF_BYTES);
  return {
    files: files.map((file) => ({ path: file.path, status: "added" })),
    diff: bounded.text,
    truncated: bounded.truncated,
  };
}

async function addedFilesDiff(workspacePath: string, files: WorkspaceFile[]): Promise<string> {
  const sections: string[] = [];
  let size = 0;
  for (const file of files) {
    if (size >= MAX_DIFF_BYTES) break;
    const result = await readWorkspaceFile(workspacePath, file.path);
    if (result.binary || result.content === undefined) {
      const section = `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\nBinary file /dev/null and b/${file.path} differ\n`;
      sections.push(section);
      size += Buffer.byteLength(section);
      continue;
    }
    const lines = result.content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const section = [
      `diff --git a/${file.path} b/${file.path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file.path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      "",
    ].join("\n");
    sections.push(section);
    size += Buffer.byteLength(section);
  }
  return sections.join("\n");
}

function boundText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

async function readBoundedProcess(command: string, args: string[], maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let captured = 0;
  let truncated = false;
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const remaining = maxBytes - captured;
    if (remaining > 0) {
      const visible = chunk.subarray(0, remaining);
      chunks.push(visible);
      captured += visible.length;
    }
    if (chunk.length > remaining) truncated = true;
  });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}
