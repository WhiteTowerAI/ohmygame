import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { GameTuning, GameTuningError, parseGameTuning } from "../src/daemon/game-tuning.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const folder of cleanups.splice(0)) await rm(folder, { recursive: true, force: true });
});

const FILE = {
  schemaVersion: 1,
  note: "kept",
  values: [
    { id: "player.jump", label: "Jump", value: 420, min: 100, max: 800, step: 10, note: "kept too" },
    { id: "world.double", label: "Double jump", value: false },
  ],
};

async function project(file: unknown = FILE) {
  const workspacePath = await realpath(await mkdtemp(path.join(tmpdir(), "ohmygame-tuning-")));
  cleanups.push(workspacePath);
  if (file !== null) await writeFile(path.join(workspacePath, "tuning.json"), JSON.stringify(file));
  const push = vi.fn(), publish = vi.fn();
  const target = { id: "p", workspacePath };
  return { target, workspacePath, push, publish, tuning: new GameTuning({ push, publish }) };
}
const saveDirectly = (operation: () => Promise<void>) => operation();

describe("the tuning file", () => {
  it("names what is wrong with it", () => {
    const wrong = (values: unknown[]) => () => parseGameTuning(JSON.stringify({ schemaVersion: 1, values }));
    expect(() => parseGameTuning("{")).toThrow("valid JSON");
    expect(() => parseGameTuning(JSON.stringify({ schemaVersion: 2, values: [] }))).toThrow("schemaVersion");
    expect(wrong([{ id: "__proto__", label: "x", value: true }])).toThrow("start with a letter");
    expect(wrong([{ id: "a", label: "x", value: true }, { id: "a", label: "y", value: true }])).toThrow("used twice");
    expect(wrong([{ id: "a", label: "", value: true }])).toThrow("label");
    expect(wrong([{ id: "a", label: "x", value: "1" }])).toThrow("number or true or false");
    expect(wrong([{ id: "a", label: "x", value: 1, min: 2, max: 1 }])).toThrow('"min" below');
    expect(wrong([{ id: "a", label: "x", value: 9, min: 0, max: 1 }])).toThrow("outside");
    expect(wrong([{ id: "a", label: "x", value: 1, min: 0, max: 2, step: 0 }])).toThrow("step");
    expect(wrong(Array.from({ length: 101 }, (_, index) => ({ id: `a${index}`, label: "x", value: true })))).toThrow("at most");
  });

  it("prefers the public folder's file, which builds include", async () => {
    const { tuning, target, workspacePath } = await project();
    await mkdir(path.join(workspacePath, "public"));
    await writeFile(path.join(workspacePath, "public/tuning.json"), JSON.stringify({ schemaVersion: 1, values: [] }));
    expect((await tuning.state(target)).file).toBe("public/tuning.json");
  });

  it("is empty without a file", async () => {
    const { tuning, target } = await project(null);
    const { sequence: _sequence, ...state } = await tuning.state(target);
    expect(state).toEqual({ values: [], draft: {}, connected: false });
  });

  it("refuses a link, which could read or overwrite anything", async () => {
    const { tuning, target, workspacePath } = await project(null);
    const outside = path.join(workspacePath, "..", `outside-${path.basename(workspacePath)}.json`);
    await writeFile(outside, JSON.stringify(FILE));
    cleanups.push(outside);
    await symlink(outside, path.join(workspacePath, "tuning.json"));
    expect((await tuning.state(target)).error).toContain("regular file");
    await expect(tuning.save(target, saveDirectly)).rejects.toBeInstanceOf(GameTuningError);
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual(FILE);
  });
});

