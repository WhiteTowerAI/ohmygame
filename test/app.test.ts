import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("creates a typed project", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-drama" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Story", type: "interactive-drama" });
  });

  it("loads and updates an Interactive Drama story", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-drama" },
    })).json();

    const loaded = await app.inject({ method: "GET", url: `/projects/${project.id}/story` });
    const story = loaded.json();
    story.chapters[0].title = "The Stopover";
    const updated = await app.inject({ method: "PUT", url: `/projects/${project.id}/story`, payload: story });

    expect(loaded.statusCode).toBe(200);
    expect(story.chapters[0].nodes).toEqual([expect.objectContaining({ type: "start" })]);
    expect(updated.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/story` })).json())
      .toMatchObject({ chapters: [{ title: "The Stopover" }] });
  });

  it("lists projects", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    const first = (await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } })).json();
    const second = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Second" } })).json();

    const response = await app.inject({ method: "GET", url: "/projects" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([second, first]);
  });

  it("renames, duplicates, and deletes projects", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-project-actions-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>First</h1>");

    const renamed = await app.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { name: "Renamed" } });
    const duplicated = await app.inject({ method: "POST", url: `/projects/${project.id}/duplicate` });
    const deleted = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Renamed" });
    expect(duplicated.statusCode).toBe(201);
    expect(duplicated.json()).toMatchObject({ name: "Renamed copy" });
    expect(await readdir(duplicated.json().workspacePath)).toEqual(["index.html"]);
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}` })).statusCode).toBe(404);
  });

  it("exposes read-only workspace code and media", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-workspace-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "hello world.txt"), "Hello\n");
    await writeFile(path.join(project.workspacePath, "cover.png"), Buffer.from([1, 2, 3]));

    const files = await app.inject({ method: "GET", url: `/projects/${project.id}/files` });
    const content = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/content?path=${encodeURIComponent("hello world.txt")}`,
    });
    const media = await app.inject({ method: "GET", url: `/projects/${project.id}/files/raw?path=cover.png` });

    expect(files.json()).toEqual([
      { path: "cover.png", size: 3, mediaType: "image" },
      { path: "hello world.txt", size: 6 },
    ]);
    expect(content.json()).toMatchObject({ path: "hello world.txt", content: "Hello\n", binary: false });
    expect(media.headers["content-type"]).toBe("image/png");
    expect(media.rawPayload).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects unsafe workspace file paths", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-workspace-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/content?path=${encodeURIComponent("../project.json")}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid workspace path" });
  });

  it("validates workspace references before prompting", async () => {
    const prompts: string[] = [];
    const session: CodingSession = {
      messages: [],
      prompt: async (prompt) => { prompts.push(prompt); },
      abort: async () => {},
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-reference-api-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "Hello");
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    const accepted = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Review", references: [{ type: "workspace-file", path: "index.html" }] },
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Review", references: [{ type: "workspace-file", path: "missing.html" }] },
    });

    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => expect(prompts[0]).toContain('["index.html"]'));
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "File not found" });
  });

  it("validates Plugin mentions and sends Codex references to Pi", async () => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-plugin-mention-api-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const mention = { name: "godot", displayName: "Godot", marketplaceId: "opengame" };

    const accepted = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Use @Godot", mentions: [mention] },
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("Use [@Godot](plugin://godot@opengame)"));
    const rejected = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Use @Missing", mentions: [{ name: "missing", displayName: "Missing", marketplaceId: "opengame" }] },
    });

    expect(accepted.statusCode).toBe(202);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "Plugin Missing is not installed" });
  });

  it("returns the skills loaded by the current conversation session", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-capabilities-api-")),
      createSession: async () => ({
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        getSkills: () => [{ name: "review", description: "Review changes" }],
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${conversation.id}/capabilities`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills).toEqual([{ name: "review", description: "Review changes" }]);
  });

  it("accepts an image without text and passes it to Pi", async () => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-image-prompt-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const image = { mediaType: "image/png", data: "aW1hZ2U=" };

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "", images: [image] },
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("", {
      images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
    }));
  });

  it("restores an active image prompt without replaying its base64 event", async () => {
    let finishPrompt!: () => void;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-active-image-")),
      createSession: async () => ({
        messages: [],
        prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
        abort: async () => { finishPrompt(); },
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const image = { mediaType: "image/png", data: "aW1hZ2U=" };
    const turn = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Describe", images: [image] },
    });

    const detail = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` });

    expect(detail.json()).toMatchObject({
      turns: [{
        id: turn.json().turnId,
        conversationId: conversation.id,
        status: "inProgress",
        items: [{ type: "userMessage", text: "Describe", images: [image], turnId: turn.json().turnId }],
      }],
      cursor: 1,
    });
    finishPrompt();
  });

  it("removes only the expected pending follow-up", async () => {
    let finishPrompt!: () => void;
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      followUp: async () => {},
      steer: async () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-pending-api-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "First" },
    });
    const pending = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Second" },
    });

    const stale = await app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/conversations/${conversation.id}/queue/stale-turn`,
    });
    const current = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` });
    const removed = await app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/conversations/${conversation.id}/queue/${pending.json().turnId}`,
    });

    expect(stale.statusCode).toBe(409);
    expect(current.json().pendingPrompts).toEqual([
      expect.objectContaining({ turnId: pending.json().turnId, prompt: "Second" }),
    ]);
    expect(removed.statusCode).toBe(204);
    finishPrompt();
  });

  it("removes and steers queued messages", async () => {
    let finishPrompt!: () => void;
    const followUp = vi.fn(async () => {});
    const steer = vi.fn(async () => {});
    const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      followUp,
      steer,
      clearQueue,
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-queue-api-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "First" } });
    const second = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Second" } })).json();
    const third = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Third" } })).json();

    const steered = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/queue/${third.turnId}/steer` });
    const detail = (await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` })).json();

    expect(steered.statusCode).toBe(204);
    expect(detail.pendingPrompts).toEqual([expect.objectContaining({ turnId: second.turnId, prompt: "Second" })]);
    expect(clearQueue).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenLastCalledWith("Third", undefined);
    finishPrompt();
  });

  it("exposes health and rejects empty prompts", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: " " },
    });
    expect(response.statusCode).toBe(400);
    const preview = await app.inject({ method: "POST", url: `/projects/${project.id}/preview` });
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toEqual({ error: "Workspace is not runnable yet" });
  });

  it("stores and serves a WebP project cover", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-cover-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const cover = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

    const missing = await app.inject({ method: "GET", url: `/projects/${project.id}/cover` });
    const invalid = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/cover`,
      headers: { "content-type": "image/webp" },
      payload: Buffer.from("not-webp"),
    });
    const stored = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/cover`,
      headers: { "content-type": "image/webp" },
      payload: cover,
    });
    const loaded = await app.inject({ method: "GET", url: `/projects/${project.id}/cover` });

    expect(missing.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
    expect(stored.statusCode).toBe(204);
    expect(loaded.statusCode).toBe(200);
    expect(loaded.headers["content-type"]).toBe("image/webp");
    expect(loaded.rawPayload).toEqual(cover);
  });

  it("opens an idle event stream immediately", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-sse-")) });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);

    try {
      const response = await fetch(`${address}/projects/${project.id}/events`, { signal: controller.signal });
      const chunk = await response.body?.getReader().read();
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(chunk?.value)).toBe(": connected\n\n");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  it("titles a new conversation before Pi produces a response", async () => {
    const session: CodingSession = {
      messages: [],
      prompt: async () => { throw new Error("No API key"); },
      abort: async () => {},
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-title-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations`,
    })).json();

    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Build a small game" },
    });
    const conversations = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations`,
    });

    expect(conversations.json()).toEqual([
      expect.objectContaining({ id: conversation.id, title: "Build a small game" }),
    ]);
  });

  it("lists Pi models and stores a conversation model without starting a session", async () => {
    const first = { provider: "provider-one", id: "model-one", name: "Model One", reasoning: true };
    const second = { provider: "provider-one", id: "model-two", name: "Model Two", reasoning: true };
    const runtime = fakeModelRuntime([first, second]);
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-models-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();

    const models = await app.inject({ method: "GET", url: "/models" });
    const created = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations`,
      payload: { model: { provider: first.provider, id: first.id }, reasoningLevel: "medium" },
    });
    const changed = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/conversations/${created.json().id}/model`,
      payload: { provider: second.provider, id: second.id },
    });
    const detail = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${created.json().id}`,
    });
    const reasoning = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/conversations/${created.json().id}/reasoning`,
      payload: { level: "high" },
    });

    expect(models.json()).toEqual({
      models: [
        { provider: first.provider, providerName: first.provider, id: first.id, name: first.name, reasoningLevels: ["off", "minimal", "low", "medium", "high"] },
        { provider: second.provider, providerName: second.provider, id: second.id, name: second.name, reasoningLevels: ["off", "minimal", "low", "medium", "high"] },
      ],
      defaultReasoningLevel: "medium",
    });
    expect(created.json()).toMatchObject({ id: expect.any(String), projectId: project.id, title: "New conversation" });
    expect(changed.json()).toEqual({
      model: { provider: second.provider, id: second.id },
      reasoningLevel: "medium",
    });
    expect(reasoning.json()).toEqual({ level: "high" });
    expect(detail.json().settings.model).toEqual({ provider: second.provider, id: second.id });
  });

  it("applies an OpenAI-compatible endpoint through Pi", async () => {
    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();
    const runtime = {
      ...fakeModelRuntime([]),
      registerProvider,
      unregisterProvider,
    } as unknown as ModelRuntime;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-model-endpoint-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: "/settings/models/providers/openai/endpoint" });
    const custom = await app.inject({
      method: "PUT",
      url: "/settings/models/providers/openai/endpoint",
      payload: { baseUrl: "https://relay.example/v1" },
    });
    const official = await app.inject({
      method: "PUT",
      url: "/settings/models/providers/openai/endpoint",
      payload: { baseUrl: "https://api.openai.com/v1" },
    });

    expect(initial.json()).toEqual({ baseUrl: "https://api.openai.com/v1" });
    expect(custom.json()).toEqual({ baseUrl: "https://relay.example/v1" });
    expect(official.json()).toEqual({ baseUrl: "https://api.openai.com/v1" });
    expect(registerProvider).toHaveBeenCalledWith("openai", { baseUrl: "https://relay.example/v1" });
    expect(unregisterProvider).toHaveBeenCalledWith("openai");
  });

  it("connects and disconnects the OpenGame Portal provider", async () => {
    const runtime = {
      ...fakeModelRuntime([{ provider: "openai", id: "known-model", name: "Known Model" }]),
      getModels: vi.fn(() => [{
        provider: "openai", id: "known-model", name: "Known Model", reasoning: false,
        input: ["text"], contextWindow: 100_000, maxTokens: 10_000,
      }]),
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      setRuntimeApiKey: vi.fn(async () => undefined),
      removeRuntimeApiKey: vi.fn(async () => undefined),
    } as unknown as ModelRuntime;
    const portalFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { base_url: "https://portal.open-game.ai/v1", api_key: "sk-portal" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "known-model" }] }));
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-portal-")),
      createModelRuntime: async () => runtime,
      portalFetch,
    });
    apps.push(app);

    const connected = await app.inject({ method: "PUT", url: "/portal/connection", payload: { accessToken: "user-token" } });
    const disconnected = await app.inject({ method: "DELETE", url: "/portal/connection" });

    expect(connected.json()).toEqual({ status: "connected", modelCount: 1 });
    expect(disconnected.statusCode).toBe(204);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("opengame", "sk-portal");
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith("opengame");
  });

  it("reports Portal connection failures as gateway errors", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-portal-error-")),
      createModelRuntime: async () => fakeModelRuntime([]),
      portalFetch: vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })),
    });
    apps.push(app);

    const response = await app.inject({ method: "PUT", url: "/portal/connection", payload: { accessToken: "user-token" } });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Portal request failed (503)" });
  });

  it("validates request bodies before they reach a manager", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-test-")) });
    apps.push(app);
    const invalidProject = await app.inject({ method: "POST", url: "/projects", payload: { name: 42 } });
    expect(invalidProject.statusCode).toBe(400);
    const invalidProjectType = await app.inject({ method: "POST", url: "/projects", payload: { type: "unknown" } });
    expect(invalidProjectType.statusCode).toBe(400);

    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const invalidPrompt = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: 42 },
    });
    expect(invalidPrompt.statusCode).toBe(400);
    const longName = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "x".repeat(201) },
    });
    expect(longName.statusCode).toBe(400);
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

    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/session-1` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      conversation: expect.objectContaining({
        id: "session-1",
        projectId: project.id,
        title: "Hello",
        messageCount: 2,
      }),
      agent: { status: "idle" },
      settings: {},
      plan: { mode: "normal" },
      turns: [{
        id: "user-1",
        conversationId: "session-1",
        status: "completed",
        items: [
          { id: "user-1", turnId: "user-1", type: "userMessage", text: "Hello", timestamp: 0 },
          { id: "assistant-1:assistant:0", turnId: "user-1", type: "agentMessage", text: "Hi", status: "completed", phase: "final_answer", timestamp: 1 },
        ],
      }],
      cursor: 0,
      pendingPrompts: [],
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
    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/session-1/turns`,
      payload: { prompt: "Current" },
    });

    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/session-1` });

    expect(response.json()).toMatchObject({
      conversation: { id: "session-1" },
      agent: { status: "running" },
      turns: [{
        id: "old-user",
        status: "completed",
        items: [
          { id: "old-user", turnId: "old-user", type: "userMessage", text: "Current" },
          { id: "old-assistant:assistant:0", turnId: "old-user", type: "agentMessage", text: "Answer", status: "completed" },
        ],
      }],
      cursor: 0,
    });
    finishPrompt();
  });
});

function sessionEntry(id: string, parentId: string | null, timestamp: string, message: object): string {
  return JSON.stringify({ type: "message", id, parentId, timestamp, message });
}

function fakeModelRuntime(models: Array<{ provider: string; id: string; name: string }>): ModelRuntime {
  return {
    getAvailable: async (provider?: string) => models.filter((model) => !provider || model.provider === provider),
    getProvider: (provider: string) => ({ name: provider }),
    getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: () => true,
  } as unknown as ModelRuntime;
}
