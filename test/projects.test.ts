import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManager, projectFolderType } from "../src/daemon/projects.js";

describe("Web Game project codebase", () => {
  it("persists name ownership and leaves legacy projects unchanged", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-names-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create(undefined, "general");
      const manual = await manager.create("My title", "general");
      expect(project.nameSource).toBe("default");
      expect(manual.nameSource).toBe("manual");
      expect(await manager.nameAutomatically(manual.id, "AI title")).toBeUndefined();
      const updatedAt = project.updatedAt;
      expect(await manager.nameAutomatically(project.id, "Moon Garden")).toMatchObject({ nameSource: "ai", updatedAt });
      await manager.touch(project.id);
      expect(await manager.nameAutomatically(project.id, "Another title")).toBeUndefined();
      expect((await manager.duplicate(project.id)).nameSource).toBe("manual");
      const metadataPath = path.join(directory, "projects", manual.id, "project.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      delete metadata.nameSource;
      await writeFile(metadataPath, JSON.stringify(metadata));
      const restored = new ProjectManager(directory);
      await restored.load();
      expect(restored.get(project.id)).toMatchObject({ name: "Moon Garden", nameSource: "ai" });
      expect(restored.get(manual.id)?.nameSource).toBeUndefined();
      expect(await restored.nameAutomatically(manual.id, "Changed legacy title")).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("makes new projects in the chosen project location, each in its own folder", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-location-"));
    const location = await mkdtemp(path.join(tmpdir(), "ohmygame-project-location-target-"));
    try {
      const manager = new ProjectManager(directory);
      await manager.load();
      await expect(manager.setLocation("relative/folder")).rejects.toThrow("absolute path");
      await expect(manager.setLocation(path.join(location, "missing"))).rejects.toThrow("not an available folder");
      await expect(manager.setLocation(path.join(directory, "projects"))).rejects.toThrow("project storage");
      await manager.setLocation(location);
      const first = await manager.create("Moon/Garden", "general");
      const second = await manager.create("Moon/Garden", "general");
      const real = (await import("node:fs/promises")).realpath;
      expect(first.workspacePath).toBe(path.join(await real(location), "Moon-Garden"));
      expect(second.workspacePath).toBe(path.join(await real(location), "Moon-Garden 2"));
      const restored = new ProjectManager(directory);
      await restored.load();
      expect(restored.location).toBe(await real(location));
      await restored.setLocation(undefined);
      const stored = await restored.create("Inside", "general");
      expect(stored.workspacePath.startsWith(path.join(directory, "projects"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(location, { recursive: true, force: true });
    }
  });
  it("checks name ownership inside queued writes and never recreates a deleted project", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-name-races-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create(undefined, "general");
      await Promise.all([manager.rename(project.id, "My title"), manager.nameAutomatically(project.id, "Late AI title"), manager.touch(project.id)]);
      expect(project).toMatchObject({ name: "My title", nameSource: "manual" });
      const removed = await manager.create(undefined, "general");
      await Promise.all([manager.delete(removed.id), manager.nameAutomatically(removed.id, "Late AI title")]);
      expect(await readdir(path.join(directory, "projects"))).not.toContain(removed.id);
      const restored = new ProjectManager(directory);
      await restored.load();
      expect(restored.get(project.id)).toMatchObject({ name: "My title", nameSource: "manual" });
      expect(restored.get(removed.id)).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps an engine-independent General Game workspace through reload and duplication", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-general-projects-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Native game", "general");
    expect(await readdir(project.workspacePath)).toEqual(["ohmygame.json"]);
    await writeFile(path.join(project.workspacePath, "project.godot"), "config_version=5\n");

    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({ type: "general", preview: { status: "waiting" } });
    const copy = await restored.duplicate(project.id);
    expect(copy.type).toBe("general");
    expect((await readdir(copy.workspacePath)).sort()).toEqual([".ohmygame", "ohmygame.json", "project.godot"]);
  });
  it("binds copied Canvas generation history to the duplicate", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-duplicate-history-")));
    const project = await manager.create("Sky garden", "asset-canvas");
    const canvas = path.join(project.workspacePath, "canvas");
    await mkdir(canvas);
    const history = ["succeeded", "failed"].map((status, index) => ({
      id: `historical-${index}`,
      toolId: "generate-image",
      createdAt: "2026-10-07T12:00:00.000Z",
      status,
      title: "Original concept",
      context: { projectId: project.id, boardId: "design", nodeId: "concept" },
      // Retry inputs can hold inline images larger than a board file may be.
      input: { prompt: "Original prompt", images: status === "failed" ? [`data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}`] : [] },
    }));
    await writeFile(path.join(canvas, "jobs.json"), JSON.stringify(history));
    const copy = await manager.duplicate(project.id);
    expect(JSON.parse(await readFile(path.join(copy.workspacePath, "canvas/jobs.json"), "utf8"))).toEqual(history.map((job) => ({ ...job, context: { ...job.context, projectId: copy.id } })));
    expect(JSON.parse(await readFile(path.join(canvas, "jobs.json"), "utf8"))).toEqual(history);
  });
  it.each([
    ["invalid JSON", "not JSON"],
    ["no job list", "{}\n"],
    ["entries without a project", '[\n  null,\n  "job"\n]\n'],
  ])("duplicates a project whose Canvas generation history has %s", async (_case, history) => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-duplicate-history-")));
    const project = await manager.create("Sky garden", "asset-canvas");
    await mkdir(path.join(project.workspacePath, "canvas"));
    await writeFile(path.join(project.workspacePath, "canvas/jobs.json"), history);
    const copy = await manager.duplicate(project.id);
    expect(await readFile(path.join(copy.workspacePath, "canvas/jobs.json"), "utf8")).toBe(history);
  });
  it.each(["electron .", "electron-forge start", "electron-vite dev", "tauri dev", "godot --editor", "NODE_ENV=dev electron .", "npx electron .", "npx --yes electron .", "cross-env NODE_ENV=dev electron .", "env NODE_OPTIONS='--trace-warnings --no-warnings' electron .", "./node_modules/.bin/electron .", "vite && electron .", "vite build", "bun format"])("does not treat a non-server dev script as a Web preview server: %s", async (dev) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-native-project-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Native", "general");
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev } }));
    expect(await manager.refreshPreviewReadiness(project.id)).toMatchObject({ webPreviewEnabled: true, preview: { status: "waiting" } });
    // Projects created before the switch existed must also remain opt-in.
    const metadataPath = path.join(directory, "projects", project.id, "project.json");
    const { settings, ...record } = JSON.parse(await readFile(metadataPath, "utf8"));
    delete settings.webPreviewEnabled;
    await writeFile(metadataPath, JSON.stringify({ ...settings, ...record, version: 1 }));
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
  });

  it.each(["vite --host 127.0.0.1", "vite --config godot/vite.config.ts", "vite --open /tauri/index.html", "vite --config build/vite.config.ts", "vite --define 'godot | tauri'", "NODE_ENV=dev pnpm exec vite"])("keeps Web servers runnable when arguments contain task or engine names: %s", async (dev) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-server-project-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create("Browser", "general");
      await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev } }));
      expect(await manager.refreshPreviewReadiness(project.id)).toMatchObject({ preview: { status: "stopped" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enables preview for new General projects and preserves an explicit opt-out through reload and duplication", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-preview-opt-in-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Browser output", "general");
    const settings = { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit" as const, webPreviewEnabled: true };
    expect(project).toMatchObject({ webPreviewEnabled: true, preview: { status: "waiting" } });
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    expect(await manager.refreshPreviewReadiness(project.id)).toMatchObject({ preview: { status: "stopped" } });
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({ webPreviewEnabled: true, preview: { status: "stopped" } });
    expect(await restored.duplicate(project.id)).toMatchObject({ webPreviewEnabled: true, preview: { status: "stopped" } });
    await manager.setRunSettings(project.id, { ...settings, webPreviewEnabled: false });
    expect(await manager.duplicate(project.id)).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
    const disabled = new ProjectManager(directory);
    await disabled.load();
    expect(disabled.get(project.id)).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
  });

  it("allows disabling preview when its configured directory has been removed", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-preview-disable-")));
    const project = await manager.create("Browser", "general");
    const client = path.join(project.workspacePath, "client");
    await mkdir(client);
    await writeFile(path.join(client, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const settings = { startupDirectory: "client", startupScript: "dev", previewPath: "/", previewViewport: "fit" as const, webPreviewEnabled: true };
    await manager.setRunSettings(project.id, settings);
    await rm(client, { recursive: true });
    expect(await manager.setRunSettings(project.id, { ...settings, webPreviewEnabled: false })).toMatchObject({ startupDirectory: "client", webPreviewEnabled: false, preview: { status: "waiting" } });
  });

  it("starts with only the file naming its type; the platform contract lives in the system prompt", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Game", "web-game");

    expect(await readdir(project.workspacePath)).toEqual(["ohmygame.json"]);
  });

  it("keeps project media defaults through unrelated saves and removes cleared overrides on disk", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-projects-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Canvas", "asset-canvas");
    await manager.setMediaModelDefaults(project.id, { image: { provider: "studio", id: "image" }, "3d": { provider: "meshy", id: "meshy-t2" } });
    await Promise.all([manager.rename(project.id, "New name"), manager.setMediaModelDefaults(project.id, { image: { provider: "studio", id: "latest" } })]);
    expect(project.name).toBe("New name");
    expect(project.mediaModelDefaults).toEqual({ image: { provider: "studio", id: "latest" } });
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)?.mediaModelDefaults).toEqual(project.mediaModelDefaults);
    await restored.setMediaModelDefaults(project.id, {});
    const cleared = new ProjectManager(directory);
    await cleared.load();
    expect(cleared.get(project.id)?.mediaModelDefaults).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8"))).not.toHaveProperty("mediaModelDefaults");
  });

  it.each([
    ["web-game", "mobile"], ["general", "mobile"],
    ["web-game", "mobile-landscape"], ["general", "mobile-landscape"],
  ] as const)("persists a runnable startup directory for %s with %s below the workspace root", async (type, previewViewport) => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Game", type);
    const gameDirectory = path.join(project.workspacePath, "apps", "game");
    await mkdir(gameDirectory, { recursive: true });
    await writeFile(path.join(gameDirectory, "package.json"), JSON.stringify({ scripts: { dev: "vite", start: "vite" } }));

    const updated = await manager.setRunSettings(project.id, {
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport,
      ...(type === "general" ? { webPreviewEnabled: true } : {}),
    });
    expect(updated).toMatchObject({
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport,
    });
    expect(updated.preview).toEqual({ status: type === "general" ? "stopped" : "waiting" });
    // The settings are the folder's; project.json keeps only this computer's record.
    expect(JSON.parse(await readFile(path.join(dataDirectory, "projects", project.id, "project.json"), "utf8"))).not.toHaveProperty("settings");
    expect(JSON.parse(await readFile(path.join(project.workspacePath, ".ohmygame/settings.json"), "utf8"))).toMatchObject({
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport,
    });

    const restored = new ProjectManager(dataDirectory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport,
      preview: { status: "stopped" },
    });
    expect(await restored.duplicate(project.id)).toMatchObject({ previewViewport });
    await expect(manager.setStartupDirectory(project.id, "../outside")).rejects.toThrow("Startup directory must be a relative path");
    await expect(manager.setStartupDirectory(project.id, "missing")).rejects.toThrow("Startup directory does not exist");
  });

  it("moves OhMyGame's files from an older layout into .ohmygame/ on load, keeping what is there", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-layout-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create("Old layout", "general");
      const workspace = project.workspacePath;
      const files: Record<string, string> = {
        ".data/assets.json": JSON.stringify({
          version: 1,
          prompts: { "art/hero.png": "Old prompt", "art/tree.png": "A tree" },
          previews: { "art/hero.png": ".data/asset-previews/hero.jpg" },
          libraryAssets: {},
        }),
        ".data/asset-previews/hero.jpg": "old preview",
        ".data/agent-attachments/batch/files/a.txt": "attachment",
        ".data/notes.txt": "someone's own file",
        ".ohmygame/thumbnails/menu.webp": "thumbnail",
        ".ohmygame/story-runtime/1/story/runtime.js": "runtime",
        ".ohmygame/assets.json": JSON.stringify({ version: 1, prompts: { "art/hero.png": "New prompt", "art/rock.png": "A rock" }, previews: {}, libraryAssets: {} }),
        ".ohmygame/asset-previews/hero.jpg": "new preview",
      };
      for (const [file, contents] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
        await writeFile(path.join(workspace, file), contents);
      }

      await new ProjectManager(directory).load();

      const read = (file: string) => readFile(path.join(workspace, file), "utf8");
      // What is already in `.ohmygame/` is kept, and what would replace it stays behind.
      expect((await readdir(path.join(workspace, ".data"))).sort()).toEqual(["asset-previews", "notes.txt"]);
      expect(await read(".data/asset-previews/hero.jpg")).toBe("old preview");
      expect(await read(".ohmygame/.gitignore")).toBe("local/\nbuild/\n");
      expect(await read(".ohmygame/asset-previews/hero.jpg")).toBe("new preview");
      expect(await read(".ohmygame/local/attachments/batch/files/a.txt")).toBe("attachment");
      expect(await read(".ohmygame/local/thumbnails/menu.webp")).toBe("thumbnail");
      expect(await read(".ohmygame/local/story-runtime/1/story/runtime.js")).toBe("runtime");
      expect((await readdir(path.join(workspace, ".ohmygame"))).sort()).toEqual([".gitignore", "asset-previews", "assets.json", "local", "settings.json"]);
      expect(JSON.parse(await read(".ohmygame/assets.json"))).toMatchObject({
        prompts: { "art/hero.png": "New prompt", "art/tree.png": "A tree", "art/rock.png": "A rock" },
        previews: { "art/hero.png": ".ohmygame/asset-previews/hero.jpg" },
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("leaves asset records it cannot read in .data/", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-layout-"));
    try {
      const project = await new ProjectManager(directory).create("Newer records", "general");
      await mkdir(path.join(project.workspacePath, ".data"));
      await writeFile(path.join(project.workspacePath, ".data/assets.json"), JSON.stringify({ version: 2 }));
      await new ProjectManager(directory).load();
      expect(await readFile(path.join(project.workspacePath, ".data/assets.json"), "utf8")).toBe(JSON.stringify({ version: 2 }));
      expect((await readdir(path.join(project.workspacePath, ".ohmygame"))).sort()).toEqual([".gitignore", "local", "settings.json"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("brings back a folder's name and settings when it is opened again as the same type", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-settings-"));
    const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-project-folder-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create(undefined, "general", folder);
      await manager.rename(project.id, "Moon Garden");
      await manager.setAppearance(project.id, { icon: "leaf" });
      await manager.setRunSettings(project.id, { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit", webPreviewEnabled: false });
      expect(JSON.parse(await readFile(path.join(folder, ".ohmygame", "settings.json"), "utf8"))).toMatchObject({
        version: 1, name: "Moon Garden", webPreviewEnabled: false, appearance: { icon: "leaf" },
      });
      expect(JSON.parse(await readFile(path.join(folder, "ohmygame.json"), "utf8"))).toMatchObject({ type: "general" });
      await manager.remove(project.id);
      expect(await projectFolderType(folder)).toBe("general");

      const reopened = await manager.create(undefined, "general", folder);
      expect(reopened).toMatchObject({ name: "Moon Garden", nameSource: "manual", webPreviewEnabled: false, appearance: { icon: "leaf" } });
      await manager.remove(reopened.id);
      expect(await manager.create("Typed name", "general", folder)).toMatchObject({ name: "Typed name", appearance: { icon: "leaf" } });
      expect((await manager.create(undefined, "interactive-story", await mkdtemp(path.join(tmpdir(), "ohmygame-other-")))).name).not.toBe("Moon Garden");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("opens a folder as the type its ohmygame.json names, and keeps its settings when asked for another", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-type-"));
    const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-project-folder-"));
    try {
      const manager = new ProjectManager(directory);
      const story = await manager.create(undefined, "interactive-story", folder);
      await writeFile(path.join(folder, "graph.json"), "{}");
      await manager.rename(story.id, "Moon Garden");
      await manager.setAppearance(story.id, { icon: "leaf" });
      await manager.remove(story.id);
      expect(await projectFolderType(folder)).toBe("interactive-story");

      // Asked for another type, nothing of the folder changes.
      const settings = await readFile(path.join(folder, ".ohmygame", "settings.json"), "utf8");
      await expect(manager.create(undefined, "web-game", folder)).rejects.toThrow("says it is interactive-story");
      expect(await readFile(path.join(folder, ".ohmygame", "settings.json"), "utf8")).toBe(settings);
      expect(await manager.create(undefined, "interactive-story", folder)).toMatchObject({ type: "interactive-story", name: "Moon Garden", appearance: { icon: "leaf" } });

      // The app's types that are General projects keep their kind in the settings.
      const web = await manager.create("Sky", "web-game", await mkdtemp(path.join(tmpdir(), "ohmygame-web-")));
      await writeFile(path.join(web.workspacePath, "index.html"), "<p>");
      await manager.rename(web.id, "Sky Garden");
      expect(JSON.parse(await readFile(path.join(web.workspacePath, ".ohmygame", "settings.json"), "utf8"))).toMatchObject({ kind: "web-game" });
      expect(await projectFolderType(web.workspacePath)).toBe("web-game");
      // The folder's file decides the type at the next start.
      await writeFile(path.join(web.workspacePath, "ohmygame.json"), JSON.stringify({ type: "interactive-story" }));
      const next = new ProjectManager(directory);
      await next.load();
      expect(next.get(web.id)).toMatchObject({ type: "interactive-story", name: "Sky Garden" });
      expect(JSON.parse(await readFile(path.join(directory, "projects", web.id, "project.json"), "utf8"))).toMatchObject({ type: "interactive-story" });

      // Settings that can't be read keep the kind the app last knew.
      const canvas = await manager.create("Board", "asset-canvas");
      await manager.rename(canvas.id, "Board game");
      await writeFile(path.join(canvas.workspacePath, ".ohmygame", "settings.json"), "{");
      const broken = new ProjectManager(directory);
      await broken.load();
      expect(broken.get(canvas.id)?.type).toBe("asset-canvas");
      expect(JSON.parse(await readFile(path.join(directory, "projects", canvas.id, "project.json"), "utf8"))).toMatchObject({ type: "asset-canvas" });
      // A folder that lost its file, as to an older snapshot, gets it back with the next save.
      await rm(path.join(web.workspacePath, "ohmygame.json"));
      await next.touch(web.id);
      expect(JSON.parse(await readFile(path.join(web.workspacePath, "ohmygame.json"), "utf8"))).toMatchObject({ type: "interactive-story" });
      // The kinds ohmygame.json can't name stay in the settings: a plugin's workspace, given a file by a plugin turned on in it…
      const workspace = await manager.create("Builder", "plugin");
      await writeFile(path.join(workspace.workspacePath, "README.md"), "plugin");
      await manager.rename(workspace.id, "Builder workspace");
      expect(JSON.parse(await readFile(path.join(workspace.workspacePath, ".ohmygame", "settings.json"), "utf8"))).toMatchObject({ kind: "plugin" });
      await writeFile(path.join(workspace.workspacePath, "ohmygame.json"), JSON.stringify({ type: "general" }));
      const reloaded = new ProjectManager(directory);
      await reloaded.load();
      expect(reloaded.get(workspace.id)?.type).toBe("plugin");
      // …and a Godot project from before Godot was a plugin, through an export and an import.
      const legacy = await manager.create("Old Godot", "godot-game");
      await writeFile(path.join(legacy.workspacePath, "project.godot"), "config_version=5\n");
      await manager.rename(legacy.id, "Old Godot game");
      expect(await readdir(legacy.workspacePath)).not.toContain("ohmygame.json");
      const staged = await mkdtemp(path.join(tmpdir(), "ohmygame-staged-"));
      await cp(legacy.workspacePath, staged, { recursive: true });
      expect(await manager.import(staged, JSON.parse(await readFile(path.join(staged, ".ohmygame", "settings.json"), "utf8")))).toMatchObject({ type: "godot-game" });
      // The dialog names a plugin's type that the app had as its own by the app's name.
      const godot = await mkdtemp(path.join(tmpdir(), "ohmygame-godot-"));
      await writeFile(path.join(godot, "ohmygame.json"), JSON.stringify({ type: "ohmygame/godot:godot-game", plugins: { "ohmygame/godot": "1.0.0" } }));
      expect(await projectFolderType(godot)).toBe("godot-game");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    }
  });

  // Creating symbolic links needs extra privileges on Windows.
  it.skipIf(process.platform === "win32")("never moves or removes OhMyGame's files through a symbolic link", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-links-"));
    const outside = await mkdtemp(path.join(tmpdir(), "ohmygame-outside-"));
    const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-linked-folder-"));
    try {
      await mkdir(path.join(outside, "asset-previews"));
      await writeFile(path.join(outside, "assets.json"), JSON.stringify({ version: 1, prompts: {}, previews: {}, libraryAssets: {} }));
      await mkdir(path.join(outside, "local"));
      await writeFile(path.join(outside, "local", "keep.txt"), "outside");
      await symlink(outside, path.join(folder, ".data"));
      const manager = new ProjectManager(directory);
      const project = await manager.create("Linked", "general", folder);
      expect((await readdir(outside)).sort()).toEqual(["asset-previews", "assets.json", "local"]);

      await rm(path.join(folder, ".data"));
      await rm(path.join(folder, ".ohmygame"), { recursive: true, force: true });
      await symlink(outside, path.join(folder, ".ohmygame"));
      await expect(manager.setCover(project.id, Buffer.from("cover"))).rejects.toThrow("Unsafe project cover path");
      await manager.remove(project.id);
      expect(await readFile(path.join(outside, "local", "keep.txt"), "utf8")).toBe("outside");
    } finally {
      for (const folderPath of [directory, outside, folder]) await rm(folderPath, { recursive: true, force: true });
    }
  });
});
