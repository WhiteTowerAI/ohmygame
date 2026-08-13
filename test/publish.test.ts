import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
  it("publishes a static workspace and exposes it through remote Community", async () => {
    const runtime = await testRuntime();
    const project = await createProject(runtime.daemon, "Static game");
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>Game</h1>");
    await writeFile(path.join(project.workspacePath, "game.js"), "window.ready = true");
    await writeFile(path.join(project.workspacePath, ".env"), "SECRET=hidden");

    const response = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

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
    const first = (await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "two");
    const second = (await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` })).json();

    expect(second.game.id).toBe(first.game.id);
    expect(second.deployment.id).not.toBe(first.deployment.id);
    expect(await readFile(path.join(runtime.publishData, "artifacts", first.deployment.id, "index.html"), "utf8")).toBe("one");
    expect(await readFile(path.join(runtime.publishData, "artifacts", second.deployment.id, "index.html"), "utf8")).toBe("two");

    await runtime.daemon.close();
    apps.splice(apps.indexOf(runtime.daemon), 1);
    const restarted = createApp({ dataDirectory, publishApiUrl: runtime.apiUrl, publishToken: token });
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

    const response = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

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

    const response = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

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

    const response = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

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

    const response = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

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

    const failed = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });
    await writeFile(path.join(project.workspacePath, "index.html"), "recover");
    const recovered = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

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
    const first = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });
    loseListingResponses = true;
    await writeFile(path.join(project.workspacePath, "index.html"), "two");

    const failed = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });
    const recovered = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

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
    await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });
    loseListingResponses = true;
    await writeFile(path.join(project.workspacePath, "index.html"), "two");
    const failed = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });
    await writeFile(path.join(project.workspacePath, "index.html"), "three");

    const published = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

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
    const first = runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });
    await started;

    const second = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });
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

  it("rejects an artifact larger than the publish limit before upload", async () => {
    const publishFetch = vi.fn(fetch);
    const runtime = await testRuntime(undefined, publishFetch);
    const project = await createProject(runtime.daemon, "Large");
    await writeFile(path.join(project.workspacePath, "index.html"), "game");
    await writeFile(path.join(project.workspacePath, "large.bin"), randomBytes(26 * 1024 * 1024));

    const response = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "Publish artifact exceeds 25 MB" });
    expect(publishFetch).not.toHaveBeenCalled();
  });

  it("keeps credentials out of the project and published artifact", async () => {
    const runtime = await testRuntime();
    const project = await createProject(runtime.daemon, "Private token");
    await writeFile(path.join(project.workspacePath, "index.html"), "safe");
    const response = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });
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
    publisher: { id: "publisher", token },
  });
  apps.push(publishServer);
  const apiUrl = await publishServer.listen({ host: "127.0.0.1", port: 0 });
  const daemon = createApp({
    dataDirectory: dataDirectory ?? await temporary("open-game-daemon-"),
    publishApiUrl: apiUrl,
    publishToken: token,
    publishFetch,
  });
  apps.push(daemon);
  await daemon.ready();
  return { apiUrl, daemon, publishData, publishServer };
}

async function createProject(app: FastifyInstance, name: string) {
  return (await app.inject({ method: "POST", url: "/projects", payload: { name } })).json();
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
