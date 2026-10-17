import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAISessionTransport, type ResponseSocket } from "../src/daemon/openai-session-transport.js";
import { OpenAISessionFiles } from "../src/daemon/openai-session-files.js";
import { SessionImages, type Json } from "../src/daemon/session-images.js";
import { installSessionImageRequests } from "../src/daemon/session-image-requests.js";
import { assistantMessageError } from "../src/daemon/agent-errors.js";
import type { ResponsesTransportMode } from "../src/shared/contracts.js";

const completed = (output: unknown[] = []) => ({ type: "response.completed", response: { id: "sse-response", status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
class PiSocket extends EventTarget implements ResponseSocket {
  readyState = 0;
  sent: Json[] = [];
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  send(data: string) {
    this.sent.push(JSON.parse(data));
    queueMicrotask(() => {
      const n = this.sent.length;
      const item = { type: "message", id: `msg-${n}`, role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "Done", annotations: [] }] };
      for (const event of [
        { type: "response.created", response: { id: `resp-${n}`, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Done" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: `resp-${n}`, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
      ]) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    });
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
async function fixture(provider = "openai", baseUrl?: string, api = "openai-responses", setupSocket?: (socket: PiSocket) => void, tools: ToolDefinition[] = [], options: {
  transportMode?: (provider: string) => ResponsesTransportMode;
  onStream?: (options: Parameters<AgentSession["agent"]["streamFunction"]>[2]) => void;
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ohmygame-image-requests-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  await runtime.setRuntimeApiKey(provider, "test-subscription");
  if (baseUrl) runtime.registerProvider(provider, { baseUrl });
  const model = runtime.getModels(provider).find((item) => item.api === api && item.input.includes("image"))!;
  const manager = SessionManager.inMemory(dir);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 1, baseDelayMs: 1 }, cacheWarming: "idle" });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }) });
  await loader.reload();
  const images = new SessionImages(manager, dir);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager: settings, sessionManager: manager, customTools: [images.recallTool, ...tools] });
  cleanup.push(() => session.dispose());
  if (options.onStream) {
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, streamOptions) => {
      options.onStream?.(streamOptions);
      return stream(model, context, streamOptions);
    };
  }
  const sockets: PiSocket[] = [];
  const transport = new OpenAISessionTransport(images, new OpenAISessionFiles(dir), () => { const socket = new PiSocket(); setupSocket?.(socket); sockets.push(socket); return socket; });
  installSessionImageRequests(session, images, dir, { transport, transportMode: options.transportMode });
  return { session, manager, settings, sockets, dir, images, transport };
}

