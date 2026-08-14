import { afterEach, describe, expect, it, vi } from "vitest";
import { addToolResultToProject, createConversation, getConversation, getToolRunFile, getToolSettings, getWorkspaceAsset, getWorkspaceFile, listModels, listProjects, listTools, listWorkspaceFiles, removePendingPrompt, renameConversation, runTool, sendPrompt, setConversationModel, subscribeToProject, updateToolSettings } from "../src/renderer/api.js";
import type { RuntimeEvent } from "../src/shared/contracts.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderer event stream", () => {
  it("handles chunked UTF-8 and ignores malformed events", async () => {
    installWindow();
    const content = [
      sse(1, "agent.started", { prompt: "Build" }),
      "event: assistant.delta\ndata: {bad json}\n\n",
      sse(2, "assistant.delta", { itemId: "assistant-1", delta: "你好" }),
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
  it("lists projects", async () => {
    installWindow();
    const projects = [{ id: "project-1", name: "First" }];
    const fetchMock = vi.fn(async () => Response.json(projects));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProjects()).resolves.toEqual(projects);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ headers: {} }));
  });

  it("loads a project's persisted conversation", async () => {
    installWindow();
    const conversation = { items: [{ id: "one", kind: "user", text: "Hi" }], cursor: 4 };
    const fetchMock = vi.fn(async () => Response.json(conversation));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConversation("project-1", "conversation-1")).resolves.toEqual(conversation);
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
    const model = { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ models: [model], defaultModel: model }))
      .mockResolvedValueOnce(Response.json({ id: "conversation-1", model }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(model));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listModels()).resolves.toEqual({ models: [model], defaultModel: model });
    await createConversation("project-1", model);
    await setConversationModel("project-1", "conversation-1", model);

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ model }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project-1/conversations/conversation-1/model", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify(model),
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

  it("sends file references and removes a pending follow-up", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ queued: true, turnId: "turn-2" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendPrompt("project-1", "conversation-1", "Review this", [{ type: "workspace-file", path: "src/app.ts" }]);
    await removePendingPrompt("project-1", "conversation-1", "turn-2");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      body: JSON.stringify({ prompt: "Review this", references: [{ type: "workspace-file", path: "src/app.ts" }] }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations/conversation-1/pending-prompt", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ turnId: "turn-2" }),
    }));
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
});

describe("renderer tools API", () => {
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

  it("loads and updates agent tool settings", async () => {
    installWindow();
    const disabled = { enabledTools: [] };
    const enabled = { enabledTools: ["generate-image"] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(disabled))
      .mockResolvedValueOnce(Response.json(enabled));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getToolSettings()).resolves.toEqual(disabled);
    await expect(updateToolSettings(enabled as never)).resolves.toEqual(enabled);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/tool-settings", expect.objectContaining({ headers: {} }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/tool-settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify(enabled),
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
