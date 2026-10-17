import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { CheckpointFile } from "../shared/contracts.js";
import type {
  WorkspaceGitChange,
  WorkspaceGitChanges,
  WorkspaceGitFileView,
} from "../shared/workspace-git.js";
import { countLineChanges } from "../shared/line-diff.js";
import { changeText, MAX_CHANGE_BYTES } from "./file-line-changes.js";
import { readWorkspaceFile, WorkspaceError } from "./workspace.js";

function git(
  workspace: string,
  args: string[],
  maxBuffer = 8 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        workspace,
        ...args,
      ],
      {
        encoding: "buffer",
        maxBuffer,
        timeout: 10_000,
        windowsHide: true,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("GIT_"),
            ),
          ),
          GIT_LITERAL_PATHSPECS: "1",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
    );
    // Also closes input for the read-only empty-tree hash used before a first commit.
    child.stdin?.end();
  });
}

async function repository(
  workspace: string,
): Promise<{ root: string; head?: string } | undefined> {
  const root = await realpath(workspace);
  let top: Buffer;
  try {
    top = await git(root, ["rev-parse", "--show-toplevel"]);
  } catch (cause) {
    const error = cause as { code?: number | string; stderr?: Buffer };
    if (
      error.code === "ENOENT" ||
      error.stderr?.toString().includes("not a git repository")
    )
      return;
    throw cause;
  }
  // A plain project nested in another repository must not expose the parent's changes.
  if ((await realpath(top.toString().slice(0, -1))) !== root) return;
  try {
    return {
      root,
      head: (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))
        .toString()
        .trim(),
    };
  } catch (cause) {
    if ((cause as { code?: number }).code !== 1) throw cause;
    return { root };
  }
}

export async function listWorkspaceGitChanges(
  workspace: string,
): Promise<WorkspaceGitChanges> {
  const repo = await repository(workspace);
  if (!repo) return { available: false, changes: [] };
  return { available: true, head: repo.head, changes: await readChanges(repo) };
}

async function readChanges(
  repo: { root: string; head?: string },
  filePath?: string,
): Promise<WorkspaceGitChange[]> {
  const baseline =
    repo.head ??
    (await git(repo.root, ["hash-object", "-t", "tree", "--stdin"]))
      .toString()
      .trim();
  const pathsFilter = filePath ? [filePath] : [];
  const [tracked, untracked] = await Promise.all([
    git(repo.root, [
      "diff",
      "--raw",
      "--numstat",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      baseline,
      "--",
      ...pathsFilter,
    ]),
    git(repo.root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...pathsFilter,
    ]),
  ]);
  const changes = new Map<string, WorkspaceGitChange>();
  const records = tracked.toString().split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith(":")) {
      const status = record.split(" ").at(-1);
      const filePath = records[++index];
      changes.set(filePath, {
        path: filePath,
        kind:
          status === "A" ? "added" : status === "D" ? "removed" : "modified",
        ...(status === "U" || changes.get(filePath)?.conflicted
          ? { conflicted: true }
          : {}),
      });
    } else {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
      if (!match || match[1] === "-") continue;
      const item = changes.get(match[3]);
      if (item)
        item.lines = { added: Number(match[1]), removed: Number(match[2]) };
    }
  }
  const paths = untracked.toString().split("\0").filter(Boolean);
  // Bound concurrent reads; large/binary files are listed without invented counts.
  for (let start = 0; start < paths.length; start += 8) {
    await Promise.all(
      paths.slice(start, start + 8).map(async (filePath) => {
        const item: WorkspaceGitChange = {
          path: filePath,
          kind: "added",
          untracked: true,
        };
        changes.set(filePath, item);
        const file = await workingFile(repo.root, filePath);
        if (file && !file.binary && !file.truncated)
          item.lines = countLineChanges("", file.content ?? "");
      }),
    );
  }
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function workingFile(
  root: string,
  filePath: string,
): Promise<CheckpointFile | null | undefined> {
  try {
    const info = await lstat(path.join(root, filePath));
    if (!info.isFile()) return undefined;
    return await readWorkspaceFile(root, filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (cause instanceof WorkspaceError) return undefined;
    throw cause;
  }
}

export async function readWorkspaceGitFile(
  workspace: string,
  filePath: string,
): Promise<WorkspaceGitFileView> {
  if (
    !filePath ||
    filePath.includes("\\") ||
    path.posix.isAbsolute(filePath) ||
    filePath
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new WorkspaceError("Invalid workspace path");
  const repo = await repository(workspace);
  if (!repo) throw new WorkspaceError("Git repository not found", "ENOENT");
  const item = (await readChanges(repo, filePath)).find(
    (item) => item.path === filePath,
  );
  if (!item) throw new WorkspaceError("Changed file not found", "ENOENT");
  let before: CheckpointFile | null = null;
  let unsupported = false;
  if (repo.head) {
    const entry = (
      await git(repo.root, ["ls-tree", "-l", "-z", repo.head, "--", filePath])
    ).toString();
    if (entry) {
      const [mode, type, oid, size] = entry.split("\t")[0].trim().split(/\s+/);
      if (type !== "blob" || !/^100/.test(mode)) unsupported = true;
      else if (Number(size) > MAX_CHANGE_BYTES)
        before = { binary: false, truncated: true };
      else {
        const bytes = await git(
          repo.root,
          ["cat-file", "blob", oid],
          MAX_CHANGE_BYTES + 1,
        );
        const text = changeText(bytes);
        before =
          text === undefined
            ? { binary: true }
            : { binary: false, content: text };
      }
    }
  }
  const after = await workingFile(repo.root, filePath);
  return {
    path: filePath,
    before:
      !item.lines && !item.untracked && before ? { binary: true } : before,
    after:
      !item.lines && !item.untracked && after
        ? { binary: true }
        : (after ?? null),
    ...(unsupported || after === undefined ? { unsupported: true } : {}),
  };
}
