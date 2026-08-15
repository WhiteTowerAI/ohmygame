import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createPublishApp } from "../src/publish-server/app.js";

const token = "test-publisher-token";
const authorization = { authorization: `Bearer ${token}` };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("public publish server", () => {
  it("authenticates creators and creates games idempotently as unlisted", async () => {
    const app = await testApp();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/games", payload: { title: "Game" } })).statusCode).toBe(401);

    const first = await createGame(app, "create-game", { title: "  Game  ", description: "  First  " });
    expect(first.statusCode).toBe(201);
    expect(first.headers["x-request-id"]).toBeTruthy();
    expect(first.json()).toMatchObject({ title: "Game", description: "First", currentDeploymentId: null });
    const replay = await createGame(app, "create-game", { title: "  Game  ", description: "  First  " });
    expect(replay.json()).toEqual(first.json());
    const conflict = await createGame(app, "create-game", { title: "Another" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");

    const gameId = first.json().id;
    const detail = await app.inject({ method: "GET", url: `/v1/games/${gameId}`, headers: authorization });
    expect(detail.json()).toMatchObject({ id: gameId, title: "Game" });
    const listing = await app.inject({
      method: "PUT",
      url: `/v1/games/${gameId}/listing`,
      headers: authorization,
      payload: { status: "listed" },
    });
    expect(listing.statusCode).toBe(409);
    expect((await createGame(app, "long-title", { title: "x".repeat(201) })).statusCode).toBe(400);
  });

  it("publishes immutable versions, switches the stable URL, and controls Community discovery", async () => {
    const app = await testApp();
    const game = (await createGame(app, "game", { title: "Playable", description: "A game" })).json();
    const firstZip = await zipFiles({ "index.html": "<h1>Version one</h1>", "assets/game.js": "console.log('one')" });
    const first = await publish(app, game.id, "deployment-one", firstZip);
    expect(first.statusCode).toBe(201);
    expect(first.json().game.currentDeploymentId).toBe(first.json().deployment.id);

    const firstDeployment = first.json().deployment;
    expect((await play(app, firstDeployment.versionUrl, "/")).body).toContain("Version one");
    expect((await play(app, firstDeployment.versionUrl, "/assets/game.js")).body).toContain("one");
    expect((await play(app, first.json().game.playUrl, "/")).body).toContain("Version one");
    expect((await play(app, first.json().game.playUrl, "/health")).statusCode).toBe(404);
    expect((await play(app, first.json().game.playUrl, "/v1/games")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/community/games" })).json()).toEqual([]);

    const listed = await app.inject({
      method: "PUT",
      url: `/v1/games/${game.id}/listing`,
      headers: authorization,
      payload: { status: "listed" },
    });
    expect(listed.json().status).toBe("listed");
    expect((await app.inject({ method: "GET", url: "/v1/community/games" })).json()[0]).toMatchObject({
      id: game.id,
      deploymentId: firstDeployment.id,
    });

    const secondZip = await zipFiles({ "index.html": "<h1>Version two</h1>" });
    const second = await publish(app, game.id, "deployment-two", secondZip);
    expect((await play(app, second.json().game.playUrl, "/")).body).toContain("Version two");
    expect((await play(app, firstDeployment.versionUrl, "/")).body).toContain("Version one");
    expect((await publish(app, game.id, "deployment-two", secondZip)).json()).toEqual(second.json());

    const unlisted = await app.inject({
      method: "PUT",
      url: `/v1/games/${game.id}/listing`,
      headers: authorization,
      payload: { status: "unlisted" },
    });
    expect(unlisted.json()).toMatchObject({ status: "unlisted", listedAt: null });
    expect((await app.inject({ method: "GET", url: "/v1/community/games" })).json()).toEqual([]);
    expect((await play(app, second.json().game.playUrl, "/")).body).toContain("Version two");
  });

  it("rejects private project files and keeps the previous deployment active", async () => {
    const app = await testApp();
    const game = (await createGame(app, "game", { title: "Safe" })).json();
    const good = await publish(app, game.id, "good", await zipFiles({ "index.html": "safe version" }));
    const unsafeZip = await zipFiles({ "index.html": "unsafe version", ".env": "SECRET=value" });
    const unsafe = await publish(app, game.id, "unsafe", unsafeZip);
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().error.code).toBe("artifact_invalid");
    expect((await play(app, good.json().game.playUrl, "/")).body).toContain("safe version");
  });

  it("restores games and playable artifacts after restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-publish-server-"));
    const first = createPublishApp({
      dataDirectory,
      playOrigin: "http://localhost:43130",
      publisher: { id: "publisher", token },
    });
    apps.push(first);
    const game = (await createGame(first, "game", { title: "Persistent" })).json();
    const published = await publish(first, game.id, "deployment", await zipFiles({ "index.html": "still here" }));
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createPublishApp({
      dataDirectory,
      playOrigin: "http://localhost:43131",
      publisher: { id: "publisher", token },
    });
    apps.push(second);
    const detail = await second.inject({ method: "GET", url: `/v1/games/${game.id}`, headers: authorization });
    expect(detail.json().currentDeploymentId).toBe(published.json().deployment.id);
    expect(detail.json().playUrl).toContain(":43131/");
    expect((await play(second, detail.json().playUrl, "/")).body).toContain("still here");
    const replayedGame = await createGame(second, "game", { title: "Persistent" });
    expect(replayedGame.json().playUrl).toContain(":43131/");
    const replayedDeployment = await publish(
      second,
      game.id,
      "deployment",
      await zipFiles({ "index.html": "still here" }),
    );
    expect(replayedDeployment.json().game.playUrl).toContain(":43131/");
    expect(replayedDeployment.json().deployment.versionUrl).toContain(":43131/");
  });

  it("lists published Community games", async () => {
    const app = await testApp();
    for (const [index, title] of ["First", "Second"].entries()) {
      const game = (await createGame(app, `game-${index}`, { title })).json();
      await publish(app, game.id, `deployment-${index}`, await zipFiles({ "index.html": title }));
      await app.inject({
        method: "PUT",
        url: `/v1/games/${game.id}/listing`,
        headers: authorization,
        payload: { status: "listed" },
      });
    }

    const games = (await app.inject({ method: "GET", url: "/v1/community/games" })).json();
    expect(games).toHaveLength(2);
    expect(games.map((game: { title: string }) => game.title).sort()).toEqual(["First", "Second"]);
  });

  it("keeps the API host separate from wildcard game domains", async () => {
    const app = createPublishApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-publish-server-")),
      playOrigin: "https://play.example.com",
      publisher: { id: "publisher", token },
    });
    apps.push(app);

    const health = await app.inject({ method: "GET", url: "/health", headers: { host: "publish.example.com" } });
    expect(health.statusCode).toBe(200);

    const game = (await createGame(app, "wildcard-game", { title: "Wildcard" })).json();
    expect(new URL(game.playUrl).hostname).toBe(`g-${game.id}.play.example.com`);
    const deployed = await publish(app, game.id, "wildcard-deployment", await zipFiles({ "index.html": "game" }));
    expect(new URL(deployed.json().deployment.versionUrl).hostname)
      .toBe(`d-${deployed.json().deployment.id}.play.example.com`);
  });

  it("counts directory entries toward artifact limits", async () => {
    const app = createPublishApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-publish-server-")),
      playOrigin: "http://localhost:43130",
      publisher: { id: "publisher", token },
      artifactLimits: { compressedBytes: 1_000_000, expandedBytes: 1_000_000, fileBytes: 1_000_000, files: 2 },
    });
    apps.push(app);
    const game = (await createGame(app, "limited-game", { title: "Limited" })).json();
    const artifact = zipEntries([
      { name: "one/", contents: "" },
      { name: "two/", contents: "" },
      { name: "index.html", contents: "game" },
    ]);
    const response = await publish(app, game.id, "too-many-entries", artifact);
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("artifact_too_large");
  });
});

