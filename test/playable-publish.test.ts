import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { ArtifactBuilder, createPluginArchive } from "../src/daemon/publish/archive.js";
import { addPlayableNode } from "../src/daemon/playable-add-node.js";
import { createNodeCodebase, readNodeCodebaseDetail, writeNodeCodebase } from "../src/daemon/playable-codebase.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Web output", () => {
  it("accepts a 99 MiB media ZIP and rejects a ZIP over 100 MiB", async () => {
    const workspace = await temporary("ohmygame-publish-limit-");
    await writeFile(path.join(workspace, "index.html"), "Game");
    const video = path.join(workspace, "clip.webm");
    await writeFile(video, "");
    const builder = new ArtifactBuilder();
    const game = { ...project(workspace), type: "web-game" as const };
    try {
      // WebM is stored in the ZIP, so zero-filled fixtures exercise real ZIP
      // limits without allocating a second large random buffer in the test.
      await truncate(video, 99 * 1024 * 1024);
      await builder.create(game).then((archive) => {
        expect(archive.length).toBeGreaterThan(99 * 1024 * 1024);
        expect(archive.length).toBeLessThanOrEqual(100 * 1024 * 1024);
      });
      await truncate(video, 101 * 1024 * 1024);
      await expect(builder.create(game)).rejects.toMatchObject({
        statusCode: 413,
        message: "Publish artifact exceeds 100 MB",
      });
    } finally { await builder.close(); }
  }, 60_000);

  it("accepts an artifact larger than 25 MiB and still enforces explicit archive limits", async () => {
    const workspace = await temporary("ohmygame-large-publish-");
    await writeFile(path.join(workspace, "index.html"), "Game");
    await writeFile(path.join(workspace, "clip.webm"), randomBytes(26 * 1024 * 1024));
    const builder = new ArtifactBuilder();
    try {
      const archive = await builder.create({ ...project(workspace), type: "web-game" });
      expect(archive.length).toBeGreaterThan(25 * 1024 * 1024);
      expect((await unzip(archive)).get("clip.webm")!.length).toBe(26 * 1024 * 1024);
      await expect(createPluginArchive(workspace, 1024)).rejects.toMatchObject({ statusCode: 413 });
    } finally { await builder.close(); }
  }, 30_000);

  it.each(["web-game", "general"] as const)("publishes %s from its configured startup directory", async (type) => {
    const workspace = await temporary("ohmygame-web-publish-");
    const client = path.join(workspace, "client");
    await mkdir(client);
    await writeFile(path.join(workspace, "index.html"), "Wrong root output");
    await writeFile(path.join(client, "index.html"), "Configured game output");
    await writeFile(path.join(client, "game.js"), "window.ready = true;");
    const builder = new ArtifactBuilder();
    try {
      const files = await unzip(await builder.create({
        id: "web-output", name: "Game", type, updatedAt: new Date(0).toISOString(),
        workspacePath: workspace, startupDirectory: "client", preview: { status: "stopped" },
      }));
      expect(files.get("index.html")?.toString()).toBe("Configured game output");
      expect(files.get("game.js")?.toString()).toBe("window.ready = true;");
      expect(files.has("client/index.html")).toBe(false);
    } finally { await builder.close(); }
  });
});

