import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { PreparedExampleCatalog } from "../src/shared/examples.js";
import { isPreparedExampleCatalog } from "../src/shared/examples.js";

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
    }],
  };
  await writeFile(path.join(directory, "catalog.json"), JSON.stringify(catalog));
  return directory;
}

async function startApp(examplesDirectory?: string) {
  const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-examples-data-")), examplesDirectory });
  apps.push(app);
  await app.ready();
  return app;
}

describe("examples", () => {
  it("lists packaged examples and serves their covers", async () => {
    const app = await startApp(await writeExamples());

    expect((await app.inject({ method: "GET", url: "/examples" })).json()).toEqual([
      { id: "pond", type: "web-game", name: "Pond", description: "A small pond." },
    ]);
    const cover = await app.inject({ method: "GET", url: "/examples/pond/cover" });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/webp");
    expect(cover.body).toBe("RIFF-cover");
    expect((await app.inject({ method: "GET", url: "/examples/missing/cover" })).statusCode).toBe(404);
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
      examples: [{ id: "pond", type: "web-game", name: "Pond", description: "", directory: "pond/files", cover: "pond/cover.webp" }],
    };
    expect(isPreparedExampleCatalog(valid)).toBe(true);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], directory: "../outside" }] })).toBe(false);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], type: "asset-canvas" }] })).toBe(false);
    expect(isPreparedExampleCatalog({ ...valid, examples: [valid.examples[0], valid.examples[0]] })).toBe(false);
  });
});
