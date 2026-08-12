import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManager } from "../src/daemon/projects.js";

describe("ProjectManager", () => {
  it("migrates an existing workspace without metadata", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const id = "1df6a50b-78e2-46b2-a96a-c97072d935f4";
    const workspace = path.join(dataDirectory, "projects", id, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "keep.txt"), "user data");
    const manager = new ProjectManager(dataDirectory);

    await manager.load();

    expect(manager.get(id)).toMatchObject({ id, name: "Untitled project", workspacePath: workspace });
    expect(await readFile(path.join(workspace, "keep.txt"), "utf8")).toBe("user data");
    expect(JSON.parse(await readFile(path.join(dataDirectory, "projects", id, "project.json"), "utf8"))).toMatchObject({ version: 1, id });
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

  it("writes generated assets only under the project workspace", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Game");

    await expect(manager.addGeneratedAsset(project.id, "image-run.webp", Buffer.from("image")))
      .resolves.toBe("assets/generated/image-run.webp");
    expect(await readFile(path.join(project.workspacePath, "assets", "generated", "image-run.webp"), "utf8")).toBe("image");
    await expect(manager.addGeneratedAsset(project.id, "../outside.webp", Buffer.from("image"))).rejects.toThrow("Invalid asset name");
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

    expect(manager.list()).toEqual([first, second]);
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
