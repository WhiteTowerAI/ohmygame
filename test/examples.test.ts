import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { createApp } from "../src/daemon/app.js";
import type { PreparedExampleCatalog } from "../src/shared/examples.js";
import { EXAMPLE_DOWNLOAD_UNAVAILABLE, isPreparedExampleCatalog } from "../src/shared/examples.js";
import { createCanvasBoard } from "../src/shared/canvas-workspace.js";
import { PluginServices } from "../src/daemon/plugin-services.js";

const apps: Array<Pick<ReturnType<typeof createApp>, "close">> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

async function writeExamples(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-examples-"));
  const files = path.join(directory, "pond", "files");
  await mkdir(path.join(files, "src"), { recursive: true });
  await writeFile(path.join(files, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
  await writeFile(path.join(files, "src", "main.ts"), "console.log('pond');\n");
  await writeFile(path.join(directory, "pond", "cover.webp"), "RIFF-cover");
  await mkdir(path.join(directory, "pond", "play", "assets"), { recursive: true });
  await writeFile(path.join(directory, "pond", "play", "index.html"), "<title>Pond</title>");
  await writeFile(path.join(directory, "pond", "play", "assets", "game.js"), "play();");
  const catalog: PreparedExampleCatalog = {
    version: 1,
    source: { repository: "WhiteTowerAI/ohmygame-examples", commit: "0".repeat(40) },
    examples: [{
      id: "pond",
      type: "web-game",
      name: "Pond",
      description: "A small pond.",
      directory: "pond/files",
      cover: "pond/cover.webp",
      play: "pond/play",
    }],
  };
  // A web game without a build, such as an interactive story, plays from its own files.
  const story = path.join(directory, "train", "files");
  await mkdir(story, { recursive: true });
  await writeFile(path.join(story, "index.html"), "<title>Night Train</title>");
  await writeFile(path.join(story, "graph.json"), JSON.stringify({ title: "Night Train" }));
  await writeFile(path.join(directory, "train", "cover.webp"), "RIFF-train");
  catalog.examples.push({
    id: "train",
    type: "web-game",
    name: "Night Train",
    description: "A short story.",
    directory: "train/files",
    cover: "train/cover.webp",
  });
  await writeFile(path.join(directory, "catalog.json"), JSON.stringify(catalog));
  return directory;
}

async function startApp(examplesDirectory?: string, dataDirectory?: string) {
  const app = createApp({
    dataDirectory: dataDirectory ?? await mkdtemp(path.join(tmpdir(), "ohmygame-examples-data-")),
    examplesDirectory,
  });
  apps.push(app);
  await app.ready();
  return app;
}

async function writeDownloadCatalog(): Promise<string> {
  const directory = await writeExamples();
  const file = path.join(directory, "catalog.json");
  const catalog = JSON.parse(await readFile(file, "utf8")) as PreparedExampleCatalog;
  for (const example of catalog.examples) {
    await rm(path.join(directory, example.directory), { recursive: true });
    if (example.play) await rm(path.join(directory, example.play), { recursive: true });
  }
  await writeFile(file, JSON.stringify({ ...catalog, version: 2 }));
  return directory;
}

async function exampleZip(files: Record<string, string>) {
  const zip = new ZipFile();
  for (const [name, contents] of Object.entries(files)) zip.addBuffer(Buffer.from(contents), name);
  const received = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  const body = await received;
  return { sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length, body: Uint8Array.from(body) };
}

function mockExampleDownloads(archives: Record<string, Awaited<ReturnType<typeof exampleZip>>>) {
  const commit = "0".repeat(40);
  const calls: string[] = [];
  const manifest = {
    version: 1, commit,
    archives: Object.fromEntries(Object.entries(archives).map(([key, { sha256, bytes }]) => [key, { sha256, bytes }])),
  };
  const byName = new Map(Object.values(archives).map((item) => [`${item.sha256}.zip`, item.body]));
  const delegate = globalThis.fetch;
  const serve = vi.fn((name: string, _init?: RequestInit) => {
    if (name === "manifest.json") return Promise.resolve(Response.json(manifest));
    return Promise.resolve(new Response(byName.get(name), { status: byName.has(name) ? 200 : 404 }));
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://updates.ohmygame.ai") return delegate(input, init);
    const name = url.pathname.replace(`/desktop/examples-v1/${commit}/`, "");
    calls.push(name);
    return serve(name, init);
  });
  return { calls, serve };
}

describe("examples", () => {
  it("preserves remixed node positions and the original viewport until explicitly edited", async () => {
    const directory = await writeExamples();
    const canvas = path.join(directory, "pond/files/canvas");
    for (const folder of ["boards", "editor"]) await mkdir(path.join(canvas, folder), { recursive: true });
    await writeFile(path.join(canvas, "index.json"), JSON.stringify({ version: 1, boards: [{ id: "design", name: "Design" }, { id: "art", name: "Art" }], documents: [] }));
    const layout = { version: 1, view: "canvas", nodes: { note: { x: 96, y: 576 } }, viewport: { x: -4805, y: 44, zoom: 1.14 } };
    for (const id of ["design", "art"]) {
      const { editorLayout: _editorLayout, ...board } = createCanvasBoard();
      await writeFile(path.join(canvas, `boards/${id}.json`), JSON.stringify({ ...board, id, nodes: [{ id: "note", type: "text", data: { text: "Example", instruction: "" } }] }));
      await writeFile(path.join(canvas, `editor/${id}.json`), JSON.stringify(layout));
    }
    const app = await startApp(directory);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "pond" } })).json();
    for (const id of ["design", "art"]) {
      const url = `/projects/${project.id}/canvas/boards/${id}`;
      const detail = (await app.inject({ method: "GET", url })).json();
      expect(detail.board.nodes[0].position).toEqual({ x: 96, y: 576 });
      expect(detail.board.editorLayout).toEqual(layout);
      expect(JSON.parse(await readFile(path.join(canvas, `editor/${id}.json`), "utf8"))).toEqual(layout);
      detail.board.editorLayout.viewport = { x: 64, y: 32, zoom: 0.3 };
      const saved = await app.inject({ method: "PUT", url, payload: detail });
      expect(saved.statusCode).toBe(200);
      const reopened = (await app.inject({ method: "GET", url })).json();
      expect(reopened.board.editorLayout.fitView).toBeUndefined();
      expect(reopened.board.editorLayout.viewport).toEqual({ x: 64, y: 32, zoom: 0.3 });
      expect(reopened.board.nodes[0].position).toEqual({ x: 96, y: 576 });
    }
  });

  it("preserves generation history and binds it to the remixed project", async () => {
    const directory = await writeExamples();
    const canvas = path.join(directory, "pond/files/canvas");
    await mkdir(canvas, { recursive: true });
    await writeFile(path.join(canvas, "index.json"), JSON.stringify({ version: 1, boards: [{ id: "design", name: "Design" }], documents: [] }));
    const history = ["succeeded", "failed"].map((status, index) => ({
      id: `historical-${index}`,
      toolId: "generate-image",
      createdAt: "2026-10-07T12:00:00.000Z",
      status,
      title: "Original concept",
      context: { projectId: "original-project", boardId: "design", nodeId: "concept" },
      input: {
        prompt: "Original prompt", resolution: "2K", aspectRatio: "16:9",
        images: status === "failed" ? [`data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}`] : [],
      },
      ...(status === "succeeded" ? { run: { id: "original-run", assetIds: ["original-asset"] } } : { error: "Original error" }),
    }));
    await writeFile(path.join(canvas, "jobs.json"), JSON.stringify(history));
    const app = await startApp(directory);
    const created = await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "pond" } });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const expected = history.map((job) => ({ ...job, context: { ...job.context, projectId: project.id } }));
    expect(JSON.parse(await readFile(path.join(project.workspacePath, "canvas/jobs.json"), "utf8"))).toEqual(expected);
    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/canvas/jobs` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected.map(({ input: _input, ...job }) => job));
    expect(JSON.parse(await readFile(path.join(canvas, "jobs.json"), "utf8"))).toEqual(history);
  });

  it("rejects invalid generation history without leaving a partially copied project", async () => {
    const directory = await writeExamples();
    const canvas = path.join(directory, "pond/files/canvas");
    await mkdir(canvas, { recursive: true });
    await writeFile(path.join(canvas, "jobs.json"), JSON.stringify({ jobs: [] }));
    const app = await startApp(directory);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "pond" } });
    expect(response.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([]);
  });

  it("lists packaged examples and serves their covers", async () => {
    const app = await startApp(await writeExamples());

    expect((await app.inject({ method: "GET", url: "/examples" })).json()).toEqual([
      { id: "pond", type: "web-game", name: "Pond", description: "A small pond." },
      { id: "train", type: "web-game", name: "Night Train", description: "A short story." },
    ]);
    const cover = await app.inject({ method: "GET", url: "/examples/pond/cover" });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/webp");
    expect(cover.body).toBe("RIFF-cover");
    expect((await app.inject({ method: "GET", url: "/examples/missing/cover" })).statusCode).toBe(404);
  });

  it("loads covers offline and downloads only the requested action, once per cached archive", async () => {
    const play = await exampleZip({ "index.html": "<title>Downloaded Pond</title>" });
    const files = await exampleZip({ "package.json": "{}", "src/main.ts": "source" });
    const { calls, serve } = mockExampleDownloads({ "pond/play": play, "pond/files": files });
    const directory = await writeDownloadCatalog();
    const data = await mkdtemp(path.join(tmpdir(), "ohmygame-examples-data-"));
    const app = await startApp(directory, data);
    expect((await app.inject({ method: "GET", url: "/examples" })).json()).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/examples/pond/cover" })).body).toBe("RIFF-cover");
    expect(calls).toEqual([]);

    const startPlay = () => app.inject({ method: "POST", url: "/examples/pond/play" });
    const [first, second] = await Promise.all([startPlay(), startPlay()]);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await (await fetch(first.json().url)).text()).toBe("<title>Downloaded Pond</title>");
    expect(calls).toEqual(["manifest.json", `${play.sha256}.zip`]);

    const remix = { method: "POST" as const, url: "/projects", payload: { exampleId: "pond" } };
    const result = await app.inject(remix);
    expect(result.statusCode).toBe(201);
    expect(await readFile(path.join(result.json().workspacePath, "src/main.ts"), "utf8")).toBe("source");
    expect(calls).toEqual(["manifest.json", `${play.sha256}.zip`, "manifest.json", `${files.sha256}.zip`]);

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    serve.mockRejectedValue(new Error("offline"));
    calls.length = 0;
    const restarted = await startApp(directory, data);
    expect((await restarted.inject({ method: "POST", url: "/examples/pond/play" })).statusCode).toBe(200);
    expect((await restarted.inject(remix)).statusCode).toBe(201);
    expect(calls).toEqual([]);

    await restarted.close();
    apps.splice(apps.indexOf(restarted), 1);
    const remixedSource = path.join(result.json().workspacePath, "src/main.ts");
    await writeFile(remixedSource, "edited game");
    const catalogFile = path.join(directory, "catalog.json");
    const catalog = JSON.parse(await readFile(catalogFile, "utf8")) as PreparedExampleCatalog;
    const updated = "1".repeat(40);
    catalog.source.commit = updated;
    await writeFile(catalogFile, JSON.stringify(catalog));
    const cache = path.join(data, "examples-cache-v1");
    for (const name of [updated, "unrelated"]) await mkdir(path.join(cache, name));
    const upgraded = await startApp(directory, data);
    expect((await upgraded.inject({ method: "GET", url: "/examples" })).json()).toHaveLength(2);
    expect((await upgraded.inject({ method: "GET", url: `/projects/${result.json().id}` })).statusCode).toBe(200);
    await upgraded.close();
    apps.splice(apps.indexOf(upgraded), 1);
    expect((await readdir(cache)).sort()).toEqual([updated, "unrelated"]);
    expect(await readFile(remixedSource, "utf8")).toBe("edited game");
    expect(calls).toEqual([]);
  });

  it("shares the source download between Play and Remix and retries after a bad archive", async () => {
    const files = await exampleZip({ "index.html": "<title>Train</title>", "graph.json": "{}" });
    const { calls, serve } = mockExampleDownloads({ "train/files": files });
    const good = serve.getMockImplementation()!;
    const archive = `${files.sha256}.zip`;
    // Same size, wrong digest.
    serve.mockImplementation((name, init) => name === archive
      ? Promise.resolve(new Response(new Uint8Array(files.bytes)))
      : good(name, init));
    const data = await mkdtemp(path.join(tmpdir(), "ohmygame-examples-data-"));
    const app = await startApp(await writeDownloadCatalog(), data);
    const remix = () => app.inject({ method: "POST", url: "/projects", payload: { exampleId: "train" } });
    const play = () => app.inject({ method: "POST", url: "/examples/train/play" });
    const failed = await remix();
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: EXAMPLE_DOWNLOAD_UNAVAILABLE });
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([]);
    expect(await readdir(path.join(data, "examples-cache-v1", "0".repeat(40), "train"))).toEqual([]);

    serve.mockImplementation(good);
    calls.length = 0;
    const [played, remixed] = await Promise.all([play(), remix()]);
    expect(played.statusCode).toBe(200);
    expect(remixed.statusCode).toBe(201);
    expect(await (await fetch(played.json().url)).text()).toBe("<title>Train</title>");
    expect(calls).toEqual(["manifest.json", archive]);
  });

  it("aborts an outstanding example download and cleans the staging folder when the daemon closes", async () => {
    const { serve } = mockExampleDownloads({});
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    serve.mockImplementation((_name, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      markStarted();
    }));
    const data = await mkdtemp(path.join(tmpdir(), "ohmygame-examples-data-"));
    const app = await startApp(await writeDownloadCatalog(), data);
    const playing = Promise.resolve(app.inject({ method: "POST", url: "/examples/train/play" }));
    await started;
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect((await playing).statusCode).toBe(502);
    expect(await readdir(path.join(data, "examples-cache-v1", "0".repeat(40), "train"))).toEqual([]);
  });

  it("serves an example's static build on loopback for playing", async () => {
    const app = await startApp(await writeExamples());

    const response = await app.inject({ method: "POST", url: "/examples/pond/play" });

    expect(response.statusCode).toBe(200);
    const { url } = response.json() as { url: string };
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{20,}\/$/);
    expect(await (await fetch(url)).text()).toBe("<title>Pond</title>");
    const script = await fetch(`${url}assets/game.js`);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe("play();");
    expect((await fetch(`${url}../cover.webp`)).status).toBe(404);
    expect((await fetch(new URL("/not-a-token/index.html", url))).status).toBe(404);
    expect((await app.inject({ method: "POST", url: "/examples/pond/play" })).json()).toEqual({ url });
    expect((await app.inject({ method: "POST", url: "/examples/lake/play" })).statusCode).toBe(404);
  });

  it("plays an example without a build as its own page", async () => {
    const app = await startApp(await writeExamples());

    const response = await app.inject({ method: "POST", url: "/examples/train/play" });

    expect(response.statusCode).toBe(200);
    const { url } = response.json() as { url: string };
    expect(await (await fetch(url)).text()).toBe("<title>Night Train</title>");
    const graph = await (await fetch(`${url}graph.json`)).json() as { title: string };
    expect(graph.title).toBe("Night Train");
    expect((await app.inject({ method: "POST", url: "/examples/train/play" })).json()).toEqual({ url });
  });

  it("creates a web game from an example without a build, as its files are", async () => {
    const app = await startApp(await writeExamples());

    const response = await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "train" } });

    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project).toMatchObject({ name: "Night Train", type: "web-game" });
    expect(await readFile(path.join(project.workspacePath, "index.html"), "utf8")).toBe("<title>Night Train</title>");
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/cover` })).body).toBe("RIFF-train");
  });

  it("has no examples when none were prepared", async () => {
    const app = await startApp(path.join(tmpdir(), "ohmygame-no-examples-here"));
    expect((await app.inject({ method: "GET", url: "/examples" })).json()).toEqual([]);
  });

  it("creates a runnable web game from an example", async () => {
    const app = await startApp(await writeExamples());

    const response = await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "pond" } });

    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project).toMatchObject({ name: "Pond", type: "web-game", preview: { status: "stopped" } });
    expect(await readFile(path.join(project.workspacePath, "src", "main.ts"), "utf8")).toBe("console.log('pond');\n");
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/cover` })).body).toBe("RIFF-cover");
  });

  it("keeps a custom project name", async () => {
    const app = await startApp(await writeExamples());
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "pond", name: "My pond" } })).json();
    expect(project.name).toBe("My pond");
  });

  it("rejects unknown examples and mismatched project types", async () => {
    const app = await startApp(await writeExamples());

    expect((await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "lake" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/projects", payload: { type: "godot-game", exampleId: "pond" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "../pond" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([]);
  });

  it("only copies an example into an empty chosen folder", async () => {
    const app = await startApp(await writeExamples());
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-example-workspace-"));
    await writeFile(path.join(workspace, "notes.txt"), "mine");

    const rejected = await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "pond", workspacePath: workspace } });

    expect(rejected.statusCode).toBe(400);
    expect(await readdir(workspace)).toEqual(["notes.txt"]);
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([]);

    const empty = await mkdtemp(path.join(tmpdir(), "ohmygame-example-empty-"));
    await writeFile(path.join(empty, ".DS_Store"), "");
    const created = await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", exampleId: "pond", workspacePath: empty } });
    expect(created.statusCode).toBe(201);
    expect((await readdir(empty)).sort()).toEqual([".DS_Store", ".ohmygame", "ohmygame.json", "package.json", "src"]);
  });

  it("validates prepared catalogs", () => {
    const valid = {
      version: 1,
      source: { repository: "a/b", commit: "c" },
      examples: [{ id: "pond", type: "web-game", name: "Pond", description: "", directory: "pond/files", cover: "pond/cover.webp", play: "pond/play" }],
    };
    expect(isPreparedExampleCatalog(valid)).toBe(true);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], directory: "../outside" }] })).toBe(false);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], type: "asset-canvas" }] })).toBe(false);
    expect(isPreparedExampleCatalog({ ...valid, examples: [valid.examples[0], valid.examples[0]] })).toBe(false);
    const { play: _play, ...withoutPlay } = valid.examples[0];
    expect(isPreparedExampleCatalog({ ...valid, examples: [withoutPlay] })).toBe(true);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], play: "../play" }] })).toBe(false);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], type: "interactive-story" }] })).toBe(false);
  });
});

describe("plugin project templates", () => {
  /** A data folder with a plugin installed whose one template is a studio's starting files. */
  async function withTemplatePlugin(): Promise<string> {
    const data = await mkdtemp(path.join(tmpdir(), "ohmygame-templates-data-"));
    const plugin = await mkdtemp(path.join(tmpdir(), "ohmygame-template-plugin-"));
    await mkdir(path.join(plugin, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(plugin, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      id: "acme/studio", version: "1.0.0", engines: { "ohmygame-api": "^2.36.0" },
      displayName: "%displayName%", description: "A game studio.",
      contributes: { templates: [{ id: "studio", title: "%template%", description: "Agents and docs for a studio.", projectType: "general", folder: "./template/" }] },
    }));
    await mkdir(path.join(plugin, "locales"), { recursive: true });
    await writeFile(path.join(plugin, "locales", "en.json"), JSON.stringify({ displayName: "Studio", template: "Game studio" }));
    await writeFile(path.join(plugin, "locales", "zh-CN.json"), JSON.stringify({ displayName: "工作室", template: "游戏工作室" }));
    const template = path.join(plugin, "template");
    await mkdir(path.join(template, ".claude", "agents"), { recursive: true });
    await writeFile(path.join(template, ".claude", "agents", "producer.md"), "# Producer\n");
    await writeFile(path.join(template, "CLAUDE.md"), "# Studio\n");
    // The app writes the project's own file; a template's is left out.
    await writeFile(path.join(template, "ohmygame.json"), JSON.stringify({ type: "web-game" }));
    const services = new PluginServices({ directory: path.join(data, "plugin-store") });
    const installed = await services.install(plugin);
    if (!installed.ok) throw new Error(JSON.stringify(installed.issues));
    await services.close();
    return data;
  }

  it("lists installed plugins' templates in the person's language", async () => {
    const app = await startApp(undefined, await withTemplatePlugin());
    const listed = (await app.inject({ method: "GET", url: "/project-templates?locale=zh-CN" })).json();
    expect(listed).toEqual([{
      id: "acme/studio:studio",
      type: "general",
      name: "游戏工作室",
      description: "Agents and docs for a studio.",
      plugin: { id: "acme/studio", displayName: "工作室", version: "1.0.0" },
    }]);
  });

  it("copies a template once into a new project of its type", async () => {
    const app = await startApp(undefined, await withTemplatePlugin());
    const created = await app.inject({ method: "POST", url: "/projects", payload: { template: "acme/studio:studio", name: "My studio" } });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project).toMatchObject({ name: "My studio", type: "general" });
    expect(await readFile(path.join(project.workspacePath, ".claude", "agents", "producer.md"), "utf8")).toBe("# Producer\n");
    expect(await readFile(path.join(project.workspacePath, "CLAUDE.md"), "utf8")).toBe("# Studio\n");
    expect(JSON.parse(await readFile(path.join(project.workspacePath, "ohmygame.json"), "utf8")).type).toBe("general");
  });

  it("needs an empty folder, a template that exists, and nothing else to start from", async () => {
    const app = await startApp(await writeExamples(), await withTemplatePlugin());
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-template-workspace-"));
    await writeFile(path.join(workspace, "notes.txt"), "mine");
    const create = (payload: object) => app.inject({ method: "POST", url: "/projects", payload });

    expect((await create({ template: "acme/studio:studio", workspacePath: workspace })).statusCode).toBe(400);
    expect(await readdir(workspace)).toEqual(["notes.txt"]);
    expect((await create({ template: "acme/studio:lab" })).statusCode).toBe(404);
    expect((await create({ template: "acme/other:studio" })).statusCode).toBe(404);
    expect((await create({ template: "acme/studio:studio", type: "web-game" })).statusCode).toBe(400);
    expect((await create({ template: "acme/studio:studio", exampleId: "pond" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([]);
  });
});
