import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { ReadStream } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import yauzl from "yauzl";
import { ZipFile } from "yazl";
import { createApp } from "../src/daemon/app.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { createNodeCodebase } from "../src/daemon/playable-codebase.js";
import {
  exportProjectArchive,
  importProjectArchive,
} from "../src/daemon/project-archive.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { writeWorkspaceNotice } from "../src/daemon/workspace-notice.js";
import { PROJECT_ARCHIVE_CONTENT_TYPE } from "../src/shared/project-archive.js";
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
    // Creating symbolic links needs extra privileges on Windows.
    if (process.platform !== "win32") {
      await symlink(
        path.join(project.workspacePath, "index.html"),
        path.join(project.workspacePath, "link.html"),
      );
    }

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

  // Windows does not apply POSIX permission bits, so the file stays readable there.
  it.skipIf(process.platform === "win32")(
    "rejects an unreadable file before returning a download",
    async () => {
      const projects = new ProjectManager(await temporaryDirectory());
      const project = await projects.create("Game", "web-game");
      const file = path.join(project.workspacePath, "index.html");
      await writeFile(file, "game");
      await chmod(file, 0o000);
      await expect(exportProjectArchive(project)).rejects.toThrow("EACCES");
    },
  );

  it.each([
    ["too many files", { maxBytes: 1024, maxEntries: 2 }],
    ["too many bytes", { maxBytes: 10, maxEntries: 10 }],
  ])(
    "refuses to export a project an import would reject for %s",
    async (_case, limits) => {
      const projects = new ProjectManager(await temporaryDirectory());
      const project = await projects.create("Game", "web-game");
      await writeFile(
        path.join(project.workspacePath, "index.html"),
        "x".repeat(20),
      );
      await writeFile(path.join(project.workspacePath, "main.js"), "start()");
      await expect(
        exportProjectArchive(project, { limits }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("too large to export"),
        statusCode: 409,
      });
    },
  );

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

  it("counts the manifest even when the workspace is empty", async () => {
    const projects = new ProjectManager(await temporaryDirectory());
    const project = await projects.create("Empty project");
    await expect(
      exportProjectArchive(project, {
        limits: { maxBytes: 10, maxEntries: 10 },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("exports a restored project without requiring a cached workspace version", async () => {
    const dataDirectory = await temporaryDirectory();
    const projects = new ProjectManager(dataDirectory);
    const project = await projects.create("Restored project");
    await writeFile(
      path.join(project.workspacePath, "index.html"),
      "restored game",
    );
    await writeWorkspaceNotice(
      project,
      "Restored a checkpoint",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    const app = createApp({ dataDirectory });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/export`,
      headers: { "x-workspace-version": "0" },
    });
    expect(response.statusCode).toBe(200);
    expect(
      (await readArchive(response.rawPayload))[
        "workspace/index.html"
      ]?.toString(),
    ).toBe("restored game");
  });

  it("checks the actual ZIP overhead before offering a download", async () => {
    const projects = new ProjectManager(await temporaryDirectory());
    const project = await projects.create("Game");
    await writeFile(
      path.join(project.workspacePath, "image.png"),
      Buffer.alloc(900),
    );
    const files = await readArchive(await exportProjectArchive(project));
    const extractedBytes = Object.values(files).reduce(
      (size, contents) => size + contents.length,
      0,
    );
    await expect(
      exportProjectArchive(project, {
        limits: { maxBytes: extractedBytes, maxEntries: 10 },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it.skipIf(process.platform === "win32")(
    "preserves executable files through export and import",
    async () => {
      const projects = new ProjectManager(await temporaryDirectory());
      const project = await projects.create("Game");
      await writeFile(
        path.join(project.workspacePath, "run.sh"),
        "#!/bin/sh\nexit 0\n",
      );
      await chmod(path.join(project.workspacePath, "run.sh"), 0o755);
      const archive = await exportProjectArchive(project);
      const imported = await importProjectArchive(
        new ProjectManager(await temporaryDirectory()),
        archive,
      );
      expect(
        (await stat(path.join(imported.workspacePath, "run.sh"))).mode & 0o111,
      ).toBe(0o111);
    },
  );

  it("counts the rewritten story graph instead of its smaller source", async () => {
    const library = new AssetLibrary(await temporaryDirectory());
    await library.load();
    const asset = await library.add("portrait.png", Buffer.from("portrait"));
    const projects = new ProjectManager(await temporaryDirectory());
    const project = await projects.create("Story", "interactive-story");
    const graph = JSON.stringify({
      assets: { portrait: { source: { kind: "library", assetId: asset.id } } },
    });
    await writeFile(path.join(project.workspacePath, "graph.json"), graph);
    const files = await readArchive(
      await exportProjectArchive(project, { library }),
    );
    const manifestBytes = files["ohmygame-project.json"]!.length;
    await expect(
      exportProjectArchive(project, {
        library,
        limits: {
          maxBytes: manifestBytes + Buffer.byteLength(graph) + 8,
          maxEntries: 10,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it.each([false, true])(
    "removes its temporary archive after downloading or cancellation (cancel=%s)",
    async (cancel) => {
      const projects = new ProjectManager(await temporaryDirectory());
      const project = await projects.create("Game");
      const download = (await exportProjectArchive(project)) as ReadStream;
      const staging = path.dirname(download.path as string);
      expect((await stat(staging)).isDirectory()).toBe(true);
      if (cancel) {
        const closed = once(download, "close");
        download.destroy();
        await closed;
      } else {
        await readArchive(download);
      }
      await vi.waitFor(async () => {
        await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});

describe("project archive import", () => {
  it.each(["fit", "mobile", "mobile-landscape"])("imports an exported project as a new project with the %s preset", async (previewViewport) => {
    const source = createApp({ dataDirectory: await temporaryDirectory() });
    const target = createApp({ dataDirectory: await temporaryDirectory() });
    apps.push(source, target);
    const original = (
      await source.inject({
        method: "POST",
        url: "/projects",
        payload: { type: "general", name: "Engine game" },
      })
    ).json();
    const settings = await source.inject({
      method: "PUT",
      url: `/projects/${original.id}/settings/run`,
      payload: {
        startupDirectory: ".",
        startupScript: "dev",
        previewPath: "/",
        previewViewport,
        webPreviewEnabled: true,
      },
    });
    expect(settings.statusCode).toBe(200);
    await mkdir(path.join(original.workspacePath, "scenes"));
    await writeFile(
      path.join(original.workspacePath, "scenes/main.tscn"),
      "[scene]",
    );
    await source.inject({
      method: "PUT",
      url: `/projects/${original.id}/cover`,
      headers: { "content-type": "image/webp" },
      payload: webp("custom"),
    });
    const archive = (
      await source.inject({
        method: "POST",
        url: `/projects/${original.id}/export`,
      })
    ).rawPayload;

    const response = await target.inject({
      method: "POST",
      url: "/projects/import",
      headers: { "content-type": PROJECT_ARCHIVE_CONTENT_TYPE },
      payload: archive,
    });

    expect(response.statusCode).toBe(201);
    const imported = response.json();
    expect(imported).toMatchObject({
      name: "Engine game",
      nameSource: "manual",
      type: "general",
      webPreviewEnabled: true,
      workspaceLocation: "managed",
    });
    expect(imported.previewViewport ?? "fit").toBe(previewViewport);
    expect(imported.id).not.toBe(original.id);
    expect(
      await readFile(
        path.join(imported.workspacePath, "scenes/main.tscn"),
        "utf8",
      ),
    ).toBe("[scene]");
    const cover = await target.inject({
      method: "GET",
      url: `/projects/${imported.id}/cover`,
    });
    expect(cover.rawPayload).toEqual(webp("custom"));
    expect(
      (
        await target.inject({
          method: "GET",
          url: `/projects/${imported.id}/cover/state`,
        })
      ).json(),
    ).toEqual({ mode: "custom" });
    expect(
      (await target.inject({ method: "GET", url: "/projects" })).json(),
    ).toHaveLength(1);
  });

  it("gives the project a new identity and binds its Canvas generation history", async () => {
    const dataDirectory = await temporaryDirectory();
    const projects = new ProjectManager(dataDirectory);
    const job = {
      id: "historical",
      toolId: "generate-image",
      status: "succeeded",
      context: { projectId: "original", boardId: "design", nodeId: "concept" },
    };
    const project = await importProjectArchive(
      projects,
      await zipArchive({
        "ohmygame-project.json": JSON.stringify({
          format: "ohmygame-project",
          version: 1,
          project: {
            name: "Sky garden",
            type: "asset-canvas",
            id: "original",
            mediaModelDefaults: {
              image: { provider: "openai", id: "gpt-image-1" },
            },
            workspacePath: "/elsewhere",
            publication: {
              gameId: "game",
              deploymentId: "d",
              playUrl: "https://example.com",
              publishedAt: "2026-10-01T00:00:00.000Z",
            },
          },
        }),
        "workspace/canvas/jobs.json": JSON.stringify([job]),
        "workspace/.git/config": "[core]",
        "workspace/art/node_modules/pkg.js": "dependency",
        "workspace/art/node_modules/.bin/tool": {
          contents: "../pkg.js",
          mode: 0o120777,
        },
        "workspace/.data/agent-attachments/a.txt": "attachment",
        "workspace/.data/assets.json": "{}",
        "notes.txt": "outside the workspace",
      }),
    );

    expect(project.id).not.toBe("original");
    expect(project.publication).toBeUndefined();
    expect(project.workspacePath).toBe(
      path.join(dataDirectory, "projects", project.id, "workspace"),
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(project.workspacePath, "canvas/jobs.json"),
          "utf8",
        ),
      ),
    ).toEqual([{ ...job, context: { ...job.context, projectId: project.id } }]);
    expect(await listFiles(project.workspacePath)).toEqual([
      ".data/assets.json",
      "canvas/jobs.json",
    ]);
    const restored = new ProjectManager(dataDirectory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({
      name: "Sky garden",
      type: "asset-canvas",
      mediaModelDefaults: { image: { provider: "openai", id: "gpt-image-1" } },
    });
    expect(await readdir(path.join(dataDirectory, "projects"))).toEqual([
      project.id,
    ]);
  });

  it("adds the current agent instructions and schemas to an imported Interactive Story", async () => {
    const projects = new ProjectManager(await temporaryDirectory());
    const project = await importProjectArchive(
      projects,
      await zipArchive({
        "ohmygame-project.json": manifest({
          name: "Story",
          type: "interactive-story",
        }),
        "workspace/README.md": "My story",
      }),
    );
    expect(await listFiles(project.workspacePath)).toEqual(
      expect.arrayContaining(["AGENTS.md", "README.md"]),
    );
    expect(
      await readFile(path.join(project.workspacePath, "README.md"), "utf8"),
    ).toBe("My story");
  });

  it.each([
    ["a path outside the workspace", "workspace/../evil"],
    ["an absolute path", "/tmp/evil"],
    ["a drive letter", "C:/evil"],
  ])(
    "rejects an archive with %s and leaves nothing behind",
    async (_case, name) => {
      const dataDirectory = await temporaryDirectory();
      const projects = new ProjectManager(dataDirectory);
      const placeholder = "x".repeat(name.length);
      const archive = await zipArchive({
        "ohmygame-project.json": manifest({ name: "Game", type: "web-game" }),
        [placeholder]: "evil",
      });
      // Change equal-length local/central entry names without yazl's path guard.
      const unsafe = Buffer.from(
        archive.toString("latin1").replaceAll(placeholder, name),
        "latin1",
      );
      // yauzl refuses these names itself; the shared checks back it up.
      await expect(importProjectArchive(projects, unsafe)).rejects.toThrow();
      await expectNothingImported(projects, dataDirectory);
    },
  );

  it("rejects symbolic links", async () => {
    const dataDirectory = await temporaryDirectory();
    const projects = new ProjectManager(dataDirectory);
    const archive = await zipArchive({
      "ohmygame-project.json": manifest({ name: "Game", type: "web-game" }),
      "workspace/link": { contents: "/etc/passwd", mode: 0o120777 },
    });
    await expect(importProjectArchive(projects, archive)).rejects.toThrow(
      "symbolic link",
    );
    await expectNothingImported(projects, dataDirectory);
  });

  it.each([
    ["the same file twice", ["workspace/index.html", "workspace/index.html"]],
    ["a file where a folder is", ["workspace/src", "workspace/src/main.js"]],
  ])("rejects an archive with %s", async (_case, names) => {
    const dataDirectory = await temporaryDirectory();
    const projects = new ProjectManager(dataDirectory);
    const zip = new ZipFile();
    zip.addBuffer(
      Buffer.from(manifest({ name: "Game", type: "web-game" })),
      "ohmygame-project.json",
    );
    for (const name of names) zip.addBuffer(Buffer.from("x"), name);
    const archive = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.once("error", reject);
      zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
      zip.end();
    });
    await expect(importProjectArchive(projects, archive)).rejects.toMatchObject(
      {
        message: "The project archive contains the same path twice.",
        statusCode: 400,
      },
    );
    await expectNothingImported(projects, dataDirectory);
  });

  it.each([
    ["too many entries", { maxBytes: 1024, maxEntries: 2 }],
    ["too many extracted bytes", { maxBytes: 200, maxEntries: 10 }],
    ["too large an upload", { maxBytes: 100, maxEntries: 10 }],
  ])("rejects an archive with %s", async (_case, limits) => {
    const dataDirectory = await temporaryDirectory();
    const projects = new ProjectManager(dataDirectory);
    const archive = await zipArchive({
      "ohmygame-project.json": manifest({ name: "Game", type: "web-game" }),
      "workspace/index.html": "x".repeat(300),
      "workspace/main.js": "start()",
    });
    await expect(
      importProjectArchive(projects, archive, { limits }),
    ).rejects.toMatchObject({
      message: "The project archive is too large.",
      statusCode: 413,
    });
    await expectNothingImported(projects, dataDirectory);
  });

  it.each([
    ["not a ZIP file", Buffer.from("not a zip"), "not a valid ZIP archive"],
    [
      "no manifest",
      { "index.html": "game" },
      "not an OhMyGame project archive",
    ],
    [
      "another format",
      {
        "ohmygame-project.json": JSON.stringify({
          format: "other",
          version: 1,
        }),
      },
      "not an OhMyGame project archive",
    ],
    [
      "a newer format version",
      {
        "ohmygame-project.json": JSON.stringify({
          format: "ohmygame-project",
          version: 2,
          project: {},
        }),
      },
      "newer version of OhMyGame",
    ],
    [
      "an unknown project type",
      {
        "ohmygame-project.json": manifest({
          name: "Game",
          type: "spreadsheet",
        }),
      },
      "type is not supported",
    ],
    [
      "invalid settings",
      {
        "ohmygame-project.json": manifest({
          name: "Game",
          type: "web-game",
          startupDirectory: "../outside",
        }),
      },
      "settings are invalid",
    ],
  ])("rejects %s", async (_case, input, message) => {
    const dataDirectory = await temporaryDirectory();
    const projects = new ProjectManager(dataDirectory);
    const archive = Buffer.isBuffer(input) ? input : await zipArchive(input);
    await expect(importProjectArchive(projects, archive)).rejects.toThrow(
      message,
    );
    await expectNothingImported(projects, dataDirectory);
  });

  it.each([
    ["not a WebP image", Buffer.from("not an image")],
    [
      "larger than a cover may be",
      Buffer.concat([webp("large"), Buffer.alloc(6 * 1024 * 1024)]),
    ],
  ])(
    "imports the project without a cover that is %s",
    async (_case, contents) => {
      const projects = new ProjectManager(await temporaryDirectory());
      const archive = await zipArchive({
        "ohmygame-project.json": JSON.stringify({
          format: "ohmygame-project",
          version: 1,
          project: { name: "Game", type: "web-game" },
          cover: { mode: "custom" },
        }),
        "cover.webp": contents.toString("latin1"),
      });
      const project = await importProjectArchive(projects, archive);
      expect(await projects.cover(project.id)).toBeUndefined();
    },
  );

  it("removes the project when a step after creating it fails", async () => {
    const dataDirectory = await temporaryDirectory();
    const projects = new ProjectManager(dataDirectory);
    vi.spyOn(projects, "refreshPreviewReadiness").mockRejectedValue(
      new Error("disk full"),
    );
    await expect(
      importProjectArchive(
        projects,
        await zipArchive({
          "ohmygame-project.json": manifest({ name: "Game", type: "web-game" }),
        }),
      ),
    ).rejects.toThrow("disk full");
    await expectNothingImported(projects, dataDirectory);
  });

  it("removes staging folders an interrupted import left behind", async () => {
    const dataDirectory = await temporaryDirectory();
    const staging = await new ProjectManager(
      dataDirectory,
    ).createImportStaging();
    await writeFile(path.join(staging, "upload.zip"), "partial");
    const projects = new ProjectManager(dataDirectory);
    // Startup does not wait for the removal.
    await projects.load();
    const imported = await importProjectArchive(
      projects,
      await zipArchive({
        "ohmygame-project.json": manifest({ name: "Game", type: "web-game" }),
      }),
    );
    await vi.waitFor(async () => {
      expect(await readdir(path.join(dataDirectory, "projects"))).toEqual([
        imported.id,
      ]);
    });
  });

  it("imports an Interactive Story project file from earlier versions", async () => {
    const library = new AssetLibrary(await temporaryDirectory());
    await library.load();
    const workspace = await temporaryDirectory();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    await writeFile(path.join(workspace, "cover.webp"), "story file");
    const app = createApp({ dataDirectory: await temporaryDirectory() });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/projects/import?name=${encodeURIComponent("Night Train")}`,
      headers: { "content-type": PROJECT_ARCHIVE_CONTENT_TYPE },
      payload: await zipArchive(
        Object.fromEntries(
          await Promise.all(
            (await listFiles(workspace))
              .filter(
                (file) =>
                  !file
                    .split("/")
                    .some(
                      (part) => part.startsWith(".") || part === "node_modules",
                    ),
              )
              .map(async (file) => [
                file,
                await readFile(path.join(workspace, file), "utf8"),
              ]),
          ),
        ),
      ),
    });

    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project).toMatchObject({
      name: "Night Train",
      type: "interactive-story",
    });
    expect(
      await readFile(path.join(project.workspacePath, "graph.json"), "utf8"),
    ).toBe(await readFile(path.join(workspace, "graph.json"), "utf8"));
    expect(
      await readFile(path.join(project.workspacePath, "cover.webp"), "utf8"),
    ).toBe("story file");
    expect(await listFiles(project.workspacePath)).toContain("AGENTS.md");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/projects/${project.id}/cover/state`,
        })
      ).json(),
    ).toEqual({ mode: "auto" });

    const unnamed = await importProjectArchive(
      new ProjectManager(await temporaryDirectory()),
      await zipArchive({ "graph.json": "{}", ".git/config": "[core]" }),
    );
    expect(unnamed.name).toBe("Untitled story");
    expect(await listFiles(unnamed.workspacePath)).not.toContain(".git/config");
  });

  it("answers import errors with their status through the API", async () => {
    const app = createApp({ dataDirectory: await temporaryDirectory() });
    apps.push(app);
    const post = (payload: Buffer) =>
      app.inject({
        method: "POST",
        url: "/projects/import",
        headers: { "content-type": PROJECT_ARCHIVE_CONTENT_TYPE },
        payload,
      });
    const invalid = await post(Buffer.from("not a zip"));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      error: "The file is not a valid ZIP archive.",
    });
    const settings = await post(
      await zipArchive({
        "ohmygame-project.json": manifest({ name: " ", type: "web-game" }),
      }),
    );
    expect(settings.statusCode).toBe(400);
    const json = await app.inject({
      method: "POST",
      url: "/projects/import",
      payload: { archive: "not a file" },
    });
    expect(json.statusCode).toBe(400);
    expect(json.json()).toEqual({
      error: "Choose a project archive to import.",
    });
    expect(
      (await app.inject({ method: "GET", url: "/projects" })).json(),
    ).toEqual([]);
  });
});

function manifest(project: Record<string, unknown>): string {
  return JSON.stringify({ format: "ohmygame-project", version: 1, project });
}

async function expectNothingImported(
  projects: ProjectManager,
  dataDirectory: string,
): Promise<void> {
  expect(projects.list()).toEqual([]);
  expect(await readdir(path.join(dataDirectory, "projects"))).toEqual([]);
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else files.push(child);
  }
  return files.sort();
}

function zipArchive(
  entries: Record<string, string | { contents: string; mode: number }>,
): Promise<Buffer> {
  const zip = new ZipFile();
  for (const [name, entry] of Object.entries(entries)) {
    const { contents, mode } =
      typeof entry === "string" ? { contents: entry, mode: 0o100644 } : entry;
    zip.addBuffer(Buffer.from(contents), name, { mode, compress: false });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

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
