import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageManagerInstallArguments,
  packageManagerRunArguments,
  resolvePackageManager,
  resolvePackageManagerExecutable,
} from "../src/daemon/package-manager.js";

describe("project package manager", () => {
  it("honors the declared manager before lockfiles, with project settings taking precedence", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-declared-manager-"),
    );
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ packageManager: "bun@1.4.2" }),
    );
    await writeFile(path.join(directory, "package-lock.json"), "{}");
    expect(await resolvePackageManager(directory)).toEqual({
      manager: "bun",
      source: "package.json: bun@1.4.2",
    });
    expect(await resolvePackageManager(directory, "npm")).toEqual({
      manager: "npm",
      source: "Project setting",
    });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ packageManager: "unknown@1" }),
    );
    await expect(resolvePackageManager(directory)).rejects.toThrow(
      "Unsupported package manager",
    );
  });

  it("resolves an executable from the child's PATH and reports unavailable managers", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-manager-path-"),
    );
    const filename = process.platform === "win32" ? "npm.cmd" : "npm";
    await mkdir(path.join(directory, "first"));
    await mkdir(path.join(directory, "second"));
    await mkdir(path.join(directory, "first", filename));
    const executable = path.join(directory, "second", filename);
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    const environment = {
      Path: [
        path.join(directory, "first"),
        path.join(directory, "second"),
      ].join(path.delimiter),
    };
    expect(await resolvePackageManagerExecutable("npm", environment)).toBe(
      executable,
    );
    await expect(
      resolvePackageManagerExecutable("bun", environment),
    ).rejects.toThrow("Project settings");
    const bun = path.join(
      directory,
      "second",
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    await writeFile(bun, "");
    await chmod(bun, 0o755);
    expect(await resolvePackageManagerExecutable("bun", environment)).toBe(bun);
  });
  it("uses an explicit choice or detects the workspace lockfile", async () => {
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), "ohmygame-package-manager-"),
    );
    await writeFile(
      path.join(workspacePath, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );

    await expect(resolvePackageManager(workspacePath)).resolves.toEqual({
      manager: "pnpm",
      source: "pnpm-lock.yaml",
    });
    await expect(resolvePackageManager(workspacePath, "bun")).resolves.toEqual({
      manager: "bun",
      source: "Project setting",
    });
  });

  it("uses package-manager-neutral run arguments", () => {
    expect(packageManagerRunArguments("dev", ["--host", "127.0.0.1"])).toEqual([
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
    ]);
    expect(packageManagerInstallArguments("npm")).toEqual([
      "install",
      "--no-audit",
      "--no-fund",
    ]);
    expect(packageManagerInstallArguments("yarn")).toEqual(["install"]);
  });
});
