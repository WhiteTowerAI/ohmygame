import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  it.each(["electron .", "tauri dev"])("keeps General Game preview off for a native dev script: %s", async (dev) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-native-project-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Native", "general");
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev } }));
    expect(await manager.refreshPreviewReadiness(project.id)).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
    // Projects created before the switch existed must also remain opt-in.
    const metadataPath = path.join(directory, "projects", project.id, "project.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    delete metadata.webPreviewEnabled;
    await writeFile(metadataPath, JSON.stringify(metadata));
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
  });

  it("persists explicit preview opt-in before output exists, through reload and duplication", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-preview-opt-in-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Browser output", "general");
    const settings = { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit" as const, webPreviewEnabled: true };
    expect(await manager.setRunSettings(project.id, settings)).toMatchObject({ webPreviewEnabled: true, preview: { status: "waiting" } });
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    expect(await manager.refreshPreviewReadiness(project.id)).toMatchObject({ preview: { status: "stopped" } });
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({ webPreviewEnabled: true, preview: { status: "stopped" } });
    expect(await restored.duplicate(project.id)).toMatchObject({ webPreviewEnabled: true, preview: { status: "stopped" } });
    await manager.setRunSettings(project.id, { ...settings, webPreviewEnabled: false });
    expect(await manager.duplicate(project.id)).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
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
      ...(type === "general" ? { webPreviewEnabled: true } : {}),
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
