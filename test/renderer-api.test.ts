import { afterEach, describe, expect, it, vi } from "vitest";
import { addExploreAssetToProject, addToolResultToProject, approvePlan, cancelPlan, compactConversation, createAssetTemplate, createConversation, deleteAsset, deleteProject, duplicateProject, getConversation, getConversationCapabilities, getConversationContextUsage, getExploreGameCover, getHomeComposerCapabilities, getModel3DGenerationSettings, getOpenAIEndpointSettings, getProjectCover, getToolRunFile, getWorkspaceAsset, getWorkspaceFile, inspectPluginSource, installCatalogPlugin, installPlugin, listAssetTemplates, listExploreAssets, listExploreTemplates, listModels, listPlugins, listProjects, listTools, listWorkspaceFiles, publishAsset, publishAssetTemplate, publishPlugin, publishProject, readPlugin, readPluginSkill, refinePlan, removePendingPrompt, renameAsset, renameConversation, renameProject, reviseLastPrompt, runTool, sendPrompt, setConversationModel, setConversationReasoning, setProjectCover, steerPendingPrompt, subscribeToProject, uninstallPlugin, updateModel3DGenerationSettings, updateOpenAIEndpointSettings, updatePluginSettings } from "../src/renderer/api.js";
import type { RuntimeEvent } from "../src/shared/contracts.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderer event stream", () => {
  it("uses the Asset Template save, Explore, and publish endpoints", async () => {
    installWindow();
    const definition = {
      mode: "image" as const, name: "Character", description: "", promptLabel: "Prompt",
      promptPlaceholder: "Describe a character", defaults: { imageResolution: "1K" as const },
    };
    const local = { ...definition, id: "local-1", source: "local" as const, createdAt: new Date(0).toISOString() };
    const remote = { ...definition, id: "remote-1", source: "catalog" as const, releaseId: "release-1", publishedAt: new Date(0).toISOString() };
    const published = { template: { id: "remote-1" }, release: { id: "release-1" } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([local]))
      .mockResolvedValueOnce(Response.json(local, { status: 201 }))
      .mockResolvedValueOnce(Response.json([remote]))
      .mockResolvedValueOnce(Response.json(published, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAssetTemplates()).resolves.toEqual([local]);
    await expect(createAssetTemplate(definition)).resolves.toEqual(local);
    await expect(listExploreTemplates()).resolves.toEqual([remote]);
    await expect(publishAssetTemplate("local-1", "token")).resolves.toEqual(published);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/asset-templates", expect.objectContaining({ method: "POST", body: JSON.stringify(definition) }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/asset-templates/local-1/publish", expect.objectContaining({ method: "POST", body: JSON.stringify({ accessToken: "token" }) }));
  });

  it("handles chunked UTF-8 and ignores malformed events", async () => {
    installWindow();
    const content = [
      sse(1, "agent.started", { prompt: "Build" }),
      "event: item.agentMessage.delta\ndata: {bad json}\n\n",
      sse(2, "item.agentMessage.delta", { itemId: "assistant-1", delta: "你好" }),
    ].join("");
    const encoded = new TextEncoder().encode(content);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(chunkedStream(encoded, [17, 83, 121]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    const received: RuntimeEvent[] = [];
    let unsubscribe = () => {};
    await new Promise<void>((resolve) => {
      unsubscribe = subscribeToProject("project", 0, {
        onEvent: (event) => {
          received.push(event);
          if (event.id === 2) {
            unsubscribe();
            resolve();
          }
        },
        onOpen: () => {},
        onError: () => {},
      });
    });

    expect(received.map((event) => event.id)).toEqual([1, 2]);
    expect(received[1]?.data).toEqual({ itemId: "assistant-1", delta: "你好" });
  });

  it("reconnects from the latest event cursor", async () => {
    installWindow();
    const urls: string[] = [];
    let unsubscribe = () => {};
    let resolveReconnect = () => {};
    const reconnected = new Promise<void>((resolve) => { resolveReconnect = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(streamFrom(sse(7, "preview.starting", {})), { status: 200 });
      }
      queueMicrotask(() => {
        unsubscribe();
        resolveReconnect();
      });
      return new Response(streamFrom(""), { status: 200 });
    }));

    unsubscribe = subscribeToProject("project", 5, {
      onEvent: () => {},
      onOpen: () => {},
      onError: () => {},
    });
    await reconnected;

    expect(urls[0]).toContain("cursor=5");
    expect(urls[1]).toContain("cursor=7");
  });

  it("reloads a snapshot after the event cursor expires", async () => {
    installWindow();
    const urls: string[] = [];
    let unsubscribe = () => {};
    let resolveReset = () => {};
    const reset = new Promise<void>((resolve) => { resolveReset = resolve; });
    const onReset = vi.fn(async () => 40);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) return Response.json({ error: "Event cursor expired" }, { status: 409 });
      queueMicrotask(() => {
        unsubscribe();
        resolveReset();
      });
      return new Response(streamFrom(""), { status: 200 });
    }));

    unsubscribe = subscribeToProject("project", 3, {
      onEvent: () => {},
      onOpen: () => {},
      onError: () => {},
      onReset,
    });
    await reset;

    expect(onReset).toHaveBeenCalledOnce();
    expect(urls[0]).toContain("cursor=3");
    expect(urls[1]).toContain("cursor=40");
  });
});

