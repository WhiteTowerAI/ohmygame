import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { createNodeCodebase, readNodeCodebase } from "../src/daemon/playable-codebase.js";
import { exportPlayableProject } from "../src/daemon/playable-project-export.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Interactive Story project export", () => {
  it("packs the editable project with its Library assets and without local folders", async () => {
    const workspace = await temporaryDirectory();
    const library = new AssetLibrary(await temporaryDirectory());
    await library.load();
    const portrait = await library.add("Hero Portrait.png", Buffer.from("library portrait"));
    const theme = await library.add("theme.mp4", Buffer.from("library video"));
    const codebase = createStarterCodebaseWithScene("Story", { width: 1280, height: 720 });
    codebase.graph.assets = {
      portrait: { type: "image", source: { kind: "library", assetId: portrait.id } },
      "portrait-again": { type: "image", source: { kind: "library", assetId: portrait.id } },
      theme: { type: "video", source: { kind: "library", assetId: theme.id } },
      door: { type: "image", source: { kind: "workspace", path: "assets/door.png" } },
    };
    codebase.graph.nodes[0]!.assets = ["portrait", "portrait-again", "theme", "door"];
    await mkdir(path.join(workspace, "assets/library"), { recursive: true });
    await writeFile(path.join(workspace, "assets/door.png"), "door");
    await writeFile(path.join(workspace, "assets/library/Hero-Portrait.png"), "user file");
    await createNodeCodebase(workspace, codebase);
    const graphText = await readFile(path.join(workspace, "graph.json"), "utf8");
    for (const folder of [".data", ".ohmygame", ".git", "node_modules"]) {
      await mkdir(path.join(workspace, folder));
      await writeFile(path.join(workspace, folder, "local.txt"), "local");
    }

    const files = await unzip(await exportPlayableProject(workspace, library));

    expect(Object.keys(files).filter((file) => /^(\.|node_modules\/)/.test(file))).toEqual([]);
    expect(files["AGENTS.md"]).toBeDefined();
    expect(files["nodes/start/node.js"]).toBeDefined();
    expect(files["editor/layout.json"]).toBeDefined();
    expect(files["assets/door.png"]?.toString()).toBe("door");
    expect(files["assets/library/Hero-Portrait.png"]?.toString()).toBe("user file");
    expect(files["assets/library/Hero-Portrait-2.png"]?.toString()).toBe("library portrait");
    expect(files["assets/library/theme.mp4"]?.toString()).toBe("library video");
    expect(JSON.parse(files["graph.json"]!.toString()).assets).toEqual({
      portrait: { type: "image", source: { kind: "workspace", path: "assets/library/Hero-Portrait-2.png" } },
      "portrait-again": { type: "image", source: { kind: "workspace", path: "assets/library/Hero-Portrait-2.png" } },
      theme: { type: "video", source: { kind: "workspace", path: "assets/library/theme.mp4" } },
      door: { type: "image", source: { kind: "workspace", path: "assets/door.png" } },
    });
    expect(await readFile(path.join(workspace, "graph.json"), "utf8")).toBe(graphText);

    const opened = await temporaryDirectory();
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(opened, file)), { recursive: true });
      await writeFile(path.join(opened, file), content);
    }
    expect((await readNodeCodebase(opened)).graph.nodes.map((node) => node.id)).toEqual(["start"]);
  });

  it("keeps graph.json byte for byte when the project uses no Library assets", async () => {
    const workspace = await temporaryDirectory();
    const library = new AssetLibrary(await temporaryDirectory());
    await library.load();
    await createNodeCodebase(workspace, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));

    const files = await unzip(await exportPlayableProject(workspace, library));

    expect(files["graph.json"]?.toString()).toBe(await readFile(path.join(workspace, "graph.json"), "utf8"));
  });

  it("names a Library asset that is missing instead of exporting an incomplete project", async () => {
    const workspace = await temporaryDirectory();
    const library = new AssetLibrary(await temporaryDirectory());
    await library.load();
    const codebase = createStarterCodebaseWithScene("Story", { width: 1280, height: 720 });
    codebase.graph.assets = { portrait: { type: "image", source: { kind: "library", assetId: "gone" } } };
    await createNodeCodebase(workspace, codebase);

    await expect(exportPlayableProject(workspace, library)).rejects.toThrow('Asset "portrait" is missing from the Library.');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-export-"));
  temporaryRoots.push(directory);
  return directory;
}

function unzip(archive: Buffer): Promise<Record<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("ZIP could not be opened."));
        return;
      }
      const files: Record<string, Buffer> = {};
      zip.once("error", reject);
      zip.once("end", () => resolve(files));
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error("ZIP entry could not be read."));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("error", reject);
          stream.once("end", () => {
            files[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
