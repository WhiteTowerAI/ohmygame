import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getWorkspaceChanges, listWorkspaceFiles, readWorkspaceFile } from "../src/daemon/workspace.js";

const execFileAsync = promisify(execFile);

describe("workspace inspection", () => {
  it("lists source files and ignores generated directories", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "open-game-workspace-"));
    await mkdir(path.join(workspace, "src"));
    await mkdir(path.join(workspace, "node_modules"));
    await mkdir(path.join(workspace, "dist"));
    await writeFile(path.join(workspace, "src", "main.ts"), "export const game = true;\n");
    await writeFile(path.join(workspace, "node_modules", "dependency.js"), "ignored");
    await writeFile(path.join(workspace, "dist", "bundle.js"), "ignored");

    await expect(listWorkspaceFiles(workspace)).resolves.toEqual([
      { path: "src/main.ts", size: 26 },
    ]);
  });

  it("reads bounded text and reports binary files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "open-game-workspace-"));
    await writeFile(path.join(workspace, "large.txt"), "x".repeat(300 * 1024));
    await writeFile(path.join(workspace, "image.bin"), Buffer.from([0xff, 0xfe, 0x00]));

    const text = await readWorkspaceFile(workspace, "large.txt");
    expect(text).toMatchObject({ binary: false, truncated: true, size: 300 * 1024 });
    expect(text.content).toHaveLength(256 * 1024);
    await expect(readWorkspaceFile(workspace, "image.bin")).resolves.toMatchObject({ binary: true, size: 3 });
  });

  it("rejects traversal and symbolic links", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "open-game-workspace-"));
    const outside = path.join(await mkdtemp(path.join(tmpdir(), "open-game-outside-")), "secret.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(workspace, "link.txt"));

    await expect(readWorkspaceFile(workspace, "../secret.txt")).rejects.toThrow("Invalid workspace path");
    await expect(readWorkspaceFile(workspace, path.resolve(outside))).rejects.toThrow("Invalid workspace path");
    await expect(readWorkspaceFile(workspace, "link.txt")).rejects.toThrow("Symbolic links cannot be opened");
  });

  it("treats files in a non-Git workspace as added", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "open-game-workspace-"));
    await writeFile(path.join(workspace, "index.html"), "<h1>Hello</h1>\n");

    await expect(getWorkspaceChanges(workspace)).resolves.toMatchObject({
      files: [{ path: "index.html", status: "added" }],
      diff: expect.stringContaining("+++ b/index.html"),
      truncated: false,
    });
  });

  it("uses the same ignored directories for Git status and diff", async () => {
    const workspace = await createGitWorkspace();
    await mkdir(path.join(workspace, "dist"));
    await writeFile(path.join(workspace, "source.txt"), "one\n");
    await writeFile(path.join(workspace, "dist", "bundle.js"), "built\n");
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "initial");
    await writeFile(path.join(workspace, "source.txt"), "one\ntwo\n");
    await writeFile(path.join(workspace, "dist", "bundle.js"), "built\nchanged\n");

    const changes = await getWorkspaceChanges(workspace);

    expect(changes.files).toEqual([{ path: "source.txt", status: "modified" }]);
    expect(changes.diff).toContain("source.txt");
    expect(changes.diff).not.toContain("dist/bundle.js");
  });

  it("marks an oversized Git diff as truncated", async () => {
    const workspace = await createGitWorkspace();
    await writeFile(path.join(workspace, "large.txt"), "a\n".repeat(350_000));
    await git(workspace, "add", "large.txt");
    await git(workspace, "commit", "-m", "initial");
    await writeFile(path.join(workspace, "large.txt"), "b\n".repeat(350_000));

    const changes = await getWorkspaceChanges(workspace);

    expect(changes.files).toEqual([{ path: "large.txt", status: "modified" }]);
    expect(changes.diff.length).toBeGreaterThan(0);
    expect(changes.truncated).toBe(true);
  });
});

async function createGitWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "open-game-git-workspace-"));
  await git(workspace, "init", "-q");
  await git(workspace, "config", "user.email", "test@example.com");
  await git(workspace, "config", "user.name", "Test");
  return workspace;
}

async function git(workspace: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", workspace, ...args]);
}
