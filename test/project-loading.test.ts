import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
