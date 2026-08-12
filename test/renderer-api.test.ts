import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToProject } from "../src/renderer/api.js";
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
      unsubscribe = subscribeToProject("project", {
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

    unsubscribe = subscribeToProject("project", {
      onEvent: () => {},
      onOpen: () => {},
      onError: () => {},
    });
    await reconnected;

    expect(urls[1]).toContain("cursor=7");
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
