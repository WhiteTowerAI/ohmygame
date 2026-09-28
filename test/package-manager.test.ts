import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageManagerInstallArguments,
  packageManagerRunArguments,
  resolvePackageManager,
} from "../src/daemon/package-manager.js";

describe("project package manager", () => {
  it("uses an explicit choice or detects the workspace lockfile", async () => {
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), "ohmygame-package-manager-"),
    );
    await writeFile(
      path.join(workspacePath, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );

    await expect(resolvePackageManager(workspacePath)).resolves.toBe("pnpm");
    await expect(resolvePackageManager(workspacePath, "bun")).resolves.toBe(
      "bun",
    );
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
