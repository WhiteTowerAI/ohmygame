import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { CodingSession } from "../src/daemon/agent.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("daemon", () => {
  it("creates an isolated empty project", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } });
    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project.name).toBe("First");
    expect(await readdir(project.workspacePath)).toEqual([]);
    expect(project.preview).toEqual({ status: "waiting" });
  });

  it("lists projects", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    const first = (await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } })).json();
    const second = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Second" } })).json();

    const response = await app.inject({ method: "GET", url: "/projects" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([first, second]);
  });

  it("exposes health and rejects empty prompts", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const response = await app.inject({ method: "POST", url: `/projects/${project.id}/prompts`, payload: { prompt: " " } });
    expect(response.statusCode).toBe(400);
    const preview = await app.inject({ method: "POST", url: `/projects/${project.id}/preview` });
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toEqual({ error: "Workspace is not runnable yet" });
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

  it("restores a project after an app restart", async () => {
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
    expect(restored.json()).toMatchObject({ id: project.id, name: "Persistent" });
    expect(restored.json()).not.toHaveProperty("canUndo");
  });

  it("restores conversation history from the project's Pi session", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-conversation-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const sessionDirectory = path.join(dataDirectory, "projects", project.id, "session");
    await mkdir(sessionDirectory);
    await writeFile(path.join(sessionDirectory, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date(0).toISOString(), cwd: project.workspacePath }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 0 },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: new Date(0).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop", timestamp: 1 },
      }),
    ].join("\n") + "\n");

    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/conversation` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { id: "user-1", kind: "user", text: "Hello" },
        { id: "assistant-1", kind: "assistant", text: "Hi", status: "complete" },
      ],
      cursor: 0,
    });
  });

  it("replays only the active turn from SSE when conversation is loaded mid-run", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-active-conversation-"));
    let finishPrompt!: () => void;
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({ dataDirectory, createSession: async () => session });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const sessionDirectory = path.join(dataDirectory, "projects", project.id, "session");
    await mkdir(sessionDirectory);
    const oldTimestamp = new Date(Date.now() - 10_000).toISOString();
    const currentTimestamp = new Date(Date.now() + 10_000).toISOString();
    await writeFile(path.join(sessionDirectory, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date(0).toISOString(), cwd: project.workspacePath }),
      sessionEntry("old-user", null, oldTimestamp, { role: "user", content: "Current", timestamp: 0 }),
      sessionEntry("old-assistant", "old-user", oldTimestamp, { role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop", timestamp: 1 }),
      sessionEntry("current-user", "old-assistant", currentTimestamp, { role: "user", content: "Current", timestamp: 2 }),
    ].join("\n") + "\n");
    await app.inject({ method: "POST", url: `/projects/${project.id}/prompts`, payload: { prompt: "Current" } });

    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/conversation` });

    expect(response.json()).toEqual({
      items: [
        { id: "old-user", kind: "user", text: "Current" },
        { id: "old-assistant", kind: "assistant", text: "Answer", status: "complete" },
      ],
      cursor: 0,
    });
    finishPrompt();
  });
});

function sessionEntry(id: string, parentId: string | null, timestamp: string, message: object): string {
  return JSON.stringify({ type: "message", id, parentId, timestamp, message });
}