async function testApp(): Promise<FastifyInstance> {
  const app = createPublishApp({
    dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-publish-server-")),
    playOrigin: "http://localhost:43130",
    publisher: { id: "publisher", token },
  });
  apps.push(app);
  return app;
}

function createGame(app: FastifyInstance, key: string, payload: { title: string; description?: string }) {
  return app.inject({
    method: "POST",
    url: "/v1/games",
    headers: { ...authorization, "idempotency-key": key },
    payload,
  });
}

async function publish(app: FastifyInstance, gameId: string, key: string, zip: Buffer) {
  const metadata = {
    artifactSha256: createHash("sha256").update(zip).digest("hex"),
    artifactBytes: zip.length,
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("artifact", new Blob([new Uint8Array(zip)], { type: "application/zip" }), "game.zip");
  const request = new Request("http://localhost/upload", { method: "POST", body: form });
  return app.inject({
    method: "POST",
    url: `/v1/games/${gameId}/deployments`,
    headers: {
      ...Object.fromEntries(request.headers),
      ...authorization,
      "idempotency-key": key,
    },
    payload: Buffer.from(await request.arrayBuffer()),
  });
}

function play(app: FastifyInstance, url: string, pathname: string) {
  const target = new URL(url);
  return app.inject({ method: "GET", url: pathname, headers: { host: target.host } });
}

async function zipFiles(files: Record<string, string>): Promise<Buffer> {
  return zipEntries(Object.entries(files).map(([name, contents]) => ({ name, contents })));
}

function zipEntries(entries: Array<{ name: string; contents: string }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.from(entry.contents);
    const checksum = crc32(contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(entry.name.endsWith("/") ? 0x10 : 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + contents.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
