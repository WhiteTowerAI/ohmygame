import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { createNodeCodebase } from "../src/daemon/playable-codebase.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import type { PreparedExampleCatalog } from "../src/shared/examples.js";
import { isPreparedExampleCatalog } from "../src/shared/examples.js";
import { createCanvasBoard } from "../src/shared/canvas-workspace.js";

const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
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
  // An interactive story example holds only the project files; the app adds
  // AGENTS.md, README.md and schemas when it copies the example.
  const story = path.join(directory, "train", "files");
  await mkdir(story, { recursive: true });
  await createNodeCodebase(story, createStarterCodebaseWithScene("Night Train", { width: 1280, height: 720 }));
  for (const owned of ["AGENTS.md", "README.md", "schemas"]) await rm(path.join(story, owned), { recursive: true });
  await writeFile(path.join(directory, "train", "cover.webp"), "RIFF-train");
  catalog.examples.push({
    id: "train",
    type: "interactive-story",
    name: "Night Train",
    description: "A short story.",
    directory: "train/files",
    cover: "train/cover.webp",
  });
  await writeFile(path.join(directory, "catalog.json"), JSON.stringify(catalog));
  return directory;
}

async function writePlayer(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-examples-player-"));
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await writeFile(path.join(directory, "index.html"), "<h1>Published player</h1>");
  await writeFile(path.join(directory, "player.js"), "window.player = true");
  await writeFile(path.join(directory, "playable-sandbox.html"), "Playable sandbox");
  await writeFile(path.join(directory, "assets", "playable-sandbox.js"), "window.sandbox = true");
  return directory;
}

async function startApp(examplesDirectory?: string, interactiveStoryPlayerDirectory?: string) {
  const app = createApp({
    dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-examples-data-")),
    examplesDirectory,
    ...(interactiveStoryPlayerDirectory ? { interactiveStoryPlayerDirectory } : {}),
  });
  apps.push(app);
  await app.ready();
  return app;
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
      { id: "train", type: "interactive-story", name: "Night Train", description: "A short story." },
    ]);
    const cover = await app.inject({ method: "GET", url: "/examples/pond/cover" });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/webp");
    expect(cover.body).toBe("RIFF-cover");
    expect((await app.inject({ method: "GET", url: "/examples/missing/cover" })).statusCode).toBe(404);
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

  it("compiles an interactive story example with the Published Player when played", async () => {
    const app = await startApp(await writeExamples(), await writePlayer());

    const response = await app.inject({ method: "POST", url: "/examples/train/play" });

    expect(response.statusCode).toBe(200);
    const { url } = response.json() as { url: string };
    expect(await (await fetch(url)).text()).toBe("<h1>Published player</h1>");
    const definition = await (await fetch(`${url}playable.json`)).json() as { graph: { title: string } };
    expect(definition.graph.title).toBe("Night Train");
    expect(await (await fetch(`${url}manifest.json`)).json()).toMatchObject({ scope: "example:train" });
    expect((await app.inject({ method: "POST", url: "/examples/train/play" })).json()).toEqual({ url });
  });

  it("creates an interactive story from an example with this version's agent contract", async () => {
    const app = await startApp(await writeExamples());

    const response = await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story", exampleId: "train" } });

    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project).toMatchObject({ name: "Night Train", type: "interactive-story" });
    for (const owned of ["AGENTS.md", "README.md", "schemas/graph.schema.json"]) {
      expect((await stat(path.join(project.workspacePath, owned))).isFile()).toBe(true);
    }
    const codebase = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    expect(codebase.graph.nodes.map((node: { id: string }) => node.id)).toEqual(["start"]);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/cover` })).body).toBe("RIFF-train");
    expect((await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story", exampleId: "train", viewport: { width: 720, height: 1280 } } })).statusCode).toBe(400);
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
    expect((await readdir(empty)).sort()).toEqual([".DS_Store", "package.json", "src"]);
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
    expect(isPreparedExampleCatalog({ ...valid, examples: [withoutPlay] })).toBe(false);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...withoutPlay, type: "interactive-story" }] })).toBe(true);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], type: "interactive-story" }] })).toBe(false);
  });
});
