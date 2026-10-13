import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureProjectDependencies } from "../src/daemon/project-dependencies.js";
import { projectProcessEnvironment } from "../src/daemon/project-process.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-dependency-test-"),
  );
  directories.push(directory);
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ dependencies: { example: "1.0.0" } }),
  );
  await writeFile(path.join(directory, "package-lock.json"), "{}");
  await writeFile(path.join(directory, "source.ts"), "user code");
  return directory;
}

async function installed(directory: string) {
  await mkdir(path.join(directory, "node_modules/example"), {
    recursive: true,
  });
  await writeFile(
    path.join(directory, "node_modules/example/package.json"),
    "{}",
  );
  await writeFile(
    path.join(directory, "node_modules/.package-lock.json"),
    "{}",
  );
}

describe("project dependencies", () => {
  it.skipIf(process.platform === "win32")(
    "ignores unreadable folders outside declared workspaces, including excluded packages",
    async () => {
      const directory = await workspace();
      await installed(directory);
      await writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({
          workspaces: ["apps/*", "!apps/excluded"],
          dependencies: { example: "1.0.0" },
        }),
      );
      await mkdir(path.join(directory, "apps/game"), { recursive: true });
      await writeFile(
        path.join(directory, "apps/game/package.json"),
        JSON.stringify({ dependencies: { example: "1.0.0" } }),
      );
      const folders = [
        path.join(directory, "assets/private"),
        path.join(directory, "apps/excluded"),
      ];
      try {
        for (const folder of folders) {
          await mkdir(folder, { recursive: true });
          await chmod(folder, 0o000);
        }
        const run = vi.fn();
        await ensureProjectDependencies(directory, "npm", run);
        expect(run).not.toHaveBeenCalled();
      } finally {
        for (const folder of folders) await chmod(folder, 0o700);
      }
    },
  );

  it("retries a failed install from clean dependencies and preserves project files", async () => {
    const directory = await workspace();
    await expect(
      ensureProjectDependencies(directory, "npm", async () => {
        await installed(directory);
        await writeFile(
          path.join(directory, "node_modules/example/stale-binary-path.js"),
          "bundled binary",
        );
        throw new Error("postinstall failed");
      }),
    ).rejects.toThrow("postinstall failed");
    await access(path.join(directory, ".ohmygame-install-pending"));

    const retry = vi.fn(async () => {
      await expect(
        access(path.join(directory, "node_modules")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await installed(directory);
    });
    await ensureProjectDependencies(directory, "npm", retry);
    expect(retry).toHaveBeenCalledWith("npm", [
      "install",
      "--no-audit",
      "--no-fund",
    ]);
    await expect(
      access(path.join(directory, ".ohmygame-install-pending")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(directory, "source.ts"), "utf8")).toBe(
      "user code",
    );
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
    await Promise.all([
      ensureProjectDependencies(directory, "npm", run),
      ensureProjectDependencies(directory, "npm", run),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("reinstalls on dependency and lockfile changes, while script changes preserve installed modules", async () => {
    const directory = await workspace();
    await installed(directory);
    const run = vi.fn(() => installed(directory));
    await ensureProjectDependencies(directory, "npm", run);
    expect(run).not.toHaveBeenCalled();
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ dependencies: { example: "2.0.0" } }),
    );
    await ensureProjectDependencies(directory, "npm", run);
    expect(run).toHaveBeenCalledTimes(1);
    await writeFile(
      path.join(directory, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 }),
    );
    await ensureProjectDependencies(directory, "npm", run);
    expect(run).toHaveBeenCalledTimes(2);
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        dependencies: { example: "2.0.0" },
        scripts: { dev: "new server" },
      }),
    );
    await ensureProjectDependencies(directory, "npm", run);
    expect(run).toHaveBeenCalledTimes(2);
    await ensureProjectDependencies(directory, "npm", run, true);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("keeps installed dependencies when npm's hidden lock is absent", async () => {
    const directory = await workspace();
    await installed(directory);
    await rm(path.join(directory, "node_modules/.package-lock.json"));
    const run = vi.fn();
    await ensureProjectDependencies(directory, "npm", run);
    expect(run).not.toHaveBeenCalled();
  });

  it("checks workspace dependencies with hoisting, exclusions and stable dependency ordering", async () => {
    const directory = await workspace();
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        workspaces: ["apps/*"],
        dependencies: { example: "1.0.0" },
      }),
    );
    await writeFile(
      path.join(directory, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - '!apps/excluded'\n",
    );
    for (const name of ["game", "excluded"])
      await mkdir(path.join(directory, "apps", name), { recursive: true });
    const manifestPath = path.join(directory, "apps/game/package.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ dependencies: { example: "1.0.0", engine: "1.0.0" } }),
    );
    await writeFile(
      path.join(directory, "apps/excluded/package.json"),
      JSON.stringify({ dependencies: { absent: "1.0.0" } }),
    );
    const run = vi.fn(async () => {
      await installed(directory);
      await mkdir(path.join(directory, "node_modules/engine"));
      await writeFile(
        path.join(directory, "node_modules/engine/package.json"),
        "{}",
      );
    });
    await installed(directory);
    await ensureProjectDependencies(directory, "pnpm", run);
    expect(run).toHaveBeenCalledOnce();
    await writeFile(
      manifestPath,
      JSON.stringify({ dependencies: { engine: "1.0.0", example: "1.0.0" } }),
    );
    await ensureProjectDependencies(directory, "pnpm", run);
    expect(run).toHaveBeenCalledOnce();
    await writeFile(
      manifestPath,
      JSON.stringify({ dependencies: { engine: "2.0.0", example: "1.0.0" } }),
    );
    await ensureProjectDependencies(directory, "pnpm", run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued install without deleting existing dependencies", async () => {
    const directory = await workspace();
    await installed(directory);
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const active = ensureProjectDependencies(
      directory,
      "npm",
      async () => {
        entered();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await installed(directory);
      },
      true,
    );
    await started;
    const run = vi.fn();
    const queued = ensureProjectDependencies(
      directory,
      "npm",
      run,
      true,
      () => {
        throw new Error("cancelled");
      },
    );
    const rejected = expect(queued).rejects.toThrow("cancelled");
    finish();
    await active;
    await rejected;
    expect(run).not.toHaveBeenCalled();
    await access(path.join(directory, "node_modules/example/package.json"));
    await expect(
      access(path.join(directory, ".ohmygame-install-pending")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("project process environment", () => {
  it("removes the app binary override without mutating the daemon environment", () => {
    const environment = {
      ESBUILD_BINARY_PATH: "/app/esbuild",
      PATH: "/runtime/bin",
      HTTPS_PROXY: "http://localhost:8080",
    };
    expect(projectProcessEnvironment(environment)).toEqual({
      PATH: "/runtime/bin",
      HTTPS_PROXY: "http://localhost:8080",
    });
    expect(environment.ESBUILD_BINARY_PATH).toBe("/app/esbuild");
  });

  it("removes the daemon's own settings and keeps everything else", () => {
    const environment = {
      OHMYGAME_DAEMON_TOKEN: "secret",
      OHMYGAME_DATA_DIR: "/data",
      OHMYGAME_ALLOWED_ORIGINS: "app://ohmygame",
      ohmygame_daemon_token: "stale-secret",
      OhMyGame_Daemon_Token_Stdin: "1",
      DAEMON_HOST: "127.0.0.1",
      DAEMON_PORT: "43110",
      Daemon_Port: "43111",
      PATH: "/runtime/bin",
      HOME: "/home/player",
      MY_OHMYGAME_LEVEL: "3",
    };
    expect(projectProcessEnvironment(environment)).toEqual({ PATH: "/runtime/bin", HOME: "/home/player", MY_OHMYGAME_LEVEL: "3" });
    expect(environment.OHMYGAME_DAEMON_TOKEN).toBe("secret");
  });
});
