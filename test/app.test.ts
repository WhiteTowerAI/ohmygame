import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("daemon", () => {
  it("creates an isolated project from the starter", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } });
    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project.name).toBe("First");
    expect(await readFile(path.join(project.workspacePath, "index.html"), "utf8")).toContain("New project");
  });

  it("exposes health and rejects empty prompts", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const response = await app.inject({ method: "POST", url: `/projects/${project.id}/prompts`, payload: { prompt: " " } });
    expect(response.statusCode).toBe(400);
  });

  it("validates request bodies before they reach a manager", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    const invalidProject = await app.inject({ method: "POST", url: "/projects", payload: { name: 42 } });
    expect(invalidProject.statusCode).toBe(400);

    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const invalidPrompt = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/prompts`,
      payload: { prompt: 42 },
    });
    expect(invalidPrompt.statusCode).toBe(400);
  });

  it("restores a project and its timeline after an app restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-restart-"));
    const first = createApp({ dataDirectory });
    apps.push(first);
    await first.ready();
    const project = (await first.inject({ method: "POST", url: "/projects", payload: { name: "Persistent" } })).json();
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createApp({ dataDirectory });
    apps.push(second);
    await second.ready();
    const restored = await second.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: project.id, name: "Persistent", canUndo: false });

    const events = await readFile(path.join(dataDirectory, "projects", project.id, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"project.created"');
  });

  it("closes an interrupted agent turn during recovery", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-interrupted-"));
    const id = "1df6a50b-78e2-46b2-a96a-c97072d935f4";
    const projectDirectory = path.join(dataDirectory, "projects", id);
    await mkdir(path.join(projectDirectory, "workspace"), { recursive: true });
    await writeFile(path.join(projectDirectory, "project.json"), JSON.stringify({ version: 1, id, name: "Interrupted" }));
    await writeFile(path.join(projectDirectory, "events.jsonl"), `${JSON.stringify({
      id: 1,
      projectId: id,
      type: "agent.started",
      timestamp: new Date(0).toISOString(),
      data: { prompt: "Build" },
    })}\n`);

    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();

    expect((await app.inject({ method: "GET", url: `/projects/${id}` })).json().agent).toEqual({ status: "idle" });
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const persisted = await readFile(path.join(projectDirectory, "events.jsonl"), "utf8");
    expect(persisted).toContain('"type":"agent.cancelled"');
  });

  it("restores the previous workspace through the undo endpoint", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-undo-"));
    const id = "1df6a50b-78e2-46b2-a96a-c97072d935f4";
    const projectDirectory = path.join(dataDirectory, "projects", id);
    await mkdir(path.join(projectDirectory, "workspace"), { recursive: true });
    await mkdir(path.join(projectDirectory, "snapshots", "previous"), { recursive: true });
    await writeFile(path.join(projectDirectory, "project.json"), JSON.stringify({ version: 1, id, name: "Undo" }));
    await writeFile(path.join(projectDirectory, "workspace", "game.js"), "after");
    await writeFile(path.join(projectDirectory, "snapshots", "previous", "game.js"), "before");
    const app = createApp({ dataDirectory });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/projects/${id}/undo` });

    expect(response.statusCode).toBe(200);
    expect(response.json().project.canUndo).toBe(false);
    expect(await readFile(path.join(projectDirectory, "workspace", "game.js"), "utf8")).toBe("before");
  });
});
