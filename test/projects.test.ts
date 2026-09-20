import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { ProjectManager } from "../src/daemon/projects.js";
import { readStoryCodebase } from "../src/daemon/story-codebase.js";
import { EDITOR_LAYOUT_SCHEMA } from "../src/shared/editor-layout-schema.js";
import { STORY_CODEBASE_SCHEMA } from "../src/shared/story-schema.js";
import { DEFAULT_SCENE_SURFACE_FILES } from "../src/shared/story.js";
import { createPlayableStoryDocument } from "./story-fixture.js";

describe("Web Game project codebase", () => {
  it("stores its runtime requirements in the project workspace", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Game", "web-game");

    const instructions = await readFile(path.join(project.workspacePath, "AGENTS.md"), "utf8");
    expect(instructions).toContain("complete Vite-based browser project");
    expect(instructions).toContain("scripts.dev");
    expect(instructions).toContain("responsive inside an iframe");
  });
});

describe("Interactive Drama project codebase", () => {
  it("creates an empty Interactive Drama project", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    const story = await manager.story(project.id);
    expect(story.chapters[0]).toMatchObject({ nodes: [], edges: [] });
    const stored = JSON.parse(await readFile(path.join(project.workspacePath, "story.json"), "utf8"));
    expect(stored.characters).toBeUndefined();
    expect(stored.overlays).toBeUndefined();
    expect(stored.interactions).toBeUndefined();
    expect(stored.playerViews).toBeUndefined();
    expect(stored.chapters[0]).toMatchObject({ nodes: [], edges: [] });
    expect(Check(STORY_CODEBASE_SCHEMA, stored)).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(project.workspacePath, "project.json"), "utf8"));
    expect(manifest).toEqual({
      version: 1,
      type: "interactive-drama",
      story: "story.json",
      storySchema: "schemas/story.schema.json",
      editorLayout: "editor/layout.json",
      editorLayoutSchema: "schemas/editor-layout.schema.json",
      editorDocs: "editor/README.md",
    });
    expect(JSON.parse(await readFile(path.join(project.workspacePath, manifest.storySchema), "utf8"))).toEqual(STORY_CODEBASE_SCHEMA);
    expect(JSON.parse(await readFile(path.join(project.workspacePath, manifest.editorLayoutSchema), "utf8"))).toEqual(EDITOR_LAYOUT_SCHEMA);
    expect(Check(EDITOR_LAYOUT_SCHEMA, story.editorLayout)).toBe(true);
    expect(Check(EDITOR_LAYOUT_SCHEMA, { ...story.editorLayout, extensions: {} })).toBe(false);
    const instructions = await readFile(path.join(project.workspacePath, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Read only the contract files relevant to the change");
    expect(instructions).toContain("Parsing alone checks syntax, not the schema");
    expect(instructions).toContain("Do not search for or install a schema validator");
    const documentation = await readFile(path.join(project.workspacePath, "editor/README.md"), "utf8");
    expect(documentation).toContain("machine-readable definition");
    expect(documentation).toContain("JSON Schema cannot fully express");
  });

  it("preserves user-authored Interactive Drama instructions", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const instructions = path.join(project.workspacePath, "AGENTS.md");
    await writeFile(instructions, "# My project instructions\n");

    await manager.story(project.id);

    expect(await readFile(instructions, "utf8")).toBe("# My project instructions\n");
  });

  it("publishes the exact persisted node field names in the Story schema", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const story = JSON.parse(await readFile(path.join(project.workspacePath, "story.json"), "utf8"));
    story.chapters[0].nodes = [
      { id: "start", type: "start", data: {} },
      {
        id: "open-ui",
        type: "open-ui",
        data: {
          title: "Title",
          content: { title: "Title", buttons: [{ id: "start", label: "Start", action: "enter-game" }] },
          presentation: {
            media: { mode: "none" },
            surface: { source: { html: "nodes/open-ui/index.html", css: "nodes/open-ui/style.css", javascript: "nodes/open-ui/script.js" } },
          },
        },
      },
    ];
    expect(Check(STORY_CODEBASE_SCHEMA, story)).toBe(true);

    const invalidStart = structuredClone(story);
    invalidStart.chapters[0].nodes[0].data.title = "Start";
    expect(Check(STORY_CODEBASE_SCHEMA, invalidStart)).toBe(false);

    const invalidEditorMetadata = structuredClone(story);
    invalidEditorMetadata.chapters[0].nodes[0].editor = { kind: "custom" };
    expect(Check(STORY_CODEBASE_SCHEMA, invalidEditorMetadata)).toBe(false);

    const invalidPresentation = structuredClone(story);
    invalidPresentation.chapters[0].nodes[1].data.presentation.media = { strategy: "none" };
    invalidPresentation.chapters[0].nodes[1].data.presentation.surface.source.js = invalidPresentation.chapters[0].nodes[1].data.presentation.surface.source.javascript;
    delete invalidPresentation.chapters[0].nodes[1].data.presentation.surface.source.javascript;
    expect(Check(STORY_CODEBASE_SCHEMA, invalidPresentation)).toBe(false);

    const invalidContent = structuredClone(story);
    invalidContent.chapters[0].nodes[1].data.content = { actions: [{ id: "start", label: "Start", type: "continue" }] };
    expect(Check(STORY_CODEBASE_SCHEMA, invalidContent)).toBe(false);

    const invalidOpenUiMedia = structuredClone(story);
    invalidOpenUiMedia.chapters[0].nodes[1].data.presentation.media = {
      mode: "own",
      items: [
        { id: "first", type: "image", source: { type: "library", assetId: "first" } },
        { id: "second", type: "image", source: { type: "library", assetId: "second" } },
      ],
    };
    expect(Check(STORY_CODEBASE_SCHEMA, invalidOpenUiMedia)).toBe(false);
  });

  it("rewrites a project manifest with undocumented fields", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const manifestPath = path.join(project.workspacePath, "project.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, editorPresentation: "editor/presentation.js" }));

    await manager.story(project.id);

    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);
  });

  it("documents the workspace boundary and minimal template path", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const instructions = await readFile(path.join(project.workspacePath, "AGENTS.md"), "utf8");

    expect(instructions).toContain("## Working boundary");
    expect(instructions).toContain("Do not inspect parent directories, other projects");
    expect(instructions).toContain("start -> open-ui -> scene -> choice -> ending-a / ending-b");
    expect(instructions).toContain("Use six runtime nodes and five edges");
    expect(instructions).toContain("Do not add variables, interactions, extra scenes, or media generation unless requested");
    expect(instructions).toContain("invoke an OhMyGame source parser");
  });

  it("stores node code outside story.json without overwriting authored source", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    const story = await manager.story(project.id);
    story.chapters[0]!.nodes.push({
      id: "platform", type: "scene", position: { x: 320, y: 180 },
      data: { title: "Platform", presentation: { media: { mode: "own", items: [{ id: "video", type: "video", source: { type: "library", assetId: "video" } }] }, surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) } } },
    });
    story.editorLayout.nodes.platform = { x: 320, y: 180 };
    await manager.setStory(project.id, story);
    const stored = JSON.parse(await readFile(path.join(project.workspacePath, "story.json"), "utf8"));
    expect(Check(STORY_CODEBASE_SCHEMA, stored)).toBe(true);
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
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
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
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const storyPath = path.join(project.workspacePath, "story.json");
    const stored = JSON.parse(await readFile(storyPath, "utf8"));
    stored.overlays = [];
    await writeFile(storyPath, JSON.stringify(stored));
    await expect(manager.story(project.id)).rejects.toThrow("unsupported story format");
  });

  it("requires the canonical editor layout instead of recovering layout from story data", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const stored = await readFile(path.join(project.workspacePath, "story.json"), "utf8");
    await rm(path.join(project.workspacePath, "editor/layout.json"));
    await expect(readStoryCodebase(project.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.story(project.id)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(project.workspacePath, "story.json"), "utf8")).toBe(stored);
  });

  it("rejects an editor layout with missing node positions", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.setStory(project.id, createPlayableStoryDocument());
    const layoutPath = path.join(project.workspacePath, "editor/layout.json");
    const layout = JSON.parse(await readFile(layoutPath, "utf8"));
    delete layout.nodes[Object.keys(layout.nodes)[0]!];
    await writeFile(layoutPath, JSON.stringify(layout));
    await expect(readStoryCodebase(project.workspacePath)).rejects.toThrow("node positions do not match story.json");
  });

  it("rejects an unsupported editor view with an accurate error", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.story(project.id);
    const layoutPath = path.join(project.workspacePath, "editor/layout.json");
    const layout = JSON.parse(await readFile(layoutPath, "utf8"));
    layout.view = "story";
    await writeFile(layoutPath, JSON.stringify(layout));

    expect(Check(EDITOR_LAYOUT_SCHEMA, layout)).toBe(false);
    await expect(manager.story(project.id)).rejects.toThrow("Invalid editor/layout.json");
  });

  it("removes every Open UI reference to a deleted Library asset", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Story", "interactive-drama");
    await manager.setStory(project.id, createPlayableStoryDocument());
    const story = await manager.story(project.id);
    const openUi = story.chapters[0]!.nodes.find((node) => node.type === "open-ui")!;
    if (openUi.type !== "open-ui") throw new Error("Open UI is missing");
    openUi.data.presentation.media = { mode: "own", items: [{ id: "background", type: "video", source: { type: "library", assetId: "shared-media" } }] };
    await manager.setStory(project.id, story);

    await manager.removeLibraryAssetReferences("shared-media");

    const updated = await manager.story(project.id);
    const updatedOpenUi = updated.chapters[0]!.nodes.find((node) => node.type === "open-ui")!;
    expect(updatedOpenUi.type === "open-ui" && updatedOpenUi.data.presentation.media).toEqual({ mode: "own", items: [] });
  });
});
