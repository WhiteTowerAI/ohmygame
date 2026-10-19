import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import {
  listWorkspaceGitChanges,
  readWorkspaceGitFile,
} from "../src/daemon/workspace-git.js";
import type { ProjectState } from "../src/shared/contracts.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped = vi.fn(actual.execFile);
  // Keep Node's custom promisify behavior for real Git fixture commands.
  for (const key of Object.getOwnPropertySymbols(actual.execFile)) {
    Object.defineProperty(
      wrapped,
      key,
      Object.getOwnPropertyDescriptor(actual.execFile, key)!,
    );
  }
  return { ...actual, execFile: wrapped };
});

const run = promisify(execFile);
let directory: string;
let workspace: string;
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-git-")),
  );
  workspace = path.join(directory, "workspace");
  await mkdir(workspace);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const git = (...args: string[]) => run("git", ["-C", workspace, ...args]);
async function write(name: string, content: string | Buffer) {
  await mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
  await writeFile(path.join(workspace, name), content);
}
async function commit() {
  await git("add", ".");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "fixture",
  );
}

describe("read-only workspace Git changes", () => {
  it("does not treat a normal project or its parent's repository as a Git project", async () => {
    await write("game.ts", "game\n");
    expect(await listWorkspaceGitChanges(workspace)).toEqual({
      available: false,
      changes: [],
    });
    await run("git", ["-C", directory, "init", "-q"]);
    expect(await listWorkspaceGitChanges(workspace)).toEqual({
      available: false,
      changes: [],
    });
  });

  it("compares the final workspace to HEAD, including staged edits, deletion and rename, without modifying Git", async () => {
    await git("init", "-q");
    await write("modified.txt", "before\n");
    await write("removed.txt", "removed\n");
    await write("old.txt", "renamed\n");
    await write("cancelled.txt", "original\n");
    await commit();
    await write("modified.txt", "staged\n");
    await write("cancelled.txt", "staged\n");
    await git("add", ".");
    await write("modified.txt", "current\nextra\n");
    await write("cancelled.txt", "original\n");
    await rm(path.join(workspace, "removed.txt"));
    await rename(
      path.join(workspace, "old.txt"),
      path.join(workspace, "new.txt"),
    );
    const index = await readFile(path.join(workspace, ".git/index"));
    const head = await git("rev-parse", "HEAD");
    expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([
      {
        path: "modified.txt",
        kind: "modified",
        lines: { added: 2, removed: 1 },
      },
      {
        path: "new.txt",
        kind: "added",
        untracked: true,
        lines: { added: 1, removed: 0 },
      },
      { path: "old.txt", kind: "removed", lines: { added: 0, removed: 1 } },
      { path: "removed.txt", kind: "removed", lines: { added: 0, removed: 1 } },
    ]);
    expect(await readWorkspaceGitFile(workspace, "modified.txt")).toMatchObject(
      {
        before: { content: "before\n" },
        after: { content: "current\nextra\n" },
      },
    );
    expect(await readWorkspaceGitFile(workspace, "removed.txt")).toMatchObject({
      before: { content: "removed\n" },
      after: null,
    });
    expect(await readFile(path.join(workspace, ".git/index"))).toEqual(index);
    expect((await git("rev-parse", "HEAD")).stdout).toBe(head.stdout);
  });

  it.each(["before\n", "", "after\nextra\n"])(
    "compares an index removal with the remaining workspace content %j",
    async (content) => {
      await git("init", "-q");
      await write("game.txt", "before\n");
      await commit();
      await git("rm", "--cached", "game.txt");
      await write("game.txt", content);
      const index = await readFile(path.join(workspace, ".git/index"));
      const head = (await git("rev-parse", "HEAD")).stdout;
      const objects = (await git("count-objects", "-v")).stdout;
      expect((await listWorkspaceGitChanges(workspace)).changes).toEqual(
        content === "before\n"
          ? []
          : [
              {
                path: "game.txt",
                kind: "modified",
                untracked: true,
                lines: { added: content === "" ? 0 : 2, removed: 1 },
              },
            ],
      );
      if (content === "before\n") {
        await expect(
          readWorkspaceGitFile(workspace, "game.txt"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readWorkspaceGitFile(workspace, "game.txt")).toMatchObject(
          {
            before: { content: "before\n" },
            after: { content },
          },
        );
      }
      expect(await readFile(path.join(workspace, ".git/index"))).toEqual(index);
      expect((await git("rev-parse", "HEAD")).stdout).toBe(head);
      expect((await git("count-objects", "-v")).stdout).toBe(objects);
    },
  );

  it("retains binary attributes and bounded previews after an index removal", async () => {
    await git("init", "-q");
    await write(".gitattributes", "data.txt -diff\n");
    await write("data.txt", "before\n");
    await write("binary.bin", Buffer.from([0, 1]));
    await write("large.txt", "before\n".repeat(40_000));
    await commit();
    await git("rm", "--cached", "data.txt", "binary.bin", "large.txt");
    expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([]);
    await write("data.txt", "after\n");
    await write("binary.bin", Buffer.from([0, 2]));
    await write("large.txt", "after\n");
    expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([
      { path: "binary.bin", kind: "modified", untracked: true },
      { path: "data.txt", kind: "modified", untracked: true },
      {
        path: "large.txt",
        kind: "modified",
        untracked: true,
        lines: { added: 1, removed: 40_000 },
      },
    ]);
    expect(await readWorkspaceGitFile(workspace, "data.txt")).toMatchObject({
      before: { binary: true },
      after: { binary: true },
    });
    expect(await readWorkspaceGitFile(workspace, "binary.bin")).toMatchObject({
      before: { binary: true },
      after: { binary: true },
    });
    expect(await readWorkspaceGitFile(workspace, "large.txt")).toMatchObject({
      before: { truncated: true },
      after: { content: "after\n" },
    });
  });

  it.each([false, true])(
    "honors CRLF normalization and core.filemode after an index removal (binary attribute: %s)",
    async (binary) => {
      await git("init", "-q");
      await git("config", "core.autocrlf", "true");
      await git("config", "core.filemode", "false");
      await write(".gitattributes", binary ? "game.txt -diff\n" : "");
      await write("game.txt", "before\r\n");
      await git("add", ".");
      await git("update-index", "--chmod=+x", "game.txt");
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "executable",
      );
      await git("rm", "--cached", "game.txt");
      expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([]);
      await write("game.txt", "after\r\n");
      expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([
        {
          path: "game.txt",
          kind: "modified",
          untracked: true,
          ...(binary ? {} : { lines: { added: 1, removed: 1 } }),
        },
      ]);
    },
  );

  it.each(["sha1", "sha256"])(
    "preserves literal paths after an index removal in a %s repository",
    async (format) => {
      await git("init", "-q", `--object-format=${format}`);
      const names = ["场景 space.txt", "-option.txt"];
      for (const name of names) await write(name, "before\n");
      await commit();
      await git("rm", "--cached", "--", ...names);
      expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([]);
      for (const name of names) await write(name, "after\n");
      expect((await listWorkspaceGitChanges(workspace)).changes).toHaveLength(
        2,
      );
      for (const name of names) {
        expect(await readWorkspaceGitFile(workspace, name)).toMatchObject({
          before: { content: "before\n" },
          after: { content: "after\n" },
        });
      }
    },
  );

  it.each([false, true])(
    "honors core.symlinks=%s after an index removal without following links",
    async (symlinks) => {
      await git("init", "-q");
      await git("config", "core.symlinks", String(symlinks));
      await write("link.txt", "target.txt");
      const oid = (await git("hash-object", "-w", "link.txt")).stdout.trim();
      await git(
        "update-index",
        "--add",
        "--cacheinfo",
        `120000,${oid},link.txt`,
      );
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "link",
      );
      await git("rm", "--cached", "link.txt");
      expect((await listWorkspaceGitChanges(workspace)).changes).toEqual(
        symlinks
          ? [
              {
                path: "link.txt",
                kind: "modified",
                untracked: true,
                lines: { added: 0, removed: 0 },
              },
            ]
          : [],
      );
      await write("link.txt", "another.txt");
      expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([
        {
          path: "link.txt",
          kind: "modified",
          untracked: true,
          lines: { added: 1, removed: 1 },
        },
      ]);
      expect(
        (await readWorkspaceGitFile(workspace, "link.txt")).unsupported,
      ).toBe(true);
    },
  );

  it.each(["removed", "directory"])(
    "retains the deletion when an untracked file becomes %s during inspection",
    async (replacement) => {
      await git("init", "-q");
      await write("game.txt", "before\n");
      await commit();
      await git("rm", "--cached", "game.txt");
      const original =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
      let changedDuringInspection = false;
      const spy = vi
        .mocked(execFile)
        .mockImplementation((file, args, options, callback) =>
          original.execFile(file, args, options, (error, stdout, stderr) => {
            if (
              !error &&
              file === "git" &&
              args?.includes(workspace) &&
              args.includes("ls-files") &&
              args.includes("--others") &&
              stdout.toString().split("\0").includes("game.txt")
            ) {
              // Deliver the real Git snapshot after the working file changes.
              rmSync(path.join(workspace, "game.txt"));
              if (replacement === "directory")
                mkdirSync(path.join(workspace, "game.txt"));
              changedDuringInspection = true;
            }
            callback?.(error, stdout, stderr);
          }),
        );
      try {
        expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([
          {
            path: "game.txt",
            kind: "removed",
            lines: { added: 0, removed: 1 },
          },
        ]);
        expect(changedDuringInspection).toBe(true);
      } finally {
        spy.mockImplementation(original.execFile);
      }
    },
  );

  it("keeps staged deletions for ignored files after an index removal", async () => {
    await git("init", "-q");
    await write(".gitignore", "ignored.txt\n");
    await write("ignored.txt", "before\n");
    await git("add", "-f", "ignored.txt");
    await commit();
    await git("rm", "--cached", "ignored.txt");
    expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([
      { path: "ignored.txt", kind: "removed", lines: { added: 0, removed: 1 } },
    ]);
  });

  it.each(["sha1", "sha256"])(
    "shows current added content before the first %s commit without writing an empty tree",
    async (format) => {
      await git("init", "-q", `--object-format=${format}`);
      await write("staged.txt", "staged\n");
      await git("add", ".");
      await write("staged.txt", "current\nextra\n");
      await write("new.txt", "new\n");
      const objects = (await git("count-objects", "-v")).stdout;
      expect((await listWorkspaceGitChanges(workspace)).changes).toEqual([
        {
          path: "new.txt",
          kind: "added",
          untracked: true,
          lines: { added: 1, removed: 0 },
        },
        { path: "staged.txt", kind: "added", lines: { added: 2, removed: 0 } },
      ]);
      expect(await readWorkspaceGitFile(workspace, "staged.txt")).toMatchObject(
        { before: null, after: { content: "current\nextra\n" } },
      );
      expect((await git("count-objects", "-v")).stdout).toBe(objects);
    },
  );

  it("honors gitignore and handles binary, oversized and empty new files", async () => {
    await git("init", "-q");
    await write(".gitignore", "ignored/\n");
    await write("binary.bin", Buffer.from([0, 1]));
    await commit();
    await write("ignored/temp.txt", "ignored\n");
    await write("binary.bin", Buffer.from([0, 2]));
    await write("new.bin", Buffer.from([0, 3]));
    await write("large.txt", "x".repeat(300 * 1024));
    await write("empty.txt", "");
    const changes = (await listWorkspaceGitChanges(workspace)).changes;
    expect(changes.map((item) => item.path)).toEqual([
      "binary.bin",
      "empty.txt",
      "large.txt",
      "new.bin",
    ]);
    expect(changes.find((item) => item.path === "empty.txt")?.lines).toEqual({
      added: 0,
      removed: 0,
    });
    expect(
      changes
        .filter((item) => item.path !== "empty.txt")
        .every((item) => !item.lines),
    ).toBe(true);
    expect(
      (await readWorkspaceGitFile(workspace, "binary.bin")).before?.binary,
    ).toBe(true);
    expect(
      (await readWorkspaceGitFile(workspace, "large.txt")).after?.truncated,
    ).toBe(true);
  });

  it("respects a tracked file's binary attribute and bounds a large committed side", async () => {
    await git("init", "-q");
    await write(".gitattributes", "data.txt -diff\n");
    await write("data.txt", "before\n");
    await write("large.txt", "x".repeat(300 * 1024));
    await commit();
    await write("data.txt", "after\n");
    await write("large.txt", "small\n");
    expect(
      (await listWorkspaceGitChanges(workspace)).changes.find(
        (item) => item.path === "data.txt",
      )?.lines,
    ).toBeUndefined();
    const data = await readWorkspaceGitFile(workspace, "data.txt");
    expect(data.before?.binary).toBe(true);
    expect(data.after?.binary).toBe(true);
    expect(
      (await readWorkspaceGitFile(workspace, "large.txt")).before?.truncated,
    ).toBe(true);
  });

  it("preserves Unicode, tabs, newlines, leading dashes and literal pathspec characters", async () => {
    await git("init", "-q");
    const names = [
      "场景 space.ts",
      "tab\tfile.txt",
      "line\nfile.txt",
      "-option.txt",
      ":[glob]*.txt",
    ];
    for (const name of names) await write(name, "before\n");
    await commit();
    for (const name of names) await write(name, "after\n");
    const changes = (await listWorkspaceGitChanges(workspace)).changes;
    expect(changes.map((item) => item.path).sort()).toEqual(names.sort());
    for (const name of names) {
      expect(changes.find((item) => item.path === name)?.lines).toEqual({
        added: 1,
        removed: 1,
      });
      expect(
        (await readWorkspaceGitFile(workspace, name)).before?.content,
      ).toBe("before\n");
    }
  });

  it("does not read symlink targets or treat gitlinks as text files", async () => {
    await git("init", "-q");
    await write("game.txt", "before\n");
    await commit();
    const { stdout: head } = await git("rev-parse", "HEAD");
    await symlink(
      path.join(directory, "secret.txt"),
      path.join(workspace, "linked.txt"),
    );
    await writeFile(path.join(directory, "secret.txt"), "outside secret\n");
    await git(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head.trim()},module`,
    );
    await git("add", "linked.txt");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "links",
    );
    await rm(path.join(workspace, "linked.txt"));
    await symlink(
      path.join(directory, "another.txt"),
      path.join(workspace, "linked.txt"),
    );
    const linked = await readWorkspaceGitFile(workspace, "linked.txt");
    expect(linked.unsupported).toBe(true);
    expect(JSON.stringify(linked)).not.toContain("outside secret");
    await git("update-index", "--force-remove", "module");
    expect((await readWorkspaceGitFile(workspace, "module")).unsupported).toBe(
      true,
    );
  });

  it("supports Git worktrees whose .git entry is a file", async () => {
    await git("init", "-q");
    await write("game.txt", "before\n");
    await commit();
    const linked = path.join(directory, "worktree");
    await git("worktree", "add", "--detach", linked);
    await writeFile(path.join(linked, "game.txt"), "after\n");
    expect((await listWorkspaceGitChanges(linked)).changes).toEqual([
      { path: "game.txt", kind: "modified", lines: { added: 1, removed: 1 } },
    ]);
    expect(
      (await readWorkspaceGitFile(linked, "game.txt")).before?.content,
    ).toBe("before\n");
  });

  it("exposes only changed project files through read-only routes", async () => {
    const app = createApp({ dataDirectory: path.join(directory, "data") });
    try {
      const project = (
        await app.inject({
          method: "POST",
          url: "/projects",
          payload: { name: "Git", type: "general" },
        })
      ).json<ProjectState>();
      workspace = project.workspacePath;
      const base = `/projects/${project.id}/git`;
      expect(
        (await app.inject({ method: "GET", url: `${base}/changes` })).json(),
      ).toEqual({ available: false, changes: [] });
      await git("init", "-q");
      await write("game.txt", "before\n");
      await commit();
      await write("game.txt", "after\n");
      expect(
        (await app.inject({ method: "GET", url: `${base}/changes` })).json()
          .changes,
      ).toContainEqual({
        path: "game.txt",
        kind: "modified",
        lines: { added: 1, removed: 1 },
      });
      expect(
        (
          await app.inject({ method: "GET", url: `${base}/file?path=game.txt` })
        ).json().before.content,
      ).toBe("before\n");
      for (const name of ["../secret.txt", ".git/config", "/etc/passwd"]) {
        expect(
          (
            await app.inject({
              method: "GET",
              url: `${base}/file?path=${encodeURIComponent(name)}`,
            })
          ).statusCode,
        ).toBe(400);
      }
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base}/file?path=missing.txt`,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: `${base}/file` })).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/projects/missing/git/changes",
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
