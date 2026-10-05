import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ProjectState, PublishResult } from "../src/shared/contracts.js";
import { isLocalDebugEnabled, isLoopbackHostname, LOCAL_DEBUG_ACCESS_TOKEN, LOCAL_DEBUG_USER } from "../src/shared/local-debug.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local debug mode", () => {
  it.each([
    [false, "", "", false],
    [false, "https://auth.example", "", false],
    [true, "https://auth.example", "key", false],
    [true, "", "", true],
    [true, "https://auth.example", "", true],
    [true, "", "key", true],
    [true, "  ", "  ", true],
  ] as const)("enables debug only in development with missing auth (%s, %s, %s)", (development, url, key, expected) => {
    expect(isLocalDebugEnabled(development, url, key)).toBe(expected);
  });

  it("restricts the debug fallback to loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) expect(isLoopbackHostname(host)).toBe(true);
    for (const host of ["0.0.0.0", "192.168.1.10", "ohmygame.ai", "localhost.example"]) expect(isLoopbackHostname(host)).toBe(false);
  });

  it("publishes a playable snapshot with cover and Community metadata without a cloud service", async () => {
    const { app, project, cloudFetch } = await runtime();
    await writeFile(path.join(project.workspacePath, "index.html"), '<h1>Local game</h1><script src="game.js"></script>');
    await writeFile(path.join(project.workspacePath, "game.js"), "window.gameReady = true");
    await writeFile(path.join(project.workspacePath, ".env"), "SECRET=private");
    const cover = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    expect((await app.inject({
      method: "PUT", url: `/projects/${project.id}/cover`,
      headers: { "content-type": "image/webp" }, payload: cover,
    })).statusCode).toBe(204);

    const response = await publish(app, project.id);
    expect(response.statusCode).toBe(201);
    const result = response.json<PublishResult>();
    expect(result.game).toMatchObject({ title: "Local title", description: "Local description", deploymentId: result.deployment.id });
    expect(new URL(result.game.playUrl).hostname).toBe("127.0.0.1");
    expect(await (await fetch(result.game.playUrl)).text()).toContain("Local game");
    expect(await (await fetch(new URL("game.js", result.game.playUrl))).text()).toContain("gameReady");
    expect((await fetch(new URL(".env", result.game.playUrl))).status).toBe(404);
    const community = { ...result.game, author: { id: LOCAL_DEBUG_USER.id, displayName: LOCAL_DEBUG_USER.name } };
    expect((await app.inject({ method: "GET", url: "/community/games" })).json()).toEqual([community]);
    expect((await app.inject({ method: "GET", url: `/community/games/${result.game.id}` })).json()).toEqual(community);
    const stored = (await app.inject({ method: "GET", url: `/projects/${project.id}` })).json<ProjectState>();
    expect(stored.publication).toMatchObject({ gameId: result.game.id, playUrl: result.game.playUrl, title: "Local title" });
    expect(result.game.coverUrl).toBe(result.deployment.coverUrl);
    expect(Buffer.from(await (await fetch(result.game.coverUrl!)).arrayBuffer())).toEqual(cover);
    const coverResponse = await app.inject({ method: "GET", url: `/community/games/${result.game.id}/deployments/${result.deployment.id}/cover` });
    expect(coverResponse.rawPayload).toEqual(cover);
    expect(coverResponse.headers["content-type"]).toBe("image/webp");
    expect(cloudFetch).not.toHaveBeenCalled();

    await app.close();
    await expect(fetch(result.game.playUrl)).rejects.toThrow();
  });

  it("updates one Community entry while preserving earlier snapshots", async () => {
    const { app, project, cloudFetch } = await runtime();
    await writeFile(path.join(project.workspacePath, "index.html"), "Version one");
    const first = (await publish(app, project.id)).json<PublishResult>();
    await writeFile(path.join(project.workspacePath, "index.html"), "Version two");
    expect(await (await fetch(first.game.playUrl)).text()).toBe("Version one");
    const second = (await publish(app, project.id, "Updated title")).json<PublishResult>();

    expect(second.game.id).toBe(first.game.id);
    expect(second.deployment.id).not.toBe(first.deployment.id);
    expect(await (await fetch(second.game.playUrl)).text()).toBe("Version two");
    expect(await (await fetch(first.game.playUrl)).text()).toBe("Version one");
    const listed = (await app.inject({ method: "GET", url: "/community/games" })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ title: "Updated title", deploymentId: second.deployment.id });
    expect(cloudFetch).not.toHaveBeenCalled();
  });

  it("preserves normal artifact validation and reports missing local games and covers", async () => {
    const { app, project, cloudFetch } = await runtime();
    expect((await app.inject({ method: "GET", url: "/community/games" })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/community/games/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/community/games/missing/deployments/missing/cover" })).statusCode).toBe(404);
    const invalid = await publish(app, project.id);
    expect(invalid.statusCode).toBe(409);
    await writeFile(path.join(project.workspacePath, "index.html"), "No cover");
    const result = (await publish(app, project.id)).json<PublishResult>();
    expect(result.game.coverUrl).toBeUndefined();
    expect((await app.inject({ method: "GET", url: `/community/games/${result.game.id}/deployments/${result.deployment.id}/cover` })).statusCode).toBe(404);
    expect(cloudFetch).not.toHaveBeenCalled();
  });

  it("rejects mock credentials outside debug mode before building or contacting the cloud", async () => {
    const { app, project, cloudFetch } = await runtime(false);
    const response = await publish(app, project.id);
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toContain("outside local development");
    expect(cloudFetch).not.toHaveBeenCalled();
  });
});

async function runtime(localDebug = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-debug-test-"));
  directories.push(directory);
  const cloudFetch = vi.fn<typeof fetch>(async () => { throw new Error("Debug mode must not call the cloud"); });
  const app = createApp({ dataDirectory: directory, localDebug, publishFetch: cloudFetch });
  apps.push(app);
  const created = await app.inject({ method: "POST", url: "/projects", payload: { name: "Debug game", type: "web-game" } });
  expect(created.statusCode).toBe(201);
  return { app, project: created.json<ProjectState>(), cloudFetch };
}

function publish(app: FastifyInstance, projectId: string, title = "Local title") {
  return app.inject({
    method: "POST", url: `/projects/${projectId}/publish`,
    payload: { accessToken: LOCAL_DEBUG_ACCESS_TOKEN, title, description: "Local description" },
  });
}
