import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManager } from "../src/daemon/projects.js";
import { readStoryCodebase } from "../src/daemon/story-codebase.js";
import { DEFAULT_SCENE_SURFACE_FILES } from "../src/shared/story.js";

describe("Interactive Drama project codebase", () => {
  it("creates a canonical playable project", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "open-game-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    const story = await manager.story(project.id);
    expect(story.chapters[0]?.nodes.map((node) => node.type)).toEqual(["start", "project-state", "ending"]);
    expect(story.chapters[0]?.edges).toHaveLength(2);
    const stored = JSON.parse(await readFile(path.join(project.workspacePath, "story.json"), "utf8"));
    expect(stored.characters).toBeUndefined();
    expect(stored.overlays).toBeUndefined();
    expect(stored.interactions).toBeUndefined();
    expect(stored.playerViews).toBeUndefined();
  });

  it("stores node code outside story.json without overwriting authored source", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "open-game-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    const story = await manager.story(project.id);
    story.chapters[0]!.nodes.push({
      id: "platform", type: "scene", position: { x: 320, y: 180 },
      data: { title: "Platform", presentation: { media: { mode: "own", items: [{ id: "video", type: "video", source: { type: "library", assetId: "video" } }] }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } } },
    });
    story.editorLayout.nodes.platform = { x: 320, y: 180 };
    await manager.setStory(project.id, story);
    const stored = JSON.parse(await readFile(path.join(project.workspacePath, "story.json"), "utf8"));
    const scene = stored.chapters[0].nodes.find((node: { id: string }) => node.id === "platform");
    expect(scene.data.clips).toBeUndefined();
    expect(scene.data.events).toBeUndefined();
    expect(scene.data.presentation.media.items).toHaveLength(1);
    expect(scene.data.presentation.surface.files).toBeUndefined();
    const cssPath = path.join(project.workspacePath, scene.data.presentation.surface.source.css);
    await writeFile(cssPath, "#scene-root { color: gold; }");
    const reloaded = await manager.story(project.id);
    await manager.setStory(project.id, { ...reloaded, variables: [] });
    expect(await readFile(cssPath, "utf8")).toBe("#scene-root { color: gold; }");
  });

  it("removes source files owned by deleted nodes", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "open-game-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    const story = await manager.story(project.id);
    story.chapters[0]!.nodes.push({ id: "scene", type: "scene", position: { x: 0, y: 0 }, data: { title: "Scene", presentation: { media: { mode: "none" }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } } } });
    story.editorLayout.nodes.scene = { x: 0, y: 0 };
    await manager.setStory(project.id, story);
    const stored = JSON.parse(await readFile(path.join(project.workspacePath, "story.json"), "utf8"));
    const source = stored.chapters[0].nodes.find((node: { id: string }) => node.id === "scene").data.presentation.surface.source.javascript;
    const sourceDirectory = path.dirname(path.join(project.workspacePath, source));
    story.chapters[0]!.nodes = story.chapters[0]!.nodes.filter((node) => node.id !== "scene");
    delete story.editorLayout.nodes.scene;
    await manager.setStory(project.id, story);
    await expect(stat(path.join(project.workspacePath, source))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sourceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported legacy story formats", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "open-game-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const storyPath = path.join(project.workspacePath, "story.json");
    const stored = JSON.parse(await readFile(storyPath, "utf8"));
    stored.overlays = [];
    await writeFile(storyPath, JSON.stringify(stored));
    await expect(manager.story(project.id)).rejects.toThrow("Invalid story document");
  });

  it("requires the canonical editor layout instead of recovering layout from story data", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "open-game-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const stored = await readFile(path.join(project.workspacePath, "story.json"), "utf8");
    await rm(path.join(project.workspacePath, "editor-layout.json"));
    await expect(readStoryCodebase(project.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.story(project.id)).rejects.toThrow("Invalid story document");
    expect(await readFile(path.join(project.workspacePath, "story.json"), "utf8")).toBe(stored);
  });

  it("rejects an editor layout with missing node positions", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "open-game-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const layoutPath = path.join(project.workspacePath, "editor-layout.json");
    const layout = JSON.parse(await readFile(layoutPath, "utf8"));
    delete layout.nodes[Object.keys(layout.nodes).find((id) => id !== "open-ui")!];
    await writeFile(layoutPath, JSON.stringify(layout));
    await expect(readStoryCodebase(project.workspacePath)).rejects.toThrow("node positions do not match story.json");
  });

  it("removes every Open UI reference to a deleted Library asset", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "open-game-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    const story = await manager.story(project.id);
    story.player.backgroundAssetId = "shared-media";
    story.player.openUiVideoAssetId = "shared-media";
    await manager.setStory(project.id, story);

    await manager.removeLibraryAssetReferences("shared-media");

    const updated = await manager.story(project.id);
    expect(updated.player.backgroundAssetId).toBeUndefined();
    expect(updated.player.openUiVideoAssetId).toBeUndefined();
  });
});
