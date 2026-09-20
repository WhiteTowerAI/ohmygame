import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { createPublishApp } from "../src/publish-server/app.js";
import { PUBLISH_ASSET_DESCRIPTION_MAX_LENGTH, PUBLISH_GAME_COVER_PATH } from "../src/shared/publish-v1.js";
import { DEFAULT_SCENE_SURFACE_FILES } from "../src/shared/story.js";
import { createPlayableStoryDocument } from "./story-fixture.js";

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
        promptPlaceholder: "Describe the shot",
        defaultPrompt: "Use continuous camera motion",
        defaults: { videoResolution: "1080p", videoAspectRatio: "16:9", videoDuration: 8 },
      },
    });
    expect(saved.statusCode).toBe(201);
    const cover = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP");
    const covered = await runtime.daemon.inject({
      method: "PUT", url: `/asset-templates/${saved.json().id}/cover`,
      headers: { "content-type": "image/webp" }, payload: cover,
    });
    expect(covered.statusCode, covered.body).toBe(200);
    expect(covered.json().hasCover).toBe(true);
    const published = await runtime.daemon.inject({
      method: "POST", url: `/asset-templates/${saved.json().id}/publish`, payload: { accessToken: token },
    });
    expect(published.statusCode, published.body).toBe(201);
    expect((await runtime.daemon.inject({ method: "GET", url: "/asset-templates" })).json()).toEqual([
      expect.objectContaining({ id: saved.json().id, publication: expect.objectContaining({ templateId: published.json().template.id, status: "listed" }) }),
    ]);
    expect((await runtime.daemon.inject({ method: "GET", url: "/explore/templates" })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Cinematic Shot", source: "catalog", releaseId: published.json().release.id, hasCover: true }),
    ]));
    const localCover = await runtime.daemon.inject({ method: "GET", url: `/asset-templates/${saved.json().id}/cover` });
    expect(localCover.statusCode).toBe(200);
    expect(localCover.rawPayload).toEqual(cover);
    const exploreCover = await runtime.daemon.inject({
      method: "GET",
      url: `/explore/templates/${published.json().template.id}/releases/${published.json().release.id}/cover`,
    });
    expect(exploreCover.statusCode, exploreCover.body).toBe(200);
    expect(exploreCover.rawPayload).toEqual(cover);

    const unpublished = await runtime.daemon.inject({
      method: "PUT", url: `/asset-templates/${saved.json().id}/publication`, payload: { accessToken: token, status: "unlisted" },
    });
    expect(unpublished.statusCode, unpublished.body).toBe(200);
    expect(unpublished.json().publication.status).toBe("unlisted");
    expect((await runtime.daemon.inject({ method: "GET", url: "/explore/templates" })).json())
      .not.toContainEqual(expect.objectContaining({ id: published.json().template.id }));

    const deleted = await runtime.daemon.inject({ method: "DELETE", url: `/asset-templates/${saved.json().id}` });
    expect(deleted.statusCode).toBe(204);
    expect((await runtime.daemon.inject({ method: "GET", url: "/asset-templates" })).json()).toEqual([]);
  });

  it("publishes, installs, and updates a Catalog Plugin without re-enabling it", async () => {
    const runtime = await testRuntime();
    const source = await temporary("ohmygame-published-plugin-");
    await mkdir(path.join(source, ".ohmygame-plugin"));
    await mkdir(path.join(source, "skills", "levels"), { recursive: true });
    await writeFile(path.join(source, "skills", "levels", "SKILL.md"), "---\nname: levels\ndescription: Build levels.\n---\n");
    const writeManifest = (version: string) => writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      name: "level-tools", version, description: "Level workflows", skills: "./skills",
      interface: { displayName: "Level Tools", defaultPrompt: ["Build a level"] },
    }));
    await writeManifest("1.0.0");
    await runtime.daemon.inject({ method: "POST", url: "/plugins/install", payload: { type: "directory", path: source } });
    const published = await runtime.daemon.inject({
      method: "POST", url: "/plugins/personal%3Alevel-tools/publish", payload: { accessToken: token },
    });
    expect(published.statusCode).toBe(201);
    const publisherCatalog = (await runtime.daemon.inject({ method: "GET", url: "/plugins" })).json();
    const publisherPlugins = publisherCatalog.plugins
      .filter((plugin: { name: string }) => plugin.name === "level-tools");
    expect(publisherPlugins).toHaveLength(1);
    expect(publisherPlugins[0]).toMatchObject({
      id: "personal:level-tools",
      installed: true,
      catalog: { pluginId: published.json().plugin.id, releaseId: published.json().release.id },
      author: { id: "publisher", displayName: "OhMyGame Creator" },
    });
    expect(publisherCatalog.explore).toEqual([
      expect.objectContaining({ id: "personal:level-tools", installed: true }),
    ]);
    expect((await runtime.daemon.inject({
      method: "POST", url: "/plugins/personal%3Alevel-tools/publication", payload: { accessToken: token },
    })).json()).toMatchObject({
      pluginId: published.json().plugin.id,
      releaseId: published.json().release.id,
      version: "1.0.0",
      status: "listed",
    });
    expect((await runtime.daemon.inject({
      method: "PUT", url: "/plugins/personal%3Alevel-tools/publication",
      payload: { accessToken: token, status: "unlisted" },
    })).statusCode).toBe(200);
    expect((await runtime.daemon.inject({ method: "GET", url: "/plugins" })).json().explore).toEqual([]);
    expect((await runtime.daemon.inject({
      method: "PUT", url: "/plugins/personal%3Alevel-tools/publication",
      payload: { accessToken: token, status: "listed" },
    })).statusCode).toBe(200);

    const consumer = createApp({ dataDirectory: await temporary("ohmygame-plugin-consumer-"), publishApiUrl: runtime.apiUrl });
    apps.push(consumer);
    await consumer.ready();
    const catalog = await consumer.inject({ method: "GET", url: "/plugins" });
    expect(catalog.json().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ohmygame:level-tools", installed: false, version: "1.0.0" }),
    ]));
    expect((await consumer.inject({ method: "GET", url: "/plugins/ohmygame%3Alevel-tools" })).json()).toMatchObject({
      installed: false,
      skills: [{ name: "Levels", enabled: true }],
    });
    expect((await consumer.inject({
      method: "GET", url: "/plugins/ohmygame%3Alevel-tools/skill-content?id=skills%2Flevels%2FSKILL.md",
    })).json()).toEqual({
      id: "skills/levels/SKILL.md",
      content: "---\nname: levels\ndescription: Build levels.\n---\n",
    });
    const installed = await consumer.inject({ method: "POST", url: "/plugins/ohmygame%3Alevel-tools/install" });
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json()).toMatchObject({
      id: "ohmygame:level-tools", version: "1.0.0", installed: true, enabled: true,
      source: { type: "catalog" },
      author: { id: "publisher", displayName: "OhMyGame Creator" },
      stats: { likes: 0, uses: 0 },
    });
    expect((await consumer.inject({ method: "GET", url: "/plugins" })).json().explore).toEqual([
      expect.objectContaining({ id: "ohmygame:level-tools", installed: true }),
    ]);
    await consumer.inject({
      method: "PUT", url: "/plugins/ohmygame%3Alevel-tools/settings", payload: { enabled: false, components: {} },
    });

    await writeManifest("1.1.0");
    await runtime.daemon.inject({ method: "POST", url: "/plugins/install", payload: { type: "directory", path: source } });
    const secondPublished = await runtime.daemon.inject({
      method: "POST", url: "/plugins/personal%3Alevel-tools/publish", payload: { accessToken: token },
    });
    expect(secondPublished.statusCode).toBe(201);
    const update = (await consumer.inject({ method: "GET", url: "/plugins" })).json().plugins
      .find((plugin: { id: string }) => plugin.id === "ohmygame:level-tools");
    expect(update).toMatchObject({ version: "1.0.0", latestVersion: "1.1.0", updateAvailable: true });
    expect((await consumer.inject({ method: "GET", url: "/plugins/ohmygame%3Alevel-tools" })).json())
      .toMatchObject({ version: "1.0.0", latestVersion: "1.1.0", updateAvailable: true });
    const updated = await consumer.inject({ method: "POST", url: "/plugins/ohmygame%3Alevel-tools/install" });
    expect(updated.statusCode).toBe(201);
    expect((await consumer.inject({ method: "GET", url: "/plugins/ohmygame%3Alevel-tools" })).json())
      .toMatchObject({ version: "1.1.0", enabled: false, source: { type: "catalog", releaseId: secondPublished.json().release.id } });
  });

  it("publishes and installs a Claude marketplace Plugin without rewriting its manifest", async () => {
    const runtime = await testRuntime();
    const source = await temporary("ohmygame-claude-plugin-");
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
    const publisherPlugins = (await runtime.daemon.inject({ method: "GET", url: "/plugins" })).json().plugins
      .filter((plugin: { name: string }) => plugin.name === "level-tools");
    expect(publisherPlugins).toHaveLength(1);
    expect(publisherPlugins[0]).toMatchObject({
      id: "marketplace:game-skills:level-tools",
      installed: true,
      catalog: { pluginId: published.json().plugin.id, releaseId: published.json().release.id },
      origin: { type: "claude-marketplace", marketplace: "Game Skills" },
      author: { id: "publisher", displayName: "OhMyGame Creator" },
    });

    const consumer = createApp({ dataDirectory: await temporary("ohmygame-claude-plugin-consumer-"), publishApiUrl: runtime.apiUrl });
    apps.push(consumer);
    await consumer.ready();
    const catalogInstall = await consumer.inject({ method: "POST", url: "/plugins/ohmygame%3Alevel-tools/install" });
    expect(catalogInstall.statusCode, catalogInstall.body).toBe(201);
    expect(catalogInstall.json()).toMatchObject({
      id: "ohmygame:level-tools",
      version: "0.1.0",
      skills: [{ name: "Levels" }],
    });
  });

  it("shares a project Asset, browses it, and imports it into an existing project", async () => {
    const runtime = await testRuntime();
    const source = await createProject(runtime.daemon, "Source");
    const target = await createProject(runtime.daemon, "Target");
    await writeFile(path.join(source.workspacePath, "sprite.png"), "image-one");
    await mkdir(path.join(source.workspacePath, ".data"), { recursive: true });
    await writeFile(path.join(source.workspacePath, ".data", "assets.json"), JSON.stringify({
      version: 1,
      prompts: { "sprite.png": "A forest sprite" },
      previews: {},
      publications: {},
    }));

    const shared = await publishAsset(runtime.daemon, source.id, "sprite.png");
    expect(shared.statusCode).toBe(201);
    const first = shared.json();
    expect((await runtime.daemon.inject({ method: "GET", url: `/projects/${source.id}/files` })).json()).toContainEqual(expect.objectContaining({
      path: "sprite.png",
      publication: expect.objectContaining({ assetId: first.asset.id, releaseId: first.release.id, status: "listed" }),
    }));
    const explored = await runtime.daemon.inject({ method: "GET", url: "/explore/assets" });
    expect(explored.json()).toMatchObject([{ id: first.asset.id, title: "sprite", description: "A forest sprite", mediaType: "image" }]);

    const unlisted = await runtime.daemon.inject({
      method: "PUT", url: `/projects/${source.id}/assets/publication?path=sprite.png`,
      payload: { accessToken: token, status: "unlisted" },
    });
    expect(unlisted.statusCode, unlisted.body).toBe(200);
    expect(unlisted.json().status).toBe("unlisted");
    expect((await runtime.daemon.inject({ method: "GET", url: "/explore/assets" })).json()).toEqual([]);

    const relisted = await runtime.daemon.inject({
      method: "PUT", url: `/projects/${source.id}/assets/publication?path=sprite.png`,
      payload: { accessToken: token, status: "listed" },
    });
    expect(relisted.statusCode, relisted.body).toBe(200);
    expect(relisted.json().status).toBe("listed");
    expect((await runtime.daemon.inject({ method: "GET", url: "/explore/assets" })).json()).toHaveLength(1);

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

    const imported = await runtime.daemon.inject({ method: "POST", url: `/projects/${target.id}/explore-assets/${first.asset.id}` });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().path).toBe("assets/imported/hero.png");
    expect(await readFile(path.join(target.workspacePath, imported.json().path), "utf8")).toBe("image-two");
    const duplicate = await runtime.daemon.inject({ method: "POST", url: `/projects/${target.id}/explore-assets/${first.asset.id}` });
    expect(duplicate.json()).toEqual(imported.json());
    expect(await readdir(path.join(target.workspacePath, "assets", "imported"))).toEqual(["hero.png"]);

    const metadata = JSON.parse(await readFile(path.join(source.workspacePath, ".data", "assets.json"), "utf8"));
    expect(metadata.publications["hero.png"]).toMatchObject({ assetId: first.asset.id, releaseId: republished.json().release.id, status: "listed" });
    expect(JSON.stringify(metadata)).not.toContain(token);
  });

  it("publishes a generated Asset directly from tool history", async () => {
    const dataDirectory = await temporary("ohmygame-tool-publish-");
    const runtime = await testRuntime(dataDirectory, undefined, {
      generate: async () => ({ bytes: Buffer.from("generated-image"), mediaType: "image/webp" }),
    });
    const generated = await runtime.daemon.inject({
      method: "POST",
      url: "/tools/generate-image/runs",
      payload: { prompt: "A forest sprite" },
    });
    expect(generated.statusCode, generated.body).toBe(201);
    const run = generated.json();

    const published = await runtime.daemon.inject({
      method: "POST",
      url: `/tool-runs/${run.id}/files/output.webp/publish`,
      payload: { accessToken: token },
    });
    expect(published.statusCode, published.body).toBe(201);
    expect((await runtime.daemon.inject({ method: "GET", url: "/explore/assets" })).json()).toContainEqual(
      expect.objectContaining({ title: "A forest sprite", description: "A forest sprite", mediaType: "image" }),
    );
    expect((await runtime.daemon.inject({ method: "GET", url: "/tool-runs" })).json()[0].files[0].publication)
      .toMatchObject({ assetId: published.json().asset.id, status: "listed" });

    const unlisted = await runtime.daemon.inject({
      method: "PUT",
      url: `/tool-runs/${run.id}/files/output.webp/publication`,
      payload: { accessToken: token, status: "unlisted" },
    });
    expect(unlisted.statusCode, unlisted.body).toBe(200);
    expect(unlisted.json().status).toBe("unlisted");
    expect((await runtime.daemon.inject({ method: "GET", url: "/explore/assets" })).json()).toEqual([]);

    await runtime.daemon.close();
    apps.splice(apps.indexOf(runtime.daemon), 1);
    const restored = createApp({ dataDirectory, imageGenerator: { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) } });
    apps.push(restored);
    expect((await restored.inject({ method: "GET", url: "/tool-runs" })).json()[0].files[0].publication.status).toBe("unlisted");
  });

  it("truncates a generated Asset prompt to the publish description limit", async () => {
    const runtime = await testRuntime();
    const project = await createProject(runtime.daemon, "Long prompt");
    await writeFile(path.join(project.workspacePath, "asset.png"), "image");
    await mkdir(path.join(project.workspacePath, ".data"), { recursive: true });
    await writeFile(path.join(project.workspacePath, ".data", "assets.json"), JSON.stringify({
      version: 1,
      prompts: { "asset.png": "x".repeat(PUBLISH_ASSET_DESCRIPTION_MAX_LENGTH + 1) },
      previews: {},
      publications: {},
    }));

    const published = await publishAsset(runtime.daemon, project.id, "asset.png");

    expect(published.statusCode, published.body).toBe(201);
    expect(published.json().asset.description).toHaveLength(PUBLISH_ASSET_DESCRIPTION_MAX_LENGTH);
  });

  it("rejects a downloaded Asset whose contents fail integrity verification", async () => {
    const asset = {
      id: "asset-1", title: "Asset", description: "", mediaType: "image", releaseId: "release-1",
      artifactSha256: "0".repeat(64), artifactBytes: 4, fileName: "asset.png", contentType: "image/png",
      publishedAt: new Date(0).toISOString(),
    };
    const daemon = createApp({
      dataDirectory: await temporary("ohmygame-daemon-"),
      publishApiUrl: "https://publish.example",
      publishFetch: async (input) => String(input).endsWith("/content")
        ? new Response("fake", { headers: { "content-type": "image/png" } })
        : Response.json(asset),
    });
    apps.push(daemon);
    const project = await createProject(daemon, "Target");
    const response = await daemon.inject({ method: "POST", url: `/projects/${project.id}/explore-assets/${asset.id}` });
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
      { ...published.game, author: { id: "publisher", displayName: "OhMyGame Creator" }, stats: { likes: 0, uses: 0 } },
    ]);
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
    const story = createPlayableStoryDocument();
    const chapter = story.chapter;
    chapter.nodes.push({ id: "scene", type: "scene", position: { x: 200, y: 0 }, data: { title: "Opening", presentation: { media: { mode: "own", items: [{ id: "clip", type: "video", source: { type: "library", assetId: video.id } }] }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } } } });
    const initialState = chapter.nodes.find((node: { type: string }) => node.type === "project-state");
    const ending = chapter.nodes.find((node: { type: string }) => node.type === "ending");
    if (!initialState || !ending) throw new Error("Playable story fixture is incomplete");
    chapter.edges = chapter.edges.filter((edge: { source: string }) => edge.source !== initialState.id);
    chapter.edges.push({ id: "state-scene", source: initialState.id, target: "scene" }, { id: "scene-ending", source: "scene", target: ending.id });
    syncStoryLayout(story);
    expect((await runtime.daemon.inject({ method: "PUT", url: `/projects/${project.id}/story`, payload: story })).statusCode).toBe(204);

    const built = await runtime.daemon.inject({ method: "POST", url: `/projects/${project.id}/interactive-drama/build` });
    expect(built.statusCode).toBe(200);
    expect(built.headers["content-type"]).toBe("application/zip");

    const published = await publishProject(runtime.daemon, project.id);
    expect(published.statusCode, published.body).toBe(201);
    const output = path.join(runtime.publishData, "artifacts", published.json().deployment.id);
    expect(await readFile(path.join(output, "index.html"), "utf8")).toContain("Published player");
    expect(await readFile(path.join(output, "scene-surface.html"), "utf8")).toContain("ohmygame:scene-surface");
    const publishedStory = JSON.parse(await readFile(path.join(output, "story.json"), "utf8"));
    const persistedStory = (await runtime.daemon.inject({ method: "GET", url: `/projects/${project.id}/story` })).json();
    const { editorLayout: _editorLayout, ...runtimeStory } = persistedStory;
    expect(publishedStory).toEqual(runtimeStory);
    expect(publishedStory.editorLayout).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"))).toMatchObject({
      version: 1,
      story: "story.json",
      scope: `published:${project.id}`,
      assets: {
        [video.id]: `./assets/media/${video.id}.mp4`,
      },
    });
    expect(await readFile(path.join(output, "assets", "media", `${video.id}.mp4`))).toEqual(videoContents);
  });

  it("does not apply the remote publish size limit to a local Interactive Drama build", async () => {
    const runtime = await testRuntime();
    const project = await createProject(runtime.daemon, "Large Drama", "interactive-drama");
    const story = createPlayableStoryDocument();
    const chapter = story.chapter;
    const initialState = chapter.nodes.find((node: { type: string }) => node.type === "project-state");
    expect(initialState).toBeDefined();
    expect((await runtime.daemon.inject({ method: "PUT", url: `/projects/${project.id}/story`, payload: story })).statusCode).toBe(204);
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

function syncStoryLayout(story: ReturnType<typeof createPlayableStoryDocument>): void {
  story.editorLayout.nodes = Object.fromEntries(story.chapter.nodes.map((node) => [node.id, node.position] as const));
}

async function testRuntime(dataDirectory = undefined as string | undefined, publishFetch?: typeof fetch, imageGenerator?: ImageGenerator) {
  const publishData = await temporary("ohmygame-publish-server-");
  const publishServer = createPublishApp({
    dataDirectory: publishData,
    playOrigin: "http://localhost:43130",
    verifyPublisherToken: async (value) => value === token ? "publisher" : undefined,
  });
  apps.push(publishServer);
  const apiUrl = await publishServer.listen({ host: "127.0.0.1", port: 0 });
  const playerDirectory = await temporary("ohmygame-player-");
  await writeFile(path.join(playerDirectory, "index.html"), "<h1>Published player</h1>");
  await writeFile(path.join(playerDirectory, "player.js"), "window.player = true");
  await writeFile(path.join(playerDirectory, "scene-surface.html"), "ohmygame:scene-surface");
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
