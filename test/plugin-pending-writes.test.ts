import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { isOwned, ownedFolders, PluginPendingWrites, ProjectIdle, type PluginPendingWritesOptions } from "../src/daemon/plugin-pending-writes.js";

const directories: string[] = [];
const started: PluginPendingWrites[] = [];
afterEach(async () => {
  for (const pending of started.splice(0)) pending.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(overrides: Partial<PluginPendingWritesOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-pending-writes-"));
  directories.push(root);
  const project = { id: "p1", workspacePath: path.join(root, "workspace"), storagePath: path.join(root, "storage") } as ProjectState;
  await mkdir(project.workspacePath, { recursive: true });
  const state = { busy: true, allowed: true, runs: [] as string[], written: new Map<string, string>(), removed: [] as string[], refuse: false, fail: undefined as unknown, warnings: [] as string[], failures: [] as unknown[] };
  const options: PluginPendingWritesOptions = {
    projects: () => [project],
    project: (id) => (id === project.id ? project : undefined),
    busy: () => state.busy,
    allowed: async () => state.allowed,
    run: async (_project, _plugin, title, apply) => {
      if (state.refuse) throw new Error("refused before it started");
      state.runs.push(title);
      try {
        await apply();
      } catch (error) {
        state.failures.push(error);
      }
    },
    write: async (_project, file, contents) => {
      if (state.fail) throw state.fail;
      state.written.set(file, contents.toString());
    },
    remove: async (_project, file) => { state.removed.push(file); },
    warn: (_error, message) => { state.warnings.push(message); },
    ...overrides,
  };
  const pending = new PluginPendingWrites(options);
  return { project, state, pending, options, start: () => { started.push(pending); pending.start(); } };
}

describe("plugin pending writes", () => {
  it("reads a manifest's projectFiles as folders a path is owned by", () => {
    const owned = ownedFolders(["./pixelfx/", "./notes.md"]);
    expect(owned).toEqual(["pixelfx", "notes.md"]);
    expect(isOwned("pixelfx", owned)).toBe(true);
    expect(isOwned("pixelfx/fx/one.json", owned)).toBe(true);
    expect(isOwned("pixelfx-other/one.json", owned)).toBe(false);
    expect(isOwned("notes.md", owned)).toBe(true);
    expect(ownedFolders(undefined)).toEqual([]);
  });

  it("waits while the project is busy, lands once in order when idle, and leaves a refused run for later", async () => {
    const { project, state, pending, start } = await setup();
    start();
    await pending.stageWrite(project, "acme/fx", "fx/a.json", Buffer.from("a1"));
    await pending.stageWrite(project, "acme/fx", "fx/b.json", Buffer.from("b"));
    await pending.stageWrite(project, "acme/fx", "fx/a.json", Buffer.from("a2"));
    await pending.flush(project, "acme/fx");
    expect(state.runs).toEqual([]);
    state.busy = false;
    state.refuse = true;
    await pending.flush(project, "acme/fx");
    expect(pending.has(project, "acme/fx")).toBe(true);
    state.refuse = false;
    await pending.flush(project, "acme/fx");
    expect(state.runs).toEqual(["Save 2 changes made during the agent's turn"]);
    expect([...state.written]).toEqual([["fx/b.json", "b"], ["fx/a.json", "a2"]]);
    expect(pending.has(project, "acme/fx")).toBe(false);
  });

  it("lands what waits before a panel's tool changes files itself, and drops what is inside a folder it deletes", async () => {
    const { project, state, pending } = await setup();
    await pending.stageWrite(project, "acme/fx", "fx/a.json", Buffer.from("a"));
    await pending.stageWrite(project, "acme/fx", "fx/sub/b.json", Buffer.from("b"));
    // Only waiting inside it, so nothing is left to delete on disk.
    await pending.stageDelete(project, "acme/fx", "fx/sub");
    expect(await pending.read(project, "acme/fx", "fx/sub/b.json")).toBeUndefined();
    const listed = pending.list(project, "acme/fx", { entries: [], truncated: false }, { folder: "fx" });
    expect(listed.entries.map((entry) => entry.path)).toEqual(["fx/a.json"]);
    const read = await pending.read(project, "acme/fx", "fx/a.json");
    if (!read || read === "deleted") throw new Error("fx/a.json should be waiting");
    expect(read.size).toBe(1);
    const chunks: Buffer[] = [];
    for await (const chunk of read.stream()) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("a");
    // Still busy, and without a change of its own: it's part of whatever called the tool.
    await pending.land(project, "acme/fx");
    expect(state.runs).toEqual([]);
    expect([...state.written.keys()]).toEqual(["fx/a.json"]);
    expect(pending.has(project, "acme/fx")).toBe(false);
    // Read after it landed, a page gets the project's file instead.
    expect(await pending.read(project, "acme/fx", "fx/a.json")).toBeUndefined();
  });

  it("stages nothing once the agent is done, and tries a write a program holds again before giving up, naming no path", async () => {
    const { project, state, pending, start } = await setup();
    start();
    await pending.stageWrite(project, "acme/fx", "fx/a.json", Buffer.from("a"));
    state.busy = false;
    await expect(pending.stageWrite(project, "acme/fx", "fx/b.json", Buffer.from("b"))).rejects.toBeInstanceOf(ProjectIdle);
    state.fail = Object.assign(new Error("EBUSY: resource busy, open '/Users/someone/game/fx/a.json'"), { code: "EBUSY", syscall: "open" });
    for (let attempt = 1; attempt < 5; attempt++) {
      await pending.flush(project, "acme/fx");
      expect(pending.has(project, "acme/fx")).toBe(true);
    }
    await pending.flush(project, "acme/fx");
    expect(pending.has(project, "acme/fx")).toBe(false);
    expect(String(state.failures.at(-1))).toContain("fx/a.json: the file system refused it (EBUSY)");
    expect(String(state.failures.at(-1))).not.toContain("/Users/");
  });

  it("drops what waits for a plugin that can no longer write, and leaves a list it can't read alone", async () => {
    const { project, state, pending, options, start } = await setup();
    start();
    await pending.stageWrite(project, "acme/fx", "fx/a.json", Buffer.from("a"));
    state.busy = false;
    state.allowed = false;
    await pending.flush(project, "acme/fx");
    expect(state.runs).toEqual([]);
    expect(pending.has(project, "acme/fx")).toBe(false);

    const folder = path.join(project.storagePath!, "plugin-pending/acme/other");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "pending.json"), JSON.stringify({ version: 2, operations: [] }));
    const restarted = new PluginPendingWrites(options);
    await restarted.load();
    expect(restarted.has(project, "acme/other")).toBe(false);
    // It can't add to what it can't read, so what is there stays.
    state.busy = true;
    await expect(restarted.stageWrite(project, "acme/other", "fx/a.json", Buffer.from("a"))).rejects.toThrow("can't be read");
    expect(JSON.parse(await readFile(path.join(folder, "pending.json"), "utf8"))).toEqual({ version: 2, operations: [] });
  });
});
