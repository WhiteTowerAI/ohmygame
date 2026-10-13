import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    { kind: "unknown metadata version", value: { version: 2 } },
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
    const contents = typeof value === "string" ? value : JSON.stringify({ ...metadata, ...value });
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
    expect(JSON.parse(await readFile(path.join(projectDirectory, "project.json"), "utf8"))).toMatchObject({ version: 1, id, type: "web-game" });
    expect(onError).not.toHaveBeenCalled();
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
    const contents = JSON.stringify({ ...metadata, type: "future-game" });
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
