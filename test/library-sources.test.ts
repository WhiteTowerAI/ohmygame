import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { LibrarySource, LibrarySourceResults } from "../src/shared/contracts.js";
import { validatePluginManifest } from "../src/shared/plugin-manifest.js";
import { libraryEmbedHosts } from "../src/shared/library-embeds.js";

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
// What is already stored isn't downloaded again; a second fetch of one fails.
const fetched = new Set();
export function activate(context) {
  context.registerCommand("search", async ({ query, cursor, collection }) => {
    if (query === "broken") return { items: [{ id: "x" }] };
    // A sound brings something to listen to; a picture's is left out, as is one the page couldn't play.
    if (query === "chime") return { items: [
      { id: "chime", name: "chime.wav", mediaType: "audio", duration: 0.5, preview: "data:audio/wav;base64,UklGRg==" },
      { id: "dot", name: "dot.png", mediaType: "image", preview: "data:audio/wav;base64,UklGRg==" },
    ] };
    // A page to embed is kept only from a site the plugin asks to connect to.
    if (query === "viewer") return { items: [
      { id: "v1", name: "v1.png", mediaType: "image", embed: "https://viewer.example/models/v1/embed?autostart=1" },
      { id: "v2", name: "v2.png", mediaType: "image", embed: "https://elsewhere.example/v2" },
      { id: "v3", name: "v3.png", mediaType: "image", embed: "http://viewer.example/v3" },
      { id: "v4", name: "v4.png", mediaType: "image", embed: "https://user:secret@viewer.example/v4" },
      { id: "v5", name: "v5.png", mediaType: "image", embed: "https://viewer.example:8443/v5" },
      { id: "v6", name: "v6.png", mediaType: "image", embed: "not a url" },
    ] };
    if (query === "unplayable") return { items: [{ id: "x", name: "x.wav", mediaType: "audio", preview: "javascript:alert(1)" }] };
    // The collection chosen reaches the plugin.
    if (query === "which") return { items: [{ id: collection ?? "none", name: "which.png", mediaType: "image" }] };
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
    if (fetched.has(id)) throw new Error(id + " was fetched again");
    fetched.add(id);
    if (id === "escape") return { file: "../outside.png" };
    // Every fetch under one name, as a simple source may do.
    if (id.startsWith("same-")) {
      await writeFile(path.join(context.dataFolder, "download.png"), Buffer.from(PNG, "base64"));
      // The first is slow to answer, so a second run alongside it would be taken and removed first.
      if (id === "same-a") await new Promise((resolve) => setTimeout(resolve, 150));
      return { file: "download.png", name: id + ".png" };
    }
    // A source that names the author and license only in its results.
    if (id.startsWith("bare-")) {
      await writeFile(path.join(context.dataFolder, id + ".png"), Buffer.from(PNG, "base64"));
      return { file: id + ".png" };
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
  id: "acme/shapes", version: "1.0.0", engines: { "ohmygame-api": "^2.5.0" }, displayName: "%name%", description: "Shapes to use.",
  entrypoints: { native: "./index.mjs" },
  capabilities: { native: true, network: ["viewer.example", "api.example:8443"] },
  contributes: {
    assetSources: [{ id: "shapes", title: "%shapes%", description: "Simple shapes.", media: ["image", "audio"], search: "search", fetch: "fetch", cacheSeconds: 3600, collections: [{ id: "round", title: "Round" }, { id: "angular", title: "Angular" }] }],
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
  return { app, dataDirectory };
}

const search = (app: ReturnType<typeof createApp>, query: string, cursor?: string) =>
  app.inject({ method: "POST", url: "/asset-sources/search", payload: { source: "acme/shapes:shapes", query, ...(cursor ? { cursor } : {}) } });
const add = (app: ReturnType<typeof createApp>, projectId: string, id: string, credit: { author?: string; license?: string; url?: string } = {}) =>
  app.inject({ method: "POST", url: `/projects/${projectId}/assets/source`, payload: { source: "acme/shapes:shapes", id, mediaType: "image", ...credit } });
const newProject = async (app: ReturnType<typeof createApp>) =>
  (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<{ id: string; workspacePath: string }>();
const credits = (project: { workspacePath: string }) => readFile(path.join(project.workspacePath, "CREDITS.md"), "utf8");

it("checks an asset source in the manifest", () => {
  const issues = (value: unknown) => {
    const result = validatePluginManifest(value);
    return result.ok ? [] : result.issues;
  };
  expect(issues(MANIFEST)).toEqual([]);
  const { entrypoints: _, ...noNative } = MANIFEST;
  expect(issues(noNative)).toContainEqual(expect.objectContaining({ path: "/contributes/assetSources/0/search" }));
  expect(issues({ ...MANIFEST, contributes: { assetSources: [{ ...MANIFEST.contributes.assetSources[0], media: [] }] } })).not.toEqual([]);
  expect(issues({ ...MANIFEST, contributes: { assetSources: [{ ...MANIFEST.contributes.assetSources[0], cacheSeconds: -1 }] } })).not.toEqual([]);
  expect(issues({ ...MANIFEST, contributes: { assetSources: [{ ...MANIFEST.contributes.assetSources[0], collections: [{ id: "round", title: "A" }, { id: "round", title: "B" }] }] } }))
    .toContainEqual(expect.objectContaining({ path: "/contributes/assetSources/0/collections/1/id" }));
});

it("takes the sites a source may embed from the hosts its plugin connects to, on the https port", () => {
  expect(libraryEmbedHosts(["a.example", "b.example:443", "c.example:8443", "a.example:443"])).toEqual(["a.example", "b.example"]);
  expect(libraryEmbedHosts(undefined)).toEqual([]);
});

it("offers a plugin's source once it is added, and not while it is off", async () => {
  // Adding it allowed what it asks for, so its native code may run outside projects.
  const { app } = await setup();
  expect((await app.inject({ method: "GET", url: "/asset-sources?locale=zh-CN" })).json<LibrarySource[]>()).toEqual([
    { id: "acme/shapes:shapes", plugin: "acme/shapes", pluginName: "形状", title: "形状库", description: "Simple shapes.", media: ["image", "audio"], cacheSeconds: 3600, collections: [{ id: "round", title: "Round" }, { id: "angular", title: "Angular" }], embedHosts: ["viewer.example"] },
  ]);

  expect((await app.inject({ method: "PUT", url: "/plugin-store/acme/shapes/every-project", payload: { on: false } })).statusCode).toBe(204);
  expect((await app.inject({ method: "GET", url: "/asset-sources" })).json()).toEqual([]);
  expect((await search(app, "")).statusCode).toBe(404);
});

it("pages through a source's results, keeping only what the app reads", async () => {
  const { app } = await setup();
  const first = await search(app, "");
  expect(first.statusCode, first.body).toBe(200);
  const page = first.json<LibrarySourceResults>();
  expect(page.items.map((item) => item.id)).toEqual(["circle", "square"]);
  expect(page.items[0]).toEqual({ id: "circle", name: "circle.png", mediaType: "image", thumbnail: `data:image/png;base64,${PNG}`, author: "Acme", license: "CC0", url: "https://shapes.example/circle" });
  expect((await search(app, "", page.next)).json<LibrarySourceResults>()).toEqual({ items: [expect.objectContaining({ id: "star" })] });
  expect((await search(app, "sq")).json<LibrarySourceResults>().items.map((item) => item.id)).toEqual(["square"]);

  expect((await search(app, "chime")).json<LibrarySourceResults>().items).toEqual([
    { id: "chime", name: "chime.wav", mediaType: "audio", duration: 0.5, preview: "data:audio/wav;base64,UklGRg==" },
    { id: "dot", name: "dot.png", mediaType: "image" },
  ]);
  expect((await search(app, "unplayable")).statusCode).toBe(502);
  expect((await search(app, "viewer")).json<LibrarySourceResults>().items).toEqual([
    { id: "v1", name: "v1.png", mediaType: "image", embed: "https://viewer.example/models/v1/embed?autostart=1" },
    ...["v2", "v3", "v4", "v5", "v6"].map((id) => ({ id, name: `${id}.png`, mediaType: "image" })),
  ]);
  const which = (collection?: string) => app.inject({ method: "POST", url: "/asset-sources/search", payload: { source: "acme/shapes:shapes", query: "which", ...(collection ? { collection } : {}) } });
  expect((await which("angular")).json<LibrarySourceResults>().items[0]?.id).toBe("angular");
  expect((await which()).json<LibrarySourceResults>().items[0]?.id).toBe("none");
  expect((await which("square")).statusCode).toBe(400);

  const broken = await search(app, "broken");
  expect(broken.statusCode).toBe(502);
  expect(broken.json().error).toContain("returned results OhMyGame can't read");
  expect((await app.inject({ method: "POST", url: "/asset-sources/search", payload: { source: "acme/shapes:shapes", query: "", media: "video" } })).statusCode).toBe(400);
});

it("keeps the credit a result showed when the source's download gives none, and the download's when it does", async () => {
  const { app } = await setup();
  const project = await newProject(app);
  const shown = { author: "Ada", license: "CC BY 4.0", url: "https://shapes.example/bare-moon" };
  const bare = await add(app, project.id, "bare-moon", shown);
  expect(bare.statusCode, bare.body).toBe(201);
  // Without either, there is no credit to keep.
  expect((await add(app, project.id, "bare-sun")).statusCode).toBe(201);
  // What the download names comes first.
  expect((await add(app, project.id, "square", shown)).statusCode).toBe(201);
  const lines = (await credits(project)).split("\n").filter((line) => line.startsWith("- "));
  expect(lines).toEqual([
    `- \`${bare.json<{ path: string }>().path}\`: bare-moon.png by Ada, CC BY 4.0, <https://shapes.example/bare-moon>`,
    expect.stringMatching(/square\.png by Acme, CC0, <https:\/\/shapes\.example\/square>$/),
  ]);
  // A page that isn't https is refused.
  expect((await add(app, project.id, "bare-star", { url: "http://shapes.example/bare-star" })).statusCode).toBe(400);
});

it("adds a result to the project with its credit, once", async () => {
  const { app, dataDirectory } = await setup();
  const project = await newProject(app);
  const added = await add(app, project.id, "circle");
  expect(added.statusCode, added.body).toBe(201);
  const { path: copied, name } = added.json<{ path: string; name: string }>();
  expect(name).toBe("circle.png");
  expect(copied).toMatch(/^\.ohmygame\/media\/imported\/circle.*\.png$/);
  expect(await readFile(path.join(project.workspacePath, copied))).toEqual(Buffer.from(PNG, "base64"));
  // The project takes the file; the plugin's folder doesn't keep it.
  expect(await readdir(path.join(dataDirectory, "plugin-store", "data", "acme", "shapes"))).toEqual([]);
  // Added again, it is the file it became, without a second download.
  const second = await add(app, project.id, "circle");
  expect(second.statusCode, second.body).toBe(201);
  expect(second.json<{ path: string }>().path).toBe(copied);
  expect(await credits(project)).toContain(`- \`${copied}\`: circle.png by Acme, CC0, <https://shapes.example/circle>\n`);
  expect((await credits(project)).match(/circle\.png by/g)).toHaveLength(1);

  // Adds run one at a time, so a source that reuses a file name loses nothing.
  const both = await Promise.all([add(app, project.id, "same-a"), add(app, project.id, "same-b")]);
  expect(both.map((response) => response.statusCode)).toEqual([201, 201]);
  expect(both.map((response) => response.json<{ name: string }>().name)).toEqual(["same-a.png", "same-b.png"]);

  expect((await add(app, "missing", "circle")).statusCode).toBe(404);
});

it("refuses a file outside the plugin's data folder or whose data isn't what it says", async () => {
  const { app, dataDirectory } = await setup();
  const project = await newProject(app);
  await mkdir(path.join(dataDirectory, "plugin-store", "data", "acme"), { recursive: true });
  await writeFile(path.join(dataDirectory, "plugin-store", "data", "acme", "outside.png"), Buffer.from(PNG, "base64"));
  const escaped = await add(app, project.id, "escape");
  expect(escaped.statusCode).toBe(502);
  expect(escaped.json().error).toContain("outside its data folder");
  const fake = await add(app, project.id, "fake");
  expect(fake.statusCode).toBe(502);
  expect(fake.json().error).toContain("isn't image/png");
});