describe("drafts", () => {
  it("reach the game clamped, and leave when they match what is saved", async () => {
    const { tuning, target, push } = await project();
    expect((await tuning.setDraft(target, { "player.jump": 9000, "world.double": true })).draft).toEqual({ "player.jump": 800, "world.double": true });
    expect(push).toHaveBeenLastCalledWith(target, { "player.jump": 800, "world.double": true });
    expect((await tuning.setDraft(target, { "player.jump": 420 })).draft).toEqual({ "world.double": true });
    expect((await tuning.setDraft(target, { "world.double": null })).draft).toEqual({});
    expect(push).toHaveBeenLastCalledWith(target, { "player.jump": 420, "world.double": false });
  });

  it("ignores what the file doesn't have, or of another type", async () => {
    const { tuning, target } = await project();
    expect((await tuning.setDraft(target, { missing: 1, "player.jump": true, "world.double": 1 })).draft).toEqual({});
  });

  it("follow the file when it changes", async () => {
    const { tuning, target, workspacePath, push, publish } = await project();
    await tuning.setDraft(target, { "player.jump": 600, "world.double": true });
    await writeFile(path.join(workspacePath, "tuning.json"), JSON.stringify({ schemaVersion: 1, values: [{ id: "player.jump", label: "Jump", value: 200, min: 100, max: 500 }] }));
    await tuning.refresh(target);
    // The draft is limited to the new range and the removed value is gone.
    expect(push).toHaveBeenLastCalledWith(target, { "player.jump": 500 });
    expect(publish.mock.lastCall?.[1].draft).toEqual({ "player.jump": 500 });
  });

  it("survive a broken file, as the agent may be writing it", async () => {
    const { tuning, target, workspacePath, push } = await project();
    await tuning.setDraft(target, { "player.jump": 600 });
    await writeFile(path.join(workspacePath, "tuning.json"), "{ half");
    const broken = await tuning.state(target);
    expect(broken.error).toContain("valid JSON");
    expect(broken.draft).toEqual({ "player.jump": 600 });
    expect(push).toHaveBeenLastCalledWith(target, { "player.jump": 600, "world.double": false });
    await expect(tuning.save(target, saveDirectly)).rejects.toBeInstanceOf(GameTuningError);
    await writeFile(path.join(workspacePath, "tuning.json"), JSON.stringify(FILE));
    expect((await tuning.state(target)).draft).toEqual({ "player.jump": 600 });
  });

  it("say which state is newer", async () => {
    const { tuning, target } = await project();
    const first = await tuning.state(target);
    const moved = await tuning.setDraft(target, { "player.jump": 600 });
    expect(moved.sequence).toBeGreaterThan(first.sequence);
    expect((await new GameTuning({ push: vi.fn(), publish: vi.fn() }).state(target)).sequence).toBeGreaterThanOrEqual(first.sequence);
  });

  it("announce only what changed", async () => {
    const { tuning, target, publish } = await project();
    await tuning.refresh(target);
    await tuning.refresh(target);
    expect(publish).toHaveBeenCalledTimes(1);
    tuning.setConnected(target, true);
    tuning.setConnected(target, true);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.lastCall?.[1].connected).toBe(true);
  });
});