describe("Pi session image request integration", () => {
  it("keeps Pi parsing and canonical image history while sending only the new turn on the second request", async () => {
    const { session, manager, settings, sockets } = await fixture();
    const network = vi.fn<typeof fetch>(() => { throw new Error("unexpected HTTP"); }); vi.stubGlobal("fetch", network);
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
    const image = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
    await session.prompt("Inspect this", { images: [image] });
    await session.prompt("Inspect it again");
    expect(sockets).toHaveLength(1); expect(sockets[0].sent).toHaveLength(2);
    expect(sockets[0].sent[1]).toMatchObject({ previous_response_id: "resp-1", input: [{ role: "user", content: [{ type: "input_text", text: "Inspect it again" }] }] });
    expect(session.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    const user = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
    expect(user).toMatchObject({ message: { content: expect.arrayContaining([image]) } });
    expect(settings.getCacheWarmingMode()).toBe("off"); expect(network).not.toHaveBeenCalled();
    session.dispose(); expect(sockets[0].readyState).toBe(3);
  });

  it("runs image budget checks after an extension payload transform, and fails before HTTP", async () => {
    const { session, sockets } = await fixture();
    const network = vi.fn<typeof fetch>(() => { throw new Error("unexpected HTTP"); }); vi.stubGlobal("fetch", network);
    const upstream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => upstream(model, context, { ...options,
      onPayload: (payload) => ({ ...(payload as Json), input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"a".repeat(21 * 1024 * 1024)}` }] }] }),
    });
    await session.prompt("Too large");
    const assistant = session.messages.findLast((message) => message.role === "assistant");
    expect(assistant).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("local image/history budget") });
    expect(network).not.toHaveBeenCalled(); expect(sockets).toHaveLength(0);
  });

  it.each(["close", "network-error", "timeout", "invalid-event"])("lets Pi retry a midstream %s over SSE and emit Reconnecting events", async (failure) => {
    const { session, settings, sockets } = await fixture("openai", undefined, "openai-responses", (socket) => {
      socket.send = (data) => {
        socket.sent.push(JSON.parse(data));
        queueMicrotask(() => {
          socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.created", response: { id: "interrupted" } }) }));
          if (failure === "close") socket.close();
          else if (failure === "network-error") socket.dispatchEvent(new Event("error"));
          else if (failure === "invalid-event") socket.dispatchEvent(new MessageEvent("message", { data: "invalid JSON" }));
        });
      };
    });
    settings.setRetryEnabled(true);
    if (failure === "timeout") settings.setHttpIdleTimeoutMs(20);
    const requests: Json[] = [];
    const network = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(await new Request(input, init).json());
      return sse(completed());
    }); vi.stubGlobal("fetch", network);
    const events: any[] = []; session.subscribe((event) => events.push(event));
    await session.prompt("Continue");
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toHaveLength(1);
    expect(network).toHaveBeenCalledOnce();
    expect(requests[0]).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(requests[0].input)).toContain("Continue");
    expect(events.filter((event) => event.type === "auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
    expect(events.find((event) => event.type === "auto_retry_end")).toMatchObject({ success: true, attempt: 1 });
    const failed = events.find((event) => event.type === "message_end" && event.message.stopReason === "error").message;
    expect(assistantMessageError(failed).diagnostics).toMatchObject({ transport: "websocket" });
    expect(assistantMessageError(failed).diagnostics?.statusCode).toBeUndefined();
    expect(session.messages.findLast((message) => message.role === "assistant")).toMatchObject({
      stopReason: "stop",
    });
  });

  it("applies provider transport changes to an existing session's next request", async () => {
    let mode: ResponsesTransportMode = "auto";
    const resolveMode = vi.fn(() => mode);
    const { session, sockets, settings } = await fixture("openai", "https://relay.example/v1", "openai-responses", undefined, [], { transportMode: resolveMode });
    const network = vi.fn<typeof fetch>(async () => sse(completed())); vi.stubGlobal("fetch", network);
    await session.prompt("Default relay request");
    expect(sockets).toHaveLength(0); expect(network).toHaveBeenCalledOnce();
    mode = "websocket";
    expect(settings.getCacheWarmingMode()).toBe("off");
    await session.prompt("Enable WebSocket");
    expect(sockets).toHaveLength(1); expect(network).toHaveBeenCalledOnce();
    mode = "sse";
    expect(settings.getCacheWarmingMode()).toBe("idle");
    await session.prompt("Use SSE");
    expect(sockets[0].readyState).toBe(3); expect(network).toHaveBeenCalledTimes(2);
    mode = "websocket";
    await session.prompt("Enable WebSocket again");
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent[0]).not.toHaveProperty("previous_response_id");
    expect(resolveMode).toHaveBeenCalledWith("openai");
  });

  it("honors Pi's explicit SSE transport when deciding whether to suppress cache warming", async () => {
    const { session, settings, sockets } = await fixture();
    session.agent.transport = "sse";
    expect(settings.getCacheWarmingMode()).toBe("idle");
    const network = vi.fn<typeof fetch>(async () => sse(completed())); vi.stubGlobal("fetch", network);
    await session.prompt("Use SSE");
    expect(network).toHaveBeenCalledOnce(); expect(sockets).toHaveLength(0);
  });

  it.each([301, 307, 308].flatMap((status) => (["auto", "sse", "websocket"] as const).map((mode) => ({ status, mode }))))(
    "preserves relay HTTP redirects for $mode requests after status $status", async ({ status, mode }) => {
      const paths: string[] = [];
      const server = createServer((request, response) => {
        paths.push(request.url!);
        request.resume();
        if (request.url === "/v1/responses") {
          response.writeHead(status, { location: "/v1/responses/" }); response.end();
        } else {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(`data: ${JSON.stringify(completed())}\n\n`);
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanup.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
      const address = server.address() as { port: number };
      const { session, sockets } = await fixture("openai", `http://127.0.0.1:${address.port}/v1`, "openai-responses", (socket) => {
        socket.send = () => queueMicrotask(() => socket.close());
      }, [], { transportMode: () => mode });
      await session.prompt("Follow the relay redirect");
      expect(paths).toEqual(["/v1/responses", "/v1/responses/"]);
      expect(session.messages.findLast((message) => message.role === "assistant")).toMatchObject({ stopReason: "stop" });
      expect(sockets).toHaveLength(mode === "websocket" ? 1 : 0);
    },
  );

  it.each(["auto", "sse"] as const)("keeps encoded relay requests intact in %s mode", async (mode) => {
    let wrappedFetch: typeof fetch | undefined;
    const endpoint = "https://relay.example/v1/responses";
    const { session, images, sockets } = await fixture("openai", "https://relay.example/v1", "openai-responses", undefined, [], {
      transportMode: () => mode, onStream: (options) => { wrappedFetch = options?.fetch; },
    });
    const network = vi.fn<typeof fetch>(async () => sse(completed())); vi.stubGlobal("fetch", network);
    await session.prompt("Capture the relay's final request boundary");
    const budget = vi.spyOn(images, "budget");
    const encoded = gzipSync(JSON.stringify({ input: [{ role: "user", content: "Encoded request" }] }));
    const request = new Request(endpoint, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: encoded });
    await wrappedFetch!(request);
    const sent = new Request(network.mock.calls[1][0], network.mock.calls[1][1]);
    expect(sent.redirect).toBe("follow");
    expect(sent.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(new Uint8Array(encoded));
    expect(budget).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it.each(["error", "failed", "before-start"])("preserves Pi's retry for a transient provider %s event", async (kind) => {
    let sends = 0;
    const { session, settings, sockets } = await fixture("openai", undefined, "openai-responses", (socket) => {
      const success = socket.send.bind(socket);
      socket.send = (data) => {
        if (sends++ > 0) { success(data); return; }
        socket.sent.push(JSON.parse(data));
        queueMicrotask(() => {
          if (kind !== "before-start") socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.created", response: { id: "failed" } }) }));
          const error = { code: "server_error", message: "Please retry your request" };
          socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(kind === "error"
            ? { type: "error", status: 500, error } : { type: "response.failed", response: { id: "failed", error } }) }));
        });
      };
    });
    settings.setRetryEnabled(true);
    const events: any[] = []; session.subscribe((event) => events.push(event));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected HTTP"); }));
    await session.prompt("Continue");
    expect(sockets).toHaveLength(2);
    expect(events.find((event) => event.type === "auto_retry_end")).toMatchObject({ success: true });
  });

  it.each([
    [401, "invalid_api_key", "Authentication failed"],
    [429, "insufficient_quota", "Quota exceeded"],
    [400, "invalid_request_error", "Invalid parameter timeout; please retry your request"],
    [undefined, undefined, "Unexpected provider rejection"],
  ])("does not retry or fall back for a midstream provider rejection %s", async (status, code, message) => {
    const { session, settings, sockets } = await fixture("openai", undefined, "openai-responses", (socket) => {
      socket.send = (data) => {
        socket.sent.push(JSON.parse(data));
        queueMicrotask(() => {
          for (const event of [
            { type: "response.created", response: { id: "rejected" } },
            { type: "error", status, error: { code, message } },
          ]) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
        });
      };
    });
    settings.setRetryEnabled(true);
    const network = vi.fn(() => { throw new Error("unexpected HTTP"); }); vi.stubGlobal("fetch", network);
    const events: any[] = []; session.subscribe((event) => events.push(event));
    await session.prompt("Continue");
    expect(events.some((event) => event.type === "auto_retry_start")).toBe(false);
    expect(network).not.toHaveBeenCalled(); expect(sockets).toHaveLength(1);
    const diagnostics = assistantMessageError(session.messages.findLast((item) => item.role === "assistant")!).diagnostics;
    expect(diagnostics).toMatchObject({ transport: "websocket" });
    expect(diagnostics?.statusCode).toBe(status); expect(diagnostics?.errorCode).toBe(code);
  });

  it("bounds failed SSE retries after a WebSocket disconnect", async () => {
    const { session, settings, sockets } = await fixture("openai", undefined, "openai-responses", (socket) => {
      socket.send = (data) => {
        socket.sent.push(JSON.parse(data));
        queueMicrotask(() => {
          socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.created", response: { id: "failed" } }) }));
          socket.close();
        });
      };
    });
    settings.setRetryEnabled(true);
    const network = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("SSE idle timeout")); } }), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", network);
    const events: any[] = []; session.subscribe((event) => events.push(event));
    await session.prompt("Continue");
    expect(sockets).toHaveLength(1); expect(network).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "auto_retry_start")).toHaveLength(1);
    expect(events.find((event) => event.type === "auto_retry_end")).toMatchObject({ success: false, attempt: 1 });
  });

  it("cancels during Reconnecting without starting the SSE retry", async () => {
    const { session, settings } = await fixture("openai", undefined, "openai-responses", (socket) => {
      socket.send = (data) => {
        socket.sent.push(JSON.parse(data));
        queueMicrotask(() => {
          socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.created", response: { id: "failed" } }) }));
          socket.close();
        });
      };
    });
    settings.setRetryEnabled(true);
    const network = vi.fn(() => { throw new Error("unexpected HTTP"); }); vi.stubGlobal("fetch", network);
    const events: any[] = [];
    session.subscribe((event) => { events.push(event); if (event.type === "auto_retry_start") setTimeout(() => session.abortRetry(), 0); });
    await session.prompt("Continue");
    expect(network).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === "auto_retry_end")).toMatchObject({ success: false, finalError: "Retry cancelled" });
  });

  it("retains completed tool results but does not execute tool calls from a failed partial response", async () => {
    let sends = 0;
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Completed tool result" }], details: {} }));
    const { session, settings } = await fixture("openai", undefined, "openai-responses", (socket) => {
      socket.send = (data) => {
        socket.sent.push(JSON.parse(data));
        const attempt = sends++;
        queueMicrotask(() => {
          const item = { type: "function_call", id: `fc-${attempt}`, call_id: attempt === 0 ? "completed-call" : "failed-call", name: "test_tool", arguments: "{}", status: "completed" };
          for (const event of [
            { type: "response.created", response: { id: `resp-${attempt}` } },
            { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
            { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
            { type: "response.output_item.done", output_index: 0, item },
          ]) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
          if (attempt === 0) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(completed([item])) }));
          else socket.close();
        });
      };
    }, [{ name: "test_tool", label: "Test tool", description: "Test tool", parameters: Type.Object({}), execute }]);
    settings.setRetryEnabled(true);
    const requests: Json[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => { requests.push(await new Request(input, init).json()); return sse(completed()); }));
    await session.prompt("Use tool");
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0].input)).toContain("Completed tool result");
    expect(JSON.stringify(requests[0].input)).toContain("completed-call");
    expect(JSON.stringify(requests[0].input)).not.toContain("failed-call");
    expect(requests[0]).not.toHaveProperty("previous_response_id");
  });

  it("reduces a custom endpoint's HTTP 413 once and carries that decision into later requests", async () => {
    const { session, manager, sockets, images } = await fixture("openai", "https://gateway.example/v1");
    const budget = vi.spyOn(images, "budget");
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      requests.push(await new Request(input, init).json());
      if (requests.length === 2) return new Response("too large", { status: 413 });
      const event = { type: "response.completed", response: { id: `http-${requests.length}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }));
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    const image = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
    await session.prompt("First", { images: [image, image, image, image] });
    await session.prompt("Second");
    await session.prompt("Third");
    const count = (request: any) => JSON.stringify(request).match(/data:image\/png;base64,/g)?.length ?? 0;
    expect(requests.map(count)).toEqual([4, 4, 3, 3]);
    expect(budget).toHaveBeenCalledTimes(4);
    expect(manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
    expect(sockets).toHaveLength(0);
  });

  it.each([["google", "google-generative-ai"], ["google-vertex", "google-vertex"]])(
    "guards %s through onPayload without injecting an unsupported custom fetch", async (provider, api) => {
      const { session, sockets } = await fixture(provider, undefined, api);
      const network = vi.fn<typeof fetch>(() => { throw new Error("unexpected HTTP"); }); vi.stubGlobal("fetch", network);
      const upstream = session.agent.streamFunction;
      session.agent.streamFunction = (model, context, options) => upstream(model, context, { ...options,
        onPayload: (payload) => ({ ...(payload as Json), contents: [{ role: "user", parts: [{ inlineData: {
          mimeType: "image/png", data: "a".repeat(21 * 1024 * 1024),
        } }] }] }),
      });
      await session.prompt("Too large");
      expect(session.messages.findLast((message) => message.role === "assistant")).toMatchObject({
        stopReason: "error", errorMessage: expect.stringContaining("local image/history budget"),
      });
      expect(network).not.toHaveBeenCalled(); expect(sockets).toHaveLength(0);
    },
  );
});
