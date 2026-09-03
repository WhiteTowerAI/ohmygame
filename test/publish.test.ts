import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { createPublishApp } from "../src/publish-server/app.js";

const token = "test-publisher-token";
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("remote publish", () => {
  it("saves, publishes, and loads an Asset Template from Explore", async () => {
    const runtime = await testRuntime();
    const saved = await runtime.daemon.inject({
      method: "POST", url: "/asset-templates", payload: {
        mode: "video",
        name: "Cinematic Shot",
        description: "One deliberate shot",
        promptLabel: "Prompt",
        promptPlaceholder: "Describe the shot",
        defaultPrompt: "Use continuous camera motion",
        defaults: { videoResolution: "768P", videoAspectRatio: "16:9", videoDuration: 8 },
      },
    });
    expect(saved.statusCode).toBe(201);
    const published = await runtime.daemon.inject({
      method: "POST", url: `/asset-templates/${saved.json().id}/publish`, payload: { accessToken: token },
    });
    expect(published.statusCode, published.body).toBe(201);
    expect((await runtime.daemon.inject({ method: "GET", url: "/asset-templates" })).json()).toEqual([
      expect.objectContaining({ id: saved.json().id, publication: expect.objectContaining({ templateId: published.json().template.id }) }),
    ]);
    expect((await runtime.daemon.inject({ method: "GET", url: "/explore/templates" })).json()).toEqual([
      expect.objectContaining({ name: "Cinematic Shot", source: "catalog", releaseId: published.json().release.id }),
    ]);
  });

  it("publishes, installs, and updates a Catalog Plugin without re-enabling it", async () => {
    const runtime = await testRuntime();
    const source = await temporary("open-game-published-plugin-");
    await mkdir(path.join(source, ".opengame-plugin"));
    await mkdir(path.join(source, "skills", "levels"), { recursive: true });
    await writeFile(path.join(source, "skills", "levels", "SKILL.md"), "---\nname: levels\ndescription: Build levels.\n---\n");
    const writeManifest = (version: string) => writeFile(path.join(source, ".opengame-plugin", "plugin.json"), JSON.stringify({
      name: "level-tools", version, description: "Level workflows", skills: "./skills",
      interface: { displayName: "Level Tools", defaultPrompt: ["Build a level"] },
    }));
    await writeManifest("1.0.0");
    await runtime.daemon.inject({ method: "POST", url: "/plugins/install", payload: { type: "directory", path: source } });
    const published = await runtime.daemon.inject({
      method: "POST", url: "/plugins/personal%3Alevel-tools/publish", payload: { accessToken: token },
    });
    expect(published.statusCode).toBe(201);

    const consumer = createApp({ dataDirectory: await temporary("open-game-plugin-consumer-"), publishApiUrl: runtime.apiUrl });
    apps.push(consumer);
    await consumer.ready();
    const catalog = await consumer.inject({ method: "GET", url: "/plugins" });
    expect(catalog.json().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "opengame:level-tools", installed: false, version: "1.0.0" }),
    ]));
    expect((await consumer.inject({ method: "GET", url: "/plugins/opengame%3Alevel-tools" })).json()).toMatchObject({
      installed: false,
      skills: [{ name: "Levels", enabled: true }],
    });
    const installed = await consumer.inject({ method: "POST", url: "/plugins/opengame%3Alevel-tools/install" });
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json()).toMatchObject({
      id: "opengame:level-tools", version: "1.0.0", installed: true, enabled: true,
      source: { type: "catalog" },
    });
    await consumer.inject({
      method: "PUT", url: "/plugins/opengame%3Alevel-tools/settings", payload: { enabled: false, components: {} },
    });

    await writeManifest("1.1.0");
    await runtime.daemon.inject({ method: "POST", url: "/plugins/install", payload: { type: "directory", path: source } });
    expect((await runtime.daemon.inject({
      method: "POST", url: "/plugins/personal%3Alevel-tools/publish", payload: { accessToken: token },
    })).statusCode).toBe(201);
    const update = (await consumer.inject({ method: "GET", url: "/plugins" })).json().plugins
      .find((plugin: { id: string }) => plugin.id === "opengame:level-tools");
    expect(update).toMatchObject({ version: "1.0.0", latestVersion: "1.1.0", updateAvailable: true });
    expect((await consumer.inject({ method: "GET", url: "/plugins/opengame%3Alevel-tools" })).json())
      .toMatchObject({ version: "1.0.0", latestVersion: "1.1.0", updateAvailable: true });
    expect((await consumer.inject({ method: "POST", url: "/plugins/opengame%3Alevel-tools/install" })).statusCode).toBe(201);
    expect((await consumer.inject({ method: "GET", url: "/plugins/opengame%3Alevel-tools" })).json())
      .toMatchObject({ version: "1.1.0", enabled: false });
  });

  it("publishes and installs a Claude marketplace Plugin without rewriting its manifest", async () => {
    const runtime = await testRuntime();
    const source = await temporary("open-game-claude-plugin-");
    await mkdir(path.join(source, ".claude-plugin"));
    await mkdir(path.join(source, "skills", "levels"), { recursive: true });
    await writeFile(path.join(source, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "game-skills",
      plugins: [{ name: "level-tools", source: "./", description: "Level workflows", skills: ["./skills/levels"] }],
    }));
    await writeFile(path.join(source, "skills", "levels", "SKILL.md"), "---\nname: levels\ndescription: Build levels.\n---\n");
    const installed = await runtime.daemon.inject({
      method: "POST", url: "/plugins/install",
      payload: { type: "directory", path: source, candidate: "marketplace:game-skills:level-tools" },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json().version).toBeUndefined();

    const missingVersion = await runtime.daemon.inject({
      method: "POST", url: "/plugins/marketplace%3Agame-skills%3Alevel-tools/publish",
      payload: { accessToken: token },
    });
    expect(missingVersion.statusCode).toBe(400);
    expect(missingVersion.json().error).toContain("semantic version");

    const published = await runtime.daemon.inject({
      method: "POST", url: "/plugins/marketplace%3Agame-skills%3Alevel-tools/publish",
      payload: { accessToken: token, version: "0.1.0" },
    });
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json().release.manifest).toMatchObject({ name: "level-tools", version: "0.1.0" });

    const consumer = createApp({ dataDirectory: await temporary("open-game-claude-plugin-consumer-"), publishApiUrl: runtime.apiUrl });
    apps.push(consumer);
    await consumer.ready();
    const catalogInstall = await consumer.inject({ method: "POST", url: "/plugins/opengame%3Alevel-tools/install" });
    expect(catalogInstall.statusCode, catalogInstall.body).toBe(201);
    expect(catalogInstall.json()).toMatchObject({
      id: "opengame:level-tools",
      version: "0.1.0",
      skills: [{ name: "Levels" }],
    });
  });

  it("shares a project Asset, browses it, and imports it into an existing project", async () => {
    const runtime = await testRuntime();
    const source = await createProject(runtime.daemon, "Source");
    const target = await createProject(runtime.daemon, "Target");
    await writeFile(path.join(source.workspacePath, "sprite.png"), "image-one");

    const shared = await publishAsset(runtime.daemon, source.id, "sprite.png");
    expect(shared.statusCode).toBe(201);
    const first = shared.json();
    const explored = await runtime.daemon.inject({ method: "GET", url: "/explore/assets" });
    expect(explored.json()).toMatchObject([{ id: first.asset.id, title: "sprite", mediaType: "image" }]);

    await writeFile(path.join(source.workspacePath, "sprite.png"), "image-two");
    const updated = (await publishAsset(runtime.daemon, source.id, "sprite.png")).json();
    expect(updated.asset.id).toBe(first.asset.id);
    expect(updated.release.id).not.toBe(first.release.id);

    const renamed = await runtime.daemon.inject({
      method: "PATCH",
      url: `/projects/${source.id}/assets?path=sprite.png`,
      payload: { name: "hero" },
    });
    expect(renamed.statusCode).toBe(200);
    const republished = await publishAsset(runtime.daemon, source.id, "hero.png");
    expect(republished.statusCode).toBe(201);
    expect(republished.json().asset.id).toBe(first.asset.id);
    expect(republished.json().release.fileName).toBe("hero.png");

    const imported = await runtime.daemon.inject({ method: "POST", url: `/projects/${target.id}/assets/import`, payload: { assetId: first.asset.id } });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().path).toBe("assets/imported/hero.png");
    expect(await readFile(path.join(target.workspacePath, imported.json().path), "utf8")).toBe("image-two");
    const duplicate = await runtime.daemon.inject({ method: "POST", url: `/projects/${target.id}/assets/import`, payload: { assetId: first.asset.id } });
    expect(duplicate.json().path).toBe("assets/imported/hero-2.png");

    const metadata = JSON.parse(await readFile(path.join(source.workspacePath, ".data", "assets.json"), "utf8"));
    expect(metadata.publications["hero.png"]).toMatchObject({ assetId: first.asset.id, releaseId: republished.json().release.id });
    expect(JSON.stringify(metadata)).not.toContain(token);
  });

  it("rejects a downloaded Asset whose contents fail integrity verification", async () => {
    const asset = {
      id: "asset-1", title: "Asset", description: "", mediaType: "image", releaseId: "release-1",
      artifactSha256: "0".repeat(64), artifactBytes: 4, fileName: "asset.png", contentType: "image/png",
      publishedAt: new Date(0).toISOString(),
    };
    const daemon = createApp({
      dataDirectory: await temporary("open-game-daemon-"),
      publishApiUrl: "https://publish.example",
      publishFetch: async (input) => String(input).endsWith("/content")
        ? new Response("fake", { headers: { "content-type": "image/png" } })
        : Response.json(asset),
    });
    apps.push(daemon);
    const project = await createProject(daemon, "Target");
    const response = await daemon.inject({ method: "POST", url: `/projects/${project.id}/assets/import`, payload: { assetId: asset.id } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Downloaded asset failed integrity verification" });
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

    const response = await publishProject(runtime.daemon, project.id);

    expect(response.statusCode).toBe(201);
    const published = response.json();
    expect(published.game).toMatchObject({ title: "Static game", description: "", deploymentId: published.deployment.id });
    expect(await readFile(path.join(runtime.publishData, "artifacts", published.deployment.id, "index.html"), "utf8")).toContain("Game");
    expect(await readdir(path.join(runtime.publishData, "artifacts", published.deployment.id))).not.toContain(".env");
    expect((await runtime.daemon.inject({ method: "GET", url: "/community/games" })).json()).toEqual([published.game]);
  });

  it("reuses the remote Game and persists its latest publication across restarts", async () => {
    const dataDirectory = await temporary("open-game-daemon-");
    const runtime = await testRuntime(dataDirectory);
    const project = await createProject(runtime.daemon, "Persistent");
    await writeFile(path.join(project.workspacePath, "index.html"), "one");
    const first = (await publishProject(runtime.daemon, project.id)).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "two");
    const second = (await publishProject(runtime.daemon, project.id)).json();

    expect(second.game.id).toBe(first.game.id);
    expect(second.deployment.id).not.toBe(first.deployment.id);
    expect(await readFile(path.join(runtime.publishData, "artifacts", first.deployment.id, "index.html"), "utf8")).toBe("one");
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
    expect(await readdir(path.join(runtime.publishData, "artifacts"))).toHaveLength(2);
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
    expect(await readdir(path.join(runtime.publishData, "artifacts"))).toHaveLength(3);
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
      dataDirectory: await temporary("open-game-daemon-"),
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
      dataDirectory: await temporary("open-game-daemon-"),
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
    expect(await readdir(project.workspacePath)).toEqual(["index.html"]);
  });
});

