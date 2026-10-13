import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAISessionTransport, type ResponseSocket } from "../src/daemon/openai-session-transport.js";
import { OpenAISessionFiles } from "../src/daemon/openai-session-files.js";
import { SessionImages, type Json } from "../src/daemon/session-images.js";
import { installSessionImageRequests } from "../src/daemon/session-image-requests.js";

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
async function fixture(provider = "openai", baseUrl?: string, api = "openai-responses", setupSocket?: (socket: PiSocket) => void) {
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
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager: settings, sessionManager: manager, customTools: [images.recallTool] });
  cleanup.push(() => session.dispose());
  const sockets: PiSocket[] = [];
  const transport = new OpenAISessionTransport(images, new OpenAISessionFiles(dir), () => { const socket = new PiSocket(); setupSocket?.(socket); sockets.push(socket); return socket; });
  installSessionImageRequests(session, images, dir, transport);
  return { session, manager, settings, sockets, dir, images };
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

  it.each(["close", "error", "failed"])("does not let Pi auto-replay inference after a streaming %s", async (failure) => {
    const { session, settings, sockets } = await fixture("openai", undefined, "openai-responses", (socket) => {
      socket.send = (data) => {
        socket.sent.push(JSON.parse(data));
        queueMicrotask(() => {
          socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.created", response: { id: "interrupted" } }) }));
          const error = { code: "server_error", message: "Internal error; please retry your request" };
          if (failure === "close") socket.close();
          else socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(failure === "error"
            ? { type: "error", status: 500, error } : { type: "response.failed", response: { id: "interrupted", error } }) }));
        });
      };
    });
    settings.setRetryEnabled(true);
    const network = vi.fn<typeof fetch>(() => { throw new Error("unexpected HTTP"); }); vi.stubGlobal("fetch", network);
    await session.prompt("Continue");
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
    expect(session.messages.findLast((message) => message.role === "assistant")).toMatchObject({
      stopReason: "error", errorMessage: expect.stringContaining("interrupted after streaming began"),
    });
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
