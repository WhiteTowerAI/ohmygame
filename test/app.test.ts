import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { CodingSession } from "../src/daemon/agent.js";
import { VIDEO_MODEL, type StoryDocument } from "../src/shared/contracts.js";
import { DEFAULT_SCENE_SURFACE_FILES, isStoryDocument, resolveStoryAssetId, validatePlayableChapter } from "../src/shared/story.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("daemon", () => {
  it("creates an isolated project with Web Game instructions", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } });
    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project.name).toBe("First");
    expect(project.type).toBe("web-game");
    expect(await readdir(project.workspacePath)).toEqual(["AGENTS.md"]);
    expect(project.preview).toEqual({ status: "waiting" });
  });

  it("creates a typed project", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-drama" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Story", type: "interactive-drama" });
    const story = (await app.inject({ method: "GET", url: `/projects/${response.json().id}/story` })).json();
    expect(story.chapter).toMatchObject({ nodes: [], edges: [] });
  });

  it("accepts a custom story viewport only for blank Interactive Drama projects", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-story-viewport-")),
      interactiveDramaExamplesDirectory: path.resolve("examples/interactive-drama"),
    });
    apps.push(app);

    const valid = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "interactive-drama",
        storyViewport: { width: 720, height: 1280 },
      },
    });
    const webProject = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "web-game",
        storyViewport: { width: 1280, height: 720 },
      },
    });
    const template = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "interactive-drama",
        templateId: "night-train",
        storyViewport: { width: 720, height: 1280 },
      },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "interactive-drama",
        storyViewport: { width: 100, height: 720 },
      },
    });

    expect(valid.statusCode).toBe(201);
    const story = (await app.inject({ method: "GET", url: `/projects/${valid.json().id}/story` })).json();
    expect(story.player.viewport).toEqual({ width: 720, height: 1280 });
    expect(webProject.statusCode).toBe(400);
    expect(template.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
  });

  it("creates a fresh Interactive Drama sample when explicitly requested", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-starter-create-")),
      interactiveDramaExamplesDirectory: path.resolve("examples/interactive-drama"),
    });
    apps.push(app);
    const created = await Promise.all([
      app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama", templateId: "night-train" } }),
      app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama", templateId: "night-train" } }),
    ]);
    expect(created.map((response) => response.statusCode)).toEqual([201, 201]);
    const projects = (await app.inject({ method: "GET", url: "/projects" })).json();
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((project: { id: string }) => project.id)).size).toBe(2);
    expect(projects.every((project: { name: string; type: string }) => project.name === "Last Train Home" && project.type === "interactive-drama")).toBe(true);

    const storyJson: unknown = (await app.inject({ method: "GET", url: `/projects/${created[0]!.json().id}/story` })).json();
    const assets = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    const assetIds = new Set<string>(assets.map((asset: { id: string }) => asset.id));
    expect(isStoryDocument(storyJson), JSON.stringify(storyJson, null, 2)).toBe(true);
    const story = storyJson as StoryDocument;
    expect(validatePlayableChapter(story.chapter, { availableAssets: new Map([...assetIds].map((id) => [id, "video" as const])) })).toBeUndefined();
    const scene = story.chapter.nodes.find((node) => node.type === "scene");
    expect(scene?.type === "scene" && scene.data.presentation.media.mode === "own" && scene.data.presentation.media.items.every((item) => assetIds.has(resolveStoryAssetId(story.chapter, item.source)!))).toBe(true);
    expect((await app.inject({ method: "GET", url: `/projects/${created[0]!.json().id}/cover` })).statusCode).toBe(200);
  });

  it("uses updated sample media only for newly created projects", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-sample-media-"));
    const examplesDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-samples-"));
    const sampleDirectory = path.join(examplesDirectory, "night-train");
    await mkdir(sampleDirectory);
    await writeFile(path.join(sampleDirectory, "mara.jpg"), "cover");
    await writeFile(path.join(sampleDirectory, "night-train.mp4"), "first video");
    const app = createApp({ dataDirectory, interactiveDramaExamplesDirectory: examplesDirectory });
    apps.push(app);

    const firstProject = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama", templateId: "night-train" } })).json();
    await writeFile(path.join(sampleDirectory, "night-train.mp4"), "updated video");
    const secondProject = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama", templateId: "night-train" } })).json();

    const assetId = async (projectId: string) => {
      const story = (await app.inject({ method: "GET", url: `/projects/${projectId}/story` })).json() as StoryDocument;
      const scene = story.chapter.nodes.find((node) => node.type === "scene");
      if (scene?.type !== "scene") throw new Error("Sample scene not found");
      const media = scene.data.presentation.media;
      if (media.mode !== "own" || !media.items[0]) throw new Error("Sample video not found");
      return resolveStoryAssetId(story.chapter, media.items[0].source)!;
    };
    const firstAssetId = await assetId(firstProject.id);
    const secondAssetId = await assetId(secondProject.id);

    expect(secondAssetId).not.toBe(firstAssetId);
    expect((await app.inject({ method: "GET", url: `/library/assets/${firstAssetId}/content` })).rawPayload.toString()).toBe("first video");
    expect((await app.inject({ method: "GET", url: `/library/assets/${secondAssetId}/content` })).rawPayload.toString()).toBe("updated video");
  });

  it("rejects an Interactive Drama template for another project type", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-template-type-")) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", templateId: "night-train" } });
    expect(response.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([]);
  });

  it("creates a Godot project and rejects the removed general type", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);

    const godot = await app.inject({ method: "POST", url: "/projects", payload: { name: "Platformer", type: "godot-game" } });
    const general = await app.inject({ method: "POST", url: "/projects", payload: { type: "general" } });

    expect(godot.statusCode).toBe(201);
    expect(godot.json()).toMatchObject({ name: "Platformer", type: "godot-game" });
    expect(general.statusCode).toBe(400);
  });

  it("loads and updates an Interactive Drama story", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-drama" },
    })).json();

    const loaded = await app.inject({ method: "GET", url: `/projects/${project.id}/story` });
    const story = loaded.json();
    story.chapter.title = "The Stopover";
    const updated = await app.inject({ method: "PUT", url: `/projects/${project.id}/story`, payload: story });

    expect(loaded.statusCode).toBe(200);
    expect(story.chapter).toMatchObject({ nodes: [], edges: [] });
    expect(updated.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json())
      .toMatchObject({ chapter: { title: "The Stopover" } });
  });

  it("generates story text with a selected language model", async () => {
    const model = { provider: "provider-one", id: "model-one", name: "Model One" };
    const completeSimple = vi.fn().mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "A cinematic rooftop at night." }],
      stopReason: "stop",
    });
    const runtime = {
      ...fakeModelRuntime([model]),
      completeSimple,
    } as unknown as ModelRuntime;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-story-text-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama" } })).json();

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/story/text/generate`,
      payload: { instruction: "Write an image prompt", model: { provider: model.provider, id: model.id } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "A cinematic rooftop at night.", model: { provider: model.provider, id: model.id } });
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("rejects story text generation without an available model", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-story-text-")),
      createModelRuntime: async () => fakeModelRuntime([]),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama" } })).json();

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/story/text/generate`,
      payload: { instruction: "Write an image prompt", model: { provider: "missing", id: "missing" } },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "The selected language model is not available" });
  });

  it("rejects story text generation for other project types", async () => {
    const completeSimple = vi.fn();
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-story-text-")),
      createModelRuntime: async () => ({
        ...fakeModelRuntime([{ provider: "provider-one", id: "model-one", name: "Model One" }]),
        completeSimple,
      } as unknown as ModelRuntime),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game" } })).json();

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/story/text/generate`,
      payload: { instruction: "Write an image prompt", model: { provider: "provider-one", id: "model-one" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Story documents require an Interactive Drama project" });
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("lists projects", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const first = (await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } })).json();
    const second = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Second" } })).json();

    const response = await app.inject({ method: "GET", url: "/projects" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([second, first]);
  });

  it("renames, duplicates, and deletes projects", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-project-actions-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>First</h1>");

    const renamed = await app.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { name: "Renamed" } });
    const duplicated = await app.inject({ method: "POST", url: `/projects/${project.id}/duplicate` });
    const deleted = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Renamed" });
    expect(duplicated.statusCode).toBe(201);
    expect(duplicated.json()).toMatchObject({ name: "Renamed copy" });
    expect(await readdir(duplicated.json().workspacePath)).toEqual(["AGENTS.md", "index.html"]);
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}` })).statusCode).toBe(404);
  });

  it("exposes read-only workspace code and media", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "hello world.txt"), "Hello\n");
    await writeFile(path.join(project.workspacePath, "cover.png"), Buffer.from([1, 2, 3]));

    const files = await app.inject({ method: "GET", url: `/projects/${project.id}/files` });
    const content = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/content?path=${encodeURIComponent("hello world.txt")}`,
    });
    const media = await app.inject({ method: "GET", url: `/projects/${project.id}/files/raw?path=cover.png` });

    expect(files.json()).toEqual([
      { path: "AGENTS.md", size: expect.any(Number) },
      { path: "cover.png", size: 3, mediaType: "image" },
      { path: "hello world.txt", size: 6 },
    ]);
    expect(content.json()).toMatchObject({ path: "hello world.txt", content: "Hello\n", binary: false });
    expect(media.headers["content-type"]).toBe("image/png");
    expect(media.rawPayload).toEqual(Buffer.from([1, 2, 3]));
  });

  it("renames and deletes workspace assets", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "old name.png"), Buffer.from([1, 2, 3]));

    const renamed = await app.inject({
      method: "PATCH",
      url: `/projects/${project.id}/assets?path=${encodeURIComponent("old name.png")}`,
      payload: { name: "new name" },
    });
    const removed = await app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/assets?path=${encodeURIComponent("new name.png")}`,
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ path: "new name.png" });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json()).not.toContainEqual(expect.objectContaining({ path: "opening.mp4" }));
  });

  it("registers project media once in the global Library and protects references", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-api-")) });
    apps.push(app);
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-drama" },
    })).json();
    await writeFile(path.join(project.workspacePath, "opening.mp4"), "video bytes");

    const first = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    const second = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ name: "opening.mp4", mediaType: "video", contentType: "video/mp4", size: 11 });
    const content = await app.inject({ method: "GET", url: `/library/assets/${first[0].id}/content` });
    expect(content.rawPayload.toString()).toBe("video bytes");

    const story = (await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json();
    story.chapter.nodes.push({
      id: "video",
      type: "video",
      position: { x: 0, y: 0 },
      data: {
        prompt: "Opening",
        model: VIDEO_MODEL,
        resolution: "720p",
        aspectRatio: "16:9",
        duration: 6,
        references: [],
        assetId: first[0].id,
      },
    }, {
      id: "scene",
      type: "scene",
      position: { x: 100, y: 0 },
      data: {
        title: "Opening",
        presentation: {
          media: { mode: "own", items: [
            { id: "library-clip", type: "video", source: { type: "library", assetId: first[0].id } },
            { id: "node-clip", type: "video", source: { type: "node", nodeId: "video" } },
          ] },
          surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) },
        },
      },
    });
    syncStoryLayout(story);
    await app.inject({ method: "PUT", url: `/projects/${project.id}/story`, payload: story });
    const blocked = await app.inject({ method: "DELETE", url: `/library/assets/${first[0].id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "Asset is used by 1 project" });

    const references = await app.inject({ method: "GET", url: `/library/assets/${first[0].id}/references` });
    expect(references.json()).toEqual([{ id: project.id, name: "Story", type: "interactive-drama" }]);
    const removed = await app.inject({ method: "DELETE", url: `/library/assets/${first[0].id}?force=true` });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json()).not.toContainEqual(expect.objectContaining({ path: "opening.mp4" }));
    const updatedStory = (await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json();
    expect(updatedStory.chapter.nodes.find((node: { id: string }) => node.id === "video").data.assetId).toBeUndefined();
    expect(updatedStory.chapter.nodes.find((node: { id: string }) => node.id === "scene").data.presentation.media.items).toEqual([
      { id: "node-clip", type: "video", source: { type: "node", nodeId: "video" } },
    ]);
  });

  it("materializes a Library asset once and checks unused Story projects without creating a document", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-materialize-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const source = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Source" } })).json();
    const target = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Target" } })).json();
    const story = (await app.inject({
      method: "POST", url: "/projects", payload: { name: "Story", type: "interactive-drama" },
    })).json();
    await writeFile(path.join(source.workspacePath, "sprite.png"), "image bytes");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/projects/${target.id}/library-assets/${asset.id}` }),
      app.inject({ method: "POST", url: `/projects/${target.id}/library-assets/${asset.id}` }),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(await readdir(path.join(target.workspacePath, "assets", "imported"))).toEqual(["sprite.png"]);
    const missing = await app.inject({ method: "POST", url: `/projects/${target.id}/library-assets/missing` });
    expect(missing.statusCode).toBe(404);
    const blocked = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });
    expect(blocked.statusCode).toBe(409);
    await expect(readFile(path.join(story.workspacePath, "story.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks Library deletion when an Interactive Drama document cannot be verified", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-old-story-")) });
    apps.push(app);
    const storyProject = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama" } })).json();
    await writeFile(path.join(storyProject.workspacePath, "story.json"), JSON.stringify({ version: 1, chapters: [] }));
    const source = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(source.workspacePath, "image.png"), "image bytes");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${source.id}/assets?path=image.png` });

    const response = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Cannot verify Library references");
  });

  it("blocks Library deletion when a canonical Interactive Drama project is incomplete", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-incomplete-story-")) });
    apps.push(app);
    const storyProject = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama" } })).json();
    await app.inject({ method: "GET", url: `/projects/${storyProject.id}/story` });
    await rm(path.join(storyProject.workspacePath, "editor/layout.json"));
    const source = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(source.workspacePath, "image.png"), "image bytes");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${source.id}/assets?path=image.png` });

    const response = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Cannot verify Library references");
  });

  it("renames and deletes an unreferenced Library asset", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-actions-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "sprite.png"), "image bytes");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${project.id}/assets?path=sprite.png` });

    const renamed = await app.inject({ method: "PATCH", url: `/library/assets/${asset.id}`, payload: { name: "hero" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("hero.png");
    const removed = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/library/assets/${asset.id}/content` })).statusCode).toBe(404);
  });

  it("imports a local image into the global Library", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const response = await app.inject({
      method: "POST",
      url: "/library/assets",
      payload: {
        name: "reference.webp",
        image: { mediaType: "image/png", data: png.toString("base64") },
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ name: "reference.png", mediaType: "image", contentType: "image/png" });
    const content = await app.inject({ method: "GET", url: `/library/assets/${response.json().id}/content` });
    expect(content.rawPayload).toEqual(png);

    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-drama" },
    })).json();
    const story = (await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json();
    story.chapter.nodes.push({
      id: "video",
      type: "video",
      position: { x: 100, y: 0 },
      data: {
        prompt: "Animate",
        model: VIDEO_MODEL,
        resolution: "720p",
        aspectRatio: "16:9",
        duration: 6,
        references: [{ type: "library", assetId: response.json().id }],
      },
    });
    syncStoryLayout(story);
    expect((await app.inject({ method: "PUT", url: `/projects/${project.id}/story`, payload: story })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/library/assets/${response.json().id}/references` })).json()).toHaveLength(1);

    expect((await app.inject({ method: "DELETE", url: `/library/assets/${response.json().id}?force=true` })).statusCode).toBe(204);
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json();
    expect(updated.chapter.nodes.find((node: { id: string }) => node.id === "video").data.references).toEqual([]);
  });

  it("rejects Library image data that does not match its media type", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/library/assets",
      payload: {
        name: "reference.png",
        image: { mediaType: "image/png", data: Buffer.from("not a png").toString("base64") },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Image data does not match its media type" });
    expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual([]);
  });

  it("uploads a video into the global Library", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

    const response = await app.inject({
      method: "POST",
      url: "/library/assets/upload?name=opening.mp4&mediaType=video%2Fmp4&duration=6.5",
      headers: { "content-type": "application/octet-stream" },
      payload: mp4,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ name: "opening.mp4", mediaType: "video", contentType: "video/mp4", duration: 6.5 });
    const content = await app.inject({ method: "GET", url: `/library/assets/${response.json().id}/content` });
    expect(content.rawPayload).toEqual(mp4);

    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama" } })).json();
    const story = (await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json();
    story.chapter.nodes.push(
      { id: "uploaded-video", type: "asset", position: { x: 100, y: 0 }, data: { assetId: response.json().id, mediaType: "video" } },
      { id: "scene", type: "scene", position: { x: 400, y: 0 }, data: { title: "Opening", presentation: { media: { mode: "own", items: [{ id: "clip", type: "video", source: { type: "node", nodeId: "uploaded-video" } }] }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } } } },
    );
    syncStoryLayout(story);
    expect((await app.inject({ method: "PUT", url: `/projects/${project.id}/story`, payload: story })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${response.json().id}?force=true` })).statusCode).toBe(204);
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json();
    expect(updated.chapter.nodes.some((node: { id: string }) => node.id === "uploaded-video")).toBe(false);
    expect(updated.chapter.nodes.find((node: { id: string }) => node.id === "scene").data.presentation.media.items).toEqual([]);
  });

  it("removes deleted Library assets from image references", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-reference-")) });
    apps.push(app);
    const image = (await app.inject({
      method: "POST",
      url: "/library/assets",
      payload: { name: "reference.png", image: { mediaType: "image/png", data: "iVBORw0KGgo=" } },
    })).json();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama" } })).json();
    const story = (await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json();
    story.chapter.nodes.push(
      { id: "library-image", type: "asset", position: { x: 100, y: 0 }, data: { assetId: image.id, mediaType: "image" } },
      { id: "generated-image", type: "image", position: { x: 400, y: 0 }, data: { prompt: "Compose", resolution: "1K", aspectRatio: "1:1", images: [{ type: "library", assetId: image.id }, { type: "node", nodeId: "library-image" }] } },
    );
    syncStoryLayout(story);
    expect((await app.inject({ method: "PUT", url: `/projects/${project.id}/story`, payload: story })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${image.id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${image.id}?force=true` })).statusCode).toBe(204);

    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json();
    expect(updated.chapter.nodes.some((node: { id: string }) => node.id === "library-image")).toBe(false);
    expect(updated.chapter.nodes.find((node: { id: string }) => node.id === "generated-image").data.images).toEqual([]);
  });

  it("rejects unsafe workspace file paths", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/content?path=${encodeURIComponent("../project.json")}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid workspace path" });
  });

  it("validates workspace references before prompting", async () => {
    const prompts: string[] = [];
    const session: CodingSession = {
      messages: [],
      prompt: async (prompt) => { prompts.push(prompt); },
      abort: async () => {},
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-reference-api-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "Hello");
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    const accepted = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Review", references: [{ type: "workspace-file", path: "index.html" }] },
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Review", references: [{ type: "workspace-file", path: "missing.html" }] },
    });

    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => expect(prompts[0]).toContain('["index.html"]'));
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "File not found" });
  });

  it("validates Plugin mentions and sends Codex references to Pi", async () => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-mention-api-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const mention = { name: "godot", displayName: "Godot", marketplaceId: "ohmygame" };

    const accepted = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Use @Godot", mentions: [mention] },
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("Use [@Godot](plugin://godot@ohmygame)"));
    const rejected = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Use @Missing", mentions: [{ name: "missing", displayName: "Missing", marketplaceId: "ohmygame" }] },
    });

    expect(accepted.statusCode).toBe(202);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "Plugin Missing is not installed" });
  });

  it("returns the skills loaded by the current conversation session", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-capabilities-api-")),
      createSession: async () => ({
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        getSkills: () => [{ name: "review", description: "Review changes" }],
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${conversation.id}/capabilities`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills).toEqual([{ name: "review", description: "Review changes" }]);
  });

  it("exposes the shared Plugins and Skills to Interactive Drama conversations", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-story-capabilities-api-")),
      createSession: async () => ({
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        getSkills: () => [{ name: "godot", description: "Control Godot" }],
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-drama" } })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${conversation.id}/capabilities`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills).toEqual([{ name: "godot", description: "Control Godot" }]);
  });

  it("makes OhMyGame media generation available without a Plugin", async () => {
    const setActiveToolsByName = vi.fn();
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-default-media-tools-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        setActiveToolsByName,
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Create a character image" },
    });

    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "write",
      "edit",
      "bash",
      "update_plan",
      "install_plugin",
      "generate_image",
      "generate_3d_asset",
      "generate_video",
    ]);
  });

  it("accepts an image without text and passes it to Pi", async () => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-image-prompt-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const image = { name: "狗大王.PNG", mediaType: "image/png", data: "aW1hZ2U=" };

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "", images: [image] },
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("", {
      images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
    }));
    await vi.waitFor(async () => {
      const detail = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` });
      expect(detail.json().agent.status).toBe("idle");
    });
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Again", images: [image] } })).statusCode).toBe(202);
    expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual([
      expect.objectContaining({ name: "狗大王.png", mediaType: "image" }),
    ]);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "assets/imported/狗大王.png", mediaType: "image" }),
    ]));
  });

  it("restores an active image prompt without replaying its base64 event", async () => {
    let finishPrompt!: () => void;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-active-image-")),
      createSession: async () => ({
        messages: [],
        prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
        abort: async () => { finishPrompt(); },
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const image = { mediaType: "image/png", data: "aW1hZ2U=" };
    const turn = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Describe", images: [image] },
    });

    const detail = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` });

    expect(detail.json()).toMatchObject({
      turns: [{
        id: turn.json().turnId,
        conversationId: conversation.id,
        status: "inProgress",
        items: [
          { type: "userMessage", text: "Describe", images: [image], turnId: turn.json().turnId },
          { type: "imageRead", count: 1, status: "completed", turnId: turn.json().turnId },
        ],
      }],
      cursor: 1,
    });
    finishPrompt();
  });

  it("removes only the expected pending follow-up", async () => {
    let finishPrompt!: () => void;
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      followUp: async () => {},
      steer: async () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-pending-api-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "First" },
    });
    const pending = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Second" },
    });

    const stale = await app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/conversations/${conversation.id}/queue/stale-turn`,
    });
    const current = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` });
    const removed = await app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/conversations/${conversation.id}/queue/${pending.json().turnId}`,
    });

    expect(stale.statusCode).toBe(409);
    expect(current.json().pendingPrompts).toEqual([
      expect.objectContaining({ turnId: pending.json().turnId, prompt: "Second" }),
    ]);
    expect(removed.statusCode).toBe(204);
    finishPrompt();
  });

  it("removes and steers queued messages", async () => {
    let finishPrompt!: () => void;
    const followUp = vi.fn(async () => {});
    const steer = vi.fn(async () => {});
    const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      followUp,
      steer,
      clearQueue,
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-queue-api-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "First" } });
    const second = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Second" } })).json();
    const third = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Third" } })).json();

    const steered = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/queue/${third.turnId}/steer` });
    const detail = (await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` })).json();

    expect(steered.statusCode).toBe(204);
    expect(detail.pendingPrompts).toEqual([expect.objectContaining({ turnId: second.turnId, prompt: "Second" })]);
    expect(clearQueue).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenLastCalledWith("Third", undefined);
    finishPrompt();
  });

  it("exposes health and rejects empty prompts", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: " " },
    });
    expect(response.statusCode).toBe(400);
    const preview = await app.inject({ method: "POST", url: `/projects/${project.id}/preview` });
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toEqual({ error: "Workspace is not runnable yet" });
  });

  it("stores and serves a WebP project cover", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-cover-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const cover = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

    const missing = await app.inject({ method: "GET", url: `/projects/${project.id}/cover` });
    const invalid = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/cover`,
      headers: { "content-type": "image/webp" },
      payload: Buffer.from("not-webp"),
    });
    const stored = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/cover`,
      headers: { "content-type": "image/webp" },
      payload: cover,
    });
    const loaded = await app.inject({ method: "GET", url: `/projects/${project.id}/cover` });

    expect(missing.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
    expect(stored.statusCode).toBe(204);
    expect(loaded.statusCode).toBe(200);
    expect(loaded.headers["content-type"]).toBe("image/webp");
    expect(loaded.rawPayload).toEqual(cover);
  });

  it("opens an idle event stream immediately", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-sse-")) });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);

    try {
      const response = await fetch(`${address}/projects/${project.id}/events`, { signal: controller.signal });
      const chunk = await response.body?.getReader().read();
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(chunk?.value)).toBe(": connected\n\n");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  it("uses the first prompt as the conversation title without renaming the project", async () => {
    const session: CodingSession = {
      messages: [],
      prompt: async () => { throw new Error("No API key"); },
      abort: async () => {},
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-title-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations`,
    })).json();

    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Build a small game" },
    });
    const conversations = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations`,
    });
    const unchangedProject = await app.inject({ method: "GET", url: `/projects/${project.id}` });

    expect(conversations.json()).toEqual([
      expect.objectContaining({ id: conversation.id, title: "Build a small game" }),
    ]);
    expect(unchangedProject.json().name).toBe(project.name);
  });

  it("lists Pi models and stores a conversation model without starting a session", async () => {
    const first = { provider: "provider-one", id: "model-one", name: "Model One", reasoning: true };
    const second = { provider: "provider-one", id: "model-two", name: "Model Two", reasoning: true };
    const runtime = fakeModelRuntime([first, second]);
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-models-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();

    const models = await app.inject({ method: "GET", url: "/models" });
    const defaults = await app.inject({
      method: "PUT",
      url: "/models/default",
      payload: { model: { provider: second.provider, id: second.id }, reasoningLevel: "high" },
    });
    const created = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations`,
      payload: { model: { provider: first.provider, id: first.id }, reasoningLevel: "medium" },
    });
    const createdWithDefaults = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations`,
      payload: {},
    });
    const changed = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/conversations/${created.json().id}/model`,
      payload: { provider: second.provider, id: second.id },
    });
    const detail = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${created.json().id}`,
    });
    const defaultDetail = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${createdWithDefaults.json().id}`,
    });
    const reasoning = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/conversations/${created.json().id}/reasoning`,
      payload: { level: "high" },
    });

    expect(models.json()).toEqual({
      models: [
        { provider: first.provider, providerName: first.provider, id: first.id, name: first.name, reasoningLevels: ["off", "minimal", "low", "medium", "high"] },
        { provider: second.provider, providerName: second.provider, id: second.id, name: second.name, reasoningLevels: ["off", "minimal", "low", "medium", "high"] },
      ],
      defaultReasoningLevel: "medium",
    });
    expect(defaults.statusCode).toBe(204);
    expect(created.json()).toMatchObject({ id: expect.any(String), projectId: project.id, title: "New conversation" });
    expect(changed.json()).toEqual({
      model: { provider: second.provider, id: second.id },
      reasoningLevel: "medium",
    });
    expect(reasoning.json()).toEqual({ level: "high" });
    expect(detail.json().settings.model).toEqual({ provider: second.provider, id: second.id });
    expect(detail.json().cursor).toBe(0);
    expect(defaultDetail.json().settings).toEqual({
      model: { provider: second.provider, id: second.id },
      reasoningLevel: "high",
    });
  });

  it("applies an OpenAI-compatible endpoint through Pi", async () => {
    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();
    const runtime = {
      ...fakeModelRuntime([]),
      registerProvider,
      unregisterProvider,
    } as unknown as ModelRuntime;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-model-endpoint-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: "/settings/models/providers/openai/endpoint" });
    const custom = await app.inject({
      method: "PUT",
      url: "/settings/models/providers/openai/endpoint",
      payload: { baseUrl: "https://relay.example/v1" },
    });
    const official = await app.inject({
      method: "PUT",
      url: "/settings/models/providers/openai/endpoint",
      payload: { baseUrl: "https://api.openai.com/v1" },
    });

    expect(initial.json()).toEqual({ baseUrl: "https://api.openai.com/v1" });
    expect(custom.json()).toEqual({ baseUrl: "https://relay.example/v1" });
    expect(official.json()).toEqual({ baseUrl: "https://api.openai.com/v1" });
    expect(registerProvider).toHaveBeenCalledWith("openai", { baseUrl: "https://relay.example/v1" });
    expect(unregisterProvider).toHaveBeenCalledWith("openai");
  });

  it("connects and disconnects the OhMyGame account provider", async () => {
    const runtime = {
      ...fakeModelRuntime([{ provider: "openai", id: "known-model", name: "Known Model" }]),
      getModels: vi.fn(() => [{
        provider: "openai", id: "known-model", name: "Known Model", reasoning: false,
        input: ["text"], contextWindow: 100_000, maxTokens: 10_000,
      }]),
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      setRuntimeApiKey: vi.fn(async () => undefined),
      removeRuntimeApiKey: vi.fn(async () => undefined),
      listCredentials: vi.fn(async () => []),
    } as unknown as ModelRuntime;
    const accountServiceFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { base_url: "https://account.ohmygame.ai/v1", api_key: "sk-account" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "known-model" }] }));
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-account-")),
      createModelRuntime: async () => runtime,
      accountServiceFetch,
    });
    apps.push(app);

    const connected = await app.inject({ method: "PUT", url: "/account/connection", payload: { accessToken: "user-token" } });
    const disconnected = await app.inject({ method: "DELETE", url: "/account/connection" });

    expect(connected.json()).toEqual({ status: "connected", modelCount: 1 });
    expect(disconnected.statusCode).toBe(204);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("ohmygame", "sk-account");
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith("ohmygame");
  });

  it("proxies account requests through the local daemon", async () => {
    const accountServiceFetch = vi.fn(async () => Response.json({ data: [{ id: 1, name: "Plus" }] }));
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-account-")),
      accountServiceFetch,
    });
    apps.push(app);

    const plans = await app.inject({ method: "GET", url: "/account/plans" });
    const usage = await app.inject({
      method: "POST",
      url: "/account/usage?page=1",
      payload: { accessToken: "supabase-token" },
    });

    expect(plans.json()).toEqual([{ id: 1, name: "Plus" }]);
    expect(accountServiceFetch).toHaveBeenCalledWith(new URL("https://account.ohmygame.ai/api/plans"), expect.any(Object));
    expect(usage.statusCode).toBe(200);
    expect(accountServiceFetch).toHaveBeenCalledWith(
      new URL("https://account.ohmygame.ai/api/usage?page=1"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer supabase-token" }),
      }),
    );
    const invalidPage = await app.inject({
      method: "POST",
      url: "/account/usage?page=0",
      payload: { accessToken: "supabase-token" },
    });
    expect(invalidPage.statusCode).toBe(400);
  });

  it("uses the connected Account credential for Meshy 7 generation", async () => {
    const runtime = {
      ...fakeModelRuntime([{ provider: "openai", id: "known-model", name: "Known Model" }]),
      getModels: vi.fn(() => [{
        provider: "openai", id: "known-model", name: "Known Model", reasoning: false,
        input: ["text"], contextWindow: 100_000, maxTokens: 10_000,
      }]),
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      setRuntimeApiKey: vi.fn(async () => undefined),
      removeRuntimeApiKey: vi.fn(async () => undefined),
      listCredentials: vi.fn(async () => []),
      getProviders: vi.fn(() => []),
    } as unknown as ModelRuntime;
    const accountServiceFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { base_url: "https://api.ohmygame.test/v1", api_key: "sk-account" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "known-model" }, { id: "meshy-7" }, { id: "meshy-t2" }] }))
      .mockResolvedValueOnce(Response.json({ id: "task_123", status: "queued", artifacts: [] }))
      .mockResolvedValueOnce(Response.json({
        id: "task_123",
        status: "completed",
        artifacts: [{ id: "artifact_123", kind: "model", variant: "primary", format: "glb", content_url: "/v1/3d/generations/task_123/content" }],
      }))
      .mockResolvedValueOnce(new Response(Buffer.from("glb"), { status: 200, headers: { "content-type": "model/gltf-binary" } }));
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-managed-3d-")),
      createModelRuntime: async () => runtime,
      accountServiceFetch,
    });
    apps.push(app);

    const connected = await app.inject({ method: "PUT", url: "/account/connection", payload: { accessToken: "user-token" } });
    expect(connected.statusCode).toBe(200);
    const providers = (await app.inject({ method: "GET", url: "/settings/providers" })).json();
    expect(providers).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "meshy" })]));
    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ohmygame", capabilities: ["language", "image", "video", "3d"] }),
    ]));
    const generated = await app.inject({
      method: "POST",
      url: "/tools/image-to-3d/runs",
      payload: {
        prompt: "A wooden knight",
        model: "meshy-7",
        quality: "standard",
        texture: true,
        pose: "auto",
      },
    });

    expect(generated.statusCode, generated.body).toBe(201);
    const run = generated.json();
    const file = await app.inject({ method: "GET", url: `/tool-runs/${run.id}/files/model.glb` });
    expect(file.rawPayload).toEqual(Buffer.from("glb"));
    expect(accountServiceFetch).toHaveBeenNthCalledWith(3, "https://api.ohmygame.test/v1/3d/generations", expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer sk-account", "content-type": "application/json" },
    }));
    expect(accountServiceFetch).toHaveBeenNthCalledWith(5, "https://api.ohmygame.test/v1/3d/generations/task_123/content", expect.objectContaining({
      headers: { authorization: "Bearer sk-account" },
    }));
  });

  it("reports Account connection failures as gateway errors", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-account-error-")),
      createModelRuntime: async () => fakeModelRuntime([]),
      accountServiceFetch: vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })),
    });
    apps.push(app);

    const response = await app.inject({ method: "PUT", url: "/account/connection", payload: { accessToken: "user-token" } });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Account service request failed (503)" });
  });

  it("validates request bodies before they reach a manager", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const invalidProject = await app.inject({ method: "POST", url: "/projects", payload: { name: 42 } });
    expect(invalidProject.statusCode).toBe(400);
    const invalidProjectType = await app.inject({ method: "POST", url: "/projects", payload: { type: "unknown" } });
    expect(invalidProjectType.statusCode).toBe(400);

    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const invalidPrompt = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: 42 },
    });
    expect(invalidPrompt.statusCode).toBe(400);
    const longName = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "x".repeat(201) },
    });
    expect(longName.statusCode).toBe(400);
  });

  it("restores a project after an app restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-restart-"));
    const first = createApp({ dataDirectory });
    apps.push(first);
    await first.ready();
    const project = (await first.inject({ method: "POST", url: "/projects", payload: { name: "Persistent" } })).json();
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createApp({ dataDirectory });
    apps.push(second);
    await second.ready();
    const restored = await second.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: project.id, name: "Persistent" });
    expect(restored.json()).not.toHaveProperty("canUndo");
  });

  it("restores conversation history from the project's Pi session", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-conversation-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const sessionDirectory = path.join(dataDirectory, "projects", project.id, "session");
    await mkdir(sessionDirectory);
    await writeFile(path.join(sessionDirectory, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date(0).toISOString(), cwd: project.workspacePath }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 0 },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: new Date(0).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop", timestamp: 1 },
      }),
      JSON.stringify({
        type: "compaction",
        id: "compaction-1",
        parentId: "assistant-1",
        timestamp: new Date(2).toISOString(),
        summary: "Earlier context",
        firstKeptEntryId: "user-1",
        tokensBefore: 42_000,
      }),
    ].join("\n") + "\n");

    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/session-1` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      conversation: expect.objectContaining({
        id: "session-1",
        projectId: project.id,
        title: "Hello",
        messageCount: 2,
      }),
      agent: { status: "idle" },
      settings: {},
      plan: { mode: "normal" },
      turns: [{
        id: "user-1",
        conversationId: "session-1",
        status: "completed",
        items: [
          { id: "user-1", turnId: "user-1", type: "userMessage", text: "Hello", timestamp: 0 },
          { id: "assistant-1:assistant:0", turnId: "user-1", type: "agentMessage", text: "Hi", status: "completed", phase: "final_answer", timestamp: 1 },
        ],
      }, {
        id: "compaction-1",
        conversationId: "session-1",
        status: "completed",
        items: [{ id: "compaction-1", turnId: "compaction-1", type: "contextCompaction", status: "completed", timestamp: 2 }],
      }],
      cursor: 0,
      pendingPrompts: [],
    });
  });

  it("replays only the active turn from SSE when conversation is loaded mid-run", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-active-conversation-"));
    let finishPrompt!: () => void;
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({ dataDirectory, createSession: async () => session });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const sessionDirectory = path.join(dataDirectory, "projects", project.id, "session");
    await mkdir(sessionDirectory);
    const oldTimestamp = new Date(Date.now() - 10_000).toISOString();
    const currentTimestamp = new Date(Date.now() + 10_000).toISOString();
    await writeFile(path.join(sessionDirectory, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date(0).toISOString(), cwd: project.workspacePath }),
      sessionEntry("old-user", null, oldTimestamp, { role: "user", content: "Current", timestamp: 0 }),
      sessionEntry("old-assistant", "old-user", oldTimestamp, { role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop", timestamp: 1 }),
      sessionEntry("current-user", "old-assistant", currentTimestamp, { role: "user", content: "Current", timestamp: 2 }),
    ].join("\n") + "\n");
    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/session-1/turns`,
      payload: { prompt: "Current" },
    });

    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/session-1` });

    expect(response.json()).toMatchObject({
      conversation: { id: "session-1" },
      agent: { status: "running" },
      turns: [{
        id: "old-user",
        status: "completed",
        items: [
          { id: "old-user", turnId: "old-user", type: "userMessage", text: "Current" },
          { id: "old-assistant:assistant:0", turnId: "old-user", type: "agentMessage", text: "Answer", status: "completed" },
        ],
      }],
      cursor: 0,
    });
    finishPrompt();
  });
});

function syncStoryLayout(story: StoryDocument): void {
  story.editorLayout.nodes = Object.fromEntries(story.chapter.nodes.map((node) => [node.id, node.position] as const));
}

function sessionEntry(id: string, parentId: string | null, timestamp: string, message: object): string {
  return JSON.stringify({ type: "message", id, parentId, timestamp, message });
}

function fakeModelRuntime(models: Array<{ provider: string; id: string; name: string }>): ModelRuntime {
  return {
    getAvailable: async (provider?: string) => models.filter((model) => !provider || model.provider === provider),
    getProvider: (provider: string) => ({ name: provider }),
    getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: () => true,
  } as unknown as ModelRuntime;
}
