import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { writePlayableFixtureWorkspace } from "./playable-fixture.js";
import { LOCAL_DEBUG_ACCESS_TOKEN } from "../src/shared/local-debug.js";

const apps: ReturnType<typeof createApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const webp = (label: string) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from(`WEBPVP8 ${label}`)]);

async function fixture(type = "web-game", localDebug = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-cover-api-"));
  directories.push(directory);
  const app = createApp({ dataDirectory: directory, localDebug });
  apps.push(app);
  const project = (await app.inject({ method: "POST", url: "/projects", payload: { type } })).json();
  const url = `/projects/${project.id}/cover`;
  const put = (image: Buffer, source?: string) => app.inject({
    method: "PUT", url: `${url}${source ? `?source=${source}` : ""}`,
    headers: { "content-type": "image/webp" }, payload: image,
  });
  return { app, project, url, put };
}

describe("project cover API", () => {
  it("saves custom covers independently of publishing and resumes automatic covers on reset", async () => {
    const { app, url, put } = await fixture();
    expect((await app.inject({ method: "GET", url: `${url}/state` })).json()).toEqual({ mode: "auto" });
    expect((await put(webp("automatic"), "auto")).statusCode).toBe(204);
    expect((await put(webp("custom"))).statusCode).toBe(204);
    expect((await put(webp("late capture"), "auto")).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("custom"));
    expect((await app.inject({ method: "GET", url: `${url}/state` })).json()).toEqual({ mode: "custom" });
    expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("automatic"));
    expect((await put(webp("new capture"), "auto")).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("new capture"));
    expect((await put(webp("invalid source"), "unknown")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/projects/missing/cover/state" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/projects/missing/cover" })).statusCode).toBe(404);
  });

  it("restores the Interactive Story thumbnail fallback without stopping node thumbnail updates", async () => {
    const { app, project, url, put } = await fixture("interactive-story");
    await writePlayableFixtureWorkspace(project.workspacePath);
    const thumbnailUrl = `/projects/${project.id}/playable/thumbnails/menu?hash=0123abcd0123ab`;
    const thumbnail = (label: string) => app.inject({ method: "PUT", url: thumbnailUrl, headers: { "content-type": "image/webp" }, payload: webp(label) });
    expect((await thumbnail("scene")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("scene"));
    await put(webp("custom"));
    expect((await thumbnail("updated scene")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("custom"));
    await app.inject({ method: "DELETE", url });
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("updated scene"));
  });

  it("keeps the Community cover at its published snapshot until the next publication", async () => {
    const { app, project, url, put } = await fixture("web-game", true);
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>Game</h1>");
    await put(webp("automatic"), "auto");
    const publish = () => app.inject({ method: "POST", url: `/projects/${project.id}/publish`, payload: { accessToken: LOCAL_DEBUG_ACCESS_TOKEN, title: "Game" } });
    const first = (await publish()).json();
    const coverUrl = `/community/games/${first.game.id}/deployments/${first.deployment.id}/cover`;
    await put(webp("custom"));
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("custom"));
    expect((await app.inject({ method: "GET", url: coverUrl })).rawPayload).toEqual(webp("automatic"));
    const second = (await publish()).json();
    expect((await app.inject({ method: "GET", url: `/community/games/${second.game.id}/deployments/${second.deployment.id}/cover` })).rawPayload).toEqual(webp("custom"));
    expect((await app.inject({ method: "GET", url: coverUrl })).rawPayload).toEqual(webp("automatic"));
  });
});
