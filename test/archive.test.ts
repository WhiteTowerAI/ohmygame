import { createHash } from "node:crypto";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import yauzl, { type Entry } from "yauzl";
import {
  ArtifactBuilder,
  createPluginArchive,
} from "../src/daemon/publish/archive.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("publish archives", () => {
  const localConfig = {
    enabled: true as const, mode: "turn-based" as const, gameId: "gomoku", deploymentId: "local-v1",
    protocolVersion: 1 as const, serverUrl: "http://127.0.0.1:43130", authPolicy: "anonymous" as const,
    roomPolicy: "invite-or-public" as const, maxClients: 2, reconnectSeconds: 120, adapterId: "gomoku",
  };
  const projectAt = (workspacePath: string) => ({ id: "local-board", name: "Board", type: "web-game" as const, updatedAt: new Date(0).toISOString(), workspacePath, preview: { status: "stopped" as const } });

  it("rejects PeerJS dependencies and CDN builds without a multiplayer declaration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-peerjs-publish-"));
    await writeFile(path.join(directory, "index.html"), '<script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>');
    await expect(new ArtifactBuilder().create(projectAt(directory))).rejects.toThrow(/PeerJS networking/);
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ dependencies: { peerjs: "1.5.5" } }));
    await expect(new ArtifactBuilder().create(projectAt(directory))).rejects.toThrow(/uses PeerJS/);
  });

  it("requires the build to retain the declared multiplayer deployment", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-missing-multiplayer-"));
    await writeFile(path.join(directory, "index.html"), "board");
    await writeFile(path.join(directory, "multiplayer.json"), JSON.stringify({ multiplayer: localConfig }));
    await expect(new ArtifactBuilder().createLocal(projectAt(directory))).rejects.toThrow(/dropped the multiplayer manifest/);
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ multiplayer: { ...localConfig, deploymentId: "other" } }));
    await expect(new ArtifactBuilder().createLocal(projectAt(directory))).rejects.toThrow(/do not match/);
  });

  it("checks local deployments for debug snapshots while rejecting them for public publishing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-local-multiplayer-"));
    await writeFile(path.join(directory, "index.html"), "board");
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ multiplayer: localConfig }));
    const builder = new ArtifactBuilder();
    await expect(builder.create(projectAt(directory))).rejects.toThrow(/HTTPS Colyseus backend/);
    const fetchDeployment = vi.fn(async () => Response.json(localConfig));
    vi.stubGlobal("fetch", fetchDeployment);
    await expect(builder.createLocal(projectAt(directory))).resolves.toBeInstanceOf(Buffer);
    expect(fetchDeployment).toHaveBeenCalledWith(new URL("http://127.0.0.1:43130/v1/games/gomoku/deployments/local-v1"), expect.objectContaining({ redirect: "error" }));
  });

  it("requires a trusted, matching multiplayer deployment for a Web Game", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-multiplayer-publish-"));
    await writeFile(path.join(workspacePath, "index.html"), "game");
    const config = {
      enabled: true as const,
      mode: "turn-based" as const,
      gameId: "stones",
      deploymentId: "first",
      protocolVersion: 1 as const,
      serverUrl: "https://games.example.test",
      authPolicy: "guest-or-account" as const,
      roomPolicy: "invite-or-public" as const,
      maxClients: 4,
      reconnectSeconds: 120,
    };
    const project = {
      id: "multiplayer-test", name: "Stones", type: "web-game" as const,
      updatedAt: new Date(0).toISOString(), workspacePath, preview: { status: "stopped" as const },
    };
    const builder = new ArtifactBuilder();
    await expect(builder.create(project, undefined, config)).rejects.toThrow(/configured game service URL/);
    vi.stubEnv("MULTIPLAYER_PUBLISH_SERVER_URL", config.serverUrl);
    const checked = vi.fn(async () => Response.json({ ...config, deploymentId: "other" }));
    vi.stubGlobal("fetch", checked);
    await expect(builder.create(project, undefined, config)).rejects.toThrow(/does not match/);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(config)));
    const archive = await builder.create(project, undefined, config);
    expect((await zipEntries(archive)).map((entry) => entry.fileName)).toContain("manifest.json");
    expect(checked).toHaveBeenCalledWith(
      new URL("https://games.example.test/v1/games/stones/deployments/first"),
      expect.objectContaining({ redirect: "error" }),
    );
  });

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

  it("stores Plugin ZIP entries so the bytes do not depend on zlib", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-stored-"));
    await mkdir(path.join(source, "skills"));
    await writeFile(path.join(source, "example.txt"), "same content ".repeat(4096));
    await writeFile(path.join(source, "skills", "SKILL.md"), "# Skill\n".repeat(4096));

    const archive = await createPluginArchive(source);
    const entries = await zipEntries(archive);

    expect(entries.map((entry) => entry.fileName)).toEqual(["example.txt", "skills/SKILL.md"]);
    for (const entry of entries) {
      expect(entry.compressionMethod).toBe(0);
      expect(entry.compressedSize).toBe(entry.uncompressedSize);
    }
    expect(createHash("sha256").update(archive).digest("hex"))
      .toBe("6ec94c765105d7eea3633546bc65955e30c9eaab10579ab12ba8a3b7d00952ff");
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

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rejects when a file in the publish output cannot be read", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-unreadable-"));
    await writeFile(path.join(workspacePath, "index.html"), "game");
    await writeFile(path.join(workspacePath, "save.dat"), "locked");
    await chmod(path.join(workspacePath, "save.dat"), 0o000);

    await expect(new ArtifactBuilder().create({
      id: "unreadable-test", name: "Game", type: "web-game", updatedAt: new Date(0).toISOString(),
      workspacePath, preview: { status: "stopped" },
    })).rejects.toMatchObject({ code: "EACCES" });
  });

  it("rejects when files are removed after they are listed", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-removed-"));
    await writeFile(path.join(source, "first.txt"), "first");
    await writeFile(path.join(source, "second.txt"), "second");
    const mocked = vi.spyOn(fs, "stat").mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void;
      queueMicrotask(() => callback(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })));
    }) as typeof fs.stat);

    try {
      await expect(createPluginArchive(source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      mocked.mockRestore();
    }
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

function zipEntries(archive: Buffer): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("ZIP could not be opened."));
        return;
      }
      const entries: Entry[] = [];
      zip.once("error", reject);
      zip.once("end", () => resolve(entries));
      zip.on("entry", (entry: Entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}
