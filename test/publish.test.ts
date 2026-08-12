import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { createPlayApp } from "../src/daemon/play-app.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("publish", () => {
  it("publishes a static workspace to an isolated playable deployment and Community", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-publish-"));
    const play = createPlayApp({ dataDirectory });
    apps.push(play);
    const playOrigin = localhostOrigin(await play.listen({ host: "localhost", port: 0 }));
    const daemon = createApp({ dataDirectory, playOrigin });
    apps.push(daemon);
    await daemon.ready();
    const project = (await daemon.inject({ method: "POST", url: "/projects", payload: { name: "Static game" } })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), '<link rel="stylesheet" href="/game.css"><script src="/game.js"></script><h1>Version one</h1>');
    await writeFile(path.join(project.workspacePath, "game.js"), 'fetch("/level.json"); window.ready = true');
    await writeFile(path.join(project.workspacePath, "game.css"), 'body { background: url("/sprite.bin") }');
    await writeFile(path.join(project.workspacePath, "level.json"), '{"level":1}');
    await writeFile(path.join(project.workspacePath, "sprite.bin"), Buffer.from([0, 255, 1, 254]));
    await writeFile(path.join(project.workspacePath, ".env"), "SECRET=hidden");

    const response = await daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

    expect(response.statusCode).toBe(201);
    const published = response.json();
    expect(published.game).toMatchObject({ projectId: project.id, title: "Static game" });
    expect(new URL(published.game.playUrl).hostname).toBe(`${published.deployment.id}.localhost`);
    expect(await (await fetch(published.game.playUrl)).text()).toContain('src="/game.js"');
    expect(await (await fetch(new URL("/level.json", published.game.playUrl))).json()).toEqual({ level: 1 });
    expect([...new Uint8Array(await (await fetch(new URL("/sprite.bin", published.game.playUrl))).arrayBuffer())]).toEqual([0, 255, 1, 254]);
    expect(await readdir(path.join(dataDirectory, "deployments", published.deployment.id, "files"))).not.toContain(".env");
    expect((await daemon.inject({ method: "GET", url: "/community/games" })).json()).toEqual([published.game]);
  });

  it("creates a new deployment and switches the existing Community game on republish", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-republish-"));
    const daemon = createApp({ dataDirectory, playOrigin: "https://play.example", verifyPlayUrl: async () => {} });
    apps.push(daemon);
    await daemon.ready();
    const project = (await daemon.inject({ method: "POST", url: "/projects", payload: { name: "Game" } })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "one");
    const first = (await daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "two");

    const second = (await daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` })).json();

    expect(second.game.id).toBe(first.game.id);
    expect(second.deployment.id).not.toBe(first.deployment.id);
    expect(new URL(second.game.playUrl).origin).not.toBe(new URL(first.game.playUrl).origin);
    expect(second.game.deploymentId).toBe(second.deployment.id);
    expect(await readFile(path.join(dataDirectory, "deployments", first.deployment.id, "files", "index.html"), "utf8")).toBe("one");
    expect(await readFile(path.join(dataDirectory, "deployments", second.deployment.id, "files", "index.html"), "utf8")).toBe("two");
  });

  it("keeps an empty workspace publishable without claiming it can run", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-empty-publish-"));
    const daemon = createApp({ dataDirectory, playOrigin: "https://play.example", verifyPlayUrl: async () => {} });
    apps.push(daemon);
    const project = (await daemon.inject({ method: "POST", url: "/projects", payload: {} })).json();

    const response = await daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Project has no build script or static index.html yet" });
    expect((await daemon.inject({ method: "GET", url: "/community/games" })).json()).toEqual([]);
  });

  it("runs an npm build and publishes its static output", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-build-publish-"));
    const daemon = createApp({ dataDirectory, playOrigin: "https://play.example", verifyPlayUrl: async () => {} });
    apps.push(daemon);
    const project = (await daemon.inject({ method: "POST", url: "/projects", payload: { name: "Built" } })).json();
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({
      scripts: { build: "node build.mjs" },
    }));
    await writeFile(path.join(project.workspacePath, "build.mjs"), `
      import { mkdir, writeFile } from "node:fs/promises";
      await mkdir("dist/assets", { recursive: true });
      await writeFile("dist/index.html", '<script src="./assets/game.js"></script>');
      await writeFile("dist/assets/game.js", "window.built = true");
    `);

    const response = await daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

    expect(response.statusCode).toBe(201);
    const deployment = response.json().deployment;
    expect(await readFile(path.join(dataDirectory, "deployments", deployment.id, "files", "assets", "game.js"), "utf8")).toContain("built");
  });

  it("restores the current Community publication with the new play port after restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-community-restart-"));
    const first = createApp({ dataDirectory, playOrigin: "http://localhost:41001", verifyPlayUrl: async () => {} });
    apps.push(first);
    await first.ready();
    const project = (await first.inject({ method: "POST", url: "/projects", payload: { name: "Persistent" } })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "game");
    const published = (await first.inject({ method: "POST", url: `/projects/${project.id}/publish` })).json();
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createApp({ dataDirectory, playOrigin: "http://localhost:41002", verifyPlayUrl: async () => {} });
    apps.push(second);
    await second.ready();

    expect((await second.inject({ method: "GET", url: `/projects/${project.id}` })).json().publication).toMatchObject({
      gameId: published.game.id,
      deploymentId: published.deployment.id,
    });
    const restored = (await second.inject({ method: "GET", url: "/community/games" })).json()[0];
    expect(restored).toMatchObject({ id: published.game.id, deploymentId: published.deployment.id });
    expect(restored.playUrl).toBe(`http://${published.deployment.id}.localhost:41002/`);
    const stored = JSON.parse(await readFile(path.join(dataDirectory, "community", "games", `${project.id}.json`), "utf8"));
    expect(stored).not.toHaveProperty("playUrl");
  });

  it("removes a deployment when URL verification fails", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-publish-failure-"));
    const daemon = createApp({
      dataDirectory,
      playOrigin: "https://play.example",
      verifyPlayUrl: async () => { throw new Error("unreachable"); },
    });
    apps.push(daemon);
    const project = (await daemon.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "game");

    const response = await daemon.inject({ method: "POST", url: `/projects/${project.id}/publish` });

    expect(response.statusCode).toBe(502);
    expect(await readdir(path.join(dataDirectory, "deployments"))).toEqual([]);
    expect((await daemon.inject({ method: "GET", url: "/community/games" })).json()).toEqual([]);
  });
});

function localhostOrigin(address: string): string {
  return `http://localhost:${new URL(address).port}`;
}
