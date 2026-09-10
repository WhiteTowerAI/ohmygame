import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssetLibrary } from "../src/daemon/asset-library.js";

describe("AssetLibrary", () => {
  it("stores one global asset for a stable source and restores it", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-library-"));
    const library = new AssetLibrary(dataDirectory);
    await library.load();

    const [first, repeated] = await Promise.all([
      library.add("opening.mp4", Buffer.from("video"), { prompt: "Opening shot", sourceKey: "tool:run:file", duration: 6.5 }),
      library.add("opening.mp4", Buffer.from("different"), { sourceKey: "tool:run:file" }),
    ]);

    expect(repeated).toEqual(first);
    expect(library.list()).toEqual([first]);
    expect(await readFile((await library.content(first.id)).absolutePath, "utf8")).toBe("video");

    const restored = new AssetLibrary(dataDirectory);
    await restored.load();
    expect(restored.list()).toEqual([first]);
  });

  it("renames metadata without moving content and deletes the asset", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-library-"));
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const asset = await library.add("model.glb", Buffer.from("model"));
    const contentPath = (await library.content(asset.id)).absolutePath;

    await expect(library.rename(asset.id, "Character")).resolves.toMatchObject({ name: "Character.glb" });
    expect((await library.content(asset.id)).absolutePath).toBe(contentPath);
    await library.delete(asset.id);
    expect(library.list()).toEqual([]);
    await expect(library.content(asset.id)).rejects.toThrow("not found");
  });

  it("rejects unsupported files and invalid names", async () => {
    const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), "open-game-library-")));
    await library.load();
    await expect(library.add("notes.txt", Buffer.from("notes"))).rejects.toThrow("supported media");
    const asset = await library.add("image.webp", Buffer.from("image"));
    await expect(library.rename(asset.id, "../outside")).rejects.toThrow("Invalid asset name");
  });

  it("rejects invalid stored metadata instead of hiding it as an empty Library", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-library-"));
    await mkdir(path.join(dataDirectory, "library"), { recursive: true });
    await writeFile(path.join(dataDirectory, "library", "assets.json"), JSON.stringify({ version: 1, assets: "invalid", sources: {} }));

    await expect(new AssetLibrary(dataDirectory).load()).rejects.toThrow("Invalid Library metadata");
  });
});
