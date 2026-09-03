import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createPublishApp } from "../src/publish-server/app.js";

const token = "test-publisher-token";
const authorization = { authorization: `Bearer ${token}` };
const verifyPublisherToken = async (value: string) => {
  if (value === token) return "publisher";
  if (value === "other-publisher-token") return "other-publisher";
  return undefined;
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("public publish server", () => {
  it("publishes and lists immutable Asset Template definitions", async () => {
    const app = await testApp();
    const created = await app.inject({
      method: "POST", url: "/v1/templates",
      headers: { ...authorization, "idempotency-key": "template" },
      payload: { name: "Character Sheet" },
    });
    expect(created.statusCode).toBe(201);
    const templateId = created.json().id;
    const definition = assetTemplateDefinition("Character Sheet");
    const release = await app.inject({
      method: "POST", url: `/v1/templates/${templateId}/releases`,
      headers: { ...authorization, "idempotency-key": "template-release" },
      payload: { definition },
    });
    expect(release.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/v1/explore/templates" })).json()).toEqual([]);
    expect((await app.inject({
      method: "PUT", url: `/v1/templates/${templateId}/listing`, headers: authorization, payload: { status: "listed" },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/explore/templates" })).json()).toEqual([
      expect.objectContaining({ id: templateId, releaseId: release.json().release.id, ...definition }),
    ]);
  });

  it("publishes immutable Plugin releases and exposes only the listed version", async () => {
    const app = await testApp();
    const created = await createPlugin(app, "create-plugin", "level-tools");
    expect(created.statusCode).toBe(201);
    const pluginId = created.json().id;

    const first = await publishPlugin(app, pluginId, "release-1", pluginManifest("1.0.0"));
    expect(first.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/v1/explore/plugins" })).json()).toEqual([]);
    await app.inject({ method: "PUT", url: `/v1/plugins/${pluginId}/listing`, headers: authorization, payload: { status: "listed" } });
    expect((await app.inject({ method: "GET", url: "/v1/explore/plugins" })).json()).toMatchObject([{
      id: pluginId, name: "level-tools", version: "1.0.0", manifest: { name: "level-tools" },
      skills: [{ id: "skills/level/SKILL.md", name: "Level", description: "Build levels." }],
    }]);
    const content = await app.inject({
      method: "GET", url: `/v1/explore/plugins/${pluginId}/releases/${first.json().release.id}/content`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toContain("application/zip");
    const skill = await app.inject({
      method: "GET",
      url: `/v1/explore/plugins/${pluginId}/releases/${first.json().release.id}/skill-content?id=skills%2Flevel%2FSKILL.md`,
    });
    expect(skill.statusCode).toBe(200);
    expect(skill.json()).toEqual({ id: "skills/level/SKILL.md", content: "---\nname: level\ndescription: Build levels.\n---\n" });
    expect((await app.inject({
      method: "GET",
      url: `/v1/explore/plugins/${pluginId}/releases/${first.json().release.id}/skill-content?id=.opengame-plugin%2Fplugin.json`,
    })).statusCode).toBe(404);

    const stale = await publishPlugin(app, pluginId, "release-stale", pluginManifest("0.9.0"));
    expect(stale.statusCode).toBe(409);
    const second = await publishPlugin(app, pluginId, "release-2", pluginManifest("1.1.0"));
    expect(second.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/v1/explore/plugins/${pluginId}` })).json().version).toBe("1.1.0");
  });

  it("keeps published Plugin archives after restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-publish-plugins-"));
    const first = createPublishApp({ dataDirectory, verifyPublisherToken });
    apps.push(first);
    const plugin = (await createPlugin(first, "plugin", "level-tools")).json();
    const release = await publishPlugin(first, plugin.id, "release", pluginManifest("1.0.0"));
    await first.inject({ method: "PUT", url: `/v1/plugins/${plugin.id}/listing`, headers: authorization, payload: { status: "listed" } });
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createPublishApp({ dataDirectory, verifyPublisherToken });
    apps.push(second);
    await second.ready();
    const content = await second.inject({
      method: "GET", url: `/v1/explore/plugins/${plugin.id}/releases/${release.json().release.id}/content`,
    });
    expect(content.statusCode).toBe(200);
    expect(createHash("sha256").update(content.rawPayload).digest("hex")).toBe(release.json().release.artifactSha256);
    expect((await second.inject({ method: "GET", url: `/v1/explore/plugins/${plugin.id}` })).json().skills)
      .toEqual([{ id: "skills/level/SKILL.md", name: "Level", description: "Build levels." }]);
  });

  it("migrates an existing Plugin release store", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-publish-plugin-migration-"));
    const initial = createPublishApp({ dataDirectory, verifyPublisherToken });
    await initial.ready();
    await initial.close();

    const database = new DatabaseSync(path.join(dataDirectory, "publish.sqlite"));
    database.exec("ALTER TABLE plugin_releases DROP COLUMN skills_json");
    database.close();

    const migrated = createPublishApp({ dataDirectory, verifyPublisherToken });
    apps.push(migrated);
    await migrated.ready();
    const columns = new DatabaseSync(path.join(dataDirectory, "publish.sqlite"));
    expect(columns.prepare("PRAGMA table_info(plugin_releases)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "skills_json" })]));
    columns.close();
  });

  it("reserves public Plugin names across publishers", async () => {
    const app = await testApp();
    expect((await createPlugin(app, "first", "level-tools")).statusCode).toBe(201);
    const response = await app.inject({
      method: "POST", url: "/v1/plugins",
      headers: { authorization: "Bearer other-publisher-token", "idempotency-key": "second" },
      payload: { name: "level-tools" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe("Plugin name is already in use");
  });

  it("publishes immutable Assets and exposes only listed releases", async () => {
    const app = await testApp();
    expect((await app.inject({ method: "POST", url: "/v1/assets", payload: { title: "Sprite", mediaType: "image" } })).statusCode).toBe(401);
    const created = await createAsset(app, "create-asset", { title: "  Forest sprite  ", mediaType: "image" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: "Forest sprite", mediaType: "image", currentReleaseId: null });
    const assetId = created.json().id;
    expect((await app.inject({ method: "PUT", url: `/v1/assets/${assetId}/listing`, headers: authorization, payload: { status: "listed" } })).statusCode).toBe(409);

    const first = await publishAsset(app, assetId, "first-release", Buffer.from("first image"), "forest.png", "image/png");
    expect(first.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/v1/explore/assets" })).json()).toEqual([]);
    expect((await app.inject({ method: "PUT", url: `/v1/assets/${assetId}/listing`, headers: authorization, payload: { status: "listed" } })).statusCode).toBe(200);
    const publicAsset = (await app.inject({ method: "GET", url: `/v1/explore/assets/${assetId}` })).json();
    expect(publicAsset).toMatchObject({ id: assetId, title: "Forest sprite", releaseId: first.json().release.id, fileName: "forest.png" });
    expect(publicAsset).not.toHaveProperty("publisherId");
    expect((await app.inject({ method: "GET", url: `/v1/explore/assets/${assetId}/releases/${first.json().release.id}/content` })).body).toBe("first image");

    const second = await publishAsset(app, assetId, "second-release", Buffer.from("second image"), "forest.png", "image/png");
    expect(second.json().release.id).not.toBe(first.json().release.id);
    expect((await app.inject({ method: "GET", url: `/v1/explore/assets/${assetId}/releases/${second.json().release.id}/content` })).body).toBe("second image");
    expect((await app.inject({ method: "GET", url: `/v1/explore/assets/${assetId}/releases/${first.json().release.id}/content` })).body).toBe("first image");
    expect((await publishAsset(app, assetId, "second-release", Buffer.from("second image"), "forest.png", "image/png")).json()).toEqual(second.json());

    await app.inject({ method: "PUT", url: `/v1/assets/${assetId}/listing`, headers: authorization, payload: { status: "unlisted" } });
    expect((await app.inject({ method: "GET", url: `/v1/explore/assets/${assetId}` })).statusCode).toBe(404);
  });

  it("keeps published Asset files after restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-publish-assets-"));
    const first = createPublishApp({ dataDirectory, verifyPublisherToken });
    apps.push(first);
    const asset = (await createAsset(first, "asset", { title: "Persistent", mediaType: "model" })).json();
    const release = await publishAsset(first, asset.id, "release", Buffer.from("glb-data"), "model.glb", "model/gltf-binary");
    await first.inject({ method: "PUT", url: `/v1/assets/${asset.id}/listing`, headers: authorization, payload: { status: "listed" } });
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createPublishApp({ dataDirectory, verifyPublisherToken });
    apps.push(second);
    await second.ready();
    expect((await second.inject({ method: "GET", url: `/v1/explore/assets/${asset.id}/releases/${release.json().release.id}/content` })).body).toBe("glb-data");
    expect(release.json().release.id).toBeTruthy();
  });

  it("rejects unsupported Asset release metadata", async () => {
    const app = await testApp();
    const asset = (await createAsset(app, "asset", { title: "Image", mediaType: "image" })).json();
    const response = await publishAsset(app, asset.id, "bad-release", Buffer.from("video"), "video.mp4", "video/mp4");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("artifact_invalid");
  });

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
    const otherPublisher = await app.inject({
      method: "GET",
      url: `/v1/games/${gameId}`,
      headers: { authorization: "Bearer other-publisher-token" },
    });
    expect(otherPublisher.statusCode).toBe(404);
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
      verifyPublisherToken,
    });
    apps.push(first);
    const game = (await createGame(first, "game", { title: "Persistent" })).json();
    const published = await publish(first, game.id, "deployment", await zipFiles({ "index.html": "still here" }));
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createPublishApp({
      dataDirectory,
      playOrigin: "http://localhost:43131",
      verifyPublisherToken,
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
      verifyPublisherToken,
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
      verifyPublisherToken,
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
    verifyPublisherToken,
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

function createAsset(app: FastifyInstance, key: string, payload: { title: string; description?: string; mediaType: string }) {
  return app.inject({ method: "POST", url: "/v1/assets", headers: { ...authorization, "idempotency-key": key }, payload });
}

function createPlugin(app: FastifyInstance, key: string, name: string) {
  return app.inject({ method: "POST", url: "/v1/plugins", headers: { ...authorization, "idempotency-key": key }, payload: { name } });
}

function pluginManifest(version: string) {
  return {
    name: "level-tools", version, description: "Level design workflows",
    interface: { displayName: "Level Tools", longDescription: "Build better levels." },
  };
}

function assetTemplateDefinition(name: string) {
  return {
    mode: "image" as const,
    name,
    description: "Consistent character views",
    promptLabel: "Prompt",
    promptPlaceholder: "Describe a character",
    defaultPrompt: "Create three views",
    defaults: { imageResolution: "2K", imageAspectRatio: "16:9", imageOutputs: 1 },
  };
}

async function publishPlugin(app: FastifyInstance, pluginId: string, key: string, manifest: ReturnType<typeof pluginManifest>) {
  const archive = await zipFiles({
    ".opengame-plugin/plugin.json": JSON.stringify(manifest),
    "skills/level/SKILL.md": "---\nname: level\ndescription: Build levels.\n---\n",
  });
  const metadata = {
    artifactSha256: createHash("sha256").update(archive).digest("hex"),
    artifactBytes: archive.length,
    manifest,
    skills: [{ id: "skills/level/SKILL.md", name: "Level", description: "Build levels." }],
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("artifact", new Blob([new Uint8Array(archive)], { type: "application/zip" }), "plugin.zip");
  const request = new Request("http://localhost/upload", { method: "POST", body: form });
  return app.inject({
    method: "POST", url: `/v1/plugins/${pluginId}/releases`,
    headers: { ...Object.fromEntries(request.headers), ...authorization, "idempotency-key": key },
    payload: Buffer.from(await request.arrayBuffer()),
  });
}

async function publishAsset(
  app: FastifyInstance,
  assetId: string,
  key: string,
  contents: Buffer,
  fileName: string,
  contentType: string,
) {
  const metadata = {
    artifactSha256: createHash("sha256").update(contents).digest("hex"),
    artifactBytes: contents.length,
    fileName,
    contentType,
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("artifact", new Blob([new Uint8Array(contents)], { type: contentType }), fileName);
  const request = new Request("http://localhost/upload", { method: "POST", body: form });
  return app.inject({
    method: "POST",
    url: `/v1/assets/${assetId}/releases`,
    headers: { ...Object.fromEntries(request.headers), ...authorization, "idempotency-key": key },
    payload: Buffer.from(await request.arrayBuffer()),
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
