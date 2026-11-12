import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssetLibrary } from "../src/daemon/asset-library.js";

describe("AssetLibrary", () => {
  it("stores one global asset for a stable source and restores it", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-"));
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
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-"));
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
    const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), "ohmygame-library-")));
    await library.load();
    await expect(library.add("notes.txt", Buffer.from("notes"))).rejects.toThrow("supported media");
    const asset = await library.add("image.webp", Buffer.from("image"));
    await expect(library.rename(asset.id, "../outside")).rejects.toThrow("Invalid asset name");
  });

  it("rejects invalid stored metadata instead of hiding it as an empty Library", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-"));
    await mkdir(path.join(dataDirectory, "library"), { recursive: true });
    await writeFile(path.join(dataDirectory, "library", "assets.json"), JSON.stringify({ version: 1, assets: "invalid", sources: {} }));

    await expect(new AssetLibrary(dataDirectory).load()).rejects.toThrow("Invalid Library metadata");
  });

  it("reads a record saved without an origin as unknown, without guessing from its sources", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-origin-"));
    const directory = path.join(dataDirectory, "library");
    await mkdir(directory, { recursive: true });
    const base = { size: 3, mediaType: "image", contentType: "image/png", createdAt: "2026-08-24T12:00:00Z" };
    await writeFile(path.join(directory, "assets.json"), JSON.stringify({
      version: 1,
      assets: [
        { ...base, id: "old", name: "old.png" },
        { ...base, id: "chat", name: "screenshot.png", origin: "uploaded" },
        { ...base, id: "project", name: "sprite.png" },
      ],
      sources: { "tool:run:old.png": "old", "conversation-image:image/png:hash": "chat", "project:project:sprite.png": "project" },
    }));
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    // Version 1 showed it; version 2 keeps only what the person chose.
    expect(library.get("old")).toMatchObject({ origin: "unknown", purpose: "asset", saved: false });
    // Chat attachments were never shown in the Library; the upgrade to version 2 says so.
    expect(library.get("chat")).toMatchObject({ origin: "uploaded", purpose: "reference", saved: false });
    // A project's file isn't saved to the Library until the person saves it.
    expect(library.get("project")).toMatchObject({ origin: "unknown", saved: false });
  });

  it("shows in the Library only what is added with `saved`, and takes it out again", async () => {
    const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), "ohmygame-library-saved-")));
    await library.load();
    const generated = await library.add("hero.png", Buffer.from("image"), { origin: "generated" });
    const uploaded = await library.add("logo.png", Buffer.from("logo"), { origin: "uploaded", saved: true });
    expect(generated.saved).toBe(false);
    expect(uploaded.saved).toBe(true);

    await expect(library.unsave(uploaded.id)).resolves.toMatchObject({ saved: false });
    expect(library.get(uploaded.id)).toMatchObject({ saved: false });
    // Taken out of the Library, the file is still stored for the projects using it.
    expect(await readFile((await library.content(uploaded.id)).absolutePath, "utf8")).toBe("logo");
    await expect(library.unsave("missing")).rejects.toThrow("not found");
  });

  it("upgrades a version 1 store, keeping in the Library only what the person chose", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-v1-"));
    const directory = path.join(dataDirectory, "library");
    await mkdir(directory, { recursive: true });
    const base = { size: 3, mediaType: "image", contentType: "image/png", createdAt: "2026-08-24T12:00:00Z", purpose: "asset" };
    await writeFile(path.join(directory, "assets.json"), JSON.stringify({
      version: 1,
      assets: [
        { ...base, id: "generated", name: "hero.png", origin: "generated", saved: true },
        { ...base, id: "canvas-upload", name: "photo.png", origin: "uploaded", saved: true },
        { ...base, id: "chat", name: "screenshot.png", origin: "uploaded", purpose: "reference", saved: true },
        { ...base, id: "saved-file", name: "sprite.png", origin: "workspace", saved: true },
        { ...base, id: "copy", name: "copy.png", origin: "workspace", saved: false },
        { ...base, id: "recording", name: "Game 2026-11-02 19-37-32.mp4", mediaType: "video", contentType: "video/mp4", origin: "uploaded", saved: true },
        { ...base, id: "builtin", name: "night-train.mp4", mediaType: "video", contentType: "video/mp4", origin: "builtin", saved: true },
      ],
      sources: {},
    }));
    const library = new AssetLibrary(dataDirectory);
    await library.load();

    expect(Object.fromEntries(library.list().map((asset) => [asset.id, asset.saved]))).toEqual({
      generated: false,
      "canvas-upload": false,
      chat: false,
      "saved-file": true,
      copy: false,
      recording: true,
      builtin: true,
    });
    // Out of the Library, still stored for whatever uses it.
    expect(library.get("generated")).toBeDefined();
    expect(JSON.parse(await readFile(path.join(directory, "assets.json"), "utf8"))).toMatchObject({ version: 2 });

    // Upgraded once: a later load reads version 2 as stored.
    await library.save("generated");
    const reloaded = new AssetLibrary(dataDirectory);
    await reloaded.load();
    expect(reloaded.get("generated")).toMatchObject({ saved: true });
    expect(reloaded.get("recording")).toMatchObject({ saved: true });
  });

  it("leaves a store from a newer version untouched", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-newer-"));
    const directory = path.join(dataDirectory, "library");
    await mkdir(directory, { recursive: true });
    const stored = JSON.stringify({ version: 3, assets: [], sources: {} });
    await writeFile(path.join(directory, "assets.json"), stored);

    await expect(new AssetLibrary(dataDirectory).load()).rejects.toThrow("Invalid Library metadata");
    expect(await readFile(path.join(directory, "assets.json"), "utf8")).toBe(stored);
  });

  it("keeps a reference promoted to an asset when the same input is submitted again", async () => {
    const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), "ohmygame-library-promote-")));
    await library.load();
    const reference = await library.add("reference.png", Buffer.from("image"), { origin: "uploaded", purpose: "reference", sourceKey: "conversation-image:image/png:hash" });
    await library.save(reference.id);
    const reused = await library.add("reference.png", Buffer.from("image"), { origin: "uploaded", purpose: "reference", sourceKey: "conversation-image:image/png:hash" });
    expect(reused).toMatchObject({ id: reference.id, origin: "uploaded", purpose: "asset" });
    expect(library.list()).toHaveLength(1);
  });
});
