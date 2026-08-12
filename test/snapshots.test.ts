import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotManager } from "../src/daemon/snapshots.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";

describe("SnapshotManager", () => {
  it("restores one workspace version without copying dependencies", async () => {
    const projectDirectory = await mkdtemp(path.join(tmpdir(), "open-game-snapshot-"));
    const workspacePath = path.join(projectDirectory, "workspace");
    await mkdir(path.join(workspacePath, "node_modules"), { recursive: true });
    await writeFile(path.join(workspacePath, "game.js"), "before");
    await writeFile(path.join(workspacePath, "node_modules", "cached"), "dependency");
    const project = createProject(workspacePath);
    const manager = new SnapshotManager(new RuntimeEventBus());

    await manager.capture(project);
    await expect(access(path.join(projectDirectory, "snapshots", "pending", "node_modules"))).rejects.toThrow();
    await writeFile(path.join(workspacePath, "game.js"), "after");
    await manager.finalize(project);
    await manager.restore(project);

    expect(await readFile(path.join(workspacePath, "game.js"), "utf8")).toBe("before");
    expect(await readFile(path.join(workspacePath, "node_modules", "cached"), "utf8")).toBe("dependency");
    expect(project.canUndo).toBe(false);
  });

  it("keeps the previous undo when a turn does not change files", async () => {
    const projectDirectory = await mkdtemp(path.join(tmpdir(), "open-game-snapshot-"));
    const workspacePath = path.join(projectDirectory, "workspace");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, "game.js"), "first");
    const project = createProject(workspacePath);
    const manager = new SnapshotManager(new RuntimeEventBus());

    await manager.capture(project);
    await writeFile(path.join(workspacePath, "game.js"), "second");
    await manager.finalize(project);
    await manager.capture(project);
    await manager.finalize(project);
    await manager.restore(project);

    expect(await readFile(path.join(workspacePath, "game.js"), "utf8")).toBe("first");
  });

  it("recovers an interrupted snapshot rotation", async () => {
    const projectDirectory = await mkdtemp(path.join(tmpdir(), "open-game-snapshot-"));
    const workspacePath = path.join(projectDirectory, "workspace");
    const retired = path.join(projectDirectory, "snapshots", "previous.retired");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(retired, { recursive: true });
    await writeFile(path.join(workspacePath, "game.js"), "after");
    await writeFile(path.join(retired, "game.js"), "before");
    const project = createProject(workspacePath);
    const manager = new SnapshotManager(new RuntimeEventBus());

    await manager.recover(project);
    await manager.restore(project);

    expect(await readFile(path.join(workspacePath, "game.js"), "utf8")).toBe("before");
  });
});

function createProject(workspacePath: string): ProjectState {
  return {
    id: "project-1",
    name: "Project",
    workspacePath,
    canUndo: false,
    preview: { status: "stopped" },
    agent: { status: "idle" },
  };
}
