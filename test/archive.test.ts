import fs from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactBuilder,
  createPluginArchive,
} from "../src/daemon/publish/archive.js";

afterEach(() => vi.unstubAllEnvs());

describe("publish archives", () => {
  it("builds with project binaries instead of the app's esbuild override", async () => {
    vi.stubEnv("ESBUILD_BINARY_PATH", "/app/esbuild");
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-env-"));
    await writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ scripts: { build: "node build.mjs" } }));
    await writeFile(path.join(workspacePath, "build.mjs"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      if (process.env.ESBUILD_BINARY_PATH) throw new Error("app binary leaked into build");
      mkdirSync("dist", { recursive: true });
      writeFileSync("dist/index.html", "built game");
    `);
    await expect(new ArtifactBuilder().create({
      id: "environment-test", name: "Game", type: "web-game", updatedAt: new Date(0).toISOString(),
      workspacePath, preview: { status: "stopped" },
    })).resolves.toBeInstanceOf(Buffer);
    expect(process.env.ESBUILD_BINARY_PATH).toBe("/app/esbuild");
  });

  it("creates identical ZIPs in different time zones", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-"));
    await writeFile(path.join(source, "example.txt"), "same content");
    const originalTimeZone = process.env.TZ;

    try {
      process.env.TZ = "UTC";
      const utc = await createPluginArchive(source);
      process.env.TZ = "Asia/Shanghai";
      const shanghai = await createPluginArchive(source);
      expect(shanghai).toEqual(utc);
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });

  it("creates identical Plugin ZIPs from different file modes", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-mode-"));
    await writeFile(path.join(source, "example.txt"), "same content");

    expect(await archiveWithMode(source, 0o100666)).toEqual(
      await archiveWithMode(source, 0o100644),
    );
  });

  it("uses a Web Game's configured startup directory as its publish source", async () => {
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), "ohmygame-archive-web-game-"),
    );
    const startupDirectory = path.join(workspacePath, "apps", "game");
    await mkdir(startupDirectory, { recursive: true });
    await writeFile(path.join(startupDirectory, "index.html"), "nested game");

    await expect(
      new ArtifactBuilder().create({
        id: "project-1",
        name: "Nested game",
        type: "web-game",
        updatedAt: new Date(0).toISOString(),
        workspacePath,
        startupDirectory: "apps/game",
        preview: { status: "stopped" },
      }),
    ).resolves.toBeInstanceOf(Buffer);
  });
});

async function archiveWithMode(source: string, mode: number): Promise<Buffer> {
  const stat = fs.stat.bind(fs);
  const mocked = vi.spyOn(fs, "stat").mockImplementation(((
    ...args: unknown[]
  ) => {
    const target = args[0] as fs.PathLike;
    const callback = args.at(-1) as (
      error: NodeJS.ErrnoException | null,
      stats?: fs.Stats,
    ) => void;
    stat(target, (error, stats) => {
      if (error) callback(error);
      else callback(null, Object.assign(stats, { mode }));
    });
  }) as typeof fs.stat);
  try {
    return await createPluginArchive(source);
  } finally {
    mocked.mockRestore();
  }
}