describe("saving", () => {
  it("writes only the values and keeps everything else in the file", async () => {
    const { tuning, target, workspacePath } = await project();
    await tuning.setDraft(target, { "player.jump": 600 });
    const write = vi.fn(saveDirectly);
    await tuning.save(target, write);
    expect(write).toHaveBeenCalledOnce();
    const raw = await readFile(path.join(workspacePath, "tuning.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ ...FILE, values: [{ ...FILE.values[0], value: 600 }, FILE.values[1]] });
    expect(raw.endsWith("}\n")).toBe(true);
    expect(await tuning.state(target)).toMatchObject({ draft: {}, values: [{ id: "player.jump", value: 600 }, {}] });
  });

  it("keeps a value moved while the save ran as a draft", async () => {
    const { tuning, target } = await project();
    await tuning.setDraft(target, { "player.jump": 600 });
    await tuning.save(target, async (operation) => {
      await operation();
      await tuning.setDraft(target, { "player.jump": 700 });
    });
    expect(await tuning.state(target)).toMatchObject({ draft: { "player.jump": 700 }, values: [{ value: 600 }, {}] });
  });

  it("keeps a value reset while the save ran, against what was saved before", async () => {
    const { tuning, target } = await project();
    await tuning.setDraft(target, { "player.jump": 600 });
    await tuning.save(target, async (operation) => {
      await operation();
      await tuning.setDraft(target, { "player.jump": null });
    });
    expect(await tuning.state(target)).toMatchObject({ draft: { "player.jump": 420 }, values: [{ value: 600 }, {}] });
  });

  it("fits a draft to the file as it is when saving", async () => {
    const { tuning, target, workspacePath } = await project();
    await tuning.setDraft(target, { "player.jump": 700, "world.double": true });
    await writeFile(path.join(workspacePath, "tuning.json"), JSON.stringify({ schemaVersion: 1, values: [
      { id: "player.jump", label: "Jump", value: 200, min: 100, max: 500 },
      { id: "world.double", label: "Double jump", value: 2, min: 1, max: 3 },
    ] }));
    await tuning.save(target, saveDirectly);
    const { values } = JSON.parse(await readFile(path.join(workspacePath, "tuning.json"), "utf8"));
    expect(values.map((item: { value: unknown }) => item.value)).toEqual([500, 2]);
    expect((await tuning.state(target)).error).toBeUndefined();
  });

  it("refuses a save that would make the file too large to read back", async () => {
    const { tuning, target, workspacePath } = await project({ ...FILE, extra: Array.from({ length: 40_000 }, () => 1) });
    await tuning.setDraft(target, { "player.jump": 600 });
    const before = await readFile(path.join(workspacePath, "tuning.json"), "utf8");
    await expect(tuning.save(target, saveDirectly)).rejects.toBeInstanceOf(GameTuningError);
    expect(await readFile(path.join(workspacePath, "tuning.json"), "utf8")).toBe(before);
    expect((await tuning.state(target)).draft).toEqual({ "player.jump": 600 });
  });

  it("keeps the draft when the save is refused", async () => {
    const { tuning, target, workspacePath } = await project();
    await tuning.setDraft(target, { "player.jump": 600 });
    await expect(tuning.save(target, async () => { throw new Error("Wait for the agent"); })).rejects.toThrow("Wait for the agent");
    expect((await tuning.state(target)).draft).toEqual({ "player.jump": 600 });
    expect(JSON.parse(await readFile(path.join(workspacePath, "tuning.json"), "utf8"))).toEqual(FILE);
  });
});

describe("the routes", () => {
  it("save without waiting on themselves, as one undoable change, also while reads and drafts come in", async () => {
    const dataDirectory = await realpath(await mkdtemp(path.join(tmpdir(), "ohmygame-tuning-app-")));
    cleanups.push(dataDirectory);
    const app = createApp({ dataDirectory });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "tuning.json"), JSON.stringify(FILE));
    const inject = (method: "GET" | "PUT" | "POST", url: string, payload?: object) => app.inject({ method, url: `/projects/${project.id}${url}`, ...(payload ? { payload } : {}) });
    const file = async () => JSON.parse(await readFile(path.join(project.workspacePath, "tuning.json"), "utf8")).values[0].value;
    // Restoring remounts open editors and reloads the game, which saving mustn't.
    const version = (await inject("GET", "/tuning")).headers["x-workspace-version"];

    expect((await inject("PUT", "/tuning/draft", { values: { "player.jump": 600 } })).json().draft).toEqual({ "player.jump": 600 });
    const [save, read, draft] = await Promise.all([
      // However the path is spelled, the save mustn't wait for itself.
      inject("POST", "/%74uning/save"),
      inject("GET", "/tuning"),
      inject("PUT", "/tuning/draft", { values: { "player.jump": 610 } }),
    ]);
    expect(save.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(draft.statusCode).toBe(200);
    expect(await file()).toBe(600);

    await inject("PUT", "/tuning/draft", { values: { "player.jump": null } });
    expect((await inject("POST", `/plugin-changes/${save.json().changeId}/undo`)).statusCode).toBe(200);
    expect(await file()).toBe(420);
    const after = await inject("GET", "/tuning");
    expect(after.json().values[0].value).toBe(420);
    expect(after.headers["x-workspace-version"]).toBe(version);
    await app.close();
  });
});
