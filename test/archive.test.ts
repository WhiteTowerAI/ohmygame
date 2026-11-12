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
import { gameServiceUrlFor, PRODUCTION_GAME_SERVICE_URL } from "../src/daemon/publish/game-service.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("publish archives", () => {
  const localConfig = {
    enabled: true as const, mode: "turn-based" as const, gameId: "gomoku", deploymentId: "local-v1",
    protocolVersion: 1 as const, serverUrl: "http://127.0.0.1:43130", authPolicy: "anonymous" as const,
    roomPolicy: "invite-or-public" as const, maxClients: 2, reconnectSeconds: 120, adapterId: "gomoku",
  };
  const projectAt = (workspacePath: string) => ({ id: "local-board", name: "Board", type: "web-game" as const, updatedAt: new Date(0).toISOString(), workspacePath, preview: { status: "stopped" as const } });

  it("publishes and exports games that bring their own networking, such as PeerJS", async () => {
    // Games made before OhMyGame's multiplayer may use PeerJS; they keep publishing and exporting.
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-peerjs-publish-"));
    await writeFile(path.join(directory, "index.html"), '<script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>');
    await expect(new ArtifactBuilder().create(projectAt(directory))).resolves.toBeInstanceOf(Buffer);
    await expect(new ArtifactBuilder().build(projectAt(directory))).resolves.toBeInstanceOf(Buffer);
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
    // Public publishing registers the rooms with OhMyGame's game service, which this builder has none of.
    await expect(builder.create(projectAt(directory))).rejects.toThrow(/needs OhMyGame's game service/);
    const fetchDeployment = vi.fn(async () => Response.json(localConfig));
    vi.stubGlobal("fetch", fetchDeployment);
    await expect(builder.createLocal(projectAt(directory))).resolves.toBeInstanceOf(Buffer);
    expect(fetchDeployment).toHaveBeenCalledWith(new URL("http://127.0.0.1:43130/v1/games/gomoku/deployments/local-v1"), expect.objectContaining({ redirect: "error" }));

    // An export has no OhMyGame game to register rooms for: it keeps the deployment the
    // build names, with or without a game service, and asks no service about it.
    fetchDeployment.mockClear();
    for (const exporter of [builder, new ArtifactBuilder({ gameServiceUrl: "https://games.example" })]) {
      await expect(exporter.build(projectAt(directory))).resolves.toBeInstanceOf(Buffer);
      const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-export-multiplayer-"));
      await exporter.buildFolder(projectAt(directory), folder);
      expect(JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")).multiplayer).toEqual(localConfig);
    }
    expect(fetchDeployment).not.toHaveBeenCalled();
    // It still refuses a build that names another deployment than the game declares.
    await writeFile(path.join(directory, "multiplayer.json"), JSON.stringify({ multiplayer: { ...localConfig, deploymentId: "other" } }));
    await expect(builder.build(projectAt(directory))).rejects.toThrow(/do not match/);
  });

  it("uses OhMyGame's production game service for the production cloud unless told otherwise", () => {
    expect(gameServiceUrlFor({}, "https://cloud.ohmygame.ai/")).toBe(PRODUCTION_GAME_SERVICE_URL);
    // A local or test cloud never reaches production's game service by default.
    expect(gameServiceUrlFor({}, "http://127.0.0.1:43130")).toBeUndefined();
    expect(gameServiceUrlFor({}, undefined)).toBeUndefined();
    expect(gameServiceUrlFor({ OHMYGAME_GAME_SERVICE_URL: "https://games.test.example" }, "https://cloud.ohmygame.ai")).toBe("https://games.test.example");
    expect(gameServiceUrlFor({ MULTIPLAYER_PUBLISH_SERVER_URL: "https://legacy.example" }, "http://127.0.0.1:43130")).toBe("https://legacy.example");
  });

  it("registers a game's local rooms with OhMyGame's game service as its publisher", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-register-multiplayer-"));
    await writeFile(path.join(directory, "index.html"), "board");
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ title: "Board", multiplayer: localConfig }));
    await writeFile(path.join(directory, "multiplayer.json"), JSON.stringify({ multiplayer: localConfig }));
    const registered = {
      ...localConfig,
      gameId: "game-1",
      deploymentId: "d-registered",
      serverUrl: "https://games.ohmygame.example/",
      authPolicy: "guest-or-account" as const,
    };
    const register = vi.fn(async (_url: URL, _init: RequestInit) => Response.json(registered, { status: 201 }));
    vi.stubGlobal("fetch", register);
    const builder = new ArtifactBuilder({ gameServiceUrl: "https://games.ohmygame.example/" });
    const prepared = await builder.prepare(projectAt(directory));
    await expect(prepared.package("game-1")).rejects.toThrow(/publisher's sign-in/);
    const manifest = JSON.parse(await zipFile(await prepared.package("game-1", { accessToken: "publisher-token" }), "manifest.json"));
    expect(manifest.multiplayer).toEqual(registered);
    const [url, init] = register.mock.calls[0]!;
    expect(String(url)).toBe("https://games.ohmygame.example/v1/games/game-1/deployments");
    expect(init.headers).toMatchObject({ Authorization: "Bearer publisher-token" });
    expect(JSON.parse(String(init.body))).toEqual({
      mode: localConfig.mode, adapterId: localConfig.adapterId, maxClients: localConfig.maxClients,
      roomPolicy: localConfig.roomPolicy, reconnectSeconds: localConfig.reconnectSeconds,
    });
    // A refusal or an answer for other rooms stops the publish.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Only the game's publisher may register its deployments." }, { status: 403 })));
    await expect(prepared.package("game-1", { accessToken: "other" })).rejects.toThrow(/refused the game's rooms: Only the game's publisher/);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...registered, maxClients: 8 })));
    await expect(prepared.package("game-1", { accessToken: "publisher-token" })).rejects.toThrow(/different deployment/);
    await prepared.dispose();
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
      adapterId: "stones",
    };
    const project = {
      id: "multiplayer-test", name: "Stones", type: "web-game" as const,
      updatedAt: new Date(0).toISOString(), workspacePath, preview: { status: "stopped" as const },
    };
    await expect(new ArtifactBuilder().create(project, undefined, config)).rejects.toThrow(/configured game service URL/);
    const builder = new ArtifactBuilder({ gameServiceUrl: `${config.serverUrl}/` });
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

  it("adds OhMyGame sign-in to published games that have a manifest, never to local builds", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-account-publish-"));
    await writeFile(path.join(directory, "index.html"), "game");
    const account = { issuer: "https://api.ohmygame.example" };
    expect(() => new ArtifactBuilder({ account: { issuer: "http://api.ohmygame.example" } })).toThrow("HTTPS");
    const builder = new ArtifactBuilder({ account });
    // A game without a manifest does not load the SDK, so it gets none.
    expect((await zipEntries(await builder.create(projectAt(directory)))).map((entry) => entry.fileName)).not.toContain("manifest.json");
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ title: "Board" }));
    expect(JSON.parse(await zipFile(await builder.create(projectAt(directory)), "manifest.json"))).toEqual({ title: "Board", account });
    expect(JSON.parse(await zipFile(await builder.createLocal(projectAt(directory)), "manifest.json"))).toEqual({ title: "Board" });
  });

  it("names the game's cloud saves service in published games, never in local builds", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-cloud-publish-"));
    await writeFile(path.join(directory, "index.html"), "game");
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ title: "Puzzle" }));
    expect(() => new ArtifactBuilder({ gameServiceUrl: "http://games.ohmygame.example/" })).toThrow("HTTPS");
    const builder = new ArtifactBuilder({ gameServiceUrl: "https://games.ohmygame.example/" });
    const prepared = await builder.prepare(projectAt(directory));
    const packaged = await prepared.package("game-1");
    await prepared.dispose();
    expect(JSON.parse(await zipFile(packaged, "manifest.json"))).toEqual({
      title: "Puzzle",
      cloud: { serverUrl: "https://games.ohmygame.example/", gameId: "game-1" },
    });
    // The local service's test sign-in and saves give way to OhMyGame's, or go.
    const local = { account: { issuer: "http://127.0.0.1:43139" }, cloud: { serverUrl: "http://127.0.0.1:43139/", gameId: "project-1" } };
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ title: "Puzzle", ...local }));
    const replaced = await builder.prepare(projectAt(directory));
    expect(JSON.parse(await zipFile(await replaced.package("game-1"), "manifest.json"))).toEqual({
      title: "Puzzle",
      cloud: { serverUrl: "https://games.ohmygame.example/", gameId: "game-1" },
    });
    await replaced.dispose();
    expect(JSON.parse(await zipFile(await builder.createLocal(projectAt(directory)), "manifest.json"))).toEqual({ title: "Puzzle", ...local });
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ title: "Puzzle" }));
    // Without the game's ID, or in a local build, saves stay in the browser.
    expect(JSON.parse(await zipFile(await builder.create(projectAt(directory)), "manifest.json"))).toEqual({ title: "Puzzle" });
    expect(JSON.parse(await zipFile(await builder.createLocal(projectAt(directory)), "manifest.json"))).toEqual({ title: "Puzzle" });
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

  it("leaves the project's ohmygame.json out of a published game", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-project-file-"));
    await writeFile(path.join(workspacePath, "index.html"), "game");
    await writeFile(path.join(workspacePath, "ohmygame.json"), JSON.stringify({ type: "general" }));
    await mkdir(path.join(workspacePath, "data"));
    await writeFile(path.join(workspacePath, "data", "ohmygame.json"), "the game's own");
    const destination = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-output-"));
    await new ArtifactBuilder().buildFolder({
      id: "project-file-test", name: "Game", type: "web-game", updatedAt: new Date(0).toISOString(),
      workspacePath, preview: { status: "stopped" },
    }, destination);
    expect(fs.readdirSync(destination, { recursive: true }).map(String).sort()).toEqual(["data", path.join("data", "ohmygame.json"), "index.html"]);
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

/** The text of one file in a ZIP. */
function zipFile(archive: Buffer, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("ZIP could not be opened."));
        return;
      }
      zip.once("error", reject);
      zip.once("end", () => reject(new Error(`${name} is not in the ZIP.`)));
      zip.on("entry", (entry: Entry) => {
        if (entry.fileName !== name) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`${name} could not be read.`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("error", reject);
          stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
      });
      zip.readEntry();
    });
  });
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
