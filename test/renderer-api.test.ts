import { afterEach, describe, expect, it, vi } from "vitest";
import { getProjectConversation, getToolRunFile, listProjects, listTools, runTool, sendPrompt, subscribeToProject } from "../src/renderer/api.js";
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
      sse(2, "assistant.delta", { delta: "你好" }),
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
    expect(received[1]?.data).toEqual({ delta: "你好" });
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

    await expect(getProjectConversation("project-1")).resolves.toEqual(conversation);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/conversation", expect.objectContaining({ headers: {} }));
  });

  it("sends a prompt to a project", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ accepted: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendPrompt("project-1", "Build a game");

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/prompts", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ prompt: "Build a game" }),
      headers: { "content-type": "application/json" },
    }));
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
