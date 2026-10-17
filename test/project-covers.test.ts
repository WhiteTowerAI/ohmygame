import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectManager } from "../src/daemon/projects.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-cover-"));
  directories.push(directory);
  const manager = new ProjectManager(directory);
  const project = await manager.create("Game");
  return { directory, manager, project };
}

describe("project cover selection", () => {
  it("freezes the current automatic cover without an upload and blocks late captures", async () => {
    const { manager, project } = await fixture();
    await Promise.all([
      manager.setCover(project.id, Buffer.from("automatic"), "auto"),
      manager.setCoverMode(project.id, "custom"),
      manager.setCover(project.id, Buffer.from("late capture"), "auto"),
    ]);
    expect(await manager.coverState(project.id)).toEqual({ mode: "custom" });
    expect(await manager.cover(project.id)).toEqual(Buffer.from("automatic"));
    await manager.setCoverMode(project.id, "auto");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("automatic"));
    await manager.setCover(project.id, Buffer.from("next capture"), "auto");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("next capture"));
    await manager.setCoverMode(project.id, "custom");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("next capture"));
    const duplicate = await manager.duplicate(project.id);
    expect(await manager.coverState(duplicate.id)).toEqual({ mode: "custom" });
    expect(await manager.cover(duplicate.id)).toEqual(Buffer.from("next capture"));
  });

  it("persists and duplicates automatic-off mode even before a cover exists", async () => {
    const { directory, manager, project } = await fixture();
    await manager.setCoverMode(project.id, "custom");
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(await restored.coverState(project.id)).toEqual({ mode: "custom" });
    const duplicate = await restored.duplicate(project.id);
    await restored.setCover(duplicate.id, Buffer.from("capture"), "auto");
    expect(await restored.coverState(duplicate.id)).toEqual({ mode: "custom" });
    expect(await restored.cover(duplicate.id)).toBeUndefined();
    await restored.setCoverMode(duplicate.id, "auto");
    await restored.setCover(duplicate.id, Buffer.from("capture"), "auto");
    expect(await restored.cover(duplicate.id)).toEqual(Buffer.from("capture"));
    expect(await restored.coverState(project.id)).toEqual({ mode: "custom" });
  });

  it("keeps a custom cover when automatic captures finish on either side of its save", async () => {
    const { manager, project } = await fixture();
    const automatic = Buffer.from("automatic");
    const custom = Buffer.from("custom");
    expect(await manager.coverState(project.id)).toEqual({ mode: "auto" });
    await Promise.all([
      manager.setCover(project.id, automatic, "auto"),
      manager.setCover(project.id, custom),
      manager.setCover(project.id, Buffer.from("late capture"), "auto"),
    ]);
    expect(await manager.cover(project.id)).toEqual(custom);
    expect(await manager.coverState(project.id)).toEqual({ mode: "custom" });

    await manager.setCoverMode(project.id, "auto");
    expect(await manager.cover(project.id)).toEqual(automatic);
    await manager.setCover(project.id, Buffer.from("next capture"), "auto");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("next capture"));
  });

  it("persists custom mode across restarts and duplicates both cover choices", async () => {
    const { directory, manager, project } = await fixture();
    await manager.setCover(project.id, Buffer.from("automatic"), "auto");
    await manager.setCover(project.id, Buffer.from("custom"));
    const restored = new ProjectManager(directory);
    await restored.load();
    await restored.setCover(project.id, Buffer.from("late capture"), "auto");
    expect(await restored.cover(project.id)).toEqual(Buffer.from("custom"));
    const duplicate = await restored.duplicate(project.id);
    expect(await restored.coverState(duplicate.id)).toEqual({ mode: "custom" });
    expect(await restored.cover(duplicate.id)).toEqual(Buffer.from("custom"));
    await restored.setCoverMode(duplicate.id, "auto");
    expect(await restored.cover(duplicate.id)).toEqual(Buffer.from("automatic"));
    expect(await restored.cover(project.id)).toEqual(Buffer.from("custom"));
    const restarted = new ProjectManager(directory);
    await restarted.load();
    expect(await restarted.coverState(duplicate.id)).toEqual({ mode: "auto" });
    expect(await restarted.cover(duplicate.id)).toEqual(Buffer.from("automatic"));
    const automaticDuplicate = await restarted.duplicate(duplicate.id);
    await restarted.setCoverMode(automaticDuplicate.id, "custom");
    expect(await restarted.cover(automaticDuplicate.id)).toEqual(Buffer.from("custom"));
    await restarted.setCoverMode(duplicate.id, "custom");
    expect(await restarted.cover(duplicate.id)).toEqual(Buffer.from("custom"));
  });

  it("restores uploaded art after toggling and uses the latest replacement", async () => {
    const { manager, project } = await fixture();
    await manager.setCover(project.id, Buffer.from("automatic"), "auto");
    await manager.setCoverMode(project.id, "custom");
    await manager.setCover(project.id, Buffer.from("uploaded"));
    await manager.setCoverMode(project.id, "auto");
    await manager.setCover(project.id, Buffer.from("new capture"), "auto");
    await manager.setCoverMode(project.id, "custom");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("uploaded"));
    await manager.setCoverMode(project.id, "auto");
    await manager.setCover(project.id, Buffer.from("replacement"));
    expect(await manager.coverState(project.id)).toEqual({ mode: "custom" });
    expect(await manager.cover(project.id)).toEqual(Buffer.from("replacement"));
    await manager.setCoverMode(project.id, "auto");
    await manager.setCoverMode(project.id, "custom");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("replacement"));
  });

  it.each(["{", "null", '"auto"', '{"mode":"unknown"}'])("recovers from an invalid state file: %s", async (state) => {
    const { manager, project } = await fixture();
    const statePath = path.join(project.storagePath!, "cover-state.json");
    await writeFile(statePath, state);
    expect(await manager.coverState(project.id)).toEqual({ mode: "auto" });
    await manager.setCover(project.id, Buffer.from("automatic"), "auto");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("automatic"));
    await manager.setCover(project.id, Buffer.from("uploaded"));
    await manager.setCoverMode(project.id, "auto");
    await writeFile(statePath, state);
    expect(await manager.coverState(project.id)).toEqual({ mode: "custom" });
    await manager.setCover(project.id, Buffer.from("late capture"), "auto");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("uploaded"));
    await manager.setCoverMode(project.id, "auto");
    expect(await manager.coverState(project.id)).toEqual({ mode: "auto" });
    expect(await manager.cover(project.id)).toEqual(Buffer.from("automatic"));
  });

  it("protects legacy covers until automatic mode is explicitly restored", async () => {
    const { manager, project } = await fixture();
    await writeFile(path.join(project.storagePath!, "cover.webp"), "legacy cover");
    expect(await manager.coverState(project.id)).toEqual({ mode: "custom" });
    await manager.setCover(project.id, Buffer.from("capture"), "auto");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("legacy cover"));
    await manager.setCoverMode(project.id, "auto");
    expect(await manager.cover(project.id)).toBeUndefined();
    await manager.setCover(project.id, Buffer.from("capture"), "auto");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("capture"));
    await manager.setCoverMode(project.id, "custom");
    expect(await manager.cover(project.id)).toEqual(Buffer.from("legacy cover"));
  });

  it("duplicates automatic covers without making them custom", async () => {
    const { manager, project } = await fixture();
    await manager.setCover(project.id, Buffer.from("automatic"), "auto");
    const duplicate = await manager.duplicate(project.id);
    expect(await manager.coverState(duplicate.id)).toEqual({ mode: "auto" });
    await manager.setCover(duplicate.id, Buffer.from("new capture"), "auto");
    expect(await manager.cover(duplicate.id)).toEqual(Buffer.from("new capture"));
  });
});
