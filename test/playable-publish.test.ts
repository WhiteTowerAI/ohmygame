import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ArtifactBuilder, validatePlayablePublishDirectory } from "../src/daemon/publish/archive.js";
import { isPublishedNodeManifest } from "../src/shared/playable-publish.js";
import {
  createNodeGraphFixture,
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

describe("Published Player", () => {
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
