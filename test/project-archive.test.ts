import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { createApp } from "../src/daemon/app.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { createNodeCodebase } from "../src/daemon/playable-codebase.js";
import { exportProjectArchive } from "../src/daemon/project-archive.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const webp = (label: string) =>
  Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from(`WEBPVP8 ${label}`),
  ]);

describe("project archive export", () => {
  it("packs the manifest, cover and workspace without dependencies, build output or secrets", async () => {
    const projects = new ProjectManager(await temporaryDirectory());
    const project = await projects.create("Moon Garden", "web-game");
    await projects.setMediaModelDefaults(project.id, {
      image: { provider: "openai", id: "gpt-image-1" },
    });
    const files: Record<string, string> = {
      "index.html": "<canvas></canvas>",
      "src/main.js": "start()",
      "levels/build/keep.txt": "level build data",
      ".gitignore": "dist\n",
      ".data/assets.json": "{}",
      ".data/asset-previews/hero.png": "preview",
      "canvas/board.json": "{}",
      "canvas/jobs.json": "[]",
      "node_modules/pkg/index.js": "dependency",
      "src/node_modules/pkg/index.js": "nested dependency",
      ".git/HEAD": "ref",
      "dist/index.js": "build",
      "build/out.txt": "build",
      "out/out.txt": "build",
      ".godot/cache": "cache",
      ".ohmygame/state.json": "agent",
      ".data/agent-attachments/a.txt": "attachment",
      ".env": "SECRET=1",
      "config/.env.local": "SECRET=2",
    };
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(project.workspacePath, file)), {
        recursive: true,
      });
      await writeFile(path.join(project.workspacePath, file), contents);
    }
    await symlink(
      path.join(project.workspacePath, "index.html"),
      path.join(project.workspacePath, "link.html"),
    );

    const archive = await readArchive(
      await exportProjectArchive(project, {
        cover: { contents: webp("cover"), mode: "custom" },
      }),
    );

    expect(Object.keys(archive).sort()).toEqual([
      "cover.webp",
      "ohmygame-project.json",
      "workspace/.data/asset-previews/hero.png",
      "workspace/.data/assets.json",
      "workspace/.gitignore",
      "workspace/canvas/board.json",
      "workspace/index.html",
      "workspace/levels/build/keep.txt",
      "workspace/src/main.js",
    ]);
    expect(archive["cover.webp"]).toEqual(webp("cover"));
    expect(JSON.parse(archive["ohmygame-project.json"]!.toString())).toEqual({
      format: "ohmygame-project",
      version: 1,
      project: {
        name: "Moon Garden",
        type: "web-game",
        mediaModelDefaults: {
          image: { provider: "openai", id: "gpt-image-1" },
        },
      },
      cover: { mode: "custom" },
    });
  });

  it("copies an Interactive Story's Library assets into the workspace", async () => {
    const library = new AssetLibrary(await temporaryDirectory());
    await library.load();
    const portrait = await library.add(
      "Hero Portrait.png",
      Buffer.from("portrait"),
    );
    const projects = new ProjectManager(await temporaryDirectory(), library);
    const project = await projects.create("Story", "interactive-story");
    const codebase = createStarterCodebaseWithScene("Story", {
      width: 1280,
      height: 720,
    });
    codebase.graph.assets.portrait = {
      type: "image",
      source: { kind: "library", assetId: portrait.id },
    };
    await createNodeCodebase(project.workspacePath, codebase);

    const archive = await readArchive(
      await exportProjectArchive(project, { library }),
    );

    expect(
      archive["workspace/assets/library/Hero-Portrait.png"]?.toString(),
    ).toBe("portrait");
    const graph = JSON.parse(archive["workspace/graph.json"]!.toString());
    expect(graph.assets.portrait.source).toEqual({
      kind: "workspace",
      path: "assets/library/Hero-Portrait.png",
    });
    expect(archive["cover.webp"]).toBeUndefined();
    expect(
      JSON.parse(archive["ohmygame-project.json"]!.toString()).cover,
    ).toBeUndefined();

    graph.assets.portrait.source = { kind: "library", assetId: "gone" };
    await writeFile(
      path.join(project.workspacePath, "graph.json"),
      JSON.stringify(graph),
    );
    await expect(
      exportProjectArchive(project, { library }),
    ).rejects.toMatchObject({
      message: 'Asset "portrait" is missing from the Library.',
      statusCode: 409,
    });
  });

  it("fails the stream instead of hanging when a file disappears while packing", async () => {
    const projects = new ProjectManager(await temporaryDirectory());
    const project = await projects.create("Game", "web-game");
    await writeFile(path.join(project.workspacePath, "index.html"), "game");
    const stream = await exportProjectArchive(project);
    await rm(path.join(project.workspacePath, "index.html"));
    await expect(readArchive(stream)).rejects.toThrow("ENOENT");
  });

  it("downloads a project with its cover through the API", async () => {
    const app = createApp({ dataDirectory: await temporaryDirectory() });
    apps.push(app);
    const project = (
      await app.inject({
        method: "POST",
        url: "/projects",
        payload: { type: "general", name: "Engine game" },
      })
    ).json();
    await writeFile(
      path.join(project.workspacePath, "main.gd"),
      "extends Node",
    );
    await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/cover?source=auto`,
      headers: { "content-type": "image/webp" },
      payload: webp("automatic"),
    });

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/export`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    const archive = await readArchive(response.rawPayload);
    expect(archive["workspace/main.gd"]?.toString()).toBe("extends Node");
    expect(archive["cover.webp"]).toEqual(webp("automatic"));
    expect(
      JSON.parse(archive["ohmygame-project.json"]!.toString()),
    ).toMatchObject({
      project: {
        name: "Engine game",
        type: "general",
        webPreviewEnabled: true,
      },
      cover: { mode: "auto" },
    });
    expect(
      (await app.inject({ method: "POST", url: "/projects/missing/export" }))
        .statusCode,
    ).toBe(404);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-project-archive-"),
  );
  directories.push(directory);
  return directory;
}

async function readArchive(
  source: Readable | Buffer,
): Promise<Record<string, Buffer>> {
  let buffer: Buffer;
  if (Buffer.isBuffer(source)) buffer = source;
  else {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(chunk as Buffer);
    buffer = Buffer.concat(chunks);
  }
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip)
        return reject(error ?? new Error("ZIP could not be opened."));
      const files: Record<string, Buffer> = {};
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("end", () => {
            files[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.once("error", reject);
      zip.once("end", () => resolve(files));
      zip.readEntry();
    });
  });
}
