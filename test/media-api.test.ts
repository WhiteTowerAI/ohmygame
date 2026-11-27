import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type { CanvasAssetCatalogEntry } from "../src/shared/canvas-assets.js";

type App = Awaited<ReturnType<typeof createApp>>;
const fixtures: { app: App; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of fixtures.splice(0)) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

async function setup(directory?: string) {
  directory ??= await mkdtemp(path.join(tmpdir(), "ohmygame-media-"));
  const app = createApp({ dataDirectory: directory });
  fixtures.push({ app, directory });
  return { app, directory };
}

const createProject = async (app: App, payload: Record<string, unknown> = {}) => (await app.inject({ method: "POST", url: "/projects", payload })).json<ProjectState>();

describe("the Library left on disk", () => {
  it("migrates a local Story's Library references from it, before its project type, including on retry", async () => {
    const { app: first, directory } = await setup();
    const project = await createProject(first, { name: "Story" });
    await first.close();
    // As the Library stored an upload before it was removed.
    const library = path.join(directory, "library");
    await mkdir(path.join(library, "files"), { recursive: true });
    await writeFile(path.join(library, "assets.json"), JSON.stringify({ version: 2, assets: [{ id: "portrait-id", name: "Portrait.PNG", size: PNG.length, mediaType: "image", contentType: "image/png", createdAt: "2026-01-01T00:00:00.000Z", saved: true }] }));
    await writeFile(path.join(library, "files", "portrait-id.png"), PNG);
    const manifest = path.join(project.workspacePath, "ohmygame.json");
    const graph = path.join(project.workspacePath, "graph.json");
    const portrait = { type: "image", source: { kind: "library", assetId: "portrait-id" }, future: 7 };
    const original = JSON.stringify({ version: 1, assets: { portrait, missing: { source: { kind: "library", assetId: "gone" } } } });
    await writeFile(manifest, JSON.stringify({ type: "interactive-story" }));
    await writeFile(graph, original);

    const { app: retry } = await setup(directory);
    await retry.ready();
    expect(JSON.parse(await readFile(manifest, "utf8")).type).toBe("interactive-story");
    expect(await readFile(graph, "utf8")).toBe(original);
    await retry.close();

    await writeFile(graph, JSON.stringify({ version: 1, assets: { portrait, second: portrait } }));
    const { app: reopened } = await setup(directory);
    await reopened.ready();
    expect(JSON.parse(await readFile(manifest, "utf8")).type).toBe("general");
    const assets = JSON.parse(await readFile(graph, "utf8")).assets;
    expect(assets.portrait).toMatchObject({ future: 7, source: { kind: "workspace" } });
    expect(assets.second.source).toEqual(assets.portrait.source);
    expect(await readFile(path.join(project.workspacePath, assets.portrait.source.path))).toEqual(PNG);
    // Read, never changed: what is left there stays for the person to keep or remove.
    expect((await readdir(library)).sort()).toEqual(["assets.json", "files"]);
  });
});

describe("project media", () => {
  it("adds an upload, such as a game recording, to the project's media", async () => {
    const { app } = await setup();
    const project = await createProject(app);
    const upload = (projectId: string) => app.inject({
      method: "POST",
      url: `/projects/${projectId}/media?name=play.webm&mediaType=video%2Fwebm`,
      headers: { "content-type": "application/octet-stream" },
      payload: WEBM,
    });
    const response = await upload(project.id);
    expect(response.statusCode, response.body).toBe(201);
    const { path: saved } = response.json<{ path: string }>();
    expect(saved).toMatch(/^\.ohmygame\/media\/imported\/play.*\.webm$/);
    expect(await readFile(path.join(project.workspacePath, saved))).toEqual(WEBM);
    expect((await upload("missing")).statusCode).toBe(404);
  });

  it("copies a media file from one project to another", async () => {
    const { app } = await setup();
    const forest = await createProject(app, { name: "Forest" });
    const city = await createProject(app, { name: "City" });
    await writeFile(path.join(forest.workspacePath, "tree.png"), PNG);
    const copied = await app.inject({ method: "POST", url: `/projects/${city.id}/media/copy`, payload: { projectId: forest.id, path: "tree.png" } });
    expect(copied.statusCode, copied.body).toBe(201);
    const { path: saved } = copied.json<{ path: string }>();
    expect(saved).toMatch(/^\.ohmygame\/media\/imported\/tree.*\.png$/);
    expect(await readFile(path.join(city.workspacePath, saved))).toEqual(PNG);
    expect((await app.inject({ method: "POST", url: `/projects/${city.id}/media/copy`, payload: { projectId: forest.id, path: "missing.png" } })).statusCode).toBe(404);
  });
});

