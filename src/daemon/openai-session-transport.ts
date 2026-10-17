import { createHash } from "node:crypto";
import { getGlobalDispatcher, WebSocket as UndiciWebSocket } from "undici/index.js";
import { ImageBudgetError, localImageError, MODEL_REQUEST_HIGH_BYTES, object, SessionImages, type Json } from "./session-images.js";
import { OpenAISessionFiles, openAIRequestScope, rejectedOpenAIFiles, isRejectedOpenAIFileError, type UsedOpenAIFile } from "./openai-session-files.js";
import type { ResponsesTransportMode } from "../shared/contracts.js";

export interface ResponseSocket extends EventTarget {
  readonly readyState: number;
  readonly handshakeStatus?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string, headers: Headers) => ResponseSocket;
interface Continuation { responseId: string; parameters: string; inputLength: number; inputHash: string }
interface TransportOptions { endpoint?: string; mode?: ResponsesTransportMode; transport?: string; cacheRetention?: string; connectTimeoutMs?: number; timeoutMs?: number }
const FALLBACK_MS = 5 * 60 * 1000;
export const RESPONSE_TRANSPORT_HEADER = "x-ohmygame-response-transport";
class SocketError extends Error {
  readonly transport = "websocket";
  constructor(message: string, readonly code?: string, readonly status?: number) { super(`${code ? `${code}: ` : ""}${message}`); }
}
class ConnectionError extends Error {
  readonly transport = "websocket";
  constructor(message: string, readonly code: string, options?: ErrorOptions) { super(message, options); }
}
/** Preserve rejected handshake status: Undici's public error event otherwise loses it. */
const createResponseSocket: SocketFactory = (url, headers) => {
  let handshakeStatus: number | undefined;
  // Node/Bun and configured dispatchers can supply either Undici callback interface.
  const dispatcher = getGlobalDispatcher().compose((dispatch) => (options, handler) => dispatch(options, new Proxy(handler, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const status = property === "onHeaders" ? args[0] : property === "onResponseStart" ? args[1] : undefined;
        if (typeof status === "number") handshakeStatus = status;
        return Reflect.apply(value, target, args);
      };
    },
  })));
  const socket = new UndiciWebSocket(url, { headers: Object.fromEntries(headers), dispatcher }) as unknown as ResponseSocket;
  Object.defineProperty(socket, "handshakeStatus", { get: () => handshakeStatus });
  return socket;
};
const sizeErrorCode = (code: unknown) => typeof code === "string" && /^(1009|request_too_large|request_size_exceeded|payload_too_large)$/.test(code);
async function sizeRejected(response: Response): Promise<boolean> {
  if (response.status === 413) return true;
  if (response.status !== 400) return false;
  const body: unknown = await response.clone().json().catch(() => undefined);
  return object(body) && object(body.error) && sizeErrorCode(body.error.code);
}
export function isOfficialOpenAIResponses(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://api.openai.com" && parsed.pathname === "/v1/responses"
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}
export function isResponsesEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.pathname.endsWith("/responses")
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}
export function prefersResponsesWebSocket(url: string, options: Pick<TransportOptions, "mode" | "transport"> = {}): boolean {
  if (!isResponsesEndpoint(url) || options.mode === "sse" || options.transport === "sse") return false;
  return options.mode === "websocket" || options.transport?.startsWith("websocket") === true || isOfficialOpenAIResponses(url);
}
function transportResponse(response: Response, transport: "sse" | "websocket"): Response {
  const headers = new Headers(response.headers); headers.set(RESPONSE_TRANSPORT_HEADER, transport);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
const sansInput = (body: Json) => { const { input: _input, previous_response_id: _id, ...rest } = body; return rest; };
const hashInput = (input: unknown[]) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

/** A session-owned transport. Pi still builds requests, refreshes auth, and parses Responses events. */
export class OpenAISessionTransport {
  private socket?: ResponseSocket;
  private openedAt = 0;
  private busy = false;
  private scope = "";
  private dispatcher = getGlobalDispatcher();
  private continuation?: Continuation;
  private pendingResponse?: { body: Json; responseId: string };
  private idleTimer?: ReturnType<typeof setTimeout>;
  private fallbackUntil = 0;
  private filesUnavailableUntil = 0;
  private invalidations = Promise.resolve();

  constructor(private readonly images: SessionImages, private readonly files: OpenAISessionFiles,
    private readonly socketFactory: SocketFactory = createResponseSocket) {}

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.socket?.close(1000, "session_reset");
    this.socket = undefined; this.continuation = undefined; this.pendingResponse = undefined; this.busy = false;
  }

  complete(responseId: string | undefined, output: unknown[]): void {
    if (!responseId || this.pendingResponse?.responseId !== responseId) return;
    const { body } = this.pendingResponse;
    this.pendingResponse = undefined;
    if (!Array.isArray(body.input)) { this.continuation = undefined; return; }
    const prefix = [...body.input, ...output];
    // The canonical session owns the images. Continuation only needs to verify its
    // serialized prefix, so do not retain another full historical request here.
    this.continuation = { responseId, parameters: JSON.stringify(sansInput(body)), inputLength: prefix.length, inputHash: hashInput(prefix) };
  }

  private delta(body: Json): Json | undefined {
    const previous = this.continuation;
    if (!previous || !Array.isArray(body.input) || JSON.stringify(sansInput(body)) !== previous.parameters
      || body.input.length < previous.inputLength || hashInput(body.input.slice(0, previous.inputLength)) !== previous.inputHash) return;
    return { ...body, previous_response_id: previous.responseId, input: body.input.slice(previous.inputLength) };
  }

  wrapFetch(delegate: typeof fetch, options: TransportOptions = {}): typeof fetch {
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!isResponsesEndpoint(url) || options.endpoint && url !== options.endpoint) return delegate(input, init);
      const request = new Request(input, init);
      if (request.method !== "POST" || !request.headers.get("content-type")?.includes("application/json")) return delegate(request);
      const original: unknown = await request.json();
      if (!object(original)) return localImageError(new ImageBudgetError());
      await this.invalidations;
      const official = isOfficialOpenAIResponses(url);
      const imageScope = official ? "openai-inline" : "inline";
      const scope = `${url}\n${openAIRequestScope(request.headers)}`;
      if (scope !== this.scope || this.dispatcher !== getGlobalDispatcher()) {
        this.dispose(); this.scope = scope; this.dispatcher = getGlobalDispatcher(); this.fallbackUntil = 0; this.filesUnavailableUntil = 0;
      }
      request.signal.throwIfAborted();
      let recoverFiles = true;
      let reduceRequest = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const body = structuredClone(original);
        let used: UsedOpenAIFile[] = [];
        // SIWC deliberately has no Files upload API. Never probe it with an OAuth credential.
        if (official && /^Bearer\s+sk-/i.test(request.headers.get("authorization") ?? "") && Date.now() >= this.filesUnavailableUntil) {
          try { used = await this.files.replace(body, request.headers, delegate, request.signal); }
          catch {
            request.signal.throwIfAborted();
            this.filesUnavailableUntil = Date.now() + 5 * 60 * 1000;
          }
        }
        this.images.applyOmissions(body, imageScope);
        let response: Response;
        const websocket = prefersResponsesWebSocket(url, options) && Date.now() >= this.fallbackUntil && !this.busy;
        try {
          if (websocket) {
            if (!this.socket || this.socket.readyState !== 1 || Date.now() - this.openedAt >= 55 * 60 * 1000) this.dispose();
            let outgoing = this.socket && options.transport !== "websocket" && options.cacheRetention !== "none" ? this.delta(body) : undefined;
            if (!outgoing) { this.continuation = undefined; outgoing = body; }
            const changed = this.images.budget(outgoing, imageScope, reduceRequest);
            if (changed && outgoing !== body) {
              this.dispose(); this.images.budget(body, imageScope); outgoing = body;
            }
            if (Buffer.byteLength(JSON.stringify({ type: "response.create", ...outgoing })) > MODEL_REQUEST_HIGH_BYTES) throw new ImageBudgetError();
            try { response = await this.send(outgoing, body, request, options, used); }
            catch (error) {
              request.signal.throwIfAborted();
              this.dispose();
              if (error instanceof SocketError) {
                if (["previous_response_not_found", "websocket_connection_limit_reached"].includes(error.code ?? "") && attempt === 0) continue;
                if ((error.status === 413 || sizeErrorCode(error.code)) && !reduceRequest) { reduceRequest = true; continue; }
                // Some provider events have no HTTP status. Preserve them as stream
                // errors rather than inventing a 400 that would suppress transient retry.
                response = error.status === undefined
                  ? new Response(new ReadableStream({ start(controller) { controller.error(error); } }),
                    { headers: { "content-type": "text/event-stream", [RESPONSE_TRANSPORT_HEADER]: "websocket" } })
                  : new Response(JSON.stringify({ error: { code: error.code, message: error.message } }),
                    { status: error.status, headers: { "content-type": "application/json", "x-should-retry": "false", [RESPONSE_TRANSPORT_HEADER]: "websocket" } });
              } else {
                // No event has escaped to Pi here. A network/handshake failure can safely fall back.
                this.fallbackUntil = Date.now() + FALLBACK_MS;
                this.images.budget(body, imageScope, reduceRequest);
                response = transportResponse(await delegate(this.httpRequest(request, body)), "sse");
              }
            }
          } else {
            if (!this.busy) this.dispose();
            this.images.budget(body, imageScope, reduceRequest);
            response = transportResponse(await delegate(this.httpRequest(request, body)), "sse");
          }
        } catch (error) {
          request.signal.throwIfAborted();
          if (error instanceof ImageBudgetError) return localImageError(error);
          throw error;
        }
        if (recoverFiles && await rejectedOpenAIFiles(response, used)) {
          recoverFiles = false; await response.body?.cancel();
          await this.files.invalidate(used); this.dispose(); continue;
        }
        if (await sizeRejected(response)) {
          if (!reduceRequest) { reduceRequest = true; await response.body?.cancel(); this.dispose(); continue; }
          const headers = new Headers(response.headers); headers.set("x-should-retry", "false");
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
        return response;
      }
      return localImageError(new ImageBudgetError());
    };
  }

  private httpRequest(request: Request, body: Json): Request {
    // HTTP SIWC requires the required history; previous_response_id is connection-local only.
    const payload = { ...body }; delete payload.previous_response_id;
    const headers = new Headers(request.headers); headers.delete("content-length");
    return new Request(request.url, { method: "POST", headers, body: JSON.stringify(payload), signal: request.signal,
      redirect: isOfficialOpenAIResponses(request.url) ? "error" : request.redirect });
  }

  private async connect(request: Request, timeoutMs: number): Promise<ResponseSocket> {
    if (this.socket?.readyState === 1) return this.socket;
    const headers = new Headers(request.headers);
    for (const name of ["content-length", "content-type", "accept", "connection"]) headers.delete(name);
    const url = new URL(request.url); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.socketFactory(url.toString(), headers);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { if (timer) clearTimeout(timer); socket.removeEventListener("open", open); socket.removeEventListener("error", error); socket.removeEventListener("close", error); request.signal.removeEventListener("abort", abort); };
      const open = () => { cleanup(); resolve(); };
      const error = (event?: Event) => {
        cleanup(); socket.close();
        const status = socket.handshakeStatus;
        // A rejected credential, quota or request is not a protocol compatibility failure.
        reject(status && [400, 401, 402, 403, 422, 429].includes(status)
          ? new SocketError(`OpenAI WebSocket handshake rejected (HTTP ${status})`, "websocket_handshake_rejected", status)
          : new ConnectionError("OpenAI WebSocket connection failed", "WEBSOCKET_CONNECT_FAILED", { cause: (event as ErrorEvent | undefined)?.error }));
      };
      const abort = () => { cleanup(); socket.close(); reject(request.signal.reason); };
      const timer = timeoutMs > 0 ? setTimeout(error, timeoutMs) : undefined; timer?.unref?.();
      socket.addEventListener("open", open); socket.addEventListener("error", error); socket.addEventListener("close", error);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    });
    this.socket = socket; this.openedAt = Date.now(); return socket;
  }

  /** Present native WebSocket events as SSE to Pi's existing parser, without changing event semantics. */
  private async send(outgoing: Json, fullBody: Json, request: Request, options: TransportOptions, used: UsedOpenAIFile[]): Promise<Response> {
    this.busy = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    let socket: ResponseSocket;
    try { socket = await this.connect(request, options.connectTimeoutMs ?? 15_000); }
    catch (error) { this.busy = false; throw error; }
    return new Promise<Response>((resolve, reject) => {
      let first = true;
      let ended = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({ start: (value) => { controller = value; }, cancel: () => finish(new Error("OpenAI stream cancelled")) });
      const response = new Response(stream, { headers: { "content-type": "text/event-stream", [RESPONSE_TRANSPORT_HEADER]: "websocket" } });
      const armTimeout = () => {
        if (timer) clearTimeout(timer);
        if (options.timeoutMs !== 0) { timer = setTimeout(() => finish(new ConnectionError("OpenAI WebSocket idle timeout", "WEBSOCKET_IDLE_TIMEOUT")), options.timeoutMs ?? 120_000); timer.unref?.(); }
      };
      const finish = (error?: unknown) => {
        if (ended) return; ended = true;
        if (timer) clearTimeout(timer);
        socket.removeEventListener("message", message); socket.removeEventListener("error", networkError); socket.removeEventListener("close", close);
        request.signal.removeEventListener("abort", abort); this.busy = false;
        if (error) {
          if (!request.signal.aborted && error instanceof ConnectionError) this.fallbackUntil = Date.now() + FALLBACK_MS;
          this.dispose();
          if (first) { reject(error); void response.body?.cancel().catch(() => {}); }
          else {
            // Pi owns bounded retries and omits failed partial attempts from model input.
            // Preserve the original error so transient failures trigger Reconnecting;
            // connection failures have already selected SSE for the next attempt.
            try { controller.error(error); }
            catch { /* The SDK may already have cancelled. */ }
          }
        } else {
          controller.close();
          this.idleTimer = setTimeout(() => this.dispose(), 2 * 60 * 1000); this.idleTimer.unref?.();
        }
      };
      const message = (event: Event) => {
        armTimeout();
        let data: unknown;
        try { data = JSON.parse(String((event as MessageEvent).data)); }
        catch { finish(new ConnectionError("OpenAI WebSocket error: invalid response event", "WEBSOCKET_INVALID_EVENT")); return; }
        if (!object(data)) { finish(new ConnectionError("OpenAI WebSocket error: invalid response event", "WEBSOCKET_INVALID_EVENT")); return; }
        const failure = data.type === "error" ? (object(data.error) ? data.error : data)
          : data.type === "response.failed" && object(data.response) ? data.response.error : undefined;
        if (isRejectedOpenAIFileError(failure, used)) {
          if (first && object(failure)) {
            finish(new SocketError(String(failure.message ?? "OpenAI image file is unavailable"), String(failure.code ?? "file_not_found"), 400)); return;
          }
          // Invalidate IDs before Pi decides whether to retry the failed model request.
          this.invalidations = this.invalidations.then(() => this.files.invalidate(used));
          void this.invalidations.catch(() => {});
        }
        if (data.type === "error") {
          const error = object(data.error) ? data.error : data;
          finish(new SocketError(typeof error.message === "string" ? error.message : "OpenAI WebSocket request failed",
            typeof error.code === "string" ? error.code : undefined, typeof data.status === "number" ? data.status : undefined)); return;
        }
        if (data.type === "response.failed") {
          const error = object(failure) ? failure : {};
          finish(new SocketError(typeof error.message === "string" ? error.message : "OpenAI response failed",
            typeof error.code === "string" ? error.code : undefined)); return;
        }
        if (first) { first = false; resolve(response); }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        if (data.type === "response.completed") {
          if (options.transport !== "websocket" && options.cacheRetention !== "none" && object(data.response) && typeof data.response.id === "string") {
            this.pendingResponse = { body: fullBody, responseId: data.response.id };
          }
          finish();
        } else if (data.type === "response.incomplete") {
          this.continuation = undefined; this.pendingResponse = undefined; finish();
        }
      };
      const networkError = (event: Event) => finish(new ConnectionError("OpenAI WebSocket connection error", "WEBSOCKET_CONNECTION_FAILED", { cause: (event as ErrorEvent).error }));
      const close = (event: Event) => {
        const { code, reason, wasClean } = event as CloseEvent;
        finish(code === 1009 ? new SocketError("OpenAI WebSocket request is too large", "1009", 413)
          : new ConnectionError(`OpenAI WebSocket closed before completion (code ${code ?? "unknown"}, clean ${wasClean ?? "unknown"})${reason ? `: ${reason}` : ""}`, `WEBSOCKET_CLOSE_${code ?? "UNKNOWN"}`));
      };
      const abort = () => finish(request.signal.reason);
      socket.addEventListener("message", message); socket.addEventListener("error", networkError); socket.addEventListener("close", close);
      request.signal.addEventListener("abort", abort, { once: true }); armTimeout();
      if (request.signal.aborted) { abort(); return; }
      const payload: Json = { ...outgoing, type: "response.create" }; delete payload.stream; delete payload.background;
      try { socket.send(JSON.stringify(payload)); }
      catch (error) { finish(new ConnectionError("OpenAI WebSocket connection error while sending", "WEBSOCKET_SEND_FAILED", { cause: error })); }
    });
  }
}
