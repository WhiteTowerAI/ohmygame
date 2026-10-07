import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { CodingSession } from "../src/daemon/agent.js";
import { writePlayableFixtureWorkspace } from "./playable-fixture.js";
import { MODEL_3D_MODELS } from "../src/shared/generation-config.js";

const apps: ReturnType<typeof createApp>[] = [];
const TEST_VIDEO_MODEL = { provider: "openrouter", id: "example/video-model" } as const;
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function saveProjectAsset(app: Awaited<ReturnType<typeof createApp>>, projectId: string, filePath: string) {
  const saved = await app.inject({ method: "POST", url: `/projects/${projectId}/assets/library?path=${encodeURIComponent(filePath)}` });
  expect(saved.statusCode, saved.body).toBe(201);
  return saved.json();
}

describe("daemon", () => {
  it("exposes project activity without requiring a conversation event subscription", async () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const prompt = vi.fn(async () => completion);
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-project-activity-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const activity = async () => (await app.inject({ method: "GET", url: "/projects/activity" })).json();
    expect(await activity()).toEqual([]);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
        payload: { prompt: "Build" },
      });
      expect(response.statusCode).toBe(202);
      await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
      expect(await activity()).toEqual([{ projectId: project.id, status: "running" }]);
      expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([expect.objectContaining({ id: project.id })]);
      await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns/${response.json().turnId}/cancel` });
      expect(await activity()).toEqual([{ projectId: project.id, status: "cancelling" }]);
    } finally {
      finish();
    }
    await vi.waitFor(async () => expect(await activity()).toEqual([]));
  });

  it("creates an empty isolated Web Game project", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } });
    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project.name).toBe("First");
    expect(project.type).toBe("web-game");
    expect(await readdir(project.workspacePath)).toEqual([]);
    expect(project.preview).toEqual({ status: "waiting" });
  });

  it("creates a typed project", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Story", type: "interactive-story" });
    const codebase = (await app.inject({ method: "GET", url: `/projects/${response.json().id}/playable/codebase` })).json();
    expect(codebase.graph).toMatchObject({ entryNodeId: "start", edges: [] });
  });

  it("serves the Node Runtime only for projects with graph.json", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Nodes", type: "interactive-story" },
    })).json();

    await rm(path.join(project.workspacePath, "graph.json"));
    const story = await app.inject({ method: "GET", url: `/projects/${project.id}/playable` });
    expect(story.statusCode).toBe(200);
    expect(story.json()).toEqual({ available: false });

    await writePlayableFixtureWorkspace(project.workspacePath);
    const playable = await app.inject({ method: "GET", url: `/projects/${project.id}/playable` });
    expect(playable.statusCode).toBe(200);
    expect(playable.json()).toMatchObject({ available: true, definition: { version: 1, graph: { title: "Ash Club" } } });

    await writeFile(path.join(project.workspacePath, "graph.json"), "{");
    const invalid = await app.inject({ method: "GET", url: `/projects/${project.id}/playable` });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain("graph.json is not valid JSON");
  });

  it("accepts a custom viewport only for blank Interactive Story projects", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-viewport-")),
    });
    apps.push(app);

    const valid = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "interactive-story",
        viewport: { width: 720, height: 1280 },
      },
    });
    const webProject = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "web-game",
        viewport: { width: 1280, height: 720 },
      },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "interactive-story",
        viewport: { width: 100, height: 720 },
      },
    });

    expect(valid.statusCode).toBe(201);
    const codebase = (await app.inject({ method: "GET", url: `/projects/${valid.json().id}/playable/codebase` })).json();
    expect(codebase.graph.viewport).toEqual({ width: 720, height: 1280 });
    expect(webProject.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
  });

  it("uses a selected non-empty folder as an external workspace without deleting it", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-external-project-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-user-workspace-"));
    await writeFile(path.join(workspacePath, "README.md"), "Existing project files\n");
    const app = createApp({ dataDirectory });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Existing files", workspacePath },
    });

    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project).toMatchObject({
      name: "Existing files",
      workspaceLocation: "external",
      workspaceAvailable: true,
    });
    expect(project.workspacePath).toBe(await realpath(workspacePath));
    expect(await readFile(path.join(workspacePath, "README.md"), "utf8")).toBe("Existing project files\n");

    const conversation = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` });
    expect(conversation.statusCode).toBe(201);
    expect((await stat(path.join(dataDirectory, "projects", project.id, "session"))).isDirectory()).toBe(true);

    const duplicateWorkspace = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Duplicate workspace", workspacePath },
    });
    expect(duplicateWorkspace.statusCode).toBe(400);
    expect(duplicateWorkspace.json()).toEqual({ error: "This folder overlaps with another OhMyGame workspace" });

    const nestedWorkspace = path.join(workspacePath, "nested");
    await mkdir(nestedWorkspace);
    const nested = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Nested workspace", workspacePath: nestedWorkspace },
    });
    expect(nested.statusCode).toBe(400);
    expect(nested.json()).toEqual({ error: "This folder overlaps with another OhMyGame workspace" });

    expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(204);
    expect(await readFile(path.join(workspacePath, "README.md"), "utf8")).toBe("Existing project files\n");
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("does not run a non-server dev script from an imported workspace", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-external-preview-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-format-workspace-"));
    await writeFile(path.join(workspacePath, "package.json"), JSON.stringify({
      scripts: { dev: "bun format" },
    }));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Formatting workspace", workspacePath },
    })).json();

    const preview = await app.inject({ method: "POST", url: `/projects/${project.id}/preview` });

    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toEqual({ error: "This folder's dev script runs a non-server task: bun format" });
    expect(project.preview).toEqual({ status: "waiting" });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("recognizes a runnable imported workspace when it is created", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-runnable-workspace-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-vite-workspace-"));
    await writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const app = createApp({ dataDirectory });
    apps.push(app);

    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Runnable workspace", workspacePath },
    })).json();

    expect(project.preview).toEqual({ status: "stopped" });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("sets a Web Game startup directory when its dev server is nested", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-nested-preview-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-nested-workspace-"));
    const startupDirectory = path.join(workspacePath, "apps", "game");
    await mkdir(startupDirectory, { recursive: true });
    await writeFile(path.join(startupDirectory, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const app = createApp({ dataDirectory });
    apps.push(app);

    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Nested workspace", workspacePath } })).json();
    expect(project.preview).toEqual({ status: "waiting" });

    const configured = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/settings/startup-directory`,
      payload: { startupDirectory: "apps/game" },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ startupDirectory: "apps/game", preview: { status: "stopped" } });

    const runSettings = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/settings/run`,
      payload: {
        startupDirectory: "apps/game",
        startupScript: "dev",
        packageManager: "pnpm",
        previewPath: "/play",
        previewViewport: "mobile",
      },
    });
    expect(runSettings.statusCode).toBe(200);
    expect(runSettings.json()).toMatchObject({
      startupDirectory: "apps/game",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport: "mobile",
    });

    const invalid = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/settings/startup-directory`,
      payload: { startupDirectory: "../outside" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "Startup directory must be a relative path inside the project workspace" });
    await rm(workspacePath, { recursive: true, force: true });
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
    expect(await readdir(duplicated.json().workspacePath)).toEqual(["index.html"]);
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}` })).statusCode).toBe(404);
  });

  it("exposes read-only workspace code and media", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "hello world.txt"), "Hello\n");
    await writeFile(path.join(project.workspacePath, "cover.png"), Buffer.from([1, 2, 3]));
    await mkdir(path.join(project.workspacePath, "empty-folder"));

    const files = await app.inject({ method: "GET", url: `/projects/${project.id}/files` });
    const content = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/content?path=${encodeURIComponent("hello world.txt")}`,
    });
    const media = await app.inject({ method: "GET", url: `/projects/${project.id}/files/raw?path=cover.png` });
    const location = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/location?path=${encodeURIComponent("hello world.txt")}`,
    });
    const folderLocation = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/location?path=empty-folder`,
    });

    expect(files.json()).toEqual([
      { path: "cover.png", size: 3, mediaType: "image" },
      { path: "empty-folder", size: 0, directory: true },
      { path: "hello world.txt", size: 6 },
    ]);
    expect(content.json()).toMatchObject({ path: "hello world.txt", content: "Hello\n", binary: false });
    expect(media.headers["content-type"]).toBe("image/png");
    expect(media.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    expect(location.json()).toEqual({ path: path.join(await realpath(project.workspacePath), "hello world.txt") });
    expect(folderLocation.json()).toEqual({ path: path.join(await realpath(project.workspacePath), "empty-folder") });
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

  it("saves project media once in the global Library and protects references", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-api-")) });
    apps.push(app);
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story" },
    })).json();
    await writeFile(path.join(project.workspacePath, "opening.mp4"), "video bytes");
    expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual([]);
    await saveProjectAsset(app, project.id, "opening.mp4");

    const first = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    const second = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ name: "opening.mp4", mediaType: "video", contentType: "video/mp4", size: 11 });
    const content = await app.inject({ method: "GET", url: `/library/assets/${first[0].id}/content` });
    expect(content.rawPayload.toString()).toBe("video bytes");

    await useLibraryAssetInGraph(app, project.id, "opening", "video", first[0].id);
    const blocked = await app.inject({ method: "DELETE", url: `/library/assets/${first[0].id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "Asset is used by 1 project" });

    const references = await app.inject({ method: "GET", url: `/library/assets/${first[0].id}/references` });
    expect(references.json()).toEqual([{ id: project.id, name: "Story", type: "interactive-story" }]);
    const removed = await app.inject({ method: "DELETE", url: `/library/assets/${first[0].id}?force=true` });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json()).not.toContainEqual(expect.objectContaining({ path: "opening.mp4" }));
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    expect(updated.graph.assets.opening).toBeUndefined();
  });

  it("materializes a Library asset once", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-materialize-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const source = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Source" } })).json();
    const target = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Target" } })).json();
    await writeFile(path.join(source.workspacePath, "sprite.png"), "image bytes");
    await saveProjectAsset(app, source.id, "sprite.png");
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
  });

  it("blocks Library deletion when an Interactive Story document cannot be verified", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-broken-graph-")) });
    apps.push(app);
    const storyProject = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    await writeFile(path.join(storyProject.workspacePath, "graph.json"), JSON.stringify({ version: 1, nodes: "broken" }));
    const source = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(source.workspacePath, "image.png"), "image bytes");
    await saveProjectAsset(app, source.id, "image.png");
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
    await saveProjectAsset(app, project.id, "sprite.png");
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
      payload: { name: "Story", type: "interactive-story" },
    })).json();
    await useLibraryAssetInGraph(app, project.id, "reference", "image", response.json().id);
    expect((await app.inject({ method: "GET", url: `/library/assets/${response.json().id}/references` })).json()).toHaveLength(1);

    expect((await app.inject({ method: "DELETE", url: `/library/assets/${response.json().id}?force=true` })).statusCode).toBe(204);
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    expect(updated.graph.assets.reference).toBeUndefined();
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

    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    await useLibraryAssetInGraph(app, project.id, "clip", "video", response.json().id);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${response.json().id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${response.json().id}?force=true` })).statusCode).toBe(204);
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    expect(updated.graph.assets.clip).toBeUndefined();
    expect(updated.graph.nodes[0].assets).not.toContain("clip");
  });

  it("uploads and serves an SVG image from the global Library", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>');

    const response = await app.inject({
      method: "POST",
      url: "/library/assets/upload?name=logo.svg&mediaType=image%2Fsvg%2Bxml",
      headers: { "content-type": "application/octet-stream" },
      payload: svg,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ name: "logo.svg", mediaType: "image", contentType: "image/svg+xml" });
    const content = await app.inject({ method: "GET", url: `/library/assets/${response.json().id}/content` });
    expect(content.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(content.rawPayload).toEqual(svg);
  });

  it("rejects non-SVG data uploaded as SVG", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/library/assets/upload?name=logo.svg&mediaType=image%2Fsvg%2Bxml",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("not an svg"),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "File data does not match its media type" });
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
    const location = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/location?path=${encodeURIComponent("../project.json")}`,
    });
    expect(location.statusCode).toBe(400);
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

  it("exposes the shared Plugins and Skills to Interactive Story conversations", async () => {
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
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
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
      "web_search",
      "update_plan",
      "install_plugin",
      "generate_image",
      "generate_3d_asset",
      "generate_video",
      "animate_3d_asset",
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

  it("stores dropped files outside the game workspace and gives the agent an attachment manifest", async () => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachments-")),
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
    const batchId = "dbd8b240-d5e1-4d0e-a741-5e9bd23f7571";

    const uploaded = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=dialogue.json&relativePath=${encodeURIComponent("references/dialogue.json")}`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: Buffer.from('{"opening":"Hello"}'),
    });

    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json()).toMatchObject({ batchId, relativePath: "references/dialogue.json", kind: "text" });
    expect(await readFile(path.join(project.workspacePath, ".data", "agent-attachments", batchId, "files", "references", "dialogue.json"), "utf8")).toContain("Hello");
    const metadata = JSON.parse(await readFile(path.join(project.workspacePath, ".data", "agent-attachments", batchId, "metadata", `${uploaded.json().id}.json`), "utf8"));
    expect(metadata).not.toHaveProperty("absolutePath");

    const sent = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "", attachments: [{ id: uploaded.json().id, batchId }] },
    });

    expect(sent.statusCode, sent.body).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.stringContaining("references/dialogue.json")));
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("untrusted reference material"));
  });

  it("passes a verified image attachment to a vision-capable agent", async () => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachment-image-")),
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
    const batchId = "ae4a9775-641e-4595-bbc8-1f1de5fb889b";
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=hero.png`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: image,
    });

    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({ kind: "image", mediaType: "image/png" });
    const sent = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "", attachments: [{ id: uploaded.json().id, batchId }] },
    });

    expect(sent.statusCode, sent.body).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.stringContaining("hero.png"), {
      images: [{ type: "image", mimeType: "image/png", data: image.toString("base64") }],
    }));
    expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual([
      expect.objectContaining({ name: "hero.png", mediaType: "image" }),
    ]);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "assets/imported/hero.png", mediaType: "image" }),
    ]));
  });

  it("rejects unsafe folder paths in agent attachments", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachment-path-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const batchId = "f8b3c92d-5017-4d83-bf05-946208ee2b1a";

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=.env&relativePath=${encodeURIComponent("secrets/.env")}`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: Buffer.from("SECRET=value"),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid attachment path" });
  });

  it("rejects attachment metadata that no longer matches its file", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachment-metadata-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const batchId = "d8ea3d7b-4665-4e7a-9d58-f1e246ac812d";
    const uploaded = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=notes.txt`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: Buffer.from("hello"),
    });
    const metadataPath = path.join(project.workspacePath, ".data", "agent-attachments", batchId, "metadata", `${uploaded.json().id}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));

    await writeFile(metadataPath, JSON.stringify({ ...metadata, size: 1 }));
    const wrongSize = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Read it", attachments: [{ id: uploaded.json().id, batchId }] },
    });
    expect(wrongSize.statusCode).toBe(500);

    await writeFile(metadataPath, JSON.stringify({ ...metadata, kind: "image", mediaType: "image/png" }));
    const fakeImage = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Read it", attachments: [{ id: uploaded.json().id, batchId }] },
    });
    expect(fakeImage.statusCode).toBe(500);
  });

  it("cleans expired draft batches but retains batches used by a conversation", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachment-cleanup-")),
      createSession: async () => ({
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const expiredBatch = "1e447592-12ac-4f8f-9da0-6027daf6a902";
    const claimedBatch = "c14bbf1a-1534-4e2a-b850-cd9e076af289";
    const upload = async (batchId: string, name: string) => app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=${name}`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: Buffer.from(name),
    });

    const expired = await upload(expiredBatch, "expired.txt");
    const claimed = await upload(claimedBatch, "claimed.txt");
    const sent = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Read it", attachments: [{ id: claimed.json().id, batchId: claimedBatch }] },
    });
    expect(sent.statusCode).toBe(202);

    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const attachmentRoot = path.join(project.workspacePath, ".data", "agent-attachments");
    await utimes(path.join(attachmentRoot, expiredBatch), old, old);
    await utimes(path.join(attachmentRoot, claimedBatch), old, old);
    expect((await upload("fd2de1f6-0acf-4d68-84cb-d8066f33ffeb", "fresh.txt")).statusCode).toBe(201);

    await expect(readFile(path.join(attachmentRoot, expiredBatch, "files", "expired.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(attachmentRoot, claimedBatch, "files", "claimed.txt"), "utf8")).toBe("claimed.txt");
    expect(expired.statusCode).toBe(201);
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
      cursor: 2,
    });
    await expect.poll(() => typeof finishPrompt).toBe("function");
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
    expect(detail.pendingPrompts).toEqual([
      expect.objectContaining({ turnId: third.turnId, prompt: "Third", steering: true }),
      expect.objectContaining({ turnId: second.turnId, prompt: "Second" }),
    ]);
    expect(clearQueue).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenLastCalledWith("Third", undefined);
    finishPrompt();
  });

  it("serves the Playable sandbox without a token", async () => {
    const playerDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-player-"));
    await mkdir(path.join(playerDirectory, "assets"));
    await writeFile(path.join(playerDirectory, "playable-sandbox.html"), "<script src=\"./assets/playable-sandbox.js\"></script>");
    await writeFile(path.join(playerDirectory, "assets", "playable-sandbox.js"), "console.log(1);");
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")),
      interactiveStoryPlayerDirectory: playerDirectory,
      accessToken: "secret",
    });
    apps.push(app);
    const page = await app.inject({ method: "GET", url: "/playable-sandbox/playable-sandbox.html" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.body).toContain("./assets/playable-sandbox.js");
    const script = await app.inject({ method: "GET", url: "/playable-sandbox/assets/playable-sandbox.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toMatch(/^text\/javascript/);
    // Everything else still needs the token.
    expect((await app.inject({ method: "GET", url: "/projects" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/playable-sandbox/playable-sandbox.html?x" })).statusCode).toBe(401);
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
    expect(preview.json()).toEqual({ error: "This folder has no package.json dev script that starts a preview server." });
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

  it("stores Node thumbnails as editor cache outside the file list", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnail-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Nodes", type: "interactive-story" } })).json();
    await writePlayableFixtureWorkspace(project.workspacePath);
    const image = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    const put = (nodeId: string, payload: Buffer, hash = "0123abcd0123ab") => app.inject({
      method: "PUT",
      url: `/projects/${project.id}/playable/thumbnails/${nodeId}?hash=${hash}`,
      headers: { "content-type": "image/webp" },
      payload,
    });

    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/playable/thumbnails/menu` })).statusCode).toBe(404);
    expect((await put("menu", Buffer.from("not-webp"))).statusCode).toBe(400);
    expect((await put("nowhere", image)).statusCode).toBe(400);
    expect((await put("menu", image, "nope")).statusCode).toBe(400);
    const stored = await put("menu", image);
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({ hash: "0123abcd0123ab" });

    const listed = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/thumbnails` });
    expect(listed.json()).toEqual({ thumbnails: { menu: stored.json() } });
    const loaded = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/thumbnails/menu` });
    expect(loaded.headers["content-type"]).toBe("image/webp");
    expect(loaded.rawPayload).toEqual(image);

    const files = (await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json() as { path: string }[];
    expect(files.some((file) => file.path.startsWith(".ohmygame"))).toBe(false);
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
      listCredentials: async () => [],
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

  it("never sends a ChatGPT sign-in through the custom OpenAI endpoint", async () => {
    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();
    const runtime = {
      ...fakeModelRuntime([]),
      listCredentials: async () => [{ providerId: "openai", type: "oauth" }],
      registerProvider,
      unregisterProvider,
    } as unknown as ModelRuntime;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-model-endpoint-oauth-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);

    await app.inject({
      method: "PUT",
      url: "/settings/models/providers/openai/endpoint",
      payload: { baseUrl: "https://relay.example/v1" },
    });

    expect(registerProvider).not.toHaveBeenCalled();
    expect(unregisterProvider).not.toHaveBeenCalled();
  });

  it("drops the custom OpenAI endpoint once ChatGPT sign-in completes", async () => {
    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();
    let credentials: Array<{ providerId: string; type: string }> = [];
    const runtime = {
      ...fakeModelRuntime([]),
      getProvider: (provider: string) => ({ name: provider, auth: { oauth: {}, apiKey: { login: true } } }),
      listCredentials: async () => credentials,
      login: async () => {
        credentials = [{ providerId: "openai", type: "oauth" }];
        return { type: "oauth" };
      },
      registerProvider,
      unregisterProvider,
    } as unknown as ModelRuntime;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-model-endpoint-signin-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);

    await app.inject({ method: "PUT", url: "/settings/models/providers/openai/endpoint", payload: { baseUrl: "https://relay.example/v1" } });
    expect(registerProvider).toHaveBeenCalledWith("openai", { baseUrl: "https://relay.example/v1" });

    const login = await app.inject({ method: "POST", url: "/settings/models/providers/openai/login", payload: { method: "oauth" } });
    expect(login.statusCode).toBe(202);
    await vi.waitFor(() => expect(unregisterProvider).toHaveBeenCalledWith("openai"));
  });

  it("does not expose the removed Cloud model connection", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-cloud-removed-")) });
    apps.push(app);
    const connected = await app.inject({ method: "PUT", url: "/account/connection", payload: { accessToken: "user-token" } });
    expect(connected.statusCode).toBe(404);
  });

  it("stores and clears Meshy credentials", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-meshy-settings-")) });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/settings/models/providers/meshy" })).json())
      .toEqual({ configured: false });
    expect((await app.inject({
      method: "PUT",
      url: "/settings/models/providers/meshy",
      payload: { apiKey: "meshy-key" },
    })).json()).toEqual({ configured: true });
    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/meshy" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/settings/models/providers/meshy" })).json())
      .toEqual({ configured: false });
    expect((await app.inject({ method: "PUT", url: "/settings/models/providers/meshy", payload: {} })).statusCode).toBe(400);
  });

  it("stores official Seedance credentials independently without exposing their values", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-seedance-settings-")) });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: "/settings/providers" });
    expect(initial.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "volcengine-ark", configured: false, status: "not_configured", capabilities: ["image", "video"] }),
      expect.objectContaining({ id: "byteplus-modelark", configured: false, status: "not_configured", capabilities: ["video"] }),
    ]));
    expect(initial.body).not.toContain("volc-key");

    expect((await app.inject({
      method: "PUT",
      url: "/settings/models/providers/volcengine-ark/seedance-key",
      payload: { apiKey: "volc-key" },
    })).json()).toEqual({ configured: true });
    expect((await app.inject({
      method: "PUT",
      url: "/settings/models/providers/byteplus-modelark/seedance-key",
      payload: { apiKey: "byteplus-key" },
    })).json()).toEqual({ configured: true });

    const configured = await app.inject({ method: "GET", url: "/settings/providers" });
    expect(configured.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "volcengine-ark", configured: true, status: "connected" }),
      expect.objectContaining({ id: "byteplus-modelark", configured: true, status: "connected" }),
    ]));
    expect(configured.body).not.toContain("volc-key");
    expect(configured.body).not.toContain("byteplus-key");

    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/volcengine-ark/seedance-key" })).statusCode).toBe(204);
    const afterDomesticClear = (await app.inject({ method: "GET", url: "/settings/providers" })).json();
    expect(afterDomesticClear).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "volcengine-ark", configured: false }),
      expect.objectContaining({ id: "byteplus-modelark", configured: true }),
    ]));
    expect((await app.inject({ method: "PUT", url: "/settings/models/providers/openrouter/seedance-key", payload: { apiKey: "wrong" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/openrouter/seedance-key" })).statusCode).toBe(404);
  });

  it("offers 3D models once Meshy is configured", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-model3d-catalog-")) });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json()).toEqual({ models: [], providers: [] });
    await app.inject({ method: "PUT", url: "/settings/models/providers/meshy", payload: { apiKey: "meshy-key" } });
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json()).toEqual({
      models: MODEL_3D_MODELS,
      providers: [{ provider: "meshy", providerName: "Meshy", state: "ready" }],
    });
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

  it("restores an external workspace after an app restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-external-restart-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-external-workspace-"));
    await writeFile(path.join(workspacePath, "existing.txt"), "Keep me");
    const first = createApp({ dataDirectory });
    apps.push(first);
    await first.ready();
    const project = (await first.inject({ method: "POST", url: "/projects", payload: { name: "External", workspacePath } })).json();
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createApp({ dataDirectory });
    apps.push(second);
    await second.ready();
    const restored = await second.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      id: project.id,
      workspacePath: await realpath(workspacePath),
      workspaceLocation: "external",
      workspaceAvailable: true,
    });
    await second.close();
    apps.splice(apps.indexOf(second), 1);
    await rm(workspacePath, { recursive: true, force: true });

    const third = createApp({ dataDirectory });
    apps.push(third);
    await third.ready();
    const missingWorkspace = await third.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(missingWorkspace.statusCode).toBe(200);
    expect(missingWorkspace.json()).toMatchObject({
      id: project.id,
      workspaceLocation: "external",
      workspaceAvailable: false,
    });
    expect((await third.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(204);
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
          { id: "compaction-1", turnId: "user-1", type: "contextCompaction", status: "completed", summary: "Earlier context", tokensBefore: 42_000, timestamp: 2 },
        ],
      }],
      cursor: 0,
      pendingPrompts: [],
    });
  });

  it("snapshots the active turn at the latest cursor when conversation is loaded mid-run", async () => {
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
    const turn = await app.inject({
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
      }, {
        id: turn.json().turnId,
        status: "inProgress",
        items: [
          { turnId: turn.json().turnId, type: "userMessage", text: "Current" },
        ],
      }],
      cursor: 1,
    });
    finishPrompt();
  });
});

/** Declares a Library asset in the project's graph and uses it on the Start node. */
/** A new project has no Scenes; adds a Blank one, `start`, through the editor's endpoint. */
async function addStartScene(app: Pick<ReturnType<typeof createApp>, "inject">, projectId: string): Promise<void> {
  const added = await app.inject({ method: "POST", url: `/projects/${projectId}/playable/nodes`, payload: { preset: "blank", id: "start" } });
  expect(added.statusCode, added.body).toBe(200);
}

/** Declares a Library asset on the project's first Scene, adding one when there is none. */
async function useLibraryAssetInGraph(
  app: ReturnType<typeof createApp>,
  projectId: string,
  id: string,
  type: "image" | "video",
  assetId: string,
): Promise<void> {
  let codebase = (await app.inject({ method: "GET", url: `/projects/${projectId}/playable/codebase` })).json();
  if (!codebase.graph.nodes.length) {
    await addStartScene(app, projectId);
    codebase = (await app.inject({ method: "GET", url: `/projects/${projectId}/playable/codebase` })).json();
  }
  codebase.graph.assets[id] = { type, source: { kind: "library", assetId } };
  codebase.graph.nodes[0].assets.push(id);
  const saved = await app.inject({ method: "PUT", url: `/projects/${projectId}/playable/codebase`, payload: codebase });
  expect(saved.statusCode, saved.body).toBe(204);
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

describe("Playable Nodes projects", () => {
  async function createPlayableApp(prefix: string, options: Parameters<typeof createApp>[0] = {}) {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), prefix)), ...options });
    apps.push(app);
    return app;
  }

  it("creates Interactive Story projects as Playable Nodes with no Scenes yet", async () => {
    const app = await createPlayableApp("ohmygame-playable-create-");
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Nodes", type: "interactive-story", viewport: { width: 720, height: 1280 } },
    });

    expect(response.statusCode).toBe(201);
    const codebase = (await app.inject({ method: "GET", url: `/projects/${response.json().id}/playable/codebase` })).json();
    expect(codebase.graph).toMatchObject({
      title: "Nodes",
      viewport: { width: 720, height: 1280 },
      nodes: [],
      edges: [],
    });
    const runtime = (await app.inject({ method: "GET", url: `/projects/${response.json().id}/playable` })).json();
    expect(runtime).toMatchObject({ available: true, definition: { graph: { nodes: [] } } });
  });

  it("lists Presets and adds a Node from one", async () => {
    const app = await createPlayableApp("ohmygame-playable-presets-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();

    const presets = await app.inject({ method: "GET", url: "/playable/presets" });
    expect(presets.statusCode).toBe(200);
    expect(presets.json().presets.map((preset: { id: string }) => preset.id)).toEqual([
      "blank", "main-menu", "choice", "qte", "hotspot", "ending", "story-map",
    ]);

    const created = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/playable/nodes`,
      payload: { preset: "main-menu", id: "menu", title: "Ash Club" },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id: "menu", title: "Ash Club", signals: ["start", "story-map"] });
    const codebase = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    // The first Scene of a new project becomes its Start.
    expect(codebase.graph.nodes.map((node: { id: string }) => node.id)).toEqual(["menu"]);
    expect(codebase.graph.entryNodeId).toBe("menu");
    expect(await readFile(path.join(project.workspacePath, "nodes/menu/index.html"), "utf8")).toContain("Ash Club");
  });

  it("rejects a duplicate Node and an unknown Preset", async () => {
    const app = await createPlayableApp("ohmygame-playable-node-errors-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    await addStartScene(app, project.id);

    const duplicate = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/playable/nodes`,
      payload: { preset: "blank", id: "start" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/playable/nodes`,
      payload: { preset: "epilogue", id: "later" },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/projects/nope/playable/nodes",
      payload: { preset: "blank", id: "later" },
    });

    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toContain("already exists");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain("Unknown Preset");
    expect(missing.statusCode).toBe(404);
  });
  it("loads and atomically updates a Playable codebase", async () => {
    const app = await createPlayableApp("ohmygame-codebase-api-");
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story" },
    })).json();
    await addStartScene(app, project.id);
    const loaded = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` });
    const codebase = loaded.json();
    codebase.graph.title = "Revised Story";
    codebase.editorLayout.nodes.start = { x: 360, y: 240 };
    codebase.sources = {
      "nodes/start/node.js": "export function mount(context) { context.root.innerHTML = 'Revised'; }\n",
    };

    const updated = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/playable/codebase`,
      payload: codebase,
    });
    const afterUpdate = (await app.inject({
      method: "GET",
      url: `/projects/${project.id}/playable/codebase`,
    })).json();
    const invalid = structuredClone(afterUpdate);
    invalid.editorLayout.nodes = {};
    const rejected = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/playable/codebase`,
      payload: invalid,
    });

    expect(loaded.statusCode).toBe(200);
    expect(updated.statusCode).toBe(204);
    const { sources: _sources, ...persistedCodebase } = codebase;
    expect(afterUpdate).toEqual(persistedCodebase);
    expect(await readFile(path.join(project.workspacePath, "nodes/start/node.js"), "utf8"))
      .toBe(codebase.sources["nodes/start/node.js"]);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("Node IDs must exactly match");
    expect((await app.inject({
      method: "GET",
      url: `/projects/${project.id}/playable/codebase`,
    })).json()).toEqual(persistedCodebase);
  });

  it("rejects Playable codebase access for other project types", async () => {
    const app = await createPlayableApp("ohmygame-codebase-type-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game" } })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/playable/codebase`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Playable codebases require an Interactive Story project" });
  });

  it("exposes structured Playable validation for Playtest and agents", async () => {
    const app = await createPlayableApp("ohmygame-playable-validation-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    await addStartScene(app, project.id);

    const valid = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/validation` });
    const graph = JSON.parse(await readFile(path.join(project.workspacePath, "graph.json"), "utf8"));
    graph.entryNodeId = "missing";
    await writeFile(path.join(project.workspacePath, "graph.json"), `${JSON.stringify(graph)}\n`);
    const invalid = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/validation?mode=publish` });

    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ ok: true, issues: [] });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ phase: "graph", code: "missing-node", path: "/entryNodeId" })]) });
  });

  it("rolls back project creation without changing a conflicting external workspace", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-codebase-workspace-"));
    await writeFile(path.join(workspacePath, "graph.json"), "user graph\n");
    await writeFile(path.join(workspacePath, "notes.txt"), "keep me\n");
    const app = await createPlayableApp("ohmygame-codebase-collision-");

    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { type: "interactive-story", workspacePath },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Playable project files already exist: graph.json" });
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([]);
    expect(await readFile(path.join(workspacePath, "graph.json"), "utf8")).toBe("user graph\n");
    expect(await readFile(path.join(workspacePath, "notes.txt"), "utf8")).toBe("keep me\n");
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("protects Library assets declared by a Playable Nodes graph", async () => {
    const app = await createPlayableApp("ohmygame-playable-library-api-");
    const source = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Source" } })).json();
    await writeFile(path.join(source.workspacePath, "portrait.png"), "image bytes");
    await saveProjectAsset(app, source.id, "portrait.png");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${source.id}/assets?path=portrait.png` });
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Playable", type: "interactive-story" },
    })).json();
    await addStartScene(app, project.id);
    const codebase = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    codebase.graph.assets.portrait = {
      type: "image",
      source: { kind: "library", assetId: asset.id },
    };
    codebase.graph.nodes[0].assets.push("portrait");
    expect((await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/playable/codebase`,
      payload: codebase,
    })).statusCode).toBe(204);

    const blocked = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "Asset is used by 1 project" });

    const removed = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}?force=true` });
    expect(removed.statusCode).toBe(204);
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    expect(updated.graph.assets.portrait).toBeUndefined();
    expect(updated.graph.nodes[0].assets).not.toContain("portrait");
  });
});

describe("Asset Canvas projects", () => {
  async function createCanvasApp(prefix: string) {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), prefix)) });
    apps.push(app);
    return app;
  }
  async function getCanvas(app: Awaited<ReturnType<typeof createApp>>, projectId: string) {
    const workspace = (await app.inject(`/projects/${projectId}/canvas/workspace`)).json();
    return (await app.inject(`/projects/${projectId}/canvas/boards/${workspace.boards[0].id}`)).json();
  }
  async function saveCanvas(app: Awaited<ReturnType<typeof createApp>>, projectId: string, board: { id: string }) {
    const current = await getCanvas(app, projectId);
    return app.inject({ method: "PUT", url: `/projects/${projectId}/canvas/boards/${board.id}`, payload: { board, revision: current.revision } });
  }

  it("stores Asset Canvas boards in the shared canvas directory", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();

    const created = await getCanvas(app, project.id);
    expect(created.board).toMatchObject({ version: 1, nodes: [], edges: [] });

    const document = created.board;
    document.nodes = [{ id: "image", type: "image", position: { x: 96, y: 96 }, data: { prompt: "A lantern", resolution: "1K", aspectRatio: "1:1", images: [] } }];
    document.editorLayout.nodes = { image: { x: 96, y: 96 } };
    expect((await saveCanvas(app, project.id, document)).statusCode).toBe(200);

    const files = await readdir(project.workspacePath);
    expect(files).toContain("canvas");
    expect(files).not.toContain("canvas.json");
    const workspace = (await app.inject({ method: "GET", url: `/projects/${project.id}/canvas/workspace` })).json();
    expect(workspace.boards).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/canvas/boards/${workspace.boards[0].id}` })).json().board.nodes).toEqual(document.nodes);
    expect((await getCanvas(app, project.id)).board.nodes).toEqual([
      expect.objectContaining({ id: "image", type: "image", data: expect.objectContaining({ prompt: "A lantern" }) }),
    ]);
  });

  it("rejects canvas documents with unknown node types", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-invalid-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();
    const document = (await getCanvas(app, project.id)).board;
    document.nodes = [{ id: "start", type: "start", position: { x: 0, y: 0 }, data: {} }];
    document.editorLayout.nodes = { start: { x: 0, y: 0 } };

    expect((await saveCanvas(app, project.id, document)).statusCode).toBe(400);
  });

  it("shares canvas endpoints with Interactive Story projects", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-story-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();

    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/canvas/workspace` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/text/generate`, payload: { instruction: "Write" } })).statusCode).toBe(409);
  });

  it("protects and removes Library assets used by a canvas", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-library-");
    const source = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Source" } })).json();
    await writeFile(path.join(source.workspacePath, "portrait.png"), "image bytes");
    await saveProjectAsset(app, source.id, "portrait.png");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${source.id}/assets?path=portrait.png` });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();
    const document = (await getCanvas(app, project.id)).board;
    document.nodes = [
      { id: "asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: asset.id, mediaType: "image" } },
      { id: "image", type: "image", position: { x: 320, y: 0 }, data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [{ type: "node", nodeId: "asset" }, { type: "library", assetId: asset.id }] } },
    ];
    document.edges = [{ id: "asset-image", source: "asset", target: "image" }];
    document.editorLayout.nodes = { asset: { x: 0, y: 0 }, image: { x: 320, y: 0 } };
    expect((await saveCanvas(app, project.id, document)).statusCode).toBe(200);

    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}?force=true` })).statusCode).toBe(204);

    const updated = (await getCanvas(app, project.id)).board;
    expect(updated.nodes).toEqual([expect.objectContaining({ id: "image", data: expect.objectContaining({ images: [] }) })]);
    expect(updated.edges).toEqual([]);
    expect(Object.keys(updated.editorLayout.nodes)).toEqual(["image"]);
  });

  it("protects and removes Library models used by an Animate 3D node", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-animate-library-");
    const source = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Source" } })).json();
    await writeFile(path.join(source.workspacePath, "hero.glb"), "glb bytes");
    await saveProjectAsset(app, source.id, "hero.glb");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${source.id}/assets?path=hero.glb` });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();
    const document = (await getCanvas(app, project.id)).board;
    document.nodes = [{ id: "animate", type: "animate-3d", position: { x: 0, y: 0 }, data: { source: { type: "library", assetId: asset.id }, heightMeters: 1.7, actionIds: [0] } }];
    document.editorLayout.nodes = { animate: { x: 0, y: 0 } };
    expect((await saveCanvas(app, project.id, document)).statusCode).toBe(200);

    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}?force=true` })).statusCode).toBe(204);

    const updated = (await getCanvas(app, project.id)).board;
    expect(updated.nodes).toEqual([expect.objectContaining({ id: "animate", data: { heightMeters: 1.7, actionIds: [0] } })]);
  });
});
