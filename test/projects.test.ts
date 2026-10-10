import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManager } from "../src/daemon/projects.js";

describe("Web Game project codebase", () => {
  it("keeps an engine-independent General Game workspace through reload and duplication", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-general-projects-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Native game", "general");
    expect(await readdir(project.workspacePath)).toEqual([]);
    await writeFile(path.join(project.workspacePath, "project.godot"), "config_version=5\n");

    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({ type: "general", preview: { status: "waiting" } });
    const copy = await restored.duplicate(project.id);
    expect(copy.type).toBe("general");
    expect(await readdir(copy.workspacePath)).toEqual(["project.godot"]);
  });
  it("starts with an empty workspace; the platform contract lives in the system prompt", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Game", "web-game");

    expect(await readdir(project.workspacePath)).toEqual([]);
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

  it.each(["web-game", "general"] as const)("persists a runnable startup directory for %s below the workspace root", async (type) => {
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
      previewViewport: "mobile",
    });
    expect(updated).toMatchObject({
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport: "mobile",
    });
    expect(updated.preview).toEqual({ status: type === "general" ? "stopped" : "waiting" });
    expect(JSON.parse(await readFile(path.join(dataDirectory, "projects", project.id, "project.json"), "utf8"))).toMatchObject({
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport: "mobile",
    });

    const restored = new ProjectManager(dataDirectory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport: "mobile",
      preview: { status: "stopped" },
    });
    await expect(manager.setStartupDirectory(project.id, "../outside")).rejects.toThrow("Startup directory must be a relative path");
    await expect(manager.setStartupDirectory(project.id, "missing")).rejects.toThrow("Startup directory does not exist");
  });
});
