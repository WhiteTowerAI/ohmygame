import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { LibraryAsset, LibraryAssetSummary, LibrarySource, LibrarySourceResults } from "../src/shared/contracts.js";
import { validatePluginManifest } from "../src/shared/plugin-manifest.js";

const fixtures: { app: ReturnType<typeof createApp>; directories: string[] }[] = [];
afterEach(async () => {
  for (const { app, directories } of fixtures.splice(0)) {
    await app.close();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

// Three shapes, two to a page. Fetching saves a PNG in the plugin's data folder.
const SHAPES = `
import { writeFile } from "node:fs/promises";
import path from "node:path";
const PNG = "${PNG}";
const ALL = ["circle", "square", "star"];
export function activate(context) {
  context.registerCommand("search", async ({ query, cursor }) => {
    if (query === "broken") return { items: [{ id: "x" }] };
    const found = ALL.filter((name) => name.includes(query));
    const start = Number(cursor ?? 0);
    return {
      items: found.slice(start, start + 2).map((name) => ({
        id: name, name: name + ".png", mediaType: "image", thumbnail: "data:image/png;base64," + PNG,
        author: "Acme", license: "CC0", url: "https://shapes.example/" + name, secret: "dropped",
      })),
      ...(start + 2 < found.length ? { next: String(start + 2) } : {}),
    };
  });
  context.registerCommand("fetch", async ({ id }) => {
    if (id === "escape") return { file: "../outside.png" };
    // Every fetch under one name, as a simple source may do.
    if (id.startsWith("same-")) {
      await writeFile(path.join(context.dataFolder, "download.png"), Buffer.from(PNG, "base64"));
      // The first is slow to answer, so a second run alongside it would be taken and removed first.
      if (id === "same-a") await new Promise((resolve) => setTimeout(resolve, 150));
      return { file: "download.png", name: id + ".png" };
    }
    if (id === "fake") {
      await writeFile(path.join(context.dataFolder, "fake.png"), "not a png");
      return { file: "fake.png" };
    }
    await writeFile(path.join(context.dataFolder, id + ".png"), Buffer.from(PNG, "base64"));
    return { file: id + ".png", author: "Acme", license: "CC0", url: "https://shapes.example/" + id };
  });
}
`;

const MANIFEST = {
  id: "acme/shapes", version: "1.0.0", engines: { "ohmygame-api": "^2.4.0" }, displayName: "%name%", description: "Shapes to use.",
  entrypoints: { native: "./index.mjs" },
  capabilities: { native: true },
  contributes: {
    assetSources: [{ id: "shapes", title: "%shapes%", description: "Simple shapes.", media: ["image"], search: "search", fetch: "fetch" }],
  },
};

async function setup() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-sources-"));
  const source = await mkdtemp(path.join(tmpdir(), "ohmygame-library-sources-plugin-"));
  const app = createApp({ dataDirectory });
  fixtures.push({ app, directories: [dataDirectory, source] });
  await app.ready();
  await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(source, "locales"), { recursive: true });
  await writeFile(path.join(source, "index.mjs"), SHAPES);
  await writeFile(path.join(source, ".ohmygame-plugin/plugin.json"), JSON.stringify(MANIFEST));
  await writeFile(path.join(source, "locales/en.json"), JSON.stringify({ name: "Shapes", shapes: "Shapes" }));
  await writeFile(path.join(source, "locales/zh-CN.json"), JSON.stringify({ name: "形状", shapes: "形状库" }));
  const payload = { source: { type: "directory", path: source } };
  const inspected = await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload });
  expect(inspected.statusCode, inspected.body).toBe(200);
  const added = await app.inject({ method: "POST", url: "/plugin-sources/install", payload: { ...payload, digest: inspected.json().digest } });
  expect(added.statusCode, added.body).toBe(201);
  return { app, dataDirectory, consent: () => app.inject({ method: "POST", url: "/plugin-store/acme/shapes/consent", payload: { allowed: inspected.json().asks } }) };
}

const search = (app: ReturnType<typeof createApp>, query: string, cursor?: string) =>
  app.inject({ method: "POST", url: "/library/sources/search", payload: { source: "acme/shapes:shapes", query, ...(cursor ? { cursor } : {}) } });
const add = (app: ReturnType<typeof createApp>, id: string) =>
  app.inject({ method: "POST", url: "/library/sources/add", payload: { source: "acme/shapes:shapes", id, mediaType: "image" } });

it("checks an asset source in the manifest", () => {
  const issues = (value: unknown) => {
    const result = validatePluginManifest(value);
    return result.ok ? [] : result.issues;
  };
  expect(issues(MANIFEST)).toEqual([]);
  const { entrypoints: _, ...noNative } = MANIFEST;
  expect(issues(noNative)).toContainEqual(expect.objectContaining({ path: "/contributes/assetSources/0/search" }));
  expect(issues({ ...MANIFEST, contributes: { assetSources: [{ ...MANIFEST.contributes.assetSources[0], media: [] }] } })).not.toEqual([]);
});

