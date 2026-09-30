import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { PUBLISH_GAME_COVER_PATH } from "../src/shared/publish-v1.js";
import { createNodeGraphFixture, writePlayableFixtureWorkspace } from "./playable-fixture.js";

const token = "test-publisher-token";
const apps: FastifyInstance[] = [];
const configuredCloudRepository = process.env.OHMYGAME_CLOUD_ROOT ?? process.env.OHMYGAME_WEB_ROOT;
const cloudRepository = configuredCloudRepository
  ? path.resolve(configuredCloudRepository)
  : path.resolve(import.meta.dirname, "../../ohmygame-cloud");
const publishServerModule = path.join(cloudRepository, "apps", "api", "src", "app.ts");
const publishServerDependencies = path.join(cloudRepository, "node_modules", "fastify", "package.json");
const createPublishApp = existsSync(publishServerModule) && existsSync(publishServerDependencies)
  ? (await import(pathToFileURL(publishServerModule).href) as {
      createPublishApp: (options: {
        dataDirectory: string;
        playOrigin?: string;
        verifyPublisherToken: (token: string) => Promise<string | undefined>;
      }) => FastifyInstance;
    }).createPublishApp
  : undefined;
const describePublishContract = createPublishApp ? describe : describe.skip;
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describePublishContract("remote publish", () => {
  it("does not expose the removed Plugin marketplace", async () => {
    const runtime = await testRuntime();

    expect((await runtime.daemon.inject({ method: "POST", url: "/plugins/personal%3Atools/publish" })).statusCode).toBe(404);
    expect((await runtime.daemon.inject({ method: "POST", url: "/plugins/ohmygame%3Atools/install" })).statusCode).toBe(404);
    expect((await runtime.daemon.inject({ method: "POST", url: "/plugins/personal%3Atools/publication" })).statusCode).toBe(404);
    expect((await runtime.daemon.inject({
      method: "POST", url: "/community/plugin/plugin/use", payload: { accessToken: token },
    })).statusCode).toBe(404);
    expect((await runtime.daemon.inject({ method: "GET", url: "/plugins" })).json()).not.toHaveProperty("explore");
  });


  it("requires a user access token for each publish", async () => {
    const publishFetch = vi.fn(fetch);
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Signed out");
    await writeFile(path.join(project.workspacePath, "index.html"), "game");

    const response = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

    expect(response.statusCode).toBe(400);
    expect(publishFetch).not.toHaveBeenCalled();
  });

  it("publishes a static workspace and exposes it through remote Community", async () => {
    const runtime = await testRuntime();
    const project = await createProject(runtime.daemon, "Static game");
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>Game</h1>");
    await writeFile(path.join(project.workspacePath, "game.js"), "window.ready = true");
    await writeFile(path.join(project.workspacePath, ".env"), "SECRET=hidden");
    const cover = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    expect((await runtime.daemon.inject({
      method: "PUT",
      url: `/projects/${project.id}/cover`,
      headers: { "content-type": "image/webp" },
      payload: cover,
    })).statusCode).toBe(204);

    const response = await publishProject(runtime.daemon, project.id, { title: "Published title", description: "A fast static game" });

    expect(response.statusCode).toBe(201);
    const published = response.json();
    expect(published.game).toMatchObject({ title: "Published title", description: "A fast static game", deploymentId: published.deployment.id });
    expect(published.game.coverUrl).toBe(published.deployment.coverUrl);
    expect(await readFile(path.join(runtime.publishData, "artifacts", published.deployment.id, "index.html"), "utf8")).toContain("Game");
    expect(await readFile(path.join(runtime.publishData, "artifacts", published.deployment.id, PUBLISH_GAME_COVER_PATH))).toEqual(cover);
    expect(await readdir(path.join(runtime.publishData, "artifacts", published.deployment.id))).not.toContain(".env");
    expect((await runtime.daemon.inject({ method: "GET", url: "/community/games" })).json()).toEqual([
      { ...published.game, author: { id: "publisher", displayName: "OhMyGame Creator" } },
    ]);
    expect((await runtime.daemon.inject({ method: "POST", url: `/community/game/${published.game.id}/viewer`, payload: { accessToken: token } })).statusCode).toBe(404);
    expect((await runtime.daemon.inject({ method: "PUT", url: `/community/game/${published.game.id}/like`, payload: { accessToken: token, liked: true } })).statusCode).toBe(404);
    expect((await runtime.daemon.inject({ method: "POST", url: `/community/game/${published.game.id}/use`, payload: { accessToken: token } })).statusCode).toBe(404);
  });

  it("builds and publishes an Interactive Drama as a static game", async () => {
    const runtime = await testRuntime();
    const project = await createProject(runtime.daemon, "Drama", "interactive-drama");
    const videoContents = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const video = (await runtime.daemon.inject({
      method: "POST",
      url: "/library/assets/upload?name=clip.mp4&mediaType=video%2Fmp4&duration=1",
      headers: { "content-type": "application/octet-stream" },
      payload: videoContents,
    })).json();
    await writePublishableGraph(project.workspacePath, video.id);

    const built = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/interactive-drama/build` });
    expect(built.statusCode).toBe(200);
    expect(built.headers["content-type"]).toBe("application/zip");

    const published = await publishProject(runtime.daemon, project.id);
    expect(published.statusCode, published.body).toBe(201);
    const output = path.join(runtime.publishData, "artifacts", published.json().deployment.id);
    expect(await readFile(path.join(output, "index.html"), "utf8")).toContain("Published player");
    expect(await readFile(path.join(output, "playable-sandbox.html"), "utf8")).toContain("Playable sandbox");
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      version: 1,
      runtime: "playable-nodes",
      scope: `published:${project.id}`,
      assets: { clip: { type: "video", contentType: "video/mp4", size: videoContents.length } },
    });
    expect(await readFile(path.join(output, ...manifest.assets.clip.path.slice(2).split("/")))).toEqual(videoContents);
  }, 20_000);

  it("does not apply the remote publish size limit to a local Interactive Drama build", async () => {
    const runtime = await testRuntime();
    const project = await createProject(runtime.daemon, "Large Drama", "interactive-drama");
    await writePublishableGraph(project.workspacePath);
    await writeFile(path.join(runtime.playerDirectory, "large.bin"), randomBytes(26 * 1024 * 1024));

    const built = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/interactive-drama/build` });

    expect(built.statusCode, built.body).toBe(200);
    expect(built.rawPayload.length).toBeGreaterThan(25 * 1024 * 1024);
  }, 15_000);

  it("reuses the remote Game and persists its latest publication across restarts", async () => {
    const dataDirectory = await temporary("ohmygame-daemon-");
    const runtime = await testRuntime(dataDirectory);
    const project = await createProject(runtime.daemon, "Persistent");
    await writeFile(path.join(project.workspacePath, "index.html"), "one");
    const first = (await publishProject(runtime.daemon, project.id)).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "two");
    const second = (await publishProject(runtime.daemon, project.id, { title: "Persistent update", description: "Second release" })).json();

    expect(second.game.id).toBe(first.game.id);
    expect(second.game).toMatchObject({ title: "Persistent update", description: "Second release" });
    expect(second.deployment.id).not.toBe(first.deployment.id);
    expect(existsSync(path.join(runtime.publishData, "artifacts", first.deployment.id))).toBe(false);
    expect(await readFile(path.join(runtime.publishData, "artifacts", second.deployment.id, "index.html"), "utf8")).toBe("two");

    await runtime.daemon.close();
    apps.splice(apps.indexOf(runtime.daemon), 1);
    const restarted = createApp({ dataDirectory, publishApiUrl: runtime.apiUrl });
    apps.push(restarted);
    await restarted.ready();
    expect((await restarted.inject({ method: "GET", url: `/projects/${project.id}` })).json().publication).toEqual({
      gameId: second.game.id,
      deploymentId: second.deployment.id,
      playUrl: second.game.playUrl,
      publishedAt: second.game.publishedAt,
      title: second.game.title,
      description: second.game.description,
    });
  });

  it("runs the project build and uploads only its static output", async () => {
    const runtime = await testRuntime();
    const project = await createProject(runtime.daemon, "Built");
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { build: "node build.mjs" } }));
    await writeFile(path.join(project.workspacePath, "build.mjs"), `
      import { mkdir, writeFile } from "node:fs/promises";
      await mkdir("dist/assets", { recursive: true });
      await writeFile("dist/index.html", "built");
      await writeFile("dist/assets/game.js", "window.built = true");
    `);

    const response = await publishProject(runtime.daemon, project.id);

    expect(response.statusCode).toBe(201);
    const deployment = response.json().deployment;
    expect(await readFile(path.join(runtime.publishData, "artifacts", deployment.id, "assets", "game.js"), "utf8")).toContain("built");
    expect(await readdir(path.join(runtime.publishData, "artifacts", deployment.id))).not.toContain("build.mjs");
  });

  it("rejects a package project without a build command", async () => {
    const publishFetch = vi.fn(fetch);
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Source project");
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await writeFile(path.join(project.workspacePath, "index.html"), '<script type="module" src="/src/main.jsx"></script>');

    const response = await publishProject(runtime.daemon, project.id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Projects with package.json need a non-empty scripts.build command before publishing",
    });
    expect(publishFetch).not.toHaveBeenCalled();
  });

  it("rejects an empty workspace before contacting the publish service", async () => {
    const publishFetch = vi.fn(fetch);
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Empty");

    const response = await publishProject(runtime.daemon, project.id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Project has no build script or static index.html yet" });
    expect(publishFetch).not.toHaveBeenCalled();
  });

  it("retries an interrupted upload with the same idempotency key", async () => {
    let deploymentRequests = 0;
    const keys: string[] = [];
    const publishFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/deployments")) {
        deploymentRequests += 1;
        keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        if (deploymentRequests === 1) {
          await fetch(input, init);
          throw new Error("connection closed after upload");
        }
      }
      return fetch(input, init);
    };
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Retry");
    await writeFile(path.join(project.workspacePath, "index.html"), "retry");

    const response = await publishProject(runtime.daemon, project.id);

    expect(response.statusCode).toBe(201);
    expect(deploymentRequests).toBe(2);
    expect(new Set(keys).size).toBe(1);
    expect(await readdir(path.join(runtime.publishData, "artifacts"))).toHaveLength(1);
  });

  it("recovers a remote deployment when local publication was not committed", async () => {
    let lostListingResponses = 0;
    const publishFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/listing") && lostListingResponses < 2) {
        lostListingResponses += 1;
        throw new Error("connection closed after listing");
      }
      return response;
    };
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Recover");
    await writeFile(path.join(project.workspacePath, "index.html"), "recover");

    const failed = await publishProject(runtime.daemon, project.id);
    await writeFile(path.join(project.workspacePath, "index.html"), "recover");
    const recovered = await publishProject(runtime.daemon, project.id);

    expect(failed.statusCode).toBe(502);
    expect(recovered.statusCode).toBe(201);
    expect(await readdir(path.join(runtime.publishData, "artifacts"))).toHaveLength(1);
  });

  it("recovers a remote update when local publication is stale", async () => {
    let loseListingResponses = false;
    let lost = 0;
    const publishFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (loseListingResponses && String(input).endsWith("/listing") && lost < 2) {
        lost += 1;
        throw new Error("connection closed after listing");
      }
      return response;
    };
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Recover update");
    await writeFile(path.join(project.workspacePath, "index.html"), "one");
    const first = await publishProject(runtime.daemon, project.id);
    loseListingResponses = true;
    await writeFile(path.join(project.workspacePath, "index.html"), "two");

    const failed = await publishProject(runtime.daemon, project.id);
    const recovered = await publishProject(runtime.daemon, project.id);

    expect(first.statusCode).toBe(201);
    expect(failed.statusCode).toBe(502);
    expect(recovered.statusCode).toBe(201);
    expect(recovered.json().deployment.id).not.toBe(first.json().deployment.id);
    expect(await readdir(path.join(runtime.publishData, "artifacts"))).toEqual([recovered.json().deployment.id]);
  });

  it("uploads current workspace changes instead of recovering a different remote artifact", async () => {
    let loseListingResponses = false;
    let lost = 0;
    const publishFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (loseListingResponses && String(input).endsWith("/listing") && lost < 2) {
        lost += 1;
        throw new Error("connection closed after listing");
      }
      return response;
    };
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Latest workspace");
    await writeFile(path.join(project.workspacePath, "index.html"), "one");
    await publishProject(runtime.daemon, project.id);
    loseListingResponses = true;
    await writeFile(path.join(project.workspacePath, "index.html"), "two");
    const failed = await publishProject(runtime.daemon, project.id);
    await writeFile(path.join(project.workspacePath, "index.html"), "three");

    const published = await publishProject(runtime.daemon, project.id);

    expect(failed.statusCode).toBe(502);
    expect(published.statusCode).toBe(201);
    expect(await readFile(
      path.join(runtime.publishData, "artifacts", published.json().deployment.id, "index.html"),
      "utf8",
    )).toBe("three");
    expect(await readdir(path.join(runtime.publishData, "artifacts"))).toEqual([published.json().deployment.id]);
  });

  it("rejects a concurrent publish for the same project", async () => {
    let uploadStarted!: () => void;
    let releaseUpload!: () => void;
    const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const publishFetch: typeof fetch = async (input, init) => {
      if (String(input).includes("/deployments")) {
        uploadStarted();
        await release;
      }
      return fetch(input, init);
    };
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Concurrent");
    await writeFile(path.join(project.workspacePath, "index.html"), "game");
    const first = publishProject(runtime.daemon, project.id);
    await started;

    const second = await publishProject(runtime.daemon, project.id);
    releaseUpload();

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "Project is already being published" });
    expect((await first).statusCode).toBe(201);
  });

  it("loads remote Community games", async () => {
    const games = [communityGame("game-1"), communityGame("game-2")];
    const publishFetch = vi.fn(async () => Response.json(games));
    const daemon = createApp({
      dataDirectory: await temporary("ohmygame-daemon-"),
      publishApiUrl: "https://publish.example",
      publishFetch,
    });
    apps.push(daemon);

    const response = await daemon.inject({ method: "GET", url: "/community/games" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(games);
    expect(publishFetch).toHaveBeenCalledOnce();
  });

  it("loads a remote Community game by id", async () => {
    const game = communityGame("game 1");
    const publishFetch = vi.fn(async () => Response.json(game));
    const daemon = createApp({
      dataDirectory: await temporary("ohmygame-daemon-"),
      publishApiUrl: "https://publish.example",
      publishFetch,
    });
    apps.push(daemon);

    const response = await daemon.inject({ method: "GET", url: "/community/games/game%201" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(game);
    expect(publishFetch).toHaveBeenCalledWith(
      "https://publish.example/v1/community/games/game%201",
      expect.anything(),
    );
  });

  it("proxies a remote Community game cover", async () => {
    const cover = Buffer.from("cover");
    const publishFetch = vi.fn(async () => new Response(cover, { headers: { "content-type": "image/webp" } }));
    const daemon = createApp({
      dataDirectory: await temporary("ohmygame-daemon-"),
      publishApiUrl: "https://publish.example",
      publishFetch,
    });
    apps.push(daemon);

    const response = await daemon.inject({
      method: "GET",
      url: "/community/games/game%201/deployments/deployment%201/cover",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload).toEqual(cover);
    expect(publishFetch).toHaveBeenCalledWith(
      "https://publish.example/v1/community/games/game%201/deployments/deployment%201/cover",
      expect.anything(),
    );
  });

  it("rejects an artifact larger than the publish limit before upload", async () => {
    const publishFetch = vi.fn(fetch);
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Large");
    await writeFile(path.join(project.workspacePath, "index.html"), "game");
    await writeFile(path.join(project.workspacePath, "large.bin"), randomBytes(26 * 1024 * 1024));

    const response = await publishProject(runtime.daemon, project.id);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "Publish artifact exceeds 25 MB" });
    expect(publishFetch).not.toHaveBeenCalled();
  });

  it("keeps the user token out of the project and published artifact", async () => {
    const runtime = await testRuntime();
    const project = await createProject(runtime.daemon, "Private token");
    await writeFile(path.join(project.workspacePath, "index.html"), "safe");
    const response = await publishProject(runtime.daemon, project.id);
    const metadata = await readFile(path.join(path.dirname(project.workspacePath), "project.json"), "utf8");
    const artifact = await readFile(path.join(runtime.publishData, "artifacts", response.json().deployment.id, "index.html"), "utf8");

    expect(metadata).not.toContain(token);
    expect(artifact).not.toContain(token);
    expect(await readdir(project.workspacePath)).toEqual(["AGENTS.md", "index.html"]);
    await expect(readFile(path.join(runtime.publishData, "artifacts", response.json().deployment.id, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/** The Ash Club fixture, whose Signals are all connected, with an optional Library video. */
async function writePublishableGraph(workspacePath: string, clipAssetId?: string): Promise<void> {
  const graph = createNodeGraphFixture();
  delete graph.assets.theme;
  for (const node of graph.nodes) node.assets = node.assets.filter((id) => id !== "theme");
  if (clipAssetId) {
    graph.assets.clip = { type: "video", source: { kind: "library", assetId: clipAssetId } };
    graph.nodes[0]!.assets.push("clip");
  }
  await rm(path.join(workspacePath, "nodes"), { recursive: true, force: true });
  await writePlayableFixtureWorkspace(workspacePath, graph);
}

async function testRuntime(dataDirectory = undefined as string | undefined, publishFetch?: typeof fetch, imageGenerator?: ImageGenerator) {
  const publishData = await temporary("ohmygame-publish-server-");
  const publishServer = createPublishApp!({
    dataDirectory: publishData,
    playOrigin: "http://localhost:43130",
    verifyPublisherToken: async (value) => value === token ? "publisher" : undefined,
  });
  apps.push(publishServer);
  const apiUrl = await publishServer.listen({ host: "127.0.0.1", port: 0 });
  const playerDirectory = await temporary("ohmygame-player-");
  await writeFile(path.join(playerDirectory, "index.html"), "<h1>Published player</h1>");
  await writeFile(path.join(playerDirectory, "player.js"), "window.player = true");
  await mkdir(path.join(playerDirectory, "assets"), { recursive: true });
  await writeFile(path.join(playerDirectory, "playable-sandbox.html"), "Playable sandbox");
  await writeFile(path.join(playerDirectory, "assets", "playable-sandbox.js"), "window.sandbox = true");
  const daemon = createApp({
    dataDirectory: dataDirectory ?? await temporary("ohmygame-daemon-"),
    publishApiUrl: apiUrl,
    publishFetch,
    imageGenerator,
    interactiveDramaPlayerDirectory: playerDirectory,
  });
  apps.push(daemon);
  await daemon.ready();
  return { apiUrl, daemon, playerDirectory, publishData, publishServer };
}

async function createProject(app: FastifyInstance, name: string, type?: "web-game" | "interactive-drama") {
  return (await app.inject({ method: "POST", url: "/projects", payload: { name, ...(type ? { type } : {}) } })).json();
}

async function publishProject(app: FastifyInstance, projectId: string, metadata?: { title: string; description?: string }) {
  const project = (await app.inject({ method: "GET", url: `/projects/${projectId}` })).json();
  return app.inject({
    method: "POST",
    url: `/projects/${projectId}/publish`,
    payload: { accessToken: token, title: metadata?.title ?? project.name, description: metadata?.description ?? "" },
  });
}

function temporary(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function communityGame(id: string) {
  return {
    id,
    title: id,
    description: "",
    deploymentId: `deployment-${id}`,
    playUrl: `https://play.example/${id}`,
    publishedAt: new Date(0).toISOString(),
  };
}
