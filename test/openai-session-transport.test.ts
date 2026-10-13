import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAISessionTransport, type ResponseSocket } from "../src/daemon/openai-session-transport.js";
import { OpenAISessionFiles } from "../src/daemon/openai-session-files.js";
import { SessionImages, wireImages, type Json } from "../src/daemon/session-images.js";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";

const dirs: string[] = [];
const transports: OpenAISessionTransport[] = [];
afterEach(async () => { transports.splice(0).forEach((transport) => transport.dispose()); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const input = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const body = (items: unknown[] = [input("hello")]): Json => ({ model: "gpt-5.6", store: false, stream: true, input: items });
function send(fetch: typeof globalThis.fetch, payload: unknown, key = "oauth-token", signal?: AbortSignal) {
  return fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload), signal });
}
class Socket extends EventTarget implements ResponseSocket {
  readyState = 0;
  sent: Json[] = [];
  onSend: (body: Json, socket: Socket) => void = (_body, socket) => socket.event({ type: "response.completed", response: { id: `resp-${socket.sent.length}`, status: "completed", output: [] } });
  constructor() { super(); queueMicrotask(() => { if (this.readyState !== 0) return; this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  event(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  send(data: string) { const parsed: Json = JSON.parse(data); this.sent.push(parsed); queueMicrotask(() => this.onSend(parsed, this)); }
  close(code = 1000) { this.readyState = 3; const event = new Event("close"); Object.assign(event, { code }); this.dispatchEvent(event); }
}
async function fixture(factory?: (socket: Socket, index: number) => void) {
  const dir = await mkdtemp(path.join(tmpdir(), "ohmygame-openai-transport-")); dirs.push(dir);
  const manager = SessionManager.inMemory(dir);
  const images = new SessionImages(manager, dir);
  const sockets: Socket[] = [];
  const headers: Headers[] = [];
  const files = new OpenAISessionFiles(path.join(dir, "files"));
  const transport = new OpenAISessionTransport(images, files, (_url, incoming) => {
    headers.push(incoming); const socket = new Socket(); factory?.(socket, sockets.length); sockets.push(socket); return socket;
  });
  transports.push(transport);
  return { dir, manager, images, files, transport, sockets, headers };
}

describe("OpenAI session transport", () => {
  it("sends only new input after completion and never probes Files with subscription credentials", async () => {
    const { transport, sockets, headers } = await fixture();
    const delegate = vi.fn<typeof fetch>(() => { throw new Error("unexpected HTTP"); });
    const fetch = transport.wrapFetch(delegate);
    const first = body(); await (await send(fetch, first)).text();
    const answer = { type: "message", role: "assistant", id: "msg-1", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
    transport.complete("resp-1", [answer]);
    await (await send(fetch, body([...(first.input as unknown[]), answer, input("next")]))).text();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent[1]).toMatchObject({ previous_response_id: "resp-1", input: [input("next")] });
    expect(sockets[0].sent[0]).not.toHaveProperty("stream");
    expect(sockets[0].sent[0]).not.toHaveProperty("background");
    expect(headers[0].get("authorization")).toBe("Bearer oauth-token");
    expect(delegate).not.toHaveBeenCalled();
  });

  it("replays the full context after a disconnect or prefix change, and isolates account changes", async () => {
    const { transport, sockets } = await fixture();
    const fetch = transport.wrapFetch(vi.fn<typeof globalThis.fetch>(() => { throw new Error("unexpected HTTP"); }));
    const first = body(); await (await send(fetch, first)).text(); transport.complete("resp-1", []);
    sockets[0].close();
    const next = body([input("hello"), input("next")]);
    await (await send(fetch, next)).text();
    expect(sockets[1].sent[0].input).toEqual(next.input);
    expect(sockets[1].sent[0]).not.toHaveProperty("previous_response_id");
    transport.complete("resp-1", []);
    await (await send(fetch, body([input("edited")]))).text();
    expect(sockets[1].sent[1]).not.toHaveProperty("previous_response_id");
    await (await send(fetch, next, "another-account")).text();
    expect(sockets).toHaveLength(3);
    expect(sockets[2].sent[0]).not.toHaveProperty("previous_response_id");
  });

  it("recovers a missing response ID once, without repeating a tool or entering SSE fallback", async () => {
    const { transport, sockets } = await fixture((socket, index) => {
      if (index === 0) socket.onSend = (request, own) => request.previous_response_id
        ? own.event({ type: "error", status: 400, error: { code: "previous_response_not_found", message: "missing" } })
        : own.event({ type: "response.completed", response: { id: "resp-1", status: "completed" } });
    });
    const delegate = vi.fn<typeof fetch>(() => { throw new Error("unexpected HTTP"); });
    const fetch = transport.wrapFetch(delegate);
    await (await send(fetch, body())).text(); transport.complete("resp-1", []);
    const next = body([input("hello"), { type: "function_call_output", call_id: "call-a", output: "already executed" }]);
    await (await send(fetch, next)).text();
    expect(sockets[0].sent[1]).toHaveProperty("previous_response_id");
    expect(sockets[1].sent[0].input).toEqual(next.input);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("falls back before streaming, with budgeted full history, but never replays after events escape", async () => {
    const { transport, sockets } = await fixture((socket) => { socket.onSend = (_request, own) => own.close(1006); });
    const bodies: Json[] = [];
    const delegate = vi.fn<typeof fetch>(async (input, init) => { bodies.push(await new Request(input, init).json()); return json({ ok: true }); });
    const fetch = transport.wrapFetch(delegate);
    const original = body(); expect((await send(fetch, original)).status).toBe(200);
    expect(bodies[0]).toEqual(original);
    await send(fetch, original); expect(sockets).toHaveLength(1); expect(delegate).toHaveBeenCalledTimes(2);

    const started = await fixture((socket) => { socket.onSend = (_request, own) => { own.event({ type: "response.created", response: { id: "resp-a" } }); own.close(1006); }; });
    const afterStart = started.transport.wrapFetch(delegate);
    const response = await send(afterStart, original);
    await expect(response.text()).rejects.toThrow("interrupted after streaming began");
    expect(delegate).toHaveBeenCalledTimes(2);
  });

  it("handles 1009 by shrinking the request once instead of sending the same body over SSE", async () => {
    const fixtureData = await fixture((socket, index) => { if (index === 0) socket.onSend = (_request, own) => own.close(1009); });
    const { manager, images, transport, sockets } = fixtureData;
    const model = openaiProvider().getModels().find((item) => item.input.includes("image"))!;
    const messages = Array.from({ length: 5 }, (_, index) => ({ role: "toolResult" as const, toolCallId: `call-${index}`, toolName: "game_use", timestamp: index + 1, isError: false,
      content: [{ type: "image" as const, mimeType: "image/jpeg", data: "YQ==" }] }));
    messages.forEach((message) => manager.appendMessage(message));
    const prepared = await images.prepare(normalizeContext({ messages }), model);
    const request = body(convertResponsesMessages(model, prepared, new Set(["openai"])));
    const delegate = vi.fn<typeof fetch>(() => { throw new Error("unexpected HTTP"); });
    await (await send(transport.wrapFetch(delegate), request)).text();
    expect(wireImages(sockets[0].sent[0])).toHaveLength(5);
    expect(wireImages(sockets[1].sent[0])).toHaveLength(4);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("honors explicit SSE and prevents oversized protected requests before the network", async () => {
    const { transport, sockets } = await fixture();
    const delegate = vi.fn<typeof fetch>(() => Promise.resolve(json({ ok: true })));
    await send(transport.wrapFetch(delegate, { transport: "sse" }), body());
    expect(sockets).toHaveLength(0);
    const large = body([{ role: "user", content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${"a".repeat(21 * 1024 * 1024)}` }] }]);
    const response = await send(transport.wrapFetch(delegate), large);
    expect(response.status).toBe(413);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(delegate).toHaveBeenCalledTimes(1); expect(sockets).toHaveLength(0);
  });

  it("budgets actual deltas instead of logical history, then bounds the full replay after disconnect", async () => {
    const { manager, images, transport, sockets } = await fixture();
    const model = openaiProvider().getModels().find((item) => item.input.includes("image"))!;
    const messages: Array<{ role: "user"; timestamp: number; content: Array<{ type: "image"; mimeType: string; data: string }> }> = [];
    const fetch = transport.wrapFetch(vi.fn<typeof globalThis.fetch>(() => { throw new Error("unexpected HTTP"); }));
    for (let index = 1; index <= 5; index++) {
      const message = { role: "user" as const, timestamp: index, content: [{ type: "image" as const, mimeType: "image/jpeg", data: "a".repeat(6 * 1024 * 1024) }] };
      manager.appendMessage(message); messages.push(message);
      const prepared = await images.prepare(normalizeContext({ messages }), model);
      const request = body(convertResponsesMessages(model, prepared, new Set(["openai"])));
      if (index === 5) sockets[0].close();
      await (await send(fetch, request)).text(); transport.complete(`resp-${index === 5 ? 1 : index}`, []);
      if (index === 4) {
        expect(manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(0);
        expect(wireImages(sockets[0].sent[3])).toHaveLength(1);
        expect(sockets[0].sent[3]).toHaveProperty("previous_response_id", "resp-3");
      }
    }
    expect(sockets).toHaveLength(2);
    expect(wireImages(sockets[1].sent[0])).toHaveLength(1);
    expect(sockets[1].sent[0]).not.toHaveProperty("previous_response_id");
    expect(manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
  });

  it("does not apply official OpenAI capabilities to custom endpoints", async () => {
    const { transport, sockets } = await fixture();
    const delegate = vi.fn<typeof fetch>(() => Promise.resolve(json({ ok: true })));
    await transport.wrapFetch(delegate)("https://gateway.example/v1/responses", { method: "POST", body: JSON.stringify(body()) });
    expect(delegate).toHaveBeenCalledOnce(); expect(sockets).toHaveLength(0);
  });

  it.each([{ transport: "websocket" }, { cacheRetention: "none" }])("honors explicit nonincremental requests: %j", async (options) => {
    const { transport, sockets } = await fixture();
    const fetch = transport.wrapFetch(vi.fn<typeof globalThis.fetch>(() => { throw new Error("unexpected HTTP"); }), options);
    await (await send(fetch, body())).text(); transport.complete("resp-1", []);
    const next = body([input("hello"), input("next")]);
    await (await send(fetch, next)).text();
    expect(sockets[0].sent[1].input).toEqual(next.input);
    expect(sockets[0].sent[1]).not.toHaveProperty("previous_response_id");
  });

  it("aborts an in-flight socket without falling back or reusing its lineage", async () => {
    const { transport, sockets } = await fixture((socket) => { socket.onSend = () => {}; });
    const delegate = vi.fn<typeof fetch>(() => { throw new Error("unexpected HTTP"); });
    const controller = new AbortController();
    const pending = send(transport.wrapFetch(delegate), body(), "oauth-token", controller.signal);
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(delegate).not.toHaveBeenCalled(); expect(sockets[0].readyState).toBe(3);
  });
});