describe("renderer project API", () => {
  it("lists and reads plugins through the unified API", async () => {
    installWindow();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ plugins: [], errors: [] }))
      .mockResolvedValueOnce(Response.json({ id: "opengame:godot" }))
      .mockResolvedValueOnce(Response.json({ id: "skills/godot/SKILL.md", content: "# Godot" }));
    vi.stubGlobal("fetch", fetchMock);

    await listPlugins();
    await readPlugin("opengame:godot");
    await readPluginSkill("opengame:godot", "skills/godot/SKILL.md");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/plugins", expect.objectContaining({ headers: {} }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/plugins/opengame%3Agodot", expect.objectContaining({ headers: {} }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/plugins/opengame%3Agodot/skill-content?id=skills%2Fgodot%2FSKILL.md", expect.objectContaining({ headers: {} }));
  });

  it("loads Composer capabilities before a project exists", async () => {
    installWindow();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ plugins: [], skills: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getHomeComposerCapabilities();

    expect(fetchMock).toHaveBeenCalledWith("/api/composer/capabilities", expect.objectContaining({ headers: {} }));
  });

  it("updates settings and removes personal plugins through the unified API", async () => {
    installWindow();
    const plugin = { id: "personal:character-writer" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(plugin))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await updatePluginSettings(plugin.id, { enabled: false, components: {} });
    await uninstallPlugin(plugin.id);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/plugins/personal%3Acharacter-writer/settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ enabled: false, components: {} }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/plugins/personal%3Acharacter-writer", expect.objectContaining({ method: "DELETE" }));
  });

  it("installs plugins through the unified API", async () => {
    installWindow();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "personal:test" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await installPlugin({ type: "git", url: "https://example.com/test.git" });

    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/install", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "git", url: "https://example.com/test.git" }),
    }));
  });

  it("inspects plugin sources through the unified API", async () => {
    installWindow();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ candidates: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await inspectPluginSource({ type: "directory", path: "/plugins/test" });

    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/inspect", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "directory", path: "/plugins/test" }),
    }));
  });

  it("passes the current user token only in the publish request body", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ deployment: {}, game: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await publishProject("project", "user-access-token");

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project/publish", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ accessToken: "user-access-token" }),
    }));
  });

  it("publishes, browses, and imports Assets through the daemon API", async () => {
    installWindow();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ asset: {}, release: {} }, { status: 201 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ path: "assets/imported/sprite.png" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await publishAsset("project", "assets/sprite.png", "user-access-token");
    await listExploreAssets();
    await addExploreAssetToProject("project", "asset-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project/assets/publish?path=assets%2Fsprite.png", expect.objectContaining({
      method: "POST", body: JSON.stringify({ accessToken: "user-access-token" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/explore/assets", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project/assets/import", expect.objectContaining({
      method: "POST", body: JSON.stringify({ assetId: "asset-1" }),
    }));
  });

  it("installs and publishes Catalog Plugins through the daemon API", async () => {
    installWindow();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "opengame:tools" }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({}, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await installCatalogPlugin("opengame:tools");
    await publishPlugin("personal:tools", "user-access-token", "0.1.0");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/plugins/opengame%3Atools/install", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/plugins/personal%3Atools/publish", expect.objectContaining({
      method: "POST", body: JSON.stringify({ accessToken: "user-access-token", version: "0.1.0" }),
    }));
  });

  it("lists projects", async () => {
    installWindow();
    const projects = [{ id: "project-1", name: "First" }];
    const fetchMock = vi.fn(async () => Response.json(projects));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProjects()).resolves.toEqual(projects);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ headers: {} }));
  });

  it("renames, duplicates, and deletes projects", async () => {
    installWindow();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "project-1", name: "Renamed" }))
      .mockResolvedValueOnce(Response.json({ id: "project-2", name: "Renamed copy" }, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await renameProject("project-1", "Renamed");
    await duplicateProject("project-1");
    await deleteProject("project-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/duplicate", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project-1", expect.objectContaining({ method: "DELETE" }));
  });

  it("loads a project's persisted conversation", async () => {
    installWindow();
    const detail = {
      conversation: { id: "conversation-1", projectId: "project-1", title: "Conversation", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), messageCount: 1 },
      agent: { status: "idle" },
      settings: {},
      plan: { mode: "normal" },
      items: [{ id: "one", turnId: "turn-1", type: "userMessage", text: "Hi" }],
      pendingPrompts: [],
      cursor: 4,
    };
    const fetchMock = vi.fn(async () => Response.json(detail));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConversation("project-1", "conversation-1")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/conversations/conversation-1",
      expect.objectContaining({ headers: {} }),
    );

    await getConversation("project-1", "conversation-1", true);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/projects/project-1/conversations/conversation-1?reset=1",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("lists models and selects one for a conversation", async () => {
    installWindow();
    const model = { provider: "openai-codex", providerName: "OpenAI Codex", id: "gpt-5.5", name: "GPT-5.5", reasoningLevels: ["low", "medium", "high"] as const };
    const settings = { model, reasoningLevel: "medium" };
    const conversation = { id: "conversation-1", projectId: "project-1", title: "New conversation", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), messageCount: 0 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ models: [model], defaultModel: model, defaultReasoningLevel: "medium" }))
      .mockResolvedValueOnce(Response.json(conversation, { status: 201 }))
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(Response.json({ level: "high" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listModels()).resolves.toEqual({ models: [model], defaultModel: model, defaultReasoningLevel: "medium" });
    await createConversation("project-1", model, "medium");
    await setConversationModel("project-1", "conversation-1", model);
    await setConversationReasoning("project-1", "conversation-1", "high");

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ model: { provider: model.provider, id: model.id }, reasoningLevel: "medium" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project-1/conversations/conversation-1/model", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ provider: model.provider, id: model.id }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/projects/project-1/conversations/conversation-1/reasoning", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ level: "high" }),
    }));
  });

  it("loads and updates the OpenAI endpoint", async () => {
    installWindow();
    const settings = { baseUrl: "https://api.openai.com/v1" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(Response.json({ ...settings, baseUrl: "https://relay.example/v1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOpenAIEndpointSettings()).resolves.toEqual(settings);
    await expect(updateOpenAIEndpointSettings("https://relay.example/v1")).resolves.toEqual({ ...settings, baseUrl: "https://relay.example/v1" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/settings/models/providers/openai/endpoint", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://relay.example/v1" }),
    }));
  });

  it("sends a prompt to a project", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ accepted: true, turnId: "turn-1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendPrompt("project-1", "conversation-1", "Build a game")).resolves.toMatchObject({ turnId: "turn-1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ prompt: "Build a game" }),
      headers: { "content-type": "application/json" },
    }));
  });

  it("sends structured Plugin mentions with the visible prompt", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ queued: false, turnId: "turn-1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const mention = { name: "godot", displayName: "Godot", marketplaceId: "opengame" };

    await sendPrompt("project-1", "conversation-1", "Use @Godot", [], [], "normal", [mention]);

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      body: JSON.stringify({ prompt: "Use @Godot", mentions: [mention] }),
    }));
  });

  it("compacts a conversation and reads Pi context usage", async () => {
    installWindow();
    const usage = { tokens: 74_000, contextWindow: 100_000, percent: 74 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ contextUsage: usage }));
    vi.stubGlobal("fetch", fetchMock);

    await compactConversation("project-1", "conversation-1", "Keep API decisions");
    await expect(getConversationContextUsage("project-1", "conversation-1")).resolves.toEqual(usage);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/conversations/conversation-1/compact", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ instructions: "Keep API decisions" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations/conversation-1/context-usage", expect.any(Object));
  });

  it("sends planning prompts and plan decisions", async () => {
    installWindow();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ queued: false, turnId: "turn-plan" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendPrompt("project-1", "conversation-1", "Plan this", [], [], "planning");
    await approvePlan("project-1", "conversation-1");
    await refinePlan("project-1", "conversation-1");
    await cancelPlan("project-1", "conversation-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      body: JSON.stringify({ prompt: "Plan this", mode: "planning" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations/conversation-1/plan/approve", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project-1/conversations/conversation-1/plan/refine", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/projects/project-1/conversations/conversation-1/plan", expect.objectContaining({ method: "DELETE" }));
  });

  it("revises the latest user message", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ queued: false, turnId: "turn-2" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await reviseLastPrompt("project-1", "conversation-1", "Build a platformer");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/conversations/conversation-1/revise-last",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "Build a platformer" }) }),
    );
  });

  it("sends image attachments with a prompt", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ queued: false, turnId: "turn-1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };

    await sendPrompt("project-1", "conversation-1", "Describe this", [], [image]);

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      body: JSON.stringify({ prompt: "Describe this", images: [image] }),
    }));
  });

  it("sends file references and removes a pending follow-up", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ queued: true, turnId: "turn-2" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendPrompt("project-1", "conversation-1", "Review this", [{ type: "workspace-file", path: "src/app.ts" }]);
    await removePendingPrompt("project-1", "conversation-1", "turn-2");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      body: JSON.stringify({ prompt: "Review this", references: [{ type: "workspace-file", path: "src/app.ts" }] }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations/conversation-1/queue/turn-2", expect.objectContaining({
      method: "DELETE",
    }));
  });

  it("loads Composer capabilities for a conversation", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ plugins: [], skills: [{ name: "review", description: "Review changes" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getConversationCapabilities("project-1", "conversation-1")).resolves.toEqual({
      plugins: [],
      skills: [{ name: "review", description: "Review changes" }],
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/projects/project-1/conversations/conversation-1/capabilities",
      expect.any(Object),
    );
  });

  it("steers queued messages", async () => {
    installWindow();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await steerPendingPrompt("project-1", "conversation-1", "turn-2");

    expect(fetchMock.mock.calls.map(([url, options]) => [url, (options as RequestInit).method, (options as RequestInit).body])).toEqual([
      ["/api/projects/project-1/conversations/conversation-1/queue/turn-2/steer", "POST", undefined],
    ]);
  });

  it("renames a conversation", async () => {
    installWindow();
    const renamed = { id: "conversation-1", title: "New title" };
    const fetchMock = vi.fn(async () => Response.json(renamed));
    vi.stubGlobal("fetch", fetchMock);

    await expect(renameConversation("project-1", "conversation-1", "New title")).resolves.toEqual(renamed);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/conversations/conversation-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "New title" }),
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("loads workspace files and encodes file paths", async () => {
    installWindow();
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await listWorkspaceFiles("project-1");
    await getWorkspaceFile("project-1", "src/my file.ts");
    await getWorkspaceAsset("project-1", "public/cover image.png");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/project-1/files",
      "/api/projects/project-1/files/content?path=src%2Fmy%20file.ts",
      "/api/projects/project-1/files/raw?path=public%2Fcover%20image.png",
    ]);
  });

  it("renames and deletes workspace assets", async () => {
    installWindow();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ path: "assets/new name.glb" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await renameAsset("project-1", "assets/old name.glb", "new name");
    await deleteAsset("project-1", "assets/new name.glb");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/assets?path=assets%2Fold%20name.glb", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "new name" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/assets?path=assets%2Fnew%20name.glb", expect.objectContaining({ method: "DELETE" }));
  });

  it("downloads workspace assets with desktop authorization", async () => {
    vi.stubGlobal("window", {
      openGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "secret" } },
      setTimeout,
      clearTimeout,
    });
    const fetchMock = vi.fn(async () => new Response(new Blob(["image"], { type: "image/png" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getWorkspaceAsset("project-1", "cover.png")).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/projects/project-1/files/raw?path=cover.png",
      { headers: { authorization: "Bearer secret" } },
    );
  });

  it("loads and stores project covers with desktop authorization", async () => {
    vi.stubGlobal("window", {
      openGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "secret" } },
      setTimeout,
      clearTimeout,
    });
    const cover = new Blob(["cover"], { type: "image/webp" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(cover))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProjectCover("project-1")).resolves.toBeInstanceOf(Blob);
    await expect(setProjectCover("project-1", cover)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://127.0.0.1:43210/projects/project-1/cover", {
      headers: { authorization: "Bearer secret" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://127.0.0.1:43210/projects/project-1/cover", {
      method: "PUT",
      headers: { "content-type": "image/webp", authorization: "Bearer secret" },
      body: cover,
    });
  });

  it("loads Community game covers through the local runtime", async () => {
    vi.stubGlobal("window", {
      openGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "secret" } },
      setTimeout,
      clearTimeout,
    });
    const fetchMock = vi.fn(async () => new Response(new Blob(["cover"], { type: "image/webp" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getExploreGameCover("game 1", "deployment 1")).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/community/games/game%201/deployments/deployment%201/cover",
      { headers: { authorization: "Bearer secret" } },
    );
  });
});

