import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ProjectManager } from "../src/daemon/projects.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A project record with `value` in it; the name and settings wait in it while the new project's folder is empty. */
function changed(record: Record<string, unknown>, value: Record<string, unknown>): Record<string, unknown> {
  const { version, id, type, ...settings } = value;
  return { ...record, ...(version === undefined ? {} : { version }), ...(id === undefined ? {} : { id }), ...(type === undefined ? {} : { type }), settings: { ...(record.settings as object), ...settings } };
}

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-loading-"));
  directories.push(directory);
  return directory;
}

describe("project loading", () => {
  it.each([
    { kind: "malformed JSON", value: "{" },
    { kind: "null", value: "null" },
    { kind: "invalid shape", value: "[]" },
    { kind: "unknown project type", value: { type: "future-game" } },
    { kind: "unknown metadata version", value: { version: 3 } },
    { kind: "mismatched project ID", value: { id: randomUUID() } },
    { kind: "invalid settings", value: { previewViewport: "unsupported" } },
  ])("keeps loading healthy projects alongside $kind without changing the skipped project", async ({ value }) => {
    const directory = await dataDirectory();
    const writer = new ProjectManager(directory);
    const healthy = await writer.create("Healthy", "general");
    const broken = await writer.create("Keep my files");
    const projectDirectory = path.dirname(broken.workspacePath);
    const metadataFile = path.join(projectDirectory, "project.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    const contents = typeof value === "string" ? value : JSON.stringify(changed(metadata, value));
    await writeFile(metadataFile, contents);
    await writeFile(path.join(broken.workspacePath, "notes.txt"), "Keep original workspace files.\n");

    const manager = new ProjectManager(directory);
    const onError = vi.fn();
    await manager.load(onError);

    expect(manager.list()).toEqual([expect.objectContaining({ id: healthy.id, type: "general" })]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(projectDirectory, expect.any(Error));
    expect(await readFile(metadataFile, "utf8")).toBe(contents);
    expect(await readFile(path.join(broken.workspacePath, "notes.txt"), "utf8")).toBe("Keep original workspace files.\n");

    await writeFile(metadataFile, JSON.stringify(metadata));
    const recovered = new ProjectManager(directory);
    await recovered.load();
    expect(recovered.get(broken.id)).toMatchObject({ id: broken.id, name: "Keep my files" });
  });

  it("continues past failures across multiple batches of concurrent project loads", async () => {
    const directory = await dataDirectory();
    const writer = new ProjectManager(directory);
    const projects = await Promise.all(Array.from({ length: 20 }, (_, index) => writer.create(`Project ${index}`)));
    const broken = projects.slice(0, 10);
    await Promise.all(broken.map((project) => writeFile(path.join(path.dirname(project.workspacePath), "project.json"), "{")));

    const manager = new ProjectManager(directory);
    const onError = vi.fn();
    await manager.load(onError);

    expect(manager.list().map((project) => project.id).sort()).toEqual(projects.slice(10).map((project) => project.id).sort());
    expect(onError).toHaveBeenCalledTimes(broken.length);
    expect(onError.mock.calls.map(([directory]) => directory).sort()).toEqual(broken.map((project) => path.dirname(project.workspacePath)).sort());
  });

  it("skips a project whose metadata cannot be read", async () => {
    const directory = await dataDirectory();
    const writer = new ProjectManager(directory);
    const healthy = await writer.create("Healthy");
    const broken = await writer.create("Unreadable");
    const metadataFile = path.join(path.dirname(broken.workspacePath), "project.json");
    await rm(metadataFile);
    await mkdir(metadataFile);
    await writeFile(path.join(metadataFile, "keep.txt"), "Keep metadata directory.\n");

    const manager = new ProjectManager(directory);
    const onError = vi.fn();
    await manager.load(onError);

    expect(manager.list()).toEqual([expect.objectContaining({ id: healthy.id })]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(path.dirname(broken.workspacePath), expect.any(Error));
    expect(await readFile(path.join(metadataFile, "keep.txt"), "utf8")).toBe("Keep metadata directory.\n");
  });

  it("still recovers a project with missing metadata", async () => {
    const directory = await dataDirectory();
    const id = randomUUID();
    const projectDirectory = path.join(directory, "projects", id);
    await mkdir(path.join(projectDirectory, "workspace"), { recursive: true });
    const manager = new ProjectManager(directory);
    const onError = vi.fn();
    await manager.load(onError);

    expect(manager.get(id)).toMatchObject({ name: "Untitled project", type: "web-game" });
    expect(JSON.parse(await readFile(path.join(projectDirectory, "project.json"), "utf8"))).toEqual({ version: 2, id, updatedAt: expect.any(String), type: "web-game" });
    expect(JSON.parse(await readFile(path.join(projectDirectory, "workspace/.ohmygame/settings.json"), "utf8"))).toEqual({ version: 1, name: "Untitled project", kind: "web-game" });
    expect(JSON.parse(await readFile(path.join(projectDirectory, "workspace/ohmygame.json"), "utf8"))).toMatchObject({ type: "general" });
    expect(onError).not.toHaveBeenCalled();

    // Without the record or ohmygame.json, the settings' kind says the type.
    const godot = randomUUID();
    const godotWorkspace = path.join(directory, "projects", godot, "workspace");
    await mkdir(path.join(godotWorkspace, ".ohmygame"), { recursive: true });
    await writeFile(path.join(godotWorkspace, ".ohmygame/settings.json"), JSON.stringify({ version: 1, name: "Old Godot", kind: "godot-game" }));
    const next = new ProjectManager(directory);
    await next.load();
    expect(next.get(godot)).toMatchObject({ name: "Old Godot", type: "godot-game" });
  });

  it("moves an older record's name and settings into the folder, which is then the record", async () => {
    const directory = await dataDirectory();
    const id = randomUUID();
    const projectDirectory = path.join(directory, "projects", id);
    await mkdir(path.join(projectDirectory, "workspace"), { recursive: true });
    await writeFile(path.join(projectDirectory, "project.json"), JSON.stringify({
      version: 1, id, name: "Old Garden", nameSource: "manual", type: "general", webPreviewEnabled: false, updatedAt: "2026-10-01T00:00:00.000Z", startupScript: "start",
    }));
    const manager = new ProjectManager(directory);
    await manager.load();
    expect(manager.get(id)).toMatchObject({ name: "Old Garden", type: "general", startupScript: "start" });
    expect(JSON.parse(await readFile(path.join(projectDirectory, "project.json"), "utf8"))).toEqual({ version: 2, id, nameSource: "manual", updatedAt: "2026-10-01T00:00:00.000Z", type: "general" });
    const settingsFile = path.join(projectDirectory, "workspace/.ohmygame/settings.json");
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ version: 1, name: "Old Garden", webPreviewEnabled: false, startupScript: "start" });
    // The type goes to the folder's ohmygame.json.
    expect(JSON.parse(await readFile(path.join(projectDirectory, "workspace/ohmygame.json"), "utf8"))).toMatchObject({ type: "general" });

    // The folder's file decides: one edited there is what the next start reads.
    await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(await readFile(settingsFile, "utf8")), name: "Edited Garden" }));
    const next = new ProjectManager(directory);
    await next.load();
    expect(next.get(id)?.name).toBe("Edited Garden");
  });

  it("never writes over settings it can't read, from a folder that is gone or a file that is broken", async () => {
    const directory = await dataDirectory();
    const folder = await dataDirectory();
    const writer = new ProjectManager(directory);
    const project = await writer.create("Sky Garden", "general", folder);
    await writer.setAppearance(project.id, { icon: "leaf" });
    const settingsFile = path.join(folder, ".ohmygame/settings.json");
    const saved = await readFile(settingsFile, "utf8");

    // A folder that isn't there shows by its name, and keeps nothing for it in the record.
    const away = `${folder}-away`;
    await rename(folder, away);
    const offline = new ProjectManager(directory);
    await offline.load();
    expect(offline.get(project.id)).toMatchObject({ name: path.basename(folder), workspaceAvailable: false });
    await expect(offline.rename(project.id, "Wrong")).rejects.toThrow("settings.json");
    expect(JSON.parse(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8"))).not.toHaveProperty("settings");
    await rename(away, folder);
    const back = new ProjectManager(directory);
    await back.load();
    expect(back.get(project.id)).toMatchObject({ name: "Sky Garden", appearance: { icon: "leaf" } });

    // A file that can't be read is left for the person to fix.
    await writeFile(settingsFile, "{");
    const broken = new ProjectManager(directory);
    await broken.load();
    await expect(broken.setAppearance(project.id, { icon: "star" })).rejects.toThrow("settings.json");
    // Nor is anything else of its look changed, copied or exported with stand-ins.
    const logo = path.join(folder, ".ohmygame/logo.webp");
    await writeFile(logo, "logo");
    await expect(broken.setLogo(project.id, undefined)).rejects.toThrow("settings.json");
    expect(await readFile(logo, "utf8")).toBe("logo");
    await expect(broken.duplicate(project.id)).rejects.toThrow("settings.json");
    expect(await readFile(settingsFile, "utf8")).toBe("{");
    // Opening the folder anew doesn't keep stand-ins either, so the fixed file is what comes back.
    await broken.remove(project.id);
    const opened = await broken.create(undefined, "general", folder);
    await expect(broken.rename(opened.id, "Stand-in")).rejects.toThrow("settings.json");
    expect(JSON.parse(await readFile(path.join(directory, "projects", opened.id, "project.json"), "utf8"))).not.toHaveProperty("settings");
    await writeFile(settingsFile, saved);
    // Repaired while the app runs, the next change starts from the file, not the stand-ins.
    expect(broken.get(opened.id)?.type).toBe("general");
    await broken.setAppearance(opened.id, { icon: "leaf" });
    expect(broken.get(opened.id)).toMatchObject({ name: "Sky Garden", type: "general" });
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({ name: "Sky Garden" });
    const fixed = new ProjectManager(directory);
    await fixed.load();
    expect(fixed.get(opened.id)).toMatchObject({ name: "Sky Garden", appearance: { icon: "leaf" } });
  });

  it("keeps what changed in the folder's file while the app runs, as through Git", async () => {
    const directory = await dataDirectory();
    const folder = await dataDirectory();
    await writeFile(path.join(folder, "README.md"), "mine");
    const manager = new ProjectManager(directory);
    const project = await manager.create("Sky Garden", "general", folder);
    const settingsFile = path.join(folder, ".ohmygame/settings.json");
    const pulled = { ...JSON.parse(await readFile(settingsFile, "utf8")), startupScript: "start" };
    await writeFile(settingsFile, JSON.stringify(pulled));
    // What only this computer keeps leaves the file as it is.
    await manager.touch(project.id);
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual(pulled);
    // A change to the settings goes onto the file as it is now.
    await manager.rename(project.id, "Moon Garden");
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({ name: "Moon Garden", startupScript: "start" });
    expect(manager.get(project.id)).toMatchObject({ name: "Moon Garden", startupScript: "start" });
    // So do a change that merges with what is there, and a copy.
    await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(await readFile(settingsFile, "utf8")), appearance: { icon: "star" }, startupScript: "play" }));
    await manager.setLogo(project.id, new Uint8Array([1]));
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({ appearance: { icon: "star", logo: true }, startupScript: "play" });
    const copy = await manager.duplicate(project.id);
    expect(JSON.parse(await readFile(path.join(copy.workspacePath, ".ohmygame/settings.json"), "utf8"))).toMatchObject({ name: "Moon Garden copy", startupScript: "play" });

    // A file that breaks while the app runs is left alone, and nothing stands in for it.
    await writeFile(settingsFile, "{");
    await expect(manager.rename(project.id, "Wrong")).rejects.toThrow("settings.json");
    await expect(manager.setLogo(project.id, undefined)).rejects.toThrow("settings.json");
    expect(await readFile(path.join(folder, ".ohmygame/logo.webp"))).toHaveLength(1);
    await expect(manager.duplicate(project.id)).rejects.toThrow("settings.json");
    await manager.touch(project.id);
    expect(await readFile(settingsFile, "utf8")).toBe("{");
    expect(JSON.parse(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8"))).not.toHaveProperty("settings");
    // Fixed, it is read again without a restart.
    await writeFile(settingsFile, JSON.stringify({ version: 1, name: "Fixed Garden", webPreviewEnabled: false }));
    await manager.setAppearance(project.id, { icon: "leaf" });
    expect(manager.get(project.id)).toMatchObject({ name: "Fixed Garden", type: "general", webPreviewEnabled: false, appearance: { icon: "leaf" } });
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({ webPreviewEnabled: false });
    // A run setting changed there stays when another one changes here.
    await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(await readFile(settingsFile, "utf8")), previewPath: "/play" }));
    await manager.setStartupDirectory(project.id, ".");
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({ previewPath: "/play" });
  });

  it("doesn't name a project automatically once its folder's file has a name of its own", async () => {
    const directory = await dataDirectory();
    const manager = new ProjectManager(directory);
    const project = await manager.create(undefined, "general");
    await writeFile(path.join(project.workspacePath, "README.md"), "mine");
    await manager.touch(project.id);
    await manager.setAppearance(project.id, { icon: "leaf" });
    const settingsFile = path.join(project.workspacePath, ".ohmygame/settings.json");
    await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(await readFile(settingsFile, "utf8")), name: "Chosen in Git" }));
    expect(await manager.nameAutomatically(project.id, "Generated title")).toBeUndefined();
    expect(JSON.parse(await readFile(settingsFile, "utf8")).name).toBe("Chosen in Git");
  });

  it("answers 409 to exporting or changing settings it can't read", async () => {
    const directory = await dataDirectory();
    const folder = await dataDirectory();
    await writeFile(path.join(folder, "README.md"), "mine");
    const project = await new ProjectManager(directory).create("Sky Garden", "general", folder);
    await writeFile(path.join(folder, ".ohmygame/settings.json"), "{");
    const app = createApp({ dataDirectory: directory });
    apps.push(app);
    await app.ready();
    const exported = await app.inject({ method: "POST", url: `/projects/${project.id}/export` });
    expect(exported.statusCode).toBe(409);
    expect(exported.json().error).toContain("settings.json");
    expect((await app.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { name: "Other" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/projects/${project.id}/appearance`, payload: { icon: "leaf" } })).statusCode).toBe(409);
  });

  it("tells the new-project dialog the type a folder names, and refuses another", async () => {
    const directory = await dataDirectory();
    const folder = await dataDirectory();
    const writer = new ProjectManager(directory);
    const story = await writer.create("Night Train", "interactive-story", folder);
    await writeFile(path.join(folder, "graph.json"), "{}");
    await writer.setAppearance(story.id, { icon: "leaf" });
    await writer.remove(story.id);
    const app = createApp({ dataDirectory: directory });
    apps.push(app);
    await app.ready();
    const named = await app.inject({ method: "POST", url: "/projects/folder-type", payload: { workspacePath: folder } });
    expect(named.json()).toEqual({ type: "interactive-story" });
    expect((await app.inject({ method: "POST", url: "/projects/folder-type", payload: { workspacePath: await dataDirectory() } })).json()).toEqual({});
    expect((await app.inject({ method: "POST", url: "/projects/folder-type", payload: { workspacePath: "relative" } })).statusCode).toBe(400);
    const refused = await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game", workspacePath: folder } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain("says it is interactive-story");
    expect(JSON.parse(await readFile(path.join(folder, ".ohmygame/settings.json"), "utf8"))).toMatchObject({ name: "Night Train", appearance: { icon: "leaf" } });
  });

  it("still rejects an unavailable project storage directory", async () => {
    const directory = await dataDirectory();
    await writeFile(path.join(directory, "projects"), "This is a file.\n");
    const onError = vi.fn();
    await expect(new ProjectManager(directory).load(onError)).rejects.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([false, true])("starts the daemon and logs skipped project paths (all projects invalid: %s)", async (allInvalid) => {
    const directory = await dataDirectory();
    const writer = new ProjectManager(directory);
    const healthy = allInvalid ? undefined : await writer.create("Healthy");
    const broken = await writer.create("Unsupported");
    const projectDirectory = path.dirname(broken.workspacePath);
    const metadataFile = path.join(projectDirectory, "project.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    const contents = JSON.stringify(changed(metadata, { type: "future-game" }));
    await writeFile(metadataFile, contents);

    const app = createApp({ dataDirectory: directory });
    apps.push(app);
    const warn = vi.spyOn(app.log, "warn");
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual(healthy ? [expect.objectContaining({ id: healthy.id })] : []);
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error), projectDirectory },
      "Could not load project; skipped during startup",
    );
    expect(await readFile(metadataFile, "utf8")).toBe(contents);
  });
});

describe.each([
  { name: "MiniMax", flag: "minimax", legacy: { provider: "minimax-video-global", id: "MiniMax-H3" }, plugin: { provider: "plugin.ohmygame.minimax.global", id: "MiniMax-H3" }, alternate: { provider: "minimax-video-cn", id: "MiniMax-H3-Max" }, mappedAlternate: { provider: "plugin.ohmygame.minimax.cn", id: "MiniMax-H3-Max" }, sourceImage: { provider: "another-provider", id: "keep-image" }, image: { provider: "another-provider", id: "keep-image" } },
  { name: "Seedance", flag: "seedance", legacy: { provider: "byteplus-modelark", id: "dreamina-seedance-2-0-260128" }, plugin: { provider: "plugin.ohmygame.seedance.byteplus", id: "dreamina-seedance-2-0-260128" }, alternate: { provider: "volcengine-ark", id: "doubao-seedance-2-5-260628" }, mappedAlternate: { provider: "plugin.ohmygame.seedance.ark", id: "doubao-seedance-2-5-260628" }, sourceImage: { provider: "volcengine-ark", id: "doubao-seedream-5-0-pro-260628" }, image: { provider: "plugin.ohmygame.seedance.ark", id: "doubao-seedream-5-0-pro-260628" } },
] as const)("committed $name project defaults", ({ flag, legacy, plugin, alternate, mappedAlternate, sourceImage, image }) => {
  async function fixture() {
    const directory = await dataDirectory(), writer = new ProjectManager(directory);
    const project = await writer.create("Migration garden", "general");
    await writer.setMediaModelDefaults(project.id, { video: legacy, image: sourceImage });
    const file = path.join(project.workspacePath, ".ohmygame/settings.json");
    const recordFile = path.join(directory, "projects", project.id, "project.json");
    const settings = { ...JSON.parse(await readFile(file, "utf8")), future: { nested: "keep portable" } };
    const record = { ...JSON.parse(await readFile(recordFile, "utf8")), extension: { keep: "local" } };
    await writeFile(file, JSON.stringify(settings)); await writeFile(recordFile, JSON.stringify(record));
    return { directory, writer, project, file, recordFile, settings, record };
  }

  it.each([false, true])("migrates only committed profiles and preserves unknown data and order (%s)", async (committed) => {
    const { directory, project, file, recordFile, settings, record } = await fixture();
    const settingsBefore = await readFile(file, "utf8"), recordBefore = await readFile(recordFile, "utf8");
    const jobsFile = path.join(project.workspacePath, "canvas/jobs.json");
    await mkdir(path.dirname(jobsFile), { recursive: true }); await writeFile(jobsFile, "opaque jobs and recovery IDs");
    const manager = new ProjectManager(directory, undefined, undefined, { [flag]: committed }), error = vi.fn();
    await manager.load(error);
    expect(error).not.toHaveBeenCalled();
    expect(manager.get(project.id)).toMatchObject({ updatedAt: project.updatedAt, mediaModelDefaults: { video: committed ? plugin : legacy, image: committed ? image : sourceImage } });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...settings, mediaModelDefaults: { video: committed ? plugin : legacy, image: committed ? image : sourceImage } });
    expect(JSON.parse(await readFile(recordFile, "utf8"))).toEqual(record);
    expect(await readFile(jobsFile, "utf8")).toBe("opaque jobs and recovery IDs");
    if (!committed) {
      expect(await readFile(file, "utf8")).toBe(settingsBefore);
      expect(await readFile(recordFile, "utf8")).toBe(recordBefore);
    }
    const after = await readFile(file, "utf8");
    const reopened = new ProjectManager(directory, undefined, undefined, { [flag]: committed }); await reopened.load();
    expect(await readFile(file, "utf8")).toBe(after);
  });

  it("keeps pending defaults and unknown fields while the folder is unavailable, then carries them into the restored folder", async () => {
    const directory = await dataDirectory(), writer = new ProjectManager(directory);
    const project = await writer.create("Pending garden", "general");
    const recordFile = path.join(directory, "projects", project.id, "project.json");
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    record.extension = { keep: true };
    record.settings = { ...record.settings, mediaModelDefaults: { video: legacy, image: sourceImage }, future: { keep: true } };
    await writeFile(recordFile, JSON.stringify(record));
    const moved = `${project.workspacePath}-offline`; await rename(project.workspacePath, moved);
    const offline = new ProjectManager(directory, undefined, undefined, { [flag]: true }); await offline.load();
    expect(offline.get(project.id)).toMatchObject({ workspaceAvailable: false, mediaModelDefaults: { video: plugin, image } });
    expect(JSON.parse(await readFile(recordFile, "utf8"))).toMatchObject({ extension: { keep: true }, settings: { future: { keep: true }, mediaModelDefaults: { video: plugin, image } } });
    await rename(moved, project.workspacePath);
    const restored = new ProjectManager(directory, undefined, undefined, { [flag]: true }); await restored.load();
    expect(restored.get(project.id)).toMatchObject({ workspaceAvailable: true, mediaModelDefaults: { video: plugin, image } });
    expect(JSON.parse(await readFile(path.join(project.workspacePath, ".ohmygame/settings.json"), "utf8"))).toMatchObject({ future: { keep: true }, mediaModelDefaults: { video: plugin, image } });
    const savedRecord = JSON.parse(await readFile(recordFile, "utf8"));
    expect(savedRecord.extension).toEqual({ keep: true }); expect(savedRecord).not.toHaveProperty("settings");
  });

  it("maps old record defaults while preserving unknown record fields through layout upgrade", async () => {
    const directory = await dataDirectory(), id = randomUUID(), root = path.join(directory, "projects", id);
    await mkdir(path.join(root, "workspace"), { recursive: true });
    await writeFile(path.join(root, "project.json"), JSON.stringify({ version: 1, id, name: "Legacy", type: "general", updatedAt: "2026-10-01T00:00:00.000Z", mediaModelDefaults: { video: legacy }, extension: { preserve: true } }));
    const manager = new ProjectManager(directory, undefined, undefined, { [flag]: true }); await manager.load();
    expect(manager.get(id)?.mediaModelDefaults?.video).toEqual(plugin);
    expect(JSON.parse(await readFile(path.join(root, "project.json"), "utf8"))).toMatchObject({ version: 2, extension: { preserve: true } });
    expect(JSON.parse(await readFile(path.join(root, "workspace/.ohmygame/settings.json"), "utf8"))).toMatchObject({ mediaModelDefaults: { video: plugin } });
  });

  it("shares mapping across external-folder registration, imported settings, duplication and saves", async () => {
    const { project, settings } = await fixture();
    const directory = await dataDirectory(), manager = new ProjectManager(directory, undefined, undefined, { [flag]: true });
    const opened = await manager.create(undefined, "general", project.workspacePath);
    expect(opened.mediaModelDefaults).toEqual({ video: plugin, image });
    const copied = await manager.duplicate(opened.id);
    expect(copied.mediaModelDefaults).toEqual({ video: plugin, image });
    expect(JSON.parse(await readFile(path.join(copied.workspacePath, ".ohmygame/settings.json"), "utf8"))).toMatchObject({ future: settings.future });
    const staged = path.join(await dataDirectory(), "workspace"); await mkdir(staged);
    const imported = await manager.import(staged, { name: "Imported", type: "general", mediaModelDefaults: { video: legacy, image: sourceImage } });
    expect(imported.mediaModelDefaults).toEqual({ video: plugin, image });
    expect((await manager.setMediaModelDefaults(imported.id, { video: alternate, image: sourceImage })).mediaModelDefaults).toEqual({ video: mappedAlternate, image });
  });

  it("serializes refreshed defaults with edits, preserves extensions, and does not restore a cleared choice", async () => {
    const { directory, project, file, settings } = await fixture();
    const manager = new ProjectManager(directory, undefined, undefined, { [flag]: true }); await manager.load();
    await writeFile(file, JSON.stringify({ ...settings, name: "External title", mediaModelDefaults: { video: legacy, image: sourceImage } }));
    await Promise.all([manager.readySettings(project.id), manager.rename(project.id, "Edited title"), manager.readySettings(project.id)]);
    expect(manager.get(project.id)).toMatchObject({ name: "Edited title", mediaModelDefaults: { video: plugin, image } });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ name: "Edited title", future: settings.future });
    await manager.setMediaModelDefaults(project.id, {});
    await manager.readySettings(project.id);
    const restored = new ProjectManager(directory, undefined, undefined, { [flag]: true }); await restored.load();
    expect(restored.get(project.id)?.mediaModelDefaults).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("mediaModelDefaults");
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty("future", settings.future);
  });

  it.each(["future", "broken", "unknown-reference-data"])("refuses %s portable settings without replacing them", async (kind) => {
    const { directory, project, file, settings } = await fixture();
    const value = structuredClone(settings);
    if (kind === "future") value.version = 2;
    if (kind === "unknown-reference-data") value.mediaModelDefaults.video.future = "keep";
    const bytes = kind === "broken" ? "{invalid" : JSON.stringify(value); await writeFile(file, bytes);
    const manager = new ProjectManager(directory, undefined, undefined, { [flag]: true }); await manager.load();
    await expect(manager.rename(project.id, "Wrong")).rejects.toThrow("settings.json");
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("refuses a newly unreadable record before changing portable settings", async () => {
    const { directory, project, file, recordFile } = await fixture();
    const manager = new ProjectManager(directory, undefined, undefined, { [flag]: true }); await manager.load();
    const before = await readFile(file, "utf8"), record = JSON.stringify({ version: 3, id: project.id, future: "keep" });
    await writeFile(recordFile, record);
    await expect(manager.rename(project.id, "Wrong")).rejects.toThrow("settings.json");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readFile(recordFile, "utf8")).toBe(record);
  });

  it("refuses hard-linked portable settings without modifying either name", async () => {
    const { directory, project, file } = await fixture();
    const alias = path.join(directory, "settings-alias.json");
    await link(file, alias);
    const before = await readFile(alias, "utf8");
    const manager = new ProjectManager(directory, undefined, undefined, { [flag]: true }); await manager.load();
    await expect(manager.rename(project.id, "Wrong")).rejects.toThrow("settings.json");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readFile(alias, "utf8")).toBe(before);
  });

});
