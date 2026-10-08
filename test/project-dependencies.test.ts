import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureProjectDependencies } from "../src/daemon/project-dependencies.js";
import { projectProcessEnvironment } from "../src/daemon/project-process.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-dependency-test-"));
  directories.push(directory);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ dependencies: { example: "1.0.0" } }));
  await writeFile(path.join(directory, "package-lock.json"), "{}");
  await writeFile(path.join(directory, "source.ts"), "user code");
  return directory;
}

async function installed(directory: string) {
  await mkdir(path.join(directory, "node_modules/example"), { recursive: true });
  await writeFile(path.join(directory, "node_modules/example/package.json"), "{}");
  await writeFile(path.join(directory, "node_modules/.package-lock.json"), "{}");
}

describe("project dependencies", () => {
  it("retries a failed install from clean dependencies and preserves project files", async () => {
    const directory = await workspace();
    await expect(ensureProjectDependencies(directory, "npm", async () => {
      await installed(directory);
      await writeFile(path.join(directory, "node_modules/example/stale-binary-path.js"), "bundled binary");
      throw new Error("postinstall failed");
    })).rejects.toThrow("postinstall failed");
    await access(path.join(directory, ".ohmygame-install-pending"));

    const retry = vi.fn(async () => {
      await expect(access(path.join(directory, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
      await installed(directory);
    });
    await ensureProjectDependencies(directory, "npm", retry);
    expect(retry).toHaveBeenCalledWith("npm", ["install", "--no-audit", "--no-fund"]);
    await expect(access(path.join(directory, ".ohmygame-install-pending"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(directory, "source.ts"), "utf8")).toBe("user code");
    await ensureProjectDependencies(directory, "npm", retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("repairs missing direct dependencies even when the npm lock exists", async () => {
    const directory = await workspace();
    await installed(directory);
    await rm(path.join(directory, "node_modules/example"), { recursive: true });
    const run = vi.fn(() => installed(directory));
    await ensureProjectDependencies(directory, "npm", run);
    expect(run).toHaveBeenCalledOnce();
  });

  it("serializes preview and publish installs of the same workspace", async () => {
    const directory = await workspace();
    const run = vi.fn(() => installed(directory));
    await Promise.all([ensureProjectDependencies(directory, "npm", run), ensureProjectDependencies(directory, "npm", run)]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps installed dependencies when npm's hidden lock is absent", async () => {
    const directory = await workspace();
    await installed(directory);
    await rm(path.join(directory, "node_modules/.package-lock.json"));
    const run = vi.fn();
    await ensureProjectDependencies(directory, "npm", run);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("project process environment", () => {
  it("removes the app binary override without mutating the daemon environment", () => {
    const environment = { ESBUILD_BINARY_PATH: "/app/esbuild", PATH: "/runtime/bin", HTTPS_PROXY: "http://localhost:8080" };
    expect(projectProcessEnvironment(environment)).toEqual({ PATH: "/runtime/bin", HTTPS_PROXY: "http://localhost:8080" });
    expect(environment.ESBUILD_BINARY_PATH).toBe("/app/esbuild");
  });
});
