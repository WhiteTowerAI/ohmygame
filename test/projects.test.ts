import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManager } from "../src/daemon/projects.js";

describe("Web Game project codebase", () => {
  it("stores its runtime requirements in the project workspace", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Game", "web-game");

    const instructions = await readFile(path.join(project.workspacePath, "AGENTS.md"), "utf8");
    expect(instructions).toContain("complete Vite-based browser project");
    expect(instructions).toContain("scripts.dev");
    expect(instructions).toContain("responsive inside an iframe");
    expect(instructions).toContain("add a test bridge solely for a routine verification pass");
    expect(instructions).toContain("normal gameplay must not depend on it");
  });

  it("persists a runnable startup directory below the workspace root", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Game", "web-game");
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
    expect(updated.preview).toEqual({ status: "waiting" });
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
