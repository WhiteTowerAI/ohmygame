import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ArtifactBuilder } from "../src/daemon/publish/archive.js";
import {
  createPlayableGraphFixture,
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

describe("Playable published Player", () => {
  it("packages the same compiled definition consumed by Playtest", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await temporary("ohmygame-playable-publish-player-");
    const data = await temporary("ohmygame-playable-publish-data-");
    const graph = createPlayableGraphFixture();
    delete graph.assets.theme;
    if (graph.shell) graph.shell.assets = [];
    await writePlayableFixtureWorkspace(workspace, graph);
    await mkdir(path.join(player, "assets"));
    await Promise.all([
      writeFile(path.join(player, "index.html"), "Published Playable Player"),
      writeFile(path.join(player, "playable-sandbox.html"), "Playable sandbox"),
      writeFile(path.join(player, "assets", "playable-sandbox.js"), "window.sandbox = true"),
      writeFile(path.join(player, "player.js"), "window.player = true"),
    ]);
    const library = new AssetLibrary(data);
    await library.load();

    const archive = await new ArtifactBuilder(
      library,
      player,
    ).buildInteractiveDrama({
      id: "playable-project",
      name: "Ash Club",
      type: "interactive-drama",
      updatedAt: new Date(0).toISOString(),
      workspacePath: workspace,
      preview: { status: "stopped" },
    });
    const files = await unzip(archive);
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    const definition = JSON.parse(files.get("playable.json")!.toString("utf8"));

    expect(manifest).toEqual({
      version: 1,
      runtime: "playable-nodes",
      playable: "playable.json",
      scope: "published:playable-project",
      assets: { background: "./assets/media/background.webp" },
    });
    expect(definition).toMatchObject({
      version: 1,
      graph: { title: "Ash Club" },
      compiled: { version: 1 },
    });
    expect(files.get("assets/media/background.webp")?.toString()).toBe(
      "fixture",
    );
    expect(files.get("playable-sandbox.html")?.toString()).toBe(
      "Playable sandbox",
    );
    expect(files.get("assets/playable-sandbox.js")?.toString()).toBe(
      "window.sandbox = true",
    );
    expect(files.has("story.json")).toBe(false);
  });

  it("rejects an incomplete Playable Player build", async () => {
    const workspace = await temporary("ohmygame-playable-publish-workspace-");
    const player = await temporary("ohmygame-playable-publish-player-");
    const data = await temporary("ohmygame-playable-publish-data-");
    const graph = createPlayableGraphFixture();
    delete graph.assets.theme;
    if (graph.shell) graph.shell.assets = [];
    await writePlayableFixtureWorkspace(workspace, graph);
    await writeFile(path.join(player, "index.html"), "Incomplete Player");
    const library = new AssetLibrary(data);
    await library.load();

    await expect(new ArtifactBuilder(library, player).buildInteractiveDrama({
      id: "playable-project",
      name: "Ash Club",
      type: "interactive-drama",
      updatedAt: new Date(0).toISOString(),
      workspacePath: workspace,
      preview: { status: "stopped" },
    })).rejects.toThrow(
      "Playable Player build is incomplete. Missing: playable-sandbox.html, assets/playable-sandbox.js.",
    );
  });
});

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