async function testRuntime(dataDirectory = undefined as string | undefined, publishFetch?: typeof fetch) {
  const publishData = await temporary("open-game-publish-server-");
  const publishServer = createPublishApp({
    dataDirectory: publishData,
    playOrigin: "http://localhost:43130",
    verifyPublisherToken: async (value) => value === token ? "publisher" : undefined,
  });
  apps.push(publishServer);
  const apiUrl = await publishServer.listen({ host: "127.0.0.1", port: 0 });
  const daemon = createApp({
    dataDirectory: dataDirectory ?? await temporary("open-game-daemon-"),
    publishApiUrl: apiUrl,
    publishFetch,
  });
  apps.push(daemon);
  await daemon.ready();
  return { apiUrl, daemon, publishData, publishServer };
}

async function createProject(app: FastifyInstance, name: string) {
  return (await app.inject({ method: "POST", url: "/projects", payload: { name } })).json();
}

function publishProject(app: FastifyInstance, projectId: string) {
  return app.inject({
    method: "POST",
    url: `/projects/${projectId}/publish`,
    payload: { accessToken: token },
  });
}

function publishAsset(app: FastifyInstance, projectId: string, assetPath: string) {
  return app.inject({
    method: "POST",
    url: `/projects/${projectId}/assets/publish?path=${encodeURIComponent(assetPath)}`,
    payload: { accessToken: token },
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
