import { createHash } from "node:crypto";
import { getGlobalDispatcher, WebSocket as UndiciWebSocket } from "undici/index.js";
import { ImageBudgetError, localImageError, MODEL_REQUEST_HIGH_BYTES, object, SessionImages, type Json } from "./session-images.js";
import { OpenAISessionFiles, openAIRequestScope, rejectedOpenAIFiles, isRejectedOpenAIFileError, type UsedOpenAIFile } from "./openai-session-files.js";

export interface ResponseSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string, headers: Headers) => ResponseSocket;
interface Continuation { responseId: string; parameters: string; inputLength: number; inputHash: string }
interface TransportOptions { transport?: string; cacheRetention?: string; connectTimeoutMs?: number; timeoutMs?: number }
class SocketError extends Error {
  constructor(message: string, readonly code?: string, readonly status = 400) { super(message); }
}
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
    private readonly socketFactory: SocketFactory = (url, headers) => new UndiciWebSocket(url, { headers: Object.fromEntries(headers), dispatcher: getGlobalDispatcher() }) as unknown as ResponseSocket) {}

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
      if (!isOfficialOpenAIResponses(url)) return delegate(input, init);
      const request = new Request(input, init);
      if (request.method !== "POST" || !request.headers.get("content-type")?.includes("application/json")) return delegate(request);
      const original: unknown = await request.json();
      if (!object(original)) return localImageError(new ImageBudgetError());
      await this.invalidations;
      const scope = openAIRequestScope(request.headers);
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
        if (/^Bearer\s+sk-/i.test(request.headers.get("authorization") ?? "") && Date.now() >= this.filesUnavailableUntil) {
          try { used = await this.files.replace(body, request.headers, delegate, request.signal); }
          catch {
            request.signal.throwIfAborted();
            this.filesUnavailableUntil = Date.now() + 5 * 60 * 1000;
          }
        }
        this.images.applyOmissions(body, "openai-inline");
        let response: Response;
        const websocket = options.transport !== "sse" && Date.now() >= this.fallbackUntil && !this.busy;
        try {
          if (websocket) {
            if (!this.socket || this.socket.readyState !== 1 || Date.now() - this.openedAt >= 55 * 60 * 1000) this.dispose();
            let outgoing = this.socket && options.transport !== "websocket" && options.cacheRetention !== "none" ? this.delta(body) : undefined;
            if (!outgoing) { this.continuation = undefined; outgoing = body; }
            const changed = this.images.budget(outgoing, "openai-inline", reduceRequest);
            if (changed && outgoing !== body) {
              this.dispose(); this.images.budget(body, "openai-inline"); outgoing = body;
            }
            if (Buffer.byteLength(JSON.stringify({ type: "response.create", ...outgoing })) > MODEL_REQUEST_HIGH_BYTES) throw new ImageBudgetError();
            try { response = await this.send(outgoing, body, request, options, used); }
            catch (error) {
              request.signal.throwIfAborted();
              this.dispose();
              if (error instanceof SocketError) {
                if (["previous_response_not_found", "websocket_connection_limit_reached"].includes(error.code ?? "") && attempt === 0) continue;
                if ((error.status === 413 || sizeErrorCode(error.code)) && !reduceRequest) { reduceRequest = true; continue; }
                response = new Response(JSON.stringify({ error: { code: error.code, message: error.message } }),
                  { status: error.status, headers: { "content-type": "application/json", "x-should-retry": "false" } });
              } else {
                // No event has escaped to Pi here. A network/handshake failure can safely fall back.
                this.fallbackUntil = Date.now() + 5 * 60 * 1000;
                this.images.budget(body, "openai-inline", reduceRequest);
                response = await delegate(this.httpRequest(request, body));
              }
            }
          } else {
            this.images.budget(body, "openai-inline", reduceRequest);
            response = await delegate(this.httpRequest(request, body));
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
    return new Request(request.url, { method: "POST", headers, body: JSON.stringify(payload), signal: request.signal, redirect: "error" });
  }

  private async connect(request: Request, timeoutMs: number): Promise<ResponseSocket> {
    if (this.socket?.readyState === 1) return this.socket;
    const headers = new Headers(request.headers);
    for (const name of ["content-length", "content-type", "accept", "connection"]) headers.delete(name);
    const socket = this.socketFactory("wss://api.openai.com/v1/responses", headers);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { if (timer) clearTimeout(timer); socket.removeEventListener("open", open); socket.removeEventListener("error", error); socket.removeEventListener("close", error); request.signal.removeEventListener("abort", abort); };
      const open = () => { cleanup(); resolve(); };
      const error = () => { cleanup(); socket.close(); reject(new Error("OpenAI WebSocket connection failed")); };
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
      const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
      const armTimeout = () => {
        if (timer) clearTimeout(timer);
        if (options.timeoutMs !== 0) { timer = setTimeout(() => finish(new Error("OpenAI WebSocket idle timeout")), options.timeoutMs ?? 120_000); timer.unref?.(); }
      };
      const finish = (error?: unknown) => {
        if (ended) return; ended = true;
        if (timer) clearTimeout(timer);
        socket.removeEventListener("message", message); socket.removeEventListener("error", networkError); socket.removeEventListener("close", close);
        request.signal.removeEventListener("abort", abort); this.busy = false;
        if (error) {
          this.dispose();
          if (first) { reject(error); void response.body?.cancel().catch(() => {}); }
          else {
            // Pi retries errors by matching their message. Keep the transport cause in
            // diagnostics without classifying an already-started inference as retryable.
            try { controller.error(new Error("OpenAI response interrupted after streaming began. Automatic replay is disabled.", { cause: error })); }
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
        catch { finish(new Error("OpenAI sent an invalid WebSocket event")); return; }
        if (!object(data)) { finish(new Error("OpenAI sent an invalid WebSocket event")); return; }
        const failure = data.type === "error" ? (object(data.error) ? data.error : data)
          : data.type === "response.failed" && object(data.response) ? data.response.error : undefined;
        if (isRejectedOpenAIFileError(failure, used)) {
          if (first && object(failure)) {
            finish(new SocketError(String(failure.message ?? "OpenAI image file is unavailable"), String(failure.code ?? "file_not_found"))); return;
          }
          // After events escape, never replay inference. Invalidate IDs for the next request.
          this.invalidations = this.invalidations.then(() => this.files.invalidate(used));
          void this.invalidations.catch(() => {});
        }
        if (data.type === "error") {
          const error = object(data.error) ? data.error : data;
          finish(new SocketError(typeof error.message === "string" ? error.message : "OpenAI WebSocket request failed",
            typeof error.code === "string" ? error.code : undefined, typeof data.status === "number" ? data.status : 400)); return;
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
      const networkError = () => finish(new Error("OpenAI WebSocket connection failed"));
      const close = (event: Event) => {
        const code = (event as CloseEvent).code;
        finish(code === 1009 ? new SocketError("OpenAI WebSocket request is too large", "1009", 413) : new Error("OpenAI WebSocket closed before completion"));
      };
      const abort = () => finish(request.signal.reason);
      socket.addEventListener("message", message); socket.addEventListener("error", networkError); socket.addEventListener("close", close);
      request.signal.addEventListener("abort", abort, { once: true }); armTimeout();
      if (request.signal.aborted) { abort(); return; }
      const payload: Json = { ...outgoing, type: "response.create" }; delete payload.stream; delete payload.background;
      try { socket.send(JSON.stringify(payload)); } catch (error) { finish(error); }
    });
  }
}
