import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManager } from "../src/daemon/projects.js";
import { listWorkspaceFiles } from "../src/daemon/workspace.js";

describe("ProjectManager", () => {
  it("migrates an existing workspace without metadata", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const id = "1df6a50b-78e2-46b2-a96a-c97072d935f4";
    const workspace = path.join(dataDirectory, "projects", id, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "keep.txt"), "user data");
    const manager = new ProjectManager(dataDirectory);

    await manager.load();

    expect(manager.get(id)).toMatchObject({ id, name: "Untitled project", type: "web-game", workspacePath: workspace });
    expect(await readFile(path.join(workspace, "keep.txt"), "utf8")).toBe("user data");
    expect(JSON.parse(await readFile(path.join(dataDirectory, "projects", id, "project.json"), "utf8"))).toMatchObject({ version: 1, id, type: "web-game" });
  });

  it("does not overwrite invalid project metadata", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const id = "1df6a50b-78e2-46b2-a96a-c97072d935f4";
    const projectDirectory = path.join(dataDirectory, "projects", id);
    await mkdir(path.join(projectDirectory, "workspace"), { recursive: true });
    await writeFile(path.join(projectDirectory, "project.json"), "not json");
    const manager = new ProjectManager(dataDirectory);

    await expect(manager.load()).rejects.toThrow();
    expect(await readFile(path.join(projectDirectory, "project.json"), "utf8")).toBe("not json");
  });

  it("creates an empty workspace", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Blank");
    expect(project.preview).toEqual({ status: "waiting" });
    expect(await readdir(project.workspacePath)).toEqual([]);
  });

  it("persists project types and preserves them when duplicating", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Story", "interactive-drama");

    expect(project.type).toBe("interactive-drama");
    expect((await manager.duplicate(project.id)).type).toBe("interactive-drama");

    const restored = new ProjectManager(dataDirectory);
    await restored.load();
    expect(restored.get(project.id)?.type).toBe("interactive-drama");
  });

  it("supports Web Game and Godot project types", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);

    expect((await manager.create("Web", "web-game")).type).toBe("web-game");
    expect((await manager.create("Godot", "godot-game")).type).toBe("godot-game");
  });

  it("creates and atomically updates an Interactive Drama story", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Story", "interactive-drama");

    const story = await manager.story(project.id);
    expect(story).toMatchObject({
      version: 8,
      characters: [],
      chapters: [{ title: "Untitled", nodes: [{ type: "start" }], edges: [] }],
    });

    story.chapters[0]!.title = "The Stopover";
    await manager.setStory(project.id, story);

    expect(JSON.parse(await readFile(path.join(project.workspacePath, "story.json"), "utf8")))
      .toMatchObject({ chapters: [{ title: "The Stopover" }] });
    expect((await manager.story(project.id)).chapters[0]?.title).toBe("The Stopover");
  });

  it("tracks and clears a Player menu background Library reference", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Story", "interactive-drama");
    const story = await manager.story(project.id);
    story.player = {
      title: "Night Train",
      backgroundAssetId: "menu-image",
      theme: { accentColor: "#ffffff", textColor: "#ffffff", font: "sans" },
      videoFit: "contain",
      choicePosition: "bottom",
    };
    await manager.setStory(project.id, story);

    expect((await manager.referencesLibraryAsset("menu-image")).map(({ id }) => id)).toEqual([project.id]);
    await manager.removeLibraryAssetReferences("menu-image");
    expect((await manager.story(project.id)).player?.backgroundAssetId).toBeUndefined();
  });

  it("tracks and clears Overlay image Library references", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Story", "interactive-drama");
    const story = await manager.story(project.id);
    story.overlays = [{ id: "hud", name: "HUD", placement: "top-left", components: [{ id: "portrait", type: "image", assetId: "portrait-image", alt: "Portrait" }] }];
    await manager.setStory(project.id, story);

    expect((await manager.referencesLibraryAsset("portrait-image")).map(({ id }) => id)).toEqual([project.id]);
    await manager.removeLibraryAssetReferences("portrait-image");
    expect((await manager.story(project.id)).overlays?.[0]?.components).toEqual([]);
  });

  it("tracks and clears character avatar Library references", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Story", "interactive-drama");
    const story = await manager.story(project.id);
    story.characters = [{ id: "ari", name: "Ari", avatarAssetId: "ari-avatar" }];
    await manager.setStory(project.id, story);

    expect((await manager.referencesLibraryAsset("ari-avatar")).map(({ id }) => id)).toEqual([project.id]);
    await manager.removeLibraryAssetReferences("ari-avatar");
    expect((await manager.story(project.id)).characters).toEqual([{ id: "ari", name: "Ari" }]);
  });

  it("loads version 3 Interactive Drama stories through the current migration", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Story", "interactive-drama");
    const current = await manager.story(project.id);
    const legacy = { ...current, version: 3 };
    await writeFile(path.join(project.workspacePath, "story.json"), JSON.stringify(legacy));

    expect((await manager.story(project.id)).version).toBe(8);
  });

  it("rejects stories for Web Game projects and invalid story documents", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const webGame = await manager.create("Game");
    const story = await manager.create("Story", "interactive-drama");

    await expect(manager.story(webGame.id)).rejects.toThrow("Interactive Drama");
    await expect(manager.setStory(story.id, { version: 8, chapters: [] })).rejects.toThrow("Invalid story document");
  });

  it("writes generated assets only under the project workspace", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Game");

    await expect(manager.addGeneratedAsset(project.id, "image-run.webp", Buffer.from("image"), { prompt: "A forest shrine" }))
      .resolves.toBe("assets/generated/image-run.webp");
    expect(await readFile(path.join(project.workspacePath, "assets", "generated", "image-run.webp"), "utf8")).toBe("image");
    expect(await manager.generatedAssetPrompt(project.id, "assets/generated/image-run.webp")).toBe("A forest shrine");
    await expect(manager.addGeneratedAsset(project.id, "../outside.webp", Buffer.from("image"))).rejects.toThrow("Invalid asset name");
  });

  it("preserves prompts when generated assets finish concurrently", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Game");

    await Promise.all([
      manager.addGeneratedAsset(project.id, "first.webp", Buffer.from("first"), { prompt: "First prompt" }),
      manager.addGeneratedAsset(project.id, "second.webp", Buffer.from("second"), { prompt: "Second prompt" }),
    ]);

    expect(await manager.generatedAssetPrompt(project.id, "assets/generated/first.webp")).toBe("First prompt");
    expect(await manager.generatedAssetPrompt(project.id, "assets/generated/second.webp")).toBe("Second prompt");
  });

  it("renames and deletes assets with their metadata and previews", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Game");
    await manager.addGeneratedAsset(project.id, "model-old.glb", Buffer.from("model"), {
      prompt: "A forest shrine",
      preview: { bytes: Buffer.from("preview"), extension: "png" },
    });

    await expect(manager.renameAsset(project.id, "assets/generated/model-old.glb", "forest shrine"))
      .resolves.toBe("assets/generated/forest shrine.glb");
    expect(await listWorkspaceFiles(project.workspacePath)).toContainEqual(expect.objectContaining({
      path: "assets/generated/forest shrine.glb",
      prompt: "A forest shrine",
      previewPath: ".data/asset-previews/model-old.png",
    }));
    await expect(access(path.join(project.workspacePath, "assets", "generated", "model-old.glb"))).rejects.toThrow();
    await expect(manager.renameAsset(project.id, "assets/generated/forest shrine.glb", "../outside"))
      .rejects.toThrow("Invalid asset name");

    await manager.deleteAsset(project.id, "assets/generated/forest shrine.glb");
    expect(await listWorkspaceFiles(project.workspacePath)).not.toContainEqual(expect.objectContaining({ mediaType: "model" }));
    await expect(access(path.join(project.workspacePath, ".data", "asset-previews", "model-old.png"))).rejects.toThrow();
  });

  it("stores one derived cover outside the workspace", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Game");
    const cover = Buffer.from("cover");

    expect(await manager.cover(project.id)).toBeUndefined();
    await manager.setCover(project.id, cover);

    expect(await manager.cover(project.id)).toEqual(cover);
    expect(await readFile(path.join(dataDirectory, "projects", project.id, "cover.webp"))).toEqual(cover);
    expect(await readdir(project.workspacePath)).toEqual([]);
  });

  it("rejects generated asset directories that are symbolic links", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const outside = await mkdtemp(path.join(tmpdir(), "open-game-outside-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Game");
    await mkdir(path.join(project.workspacePath, "assets"));
    await symlink(outside, path.join(project.workspacePath, "assets", "generated"));

    await expect(manager.addGeneratedAsset(project.id, "image.webp", Buffer.from("image")))
      .rejects.toThrow("Unsafe generated asset path");
    expect(await readdir(outside)).toEqual([]);
  });

  it("lists its projects", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const first = await manager.create("First");
    const second = await manager.create("Second");

    expect(manager.list()).toEqual([second, first]);
  });

  it("renames, duplicates, and deletes a project", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("First");
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>First</h1>");
    await manager.setCover(project.id, Buffer.from("cover"));
    await mkdir(path.join(project.workspacePath, "node_modules", "dependency"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "node_modules", "dependency", "index.js"), "generated");

    await expect(manager.rename(project.id, "Renamed")).resolves.toMatchObject({ name: "Renamed" });
    const duplicate = await manager.duplicate(project.id);

    expect(duplicate).toMatchObject({ name: "Renamed copy" });
    expect(duplicate.publication).toBeUndefined();
    expect(await readFile(path.join(duplicate.workspacePath, "index.html"), "utf8")).toBe("<h1>First</h1>");
    expect(await manager.cover(duplicate.id)).toEqual(Buffer.from("cover"));
    await expect(readdir(path.join(duplicate.workspacePath, "node_modules"))).rejects.toThrow();
    await expect(manager.delete(project.id)).resolves.toMatchObject({ id: project.id });
    expect(manager.get(project.id)).toBeUndefined();
  });

  it("renames a project only while its expected name is current", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create();

    await expect(manager.renameIfCurrent(project.id, "Untitled project", "Platform World"))
      .resolves.toMatchObject({ name: "Platform World" });
    await expect(manager.renameIfCurrent(project.id, "Untitled project", "Other name"))
      .resolves.toBeUndefined();

    const restored = new ProjectManager(dataDirectory);
    await restored.load();
    expect(restored.get(project.id)?.name).toBe("Platform World");
  });

  it("restores runnable and non-runnable workspaces with distinct preview states", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const runnable = await manager.create("Runnable");
    const waiting = await manager.create("Waiting");
    await writeFile(path.join(runnable.workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));

    const restored = new ProjectManager(dataDirectory);
    await restored.load();

    expect(restored.get(runnable.id)?.preview.status).toBe("stopped");
    expect(restored.get(waiting.id)?.preview.status).toBe("waiting");
  });
});
