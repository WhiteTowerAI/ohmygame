import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ArtifactBuilder, createPluginArchive, validatePlayablePublishDirectory } from "../src/daemon/publish/archive.js";
import { isPublishedNodeManifest } from "../src/shared/playable-publish.js";
import { addPlayableNode } from "../src/daemon/playable-add-node.js";
import { createNodeCodebase, readNodeCodebaseDetail, writeNodeCodebase } from "../src/daemon/playable-codebase.js";
import {
  createNodeGraphFixture,
  createStarterCodebaseWithScene,
  writePlayableFixtureWorkspace,
} from "./playable-fixture.js";

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

describe("Published Player", () => {
  it("hashes optimized assets in the legacy manifest and preserves originals", async () => {
    const workspace = await temporary("ohmygame-legacy-compression-");
    const player = await playerFixture();
    const data = await temporary("ohmygame-legacy-compression-data-");
    const graph = createNodeGraphFixture();
    delete graph.assets.theme;
    graph.assets.background = { type: "image", source: { kind: "workspace", path: "assets/background.png" } };
    for (const node of graph.nodes) node.assets = node.assets.filter((id) => id !== "theme");
    await writePlayableFixtureWorkspace(workspace, graph);
    const original = await sharp({ create: { width: 512, height: 512, channels: 4, background: "red" } }).png({ compressionLevel: 0 }).toBuffer();
    await writeFile(path.join(workspace, "assets/background.png"), original);
    const library = new AssetLibrary(data);
    await library.load();
    const builder = new ArtifactBuilder(library, player);
    try {
      const files = await unzip(await builder.create(project(workspace)));
      const manifest = JSON.parse(files.get("manifest.json")!.toString());
      const asset = manifest.assets.background;
      const optimized = files.get(asset.path.slice(2))!;
      expect(optimized.length).toBeLessThan(original.length / 10);
      expect(asset.size).toBe(optimized.length);
      expect(asset.integrity).toBe(`sha256-${createHash("sha256").update(optimized).digest("base64")}`);
      expect(asset.path).toBe(`./assets/media/${createHash("sha256").update(optimized).digest("hex")}.png`);
      expect((await readFile(path.join(workspace, "assets/background.png"))).equals(original)).toBe(true);
    } finally { await builder.close(); }
  });

  it("validates the strict published manifest contract", () => {
    const manifest = {
      version: 1,
      runtime: "playable-nodes",
      scope: "published:project",
      graphSignature: "a".repeat(64),
      definition: { path: "./playable.json", integrity: `sha256-${"A".repeat(43)}=` },
      assets: {},
    };

    expect(isPublishedNodeManifest(manifest)).toBe(true);
    expect(isPublishedNodeManifest({ ...manifest, extra: true })).toBe(false);
    expect(isPublishedNodeManifest({ ...manifest, definition: { ...manifest.definition, path: "../playable.json" } })).toBe(false);
    expect(isPublishedNodeManifest({ ...manifest, assets: {
      clip: { path: "./assets/media/clip.mp4", integrity: `sha256-${"A".repeat(43)}=`, type: "video", contentType: "image/png", size: 1 },
    } })).toBe(false);
  });

  it("packages the same compiled definition consumed by Playtest", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await temporary("ohmygame-playable-publish-player-");
    const data = await temporary("ohmygame-playable-publish-data-");
    const graph = createNodeGraphFixture();
    delete graph.assets.theme;
    for (const node of graph.nodes) node.assets = node.assets.filter((id) => id !== "theme");
    await writePlayableFixtureWorkspace(workspace, graph);
    await mkdir(path.join(player, "assets"));
    await Promise.all([
      writeFile(path.join(player, "index.html"), "Published Player"),
      writeFile(path.join(player, "playable-sandbox.html"), "Playable sandbox"),
      writeFile(path.join(player, "assets", "playable-sandbox.js"), "window.sandbox = true"),
      writeFile(path.join(player, "player.js"), "window.player = true"),
    ]);
    const library = new AssetLibrary(data);
    await library.load();

    const archive = await new ArtifactBuilder(
      library,
      player,
    ).buildInteractiveStory({
      id: "playable-project",
      name: "Ash Club",
      type: "interactive-story",
      updatedAt: new Date(0).toISOString(),
      workspacePath: workspace,
      preview: { status: "stopped" },
    });
    const files = await unzip(archive);
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    const definition = JSON.parse(files.get("playable.json")!.toString("utf8"));

    const assetDigest = createHash("sha256").update("fixture").digest("hex");
    expect(manifest).toMatchObject({
      version: 1,
      runtime: "playable-nodes",
      scope: "published:playable-project",
      graphSignature: definition.graphSignature,
      definition: { path: "./playable.json", integrity: expect.stringMatching(/^sha256-/) },
      assets: {
        background: {
          path: `./assets/media/${assetDigest}.webp`,
          type: "image",
          contentType: "image/webp",
          size: 7,
          integrity: expect.stringMatching(/^sha256-/),
        },
      },
    });
    expect(definition).toMatchObject({
      version: 1,
      graph: { title: "Ash Club" },
      compiled: { version: 1 },
    });
    expect(files.get(`assets/media/${assetDigest}.webp`)?.toString()).toBe(
      "fixture",
    );
    expect(files.get("playable-sandbox.html")?.toString()).toBe(
      "Playable sandbox",
    );
    expect(files.get("assets/playable-sandbox.js")?.toString()).toBe(
      "window.sandbox = true",
    );
  });

  it("publishes per-Scene clip bounds with the complete original video bytes", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await playerFixture();
    const data = await temporary("ohmygame-playable-publish-data-");
    const graph = createNodeGraphFixture();
    graph.assets.intro = { type: "video", source: { kind: "workspace", path: "assets/intro.webm" } };
    delete graph.assets.theme;
    for (const node of graph.nodes) node.assets = node.assets.filter((id) => id !== "theme");
    graph.nodes[0]!.assets.push("intro");
    await writePlayableFixtureWorkspace(workspace, graph);
    await writeFile(path.join(workspace, "assets/intro.webm"), "original complete video bytes");
    await writeFile(path.join(workspace, graph.nodes[0]!.source.html), '<div data-media="backdrop" data-type="video" data-asset="intro" data-clip-start="1.5" data-clip-end="3.2"></div>');
    const library = new AssetLibrary(data);
    await library.load();
    const archive = await new ArtifactBuilder(library, player).buildInteractiveStory({ id: "clip-project", name: "Clip", type: "interactive-story", updatedAt: new Date(0).toISOString(), workspacePath: workspace, preview: { status: "stopped" } });
    const files = await unzip(archive);
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    const definition = JSON.parse(files.get("playable.json")!.toString("utf8"));
    expect(definition.compiled.nodes.menu.html).toContain('data-clip-start="1.5" data-clip-end="3.2"');
    expect(files.get(manifest.assets.intro.path.slice(2))!.toString()).toBe("original complete video bytes");
  });

  it("deduplicates identical Asset content while retaining stable IDs", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await playerFixture();
    const data = await temporary("ohmygame-playable-publish-data-");
    const graph = createNodeGraphFixture();
    delete graph.assets.theme;
    graph.assets.poster = structuredClone(graph.assets.background!);
    graph.nodes[0]!.assets.push("poster");
    for (const node of graph.nodes) node.assets = node.assets.filter((id) => id !== "theme");
    await writePlayableFixtureWorkspace(workspace, graph);
    const library = new AssetLibrary(data);
    await library.load();

    const files = await unzip(await new ArtifactBuilder(library, player).buildInteractiveStory(project(workspace)));
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    const mediaFiles = [...files.keys()].filter((file) => file.startsWith("assets/media/"));

    expect(manifest.assets.background.path).toBe(manifest.assets.poster.path);
    expect(mediaFiles).toHaveLength(1);
  });

  it("rejects missing Library content as a publish validation error", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await playerFixture();
    const data = await temporary("ohmygame-playable-publish-data-");
    await writePlayableFixtureWorkspace(workspace);
    const library = new AssetLibrary(data);
    await library.load();

    await expect(new ArtifactBuilder(library, player).buildInteractiveStory(project(workspace)))
      .rejects.toMatchObject({ message: "Library asset not found", statusCode: 409 });
  });

  it("rejects an Asset whose file type does not match its graph declaration", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await playerFixture();
    const data = await temporary("ohmygame-playable-publish-data-");
    const graph = createNodeGraphFixture();
    delete graph.assets.theme;
    graph.assets.background!.type = "video";
    for (const node of graph.nodes) node.assets = node.assets.filter((id) => id !== "theme");
    await writePlayableFixtureWorkspace(workspace, graph);
    const library = new AssetLibrary(data);
    await library.load();

    await expect(new ArtifactBuilder(library, player).buildInteractiveStory(project(workspace)))
      .rejects.toThrow('Asset "background" is not a compatible video asset.');
  });

  it("detects a modified Asset before a static directory is published", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await playerFixture();
    const data = await temporary("ohmygame-playable-publish-data-");
    const graph = createNodeGraphFixture();
    delete graph.assets.theme;
    for (const node of graph.nodes) node.assets = node.assets.filter((id) => id !== "theme");
    await writePlayableFixtureWorkspace(workspace, graph);
    const library = new AssetLibrary(data);
    await library.load();
    const files = await unzip(await new ArtifactBuilder(library, player).buildInteractiveStory(project(workspace)));
    const output = await temporary("ohmygame-playable-publish-output-");
    for (const [relative, contents] of files) {
      await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
      await writeFile(path.join(output, relative), contents);
    }
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    await writeFile(path.join(output, manifest.assets.background.path), "modified");

    await expect(validatePlayablePublishDirectory(output))
      .rejects.toThrow('Published Asset "background" does not match its declared size.');
  });

  it("rejects a definition whose compiled surfaces do not match its graph", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await playerFixture();
    const data = await temporary("ohmygame-playable-publish-data-");
    const graph = createNodeGraphFixture();
    delete graph.assets.theme;
    for (const node of graph.nodes) node.assets = node.assets.filter((id) => id !== "theme");
    await writePlayableFixtureWorkspace(workspace, graph);
    const library = new AssetLibrary(data);
    await library.load();
    const files = await unzip(await new ArtifactBuilder(library, player).buildInteractiveStory(project(workspace)));
    const output = await temporary("ohmygame-playable-publish-output-");
    for (const [relative, contents] of files) {
      await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
      await writeFile(path.join(output, relative), contents);
    }

    const definition = JSON.parse(files.get("playable.json")!.toString("utf8"));
    delete definition.compiled.nodes.menu;
    definition.graphSignature = createHash("sha256")
      .update(JSON.stringify({ graph: definition.graph, compiled: definition.compiled }))
      .digest("hex");
    const definitionBytes = Buffer.from(`${JSON.stringify(definition)}\n`);
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    manifest.graphSignature = definition.graphSignature;
    manifest.definition.integrity = `sha256-${createHash("sha256").update(definitionBytes).digest("base64")}`;
    await Promise.all([
      writeFile(path.join(output, "playable.json"), definitionBytes),
      writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    ]);

    await expect(validatePlayablePublishDirectory(output))
      .rejects.toThrow("Published Node definition does not match its manifest.");
  });

  it("rejects an incomplete Published Player build", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await temporary("ohmygame-playable-publish-player-");
    const data = await temporary("ohmygame-playable-publish-data-");
    const graph = createNodeGraphFixture();
    delete graph.assets.theme;
    for (const node of graph.nodes) node.assets = node.assets.filter((id) => id !== "theme");
    await writePlayableFixtureWorkspace(workspace, graph);
    await writeFile(path.join(player, "index.html"), "Incomplete Player");
    const library = new AssetLibrary(data);
    await library.load();

    await expect(new ArtifactBuilder(library, player).buildInteractiveStory({
      id: "playable-project",
      name: "Ash Club",
      type: "interactive-story",
      updatedAt: new Date(0).toISOString(),
      workspacePath: workspace,
      preview: { status: "stopped" },
    })).rejects.toThrow(
      "Published Player build is incomplete. Missing: playable-sandbox.html, assets/playable-sandbox.js.",
    );
  });
});

async function playerFixture(): Promise<string> {
  const player = await temporary("ohmygame-playable-publish-player-");
  await mkdir(path.join(player, "assets"));
  await Promise.all([
    writeFile(path.join(player, "index.html"), "Published Player"),
    writeFile(path.join(player, "playable-sandbox.html"), "Playable sandbox"),
    writeFile(path.join(player, "assets", "playable-sandbox.js"), "window.sandbox = true"),
  ]);
  return player;
}

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
