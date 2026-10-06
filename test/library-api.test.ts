import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { LibraryAsset, LibraryAssetSummary, ProjectState } from "../src/shared/contracts.js";
import type { CanvasBoardDetail } from "../src/shared/canvas-workspace.js";

type App = Awaited<ReturnType<typeof createApp>>;
const fixtures: { app: App; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of fixtures.splice(0)) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-filters-"));
  const app = createApp({ dataDirectory: directory });
  fixtures.push({ app, directory });
  return app;
}

async function upload(app: App, purpose: "asset" | "reference" = "asset"): Promise<LibraryAsset> {
  const response = await app.inject({ method: "POST", url: "/library/assets", payload: {
    name: "portrait.png", purpose,
    image: { mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") },
  } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

async function list(app: App): Promise<LibraryAssetSummary[]> {
  const response = await app.inject({ method: "GET", url: "/library/assets" });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

describe("Library provenance and project filters", () => {
  it("keeps upload provenance across projects and only saves project files explicitly", async () => {
    const app = await setup();
    const asset = await upload(app);
    const first = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Forest" } })).json<ProjectState>();
    const second = (await app.inject({ method: "POST", url: "/projects", payload: { name: "City" } })).json<ProjectState>();
    for (const project of [first, second]) {
      expect((await app.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${asset.id}` })).statusCode).toBe(201);
    }
    await writeFile(path.join(first.workspacePath, "sprite.png"), "project media");
    expect(await list(app)).toHaveLength(1);
    const saved = await app.inject({ method: "POST", url: `/projects/${first.id}/assets/library?path=sprite.png` });
    expect(saved.statusCode, saved.body).toBe(201);
    const assets = await list(app);
    expect(assets).toHaveLength(2);
    expect(assets.find((candidate) => candidate.id === asset.id)).toMatchObject({ origin: "uploaded", referenceOnly: false, projects: [{ id: first.id, name: "Forest" }, { id: second.id, name: "City" }] });
    expect(assets.find((candidate) => candidate.name === "sprite.png")).toMatchObject({ origin: "workspace", saved: true, projects: [{ id: first.id }] });
    expect(await list(app)).toEqual(assets);
    await app.inject({ method: "PATCH", url: `/projects/${first.id}`, payload: { name: "New Forest" } });
    expect((await list(app)).find((candidate) => candidate.id === asset.id)?.projects[0]?.name).toBe("New Forest");
  });

  it("keeps repeated saves stable and saves the latest contents after a project file changes", async () => {
    const app = await setup();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<ProjectState>();
    const file = path.join(project.workspacePath, "sprite.png");
    await writeFile(file, "first");
    const url = `/projects/${project.id}/assets/library?path=sprite.png`;
    const first = (await app.inject({ method: "POST", url })).json<LibraryAsset>();
    const repeated = (await app.inject({ method: "POST", url })).json<LibraryAsset>();
    expect(repeated.id).toBe(first.id);
    await writeFile(file, "changed");
    const changed = (await app.inject({ method: "POST", url })).json<LibraryAsset>();
    expect(changed.id).not.toBe(first.id);
    expect(changed).toMatchObject({ saved: true, origin: "workspace" });
    expect((await app.inject({ method: "GET", url: `/library/assets/${changed.id}/content` })).body).toBe("changed");
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/assets/library?path=../outside.png` })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/library/assets/missing/save" })).statusCode).toBe(404);
  });

  it("distinguishes canvas reference inputs from materialized assets and standalone nodes", async () => {
    const app = await setup();
    const asset = await upload(app, "reference");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Art", type: "asset-canvas" } })).json<ProjectState>();
    const base = `/projects/${project.id}/canvas`;
    const workspace = (await app.inject({ method: "GET", url: `${base}/workspace` })).json();
    const boardUrl = `${base}/boards/${workspace.boards[0].id}`;
    const detail = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>();
    detail.board.nodes = [{ id: "image", type: "image", position: { x: 320, y: 0 }, data: { prompt: "Portrait", resolution: "1K", aspectRatio: "1:1", images: [{ type: "library", assetId: asset.id }] } }];
    detail.board.editorLayout.nodes = { image: { x: 320, y: 0 } };
    const saved = await app.inject({ method: "PUT", url: boardUrl, payload: detail });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await list(app))[0]).toMatchObject({ id: asset.id, referenceOnly: true, projects: [{ id: project.id }] });

    const asAsset = saved.json<CanvasBoardDetail>();
    asAsset.board.nodes.push({ id: "asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: asset.id, mediaType: "image" } });
    asAsset.board.editorLayout.nodes.asset = { x: 0, y: 0 };
    const promoted = await app.inject({ method: "PUT", url: boardUrl, payload: asAsset });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect((await list(app))[0]).toMatchObject({ id: asset.id, origin: "uploaded", referenceOnly: false });
  });

  it("promotes a reference explicitly added to a project", async () => {
    const app = await setup();
    const asset = await upload(app, "reference");
    expect((await list(app))[0]?.referenceOnly).toBe(true);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<ProjectState>();
    const copied = await app.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${asset.id}` });
    expect(copied.statusCode, copied.body).toBe(201);
    expect((await list(app))[0]).toMatchObject({ origin: "uploaded", purpose: "asset", referenceOnly: false });
  });

  it("inserts a local canvas image even when its Library link is stale", async () => {
    const app = await setup();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<ProjectState>();
    const base = `/projects/${project.id}/canvas`;
    const document = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Design" } })).json();
    await writeFile(path.join(project.workspacePath, "portrait.png"), "local image");
    await writeFile(path.join(project.workspacePath, "canvas", "assets.json"), JSON.stringify({
      version: 1, assets: { portrait: { name: "portrait.png", path: "portrait.png", libraryAssetId: "missing" } },
    }));
    const inserted = await app.inject({ method: "POST", url: `${base}/documents/${document.document.id}/images`, payload: { assetId: "portrait" } });
    expect(inserted.statusCode, inserted.body).toBe(200);
    expect(inserted.json().document.markdown).toContain("![portrait.png](../../portrait.png)");
    expect(await list(app)).toEqual([]);
  });

  it("promotes a reference inserted into a document and keeps browsing available for a broken canvas", async () => {
    const app = await setup();
    const asset = await upload(app, "reference");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<ProjectState>();
    const base = `/projects/${project.id}/canvas`;
    const document = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Design" } })).json();
    const inserted = await app.inject({ method: "POST", url: `${base}/documents/${document.document.id}/images`, payload: { assetId: asset.id } });
    expect(inserted.statusCode, inserted.body).toBe(200);
    expect((await list(app))[0]).toMatchObject({ purpose: "asset", referenceOnly: false, projects: [{ id: project.id }] });
    await writeFile(path.join(project.workspacePath, "canvas", "index.json"), "broken");
    expect((await list(app))[0]?.id).toBe(asset.id);
  });
});