describe("Web story output", () => {
  it("compresses publish PNGs without altering workspace originals or local builds", async () => {
    const workspace = await temporary("ohmygame-web-story-compression-");
    await createNodeCodebase(workspace, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));
    await mkdir(path.join(workspace, "assets"));
    const original = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 0.5 } } }).png({ compressionLevel: 0 }).toBuffer();
    const assetPath = path.join(workspace, "assets", "background.png");
    await writeFile(assetPath, original);
    const codebase = await readNodeCodebaseDetail(workspace);
    await writeNodeCodebase(workspace, { ...codebase, graph: { ...codebase.graph, nodes: codebase.graph.nodes.map((node) => ({ ...node, signals: [] })), assets: { background: { type: "image", source: { kind: "workspace", path: "assets/background.png" } } } } });
    const builder = new ArtifactBuilder();
    try {
      const local = await unzip(await builder.buildInteractiveStory(project(workspace)));
      const published = await unzip(await builder.create(project(workspace)));
      const optimized = published.get("assets/background.png")!;
      expect(optimized.length).toBeLessThan(original.length / 10);
      expect((await sharp(optimized).raw().toBuffer()).equals(await sharp(original).raw().toBuffer())).toBe(true);
      expect(local.get("assets/background.png")!.equals(original)).toBe(true);
      expect((await readFile(assetPath)).equals(original)).toBe(true);
    } finally { await builder.close(); }
  });

  it("publishes the files that play the story and the assets it uses, and nothing of the editor", async () => {
    const workspace = await temporary("ohmygame-web-story-publish-");
    await createNodeCodebase(workspace, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));
    await addPlayableNode(workspace, { preset: "visual-novel", id: "chapter" });
    await mkdir(path.join(workspace, "assets"));
    await mkdir(path.join(workspace, ".ohmygame"), { recursive: true });
    await Promise.all([
      writeFile(path.join(workspace, "assets", "street.webp"), "declared"),
      writeFile(path.join(workspace, "assets", "paper.png"), "named in CSS"),
      writeFile(path.join(workspace, "assets", "unused.mp4"), "unused"),
      writeFile(path.join(workspace, ".ohmygame", "cache.json"), "{}"),
      mkdir(path.join(workspace, "fonts")).then(() => writeFile(path.join(workspace, "fonts", "serif.woff2"), "font")),
      mkdir(path.join(workspace, "canvas")).then(() => writeFile(path.join(workspace, "canvas", "board.png"), "board")),
    ]);
    await writeFile(path.join(workspace, "shared", "style", "fonts.css"), '@font-face { font-family: Serif; src: url("../../fonts/serif.woff2"); }\n/* canvas/board.png belongs to the editor */\n');
    await writeFile(path.join(workspace, "nodes", "chapter", "style.css"), '.vn { background: url("../../assets/paper.png"); }\n');
    const codebase = await readNodeCodebaseDetail(workspace);
    await writeNodeCodebase(workspace, {
      ...codebase,
      graph: {
        ...codebase.graph,
        entryNodeId: "chapter",
        assets: { street: { type: "image", source: { kind: "workspace", path: "assets/street.webp" } } },
        nodes: codebase.graph.nodes.map((node) => node.id === "chapter" ? { ...node, assets: ["street"], signals: [] } : { ...node, signals: [] }),
      },
    });

    const builder = new ArtifactBuilder();
    try {
      const files = await unzip(await builder.buildInteractiveStory(project(workspace)));
      const names = [...files.keys()].sort();
      expect(names).toContain("index.html");
      expect(names).toContain("graph.json");
      expect(names).toContain("story/story-web/runtime.js");
      expect(names).toContain("nodes/chapter/script.txt");
      expect(names).toContain("shared/vn/player.js");
      expect(names).toContain("assets/street.webp");
      expect(names).toContain("assets/paper.png");
      expect(names).toContain("fonts/serif.woff2");
      expect(names).not.toContain("canvas/board.png");
      for (const left of ["assets/unused.mp4", "story/manifest.json", "editor/layout.json", "AGENTS.md", "README.md", "schemas/graph.schema.json", ".ohmygame/cache.json"])
        expect(names).not.toContain(left);
    } finally { await builder.close(); }
  });

  it("refuses to publish a web story that still uses a Library asset", async () => {
    const workspace = await temporary("ohmygame-web-story-library-");
    await createNodeCodebase(workspace, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));
    const codebase = await readNodeCodebaseDetail(workspace);
    await writeNodeCodebase(workspace, {
      ...codebase,
      graph: { ...codebase.graph, assets: { opening: { type: "video", source: { kind: "library", assetId: "lib" } } }, nodes: codebase.graph.nodes.map((node) => ({ ...node, signals: [] })) },
    });
    const builder = new ArtifactBuilder();
    try {
      await expect(builder.buildInteractiveStory(project(workspace))).rejects.toThrow('Asset "opening" is in the Library');
    } finally { await builder.close(); }
  });
});

describe("Stories made before web stories", () => {
  it("refuses to build one until the Story editor has upgraded it", async () => {
    const workspace = await temporary("ohmygame-sandbox-story-");
    await createNodeCodebase(workspace, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));
    await rm(path.join(workspace, "index.html"));
    await rm(path.join(workspace, "story"), { recursive: true });
    const builder = new ArtifactBuilder();
    try {
      await expect(builder.buildInteractiveStory(project(workspace))).rejects.toThrow("Open it in the Story editor, which upgrades it");
    } finally { await builder.close(); }
  });
});

function project(workspacePath: string) {
  return {
    id: "playable-project",
    name: "Ash Club",
    type: "interactive-story" as const,
    updatedAt: new Date(0).toISOString(),
    workspacePath,
    preview: { status: "stopped" as const },
  };
}

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error("ZIP could not be opened."));
        return;
      }
      const files = new Map<string, Buffer>();
      zip.once("error", reject);
      zip.once("end", () => resolve(files));
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(
              streamError ??
                new Error(`ZIP entry "${entry.fileName}" could not be read.`),
            );
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("error", reject);
          stream.once("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