it("offers a plugin's source once it is allowed what it asks for, and not while it is off", async () => {
  const { app, consent } = await setup();
  // Native code runs outside projects only with the consent given when it was added.
  expect((await app.inject({ method: "GET", url: "/library/sources" })).json()).toEqual([]);
  expect((await search(app, "")).statusCode).toBe(404);
  expect((await consent()).statusCode).toBe(204);
  expect((await app.inject({ method: "GET", url: "/library/sources?locale=zh-CN" })).json<LibrarySource[]>()).toEqual([
    { id: "acme/shapes:shapes", plugin: "acme/shapes", pluginName: "形状", title: "形状库", description: "Simple shapes.", media: ["image"] },
  ]);

  expect((await app.inject({ method: "PUT", url: "/plugin-store/acme/shapes/enabled", payload: { enabled: false } })).statusCode).toBe(204);
  expect((await app.inject({ method: "GET", url: "/library/sources" })).json()).toEqual([]);
  expect((await search(app, "")).statusCode).toBe(404);
});

it("pages through a source's results, keeping only what the Library reads", async () => {
  const { app, consent } = await setup();
  await consent();
  const first = await search(app, "");
  expect(first.statusCode, first.body).toBe(200);
  const page = first.json<LibrarySourceResults>();
  expect(page.items.map((item) => item.id)).toEqual(["circle", "square"]);
  expect(page.items[0]).toEqual({ id: "circle", name: "circle.png", mediaType: "image", thumbnail: `data:image/png;base64,${PNG}`, author: "Acme", license: "CC0", url: "https://shapes.example/circle" });
  expect((await search(app, "", page.next)).json<LibrarySourceResults>()).toEqual({ items: [expect.objectContaining({ id: "star" })] });
  expect((await search(app, "sq")).json<LibrarySourceResults>().items.map((item) => item.id)).toEqual(["square"]);

  const broken = await search(app, "broken");
  expect(broken.statusCode).toBe(502);
  expect(broken.json().error).toContain("returned results the Library can't read");
  expect((await app.inject({ method: "POST", url: "/library/sources/search", payload: { source: "acme/shapes:shapes", query: "", media: "video" } })).statusCode).toBe(400);
});

it("adds a result to the Library with where it came from, once", async () => {
  const { app, dataDirectory, consent } = await setup();
  await consent();
  const added = await add(app, "circle");
  expect(added.statusCode, added.body).toBe(201);
  const asset = added.json<LibraryAsset>();
  expect(asset).toMatchObject({
    name: "circle.png", mediaType: "image", origin: "uploaded", saved: true,
    sourcedFrom: { source: "acme/shapes:shapes", item: "circle", author: "Acme", license: "CC0", url: "https://shapes.example/circle" },
  });
  expect((await app.inject({ method: "GET", url: `/library/assets/${asset.id}/content` })).rawPayload).toEqual(Buffer.from(PNG, "base64"));
  // The Library takes the file; the plugin's folder doesn't keep it.
  expect(await readdir(path.join(dataDirectory, "plugin-store", "data", "acme", "shapes"))).toEqual([]);
  expect((await add(app, "circle")).json<LibraryAsset>().id).toBe(asset.id);
  expect((await app.inject({ method: "GET", url: "/library/assets" })).json<LibraryAssetSummary[]>().filter((item) => item.saved)).toHaveLength(1);

  // Adds run one at a time, so a source that reuses a file name loses nothing.
  const both = await Promise.all([add(app, "same-a"), add(app, "same-b")]);
  expect(both.map((response) => response.statusCode)).toEqual([201, 201]);
  expect(both.map((response) => response.json<LibraryAsset>().name)).toEqual(["same-a.png", "same-b.png"]);

  // Removed from the Library and added again, it is back.
  const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<{ id: string }>();
  expect((await app.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${asset.id}` })).statusCode).toBe(201);
  expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(204);
  expect((await add(app, "circle")).json<LibraryAsset>()).toMatchObject({ id: asset.id, saved: true });
});

it("refuses a file outside the plugin's data folder or whose data isn't what it says", async () => {
  const { app, dataDirectory, consent } = await setup();
  await consent();
  await mkdir(path.join(dataDirectory, "plugin-store", "data", "acme"), { recursive: true });
  await writeFile(path.join(dataDirectory, "plugin-store", "data", "acme", "outside.png"), Buffer.from(PNG, "base64"));
  const escaped = await add(app, "escape");
  expect(escaped.statusCode).toBe(502);
  expect(escaped.json().error).toContain("outside its data folder");
  const fake = await add(app, "fake");
  expect(fake.statusCode).toBe(502);
  expect(fake.json().error).toContain("isn't image/png");
  expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual([]);
});