describe("canvas media", () => {
  it("puts an upload on the canvas as a project file", async () => {
    const { app } = await setup();
    const project = await createProject(app, { type: "asset-canvas" });
    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/canvas/assets?name=portrait.png&mediaType=image%2Fpng`,
      headers: { "content-type": "application/octet-stream" },
      payload: PNG,
    });
    expect(response.statusCode, response.body).toBe(201);
    const asset = response.json<CanvasAssetCatalogEntry>();
    expect(asset).toMatchObject({ mediaType: "image", contentType: "image/png" });
    expect(asset.path).toMatch(/^\.ohmygame\/media\/imported\/portrait.*\.png$/);
    const manifest = JSON.parse(await readFile(path.join(project.workspacePath, "canvas", "assets.json"), "utf8"));
    expect(manifest.assets[asset.id]).toEqual({ name: path.basename(asset.path), path: asset.path });
  });

  it("names a file of its own project once, and copies in another project's", async () => {
    const { app } = await setup();
    const project = await createProject(app);
    const other = await createProject(app);
    await writeFile(path.join(project.workspacePath, "hero.png"), PNG);
    await writeFile(path.join(other.workspacePath, "villain.png"), PNG);
    const add = (projectId: string, file: string) => app.inject({ method: "POST", url: `/projects/${project.id}/canvas/assets/media`, payload: { projectId, path: file } });

    // Before the canvas was ever opened: it is made, then the file named on it.
    const own = await add(project.id, "hero.png");
    expect(own.statusCode, own.body).toBe(201);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/canvas/workspace` })).json<{ assets: CanvasAssetCatalogEntry[] }>().assets).toEqual([own.json()]);
    expect(own.json<CanvasAssetCatalogEntry>()).toMatchObject({ path: "hero.png", mediaType: "image" });
    expect((await add(project.id, "hero.png")).json<CanvasAssetCatalogEntry>().id).toBe(own.json<CanvasAssetCatalogEntry>().id);

    const copied = (await add(other.id, "villain.png")).json<CanvasAssetCatalogEntry>();
    expect(copied.path).toMatch(/^\.ohmygame\/media\/imported\/villain.*\.png$/);
    expect(await readFile(path.join(project.workspacePath, copied.path))).toEqual(PNG);
    expect((await add("missing", "villain.png")).statusCode).toBe(404);
  });

  it("inserts a canvas image into a document even when it names a Library asset that is gone", async () => {
    const { app } = await setup();
    const project = await createProject(app);
    const base = `/projects/${project.id}/canvas`;
    const document = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Design" } })).json();
    await writeFile(path.join(project.workspacePath, "portrait.png"), "local image");
    await writeFile(path.join(project.workspacePath, "canvas", "assets.json"), JSON.stringify({
      version: 1, assets: { portrait: { name: "portrait.png", path: "portrait.png", libraryAssetId: "missing" } },
    }));
    const inserted = await app.inject({ method: "POST", url: `${base}/documents/${document.document.id}/images`, payload: { assetId: "portrait" } });
    expect(inserted.statusCode, inserted.body).toBe(200);
    expect(inserted.json().document.markdown).toContain("![portrait.png](../../portrait.png)");
  });
});
