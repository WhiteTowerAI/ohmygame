import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManager } from "../src/daemon/projects.js";

describe("project codebases", () => {
  it("stores Web Game runtime requirements in the workspace", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Game", "web-game");

    const instructions = await readFile(path.join(project.workspacePath, "AGENTS.md"), "utf8");
    expect(instructions).toContain("complete Vite-based browser project");
    expect(instructions).toContain("scripts.dev");
    expect(instructions).toContain("responsive inside an iframe");
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

  it("keeps Asset Canvas persistence separate from Interactive Drama", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const drama = await manager.create("Drama", "interactive-drama");
    const canvas = await manager.create("Canvas", "asset-canvas");

    await expect(manager.assetCanvas(drama.id)).rejects.toThrow("Canvas documents require an Asset Canvas project");
    const document = await manager.assetCanvas(canvas.id);
    document.nodes.push({
      id: "prompt",
      type: "text",
      position: { x: 80, y: 120 },
      data: { text: "", instruction: "Write a prompt" },
    });
    document.editorLayout.nodes.prompt = { x: 80, y: 120 };
    await manager.setAssetCanvas(canvas.id, document);

    const persisted = JSON.parse(await readFile(path.join(canvas.workspacePath, "canvas.json"), "utf8"));
    expect(persisted.nodes[0]).not.toHaveProperty("position");
    expect(JSON.parse(await readFile(path.join(canvas.workspacePath, "editor/layout.json"), "utf8"))).toMatchObject({ nodes: { prompt: { x: 80, y: 120 } } });
    expect(await readFile(path.join(canvas.workspacePath, "schemas/asset-canvas.schema.json"), "utf8")).toContain('"model-3d"');
    expect(await readFile(path.join(canvas.workspacePath, "AGENTS.md"), "utf8")).toContain("It is not an Interactive Drama runtime");
  });
});