describe("renderer tools API", () => {
  it("loads and updates 3D generation settings", async () => {
    installWindow();
    const settings = { apiUrl: "https://api.meshy.ai", hasApiKey: true };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(Response.json(settings));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getModel3DGenerationSettings()).resolves.toEqual(settings);
    await expect(updateModel3DGenerationSettings({ apiUrl: settings.apiUrl, apiKey: "secret" })).resolves.toEqual(settings);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/settings/model-3d-generation", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ apiUrl: settings.apiUrl, apiKey: "secret" }),
    }));
  });
  it("lists and runs tools", async () => {
    installWindow();
    const tool = { id: "generate-image", name: "Image Generator" };
    const run = { id: "run-1", toolId: tool.id, files: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([tool]))
      .mockResolvedValueOnce(Response.json(run, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listTools()).resolves.toEqual([tool]);
    await expect(runTool("generate-image", { prompt: "A forest", size: "1536x1024" })).resolves.toEqual(run);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/tools", expect.objectContaining({ headers: {} }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/tools/generate-image/runs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ prompt: "A forest", size: "1536x1024" }),
    }));
  });

  it("downloads tool output with desktop authorization", async () => {
    vi.stubGlobal("window", {
      openGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "secret" } },
      setTimeout,
      clearTimeout,
    });
    const blob = new Blob(["image"], { type: "image/webp" });
    const fetchMock = vi.fn(async () => new Response(blob));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getToolRunFile("run-1", "output.webp")).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/tool-runs/run-1/files/output.webp",
      { headers: { authorization: "Bearer secret" } },
    );
  });

  it("adds a tool result to a project", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ path: "assets/generated/image.webp" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(addToolResultToProject("project-1", { runId: "run-1", fileName: "output.webp" }))
      .resolves.toEqual({ path: "assets/generated/image.webp" });
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/tool-results", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ runId: "run-1", fileName: "output.webp" }),
    }));
  });

});

function installWindow(): void {
  vi.stubGlobal("window", {
    openGameDesktop: undefined,
    setTimeout,
    clearTimeout,
  });
}

function sse(id: number, type: RuntimeEvent["type"], data: object): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({
    id,
    projectId: "project",
    type,
    timestamp: new Date(0).toISOString(),
    data,
  })}\n\n`;
}

function streamFrom(content: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(content);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function chunkedStream(bytes: Uint8Array, boundaries: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const boundary of boundaries) {
        controller.enqueue(bytes.slice(offset, boundary));
        offset = boundary;
      }
      controller.enqueue(bytes.slice(offset));
      controller.close();
    },
  });
}
