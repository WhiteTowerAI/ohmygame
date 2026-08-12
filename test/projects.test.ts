import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    const manager = new ProjectManager(dataDirectory, "/unused");

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
    const manager = new ProjectManager(dataDirectory, "/unused");

    await expect(manager.load()).rejects.toThrow();
    expect(await readFile(path.join(projectDirectory, "project.json"), "utf8")).toBe("not json");
  });
});
