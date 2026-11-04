import { AgentProcess, processFailure } from "./process.js";
import { record } from "./driver-context.js";
import { cliProbeError } from "./compatibility.js";

const REQUEST_TIMEOUT_MS = 60_000;

export interface JsonRpcHandlers {
  processDirectory?: string;
  notification?: (method: string, params: Record<string, unknown>) => void;
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  exit?: (failure: string) => void;
}

/** A request the other side refused, with its JSON-RPC error code. */
export function rpcErrorCode(cause: unknown): number | undefined {
  const code = (cause as { rpcCode?: unknown } | undefined)?.rpcCode;
  return typeof code === "number" ? code : undefined;
}

/**
 * A JSON-RPC 2.0 connection to a CLI over its stdio, one message per line
 * each way, as Codex's app server and the Agent Client Protocol speak it.
 */
export class JsonRpcProcess {
  readonly process: AgentProcess;
  #next = 1;
  #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (cause: Error) => void;
      timer?: NodeJS.Timeout;
    }
  >();
  #closed?: Error;

  constructor(
    binaryPath: string,
    args: readonly string[],
    cwd: string,
    env: Record<string, string>,
    readonly name: string,
    private readonly handlers: JsonRpcHandlers = {},
  ) {
    this.process = new AgentProcess({
      binaryPath,
      args: [...args],
      cwd,
      env,
      processDirectory: handlers.processDirectory,
      onLine: (line) => this.#receive(line),
      onExit: (code, signal, stderr) => {
        this.#closed = new Error(processFailure(name, code, signal, stderr));
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(this.#closed);
        }
        this.#pending.clear();
        handlers.exit?.(this.#closed.message);
      },
    });
  }

  /** A request; `Infinity` waits as long as it takes, as for a turn that ends when the agent says. */
  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(new Error(`${this.name} did not answer ${method}`));
          }, timeoutMs)
        : undefined;
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.process.write({ jsonrpc: "2.0", id, method, params });
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.process.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  stop(): Promise<void> {
    return this.process.stop();
  }

  #receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof message.method === "string") {
      const params = record(message.params) ?? {};
      if (id === undefined || id === null) {
        this.handlers.notification?.(message.method, params);
        return;
      }
      void (
        this.handlers.request?.(message.method, params) ??
        Promise.reject(
          Object.assign(new Error(`Unsupported request ${message.method}`), {
            rpcCode: -32601,
          }),
        )
      ).then(
        (result) => {
          if (this.process.running)
            this.process.write({ jsonrpc: "2.0", id, result });
        },
        (cause) => {
          if (this.process.running)
            this.process.write({
              jsonrpc: "2.0",
              id,
              error: {
                code: rpcErrorCode(cause) ?? -32000,
                message: cause instanceof Error ? cause.message : String(cause),
              },
            });
        },
      );
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = record(message.error);
    if (error)
      pending.reject(
        Object.assign(
          cliProbeError(
            this.name,
            String(error.message ?? `${this.name} request failed`),
          ),
          typeof error.code === "number" ? { rpcCode: error.code } : {},
        ),
      );
    else pending.resolve(message.result);
  }
}
