import { randomUUID } from "node:crypto";
import type { PlaytestDriver, PlaytestIpcMessage, PlaytestRequest, PlaytestResult } from "../shared/playtest.js";

interface ProcessIpc {
  connected?: boolean;
  send?: (message: PlaytestIpcMessage, callback?: (error: Error | null) => void) => boolean;
  on(event: "message" | "disconnect", listener: (...args: any[]) => void): unknown;
  off(event: "message" | "disconnect", listener: (...args: any[]) => void): unknown;
}

interface PendingRequest {
  resolve: (result: PlaytestResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class ProcessPlaytestDriver implements PlaytestDriver {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #onMessage = (message: unknown) => this.#handleMessage(message);
  readonly #onDisconnect = () => this.#rejectAll(new Error("Desktop playtest service disconnected"));
  #closed = false;

  constructor(
    private readonly ipc: ProcessIpc = process as unknown as ProcessIpc,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    ipc.on("message", this.#onMessage);
    ipc.on("disconnect", this.#onDisconnect);
  }

  get available(): boolean {
    return !this.#closed && this.ipc.connected === true && typeof this.ipc.send === "function";
  }

  request(request: PlaytestRequest, signal?: AbortSignal): Promise<PlaytestResult> {
    if (!this.available) return Promise.reject(new Error("Browser playtesting is not available in this environment"));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = randomUUID();
    return new Promise<PlaytestResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#settle(id, new Error(`Browser playtest request timed out after ${this.timeoutMs}ms`));
        this.#send({ channel: "ohmygame:playtest-cancel", id });
      }, this.timeoutMs);
      const onAbort = signal ? () => {
        this.#settle(id, abortError());
        this.#send({ channel: "ohmygame:playtest-cancel", id });
      } : undefined;
      signal?.addEventListener("abort", onAbort!, { once: true });
      this.#pending.set(id, { resolve, reject, signal, onAbort, timeout });
      this.#send({ channel: "ohmygame:playtest-request", id, request }, (error) => {
        if (error) this.#settle(id, error);
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.ipc.off("message", this.#onMessage);
    this.ipc.off("disconnect", this.#onDisconnect);
    this.#rejectAll(new Error("Browser playtest driver closed"));
  }

  #send(message: PlaytestIpcMessage, callback?: (error: Error | null) => void): void {
    try {
      this.ipc.send?.(message, callback);
    } catch (cause) {
      callback?.(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  #handleMessage(message: unknown): void {
    if (!isResponse(message)) return;
    if (message.error) this.#settle(message.id, new Error(message.error));
    else if (message.result) this.#settle(message.id, undefined, message.result);
    else this.#settle(message.id, new Error("Desktop playtest service returned an empty response"));
  }

  #settle(id: string, error?: Error, result?: PlaytestResult): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(result!);
  }

  #rejectAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) this.#settle(id, error);
  }
}

function isResponse(value: unknown): value is Extract<PlaytestIpcMessage, { channel: "ohmygame:playtest-response" }> {
  if (!value || typeof value !== "object") return false;
  const message = value as { channel?: unknown; id?: unknown; result?: unknown; error?: unknown };
  return message.channel === "ohmygame:playtest-response" && typeof message.id === "string" &&
    (message.result !== undefined || typeof message.error === "string");
}

function abortError(): Error {
  return new DOMException("Browser playtest request aborted", "AbortError");
}
