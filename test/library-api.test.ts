import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("Library store upgrade", () => {
  it("migrates a local Story's Library references before its project type, including on retry", async () => {
    const first = await setup();
    const image = await upload(first);
    const project = (await first.inject({ method: "POST", url: "/projects", payload: { name: "Story" } })).json<ProjectState>();
    const directory = fixtures[0]!.directory;
    await first.close();
    const manifest = path.join(project.workspacePath, "ohmygame.json");
    const graph = path.join(project.workspacePath, "graph.json");
    const portrait = { type: "image", source: { kind: "library", assetId: image.id }, future: 7 };
    const original = JSON.stringify({ version: 1, assets: { portrait, missing: { source: { kind: "library", assetId: "gone" } } } });
    await writeFile(manifest, JSON.stringify({ type: "interactive-story" }));
    await writeFile(graph, original);

    const retry = createApp({ dataDirectory: directory });
    fixtures.push({ app: retry, directory });
    await retry.ready();
    expect(JSON.parse(await readFile(manifest, "utf8")).type).toBe("interactive-story");
    expect(await readFile(graph, "utf8")).toBe(original);
    // Other references in a project skipped during migration still need their bytes.
    expect((await retry.inject({ method: "GET", url: `/library/assets/${image.id}/content` })).statusCode).toBe(200);
    await retry.close();

    await writeFile(graph, JSON.stringify({ version: 1, assets: { portrait, second: portrait } }));
    const reopened = createApp({ dataDirectory: directory });
    fixtures.push({ app: reopened, directory });
    await reopened.ready();
    expect(JSON.parse(await readFile(manifest, "utf8")).type).toBe("general");
    const assets = JSON.parse(await readFile(graph, "utf8")).assets;
    expect(assets.portrait).toMatchObject({ future: 7, source: { kind: "workspace" } });
    expect(assets.second.source).toEqual(assets.portrait.source);
    expect(await readFile(path.join(project.workspacePath, assets.portrait.source.path))).toEqual(Buffer.from("iVBORw0KGgo=", "base64"));
  });

  it("takes what was collected by itself out of an older Library at startup", async () => {
    const first = await setup();
    const used = await upload(first);
    const project = (await first.inject({ method: "POST", url: "/projects", payload: { name: "Forest" } })).json<ProjectState>();
    expect((await first.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${used.id}` })).statusCode).toBe(201);
    const directory = fixtures[0]!.directory;
    await first.close();
    // As version 1 stored it: everything uploaded or generated was in the Library.
    const store = path.join(directory, "library", "assets.json");
    const stored = JSON.parse(await readFile(store, "utf8")) as { version: number; assets: { saved: boolean }[] };
    await writeFile(store, JSON.stringify({ ...stored, version: 1, assets: stored.assets.map((asset) => ({ ...asset, saved: true })) }));

    const reopened = createApp({ dataDirectory: directory });
    fixtures.push({ app: reopened, directory });
    expect((await list(reopened)).find((asset) => asset.id === used.id)).toMatchObject({ saved: false, projects: [{ id: project.id }] });
    expect((await reopened.inject({ method: "GET", url: `/library/assets/${used.id}/content` })).statusCode).toBe(200);
    expect(JSON.parse(await readFile(store, "utf8"))).toMatchObject({ version: 2 });
  });
});

describe("Library provenance and project filters", () => {
  it("keeps upload provenance across projects", async () => {
    const app = await setup();
    const asset = await upload(app);
    const first = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Forest" } })).json<ProjectState>();
    const second = (await app.inject({ method: "POST", url: "/projects", payload: { name: "City" } })).json<ProjectState>();
    for (const project of [first, second]) {
      expect((await app.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${asset.id}` })).statusCode).toBe(201);
    }
    const assets = await list(app);
    expect(assets).toHaveLength(1);
    expect(assets.find((candidate) => candidate.id === asset.id)).toMatchObject({ origin: "uploaded", referenceOnly: false, projects: [{ id: first.id, name: "Forest" }, { id: second.id, name: "City" }] });
    expect(await list(app)).toEqual(assets);
    await app.inject({ method: "PATCH", url: `/projects/${first.id}`, payload: { name: "New Forest" } });
    expect((await list(app)).find((candidate) => candidate.id === asset.id)?.projects[0]?.name).toBe("New Forest");
  });

  it("puts an upload for a project, as a game recording, in the project's media", async () => {
    const app = await setup();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<ProjectState>();
    const upload = (projectId: string) => app.inject({
      method: "POST",
      url: `/library/assets/upload?name=play.webm&mediaType=video%2Fwebm&duration=2&projectId=${projectId}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]),
    });
    const response = await upload(project.id);
    expect(response.statusCode, response.body).toBe(201);
    const { projectPath } = response.json<{ projectPath: string }>();
    expect(projectPath).toMatch(/^\.ohmygame\/media\/imported\/play.*\.webm$/);
    expect(await readFile(path.join(project.workspacePath, projectPath))).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]));
    expect((await upload("missing")).statusCode).toBe(404);
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
    // Used as an asset now, but only "Save to Library" puts it in the Library.
    expect((await list(app))[0]).toMatchObject({ origin: "uploaded", purpose: "asset", referenceOnly: false, saved: false });
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
