import { randomUUID } from "node:crypto";

/** Why a request to the project's windows ended without its value. */
export type ClaimFailure = "cancelled" | "unclaimed" | "declined" | "timeout" | "failed";

interface Waiting<T, D> {
  projectId: string;
  detail: D;
  started: boolean;
  declined: string[];
  timer?: NodeJS.Timeout;
  resolve(value: T): void;
  reject(error: Error): void;
}

export interface WindowClaimsOptions {
  /** How many windows of the app have the project open, each of which may take a request. */
  windows(projectId: string): number;
  /** Tells the project's windows a request was given up, so the one that took it stops. */
  cancel(projectId: string, request: string): void;
  /** The error a request fails with. */
  error(kind: ClaimFailure, message: string): Error;
}

/**
 * Requests the daemon hands a project's open windows as an event, since it
 * has no page of its own. One window claims a request before it acts on it,
 * so only one does; a window that can't take it declines with why, and once
 * every open window has, the request fails with their reasons. A request
 * nobody claims in time, or that its caller stops, is given up and the
 * windows hear so.
 */
export class WindowClaims<T, D> {
  readonly #waiting = new Map<string, Waiting<T, D>>();

  constructor(private readonly options: WindowClaimsOptions) {}

  /**
   * Publishes a request with `publish` and waits for a window's value.
   * `unclaimed` is the error when no window claims it within `startMs`.
   */
  request(projectId: string, detail: D, start: {
    startMs: number;
    unclaimed: string;
    signal?: AbortSignal;
    publish(request: string, expires: number): void;
  }): Promise<T> {
    const { signal } = start;
    if (signal?.aborted) return Promise.reject(this.options.error("cancelled", "Cancelled"));
    const request = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const settle = () => {
        clearTimeout(waiting.timer);
        signal?.removeEventListener("abort", abort);
        this.#waiting.delete(request);
      };
      const waiting: Waiting<T, D> = {
        projectId,
        detail,
        started: false,
        declined: [],
        resolve: (value) => { settle(); resolve(value); },
        reject: (error) => { settle(); reject(error); },
      };
      const abort = () => this.#give(request, waiting, "cancelled", "Cancelled");
      this.#waiting.set(request, waiting);
      this.#arm(request, waiting, start.startMs, "unclaimed", start.unclaimed);
      signal?.addEventListener("abort", abort, { once: true });
      start.publish(request, Date.now() + start.startMs);
    });
  }

  /** What a request waiting under this project was made with. */
  detail(projectId: string, request: string): D | undefined {
    return this.#get(projectId, request)?.detail;
  }

  /**
   * A window claims a request, which it then has `ms` to finish, failing
   * with `message` after. False when another window took it first or
   * nothing waits for it.
   */
  claim(projectId: string, request: string, ms: number, message: string): boolean {
    const waiting = this.#get(projectId, request);
    if (!waiting || waiting.started) return false;
    waiting.started = true;
    this.#arm(request, waiting, ms, "timeout", message);
    return true;
  }

  /** A window can't take a request; once every open window has said why, it fails with their reasons. */
  decline(projectId: string, request: string, reason: string): boolean {
    const waiting = this.#get(projectId, request);
    if (!waiting) return false;
    // Another window took it.
    if (waiting.started) return true;
    waiting.declined.push(reason);
    if (waiting.declined.length >= this.options.windows(projectId))
      this.#give(request, waiting, "declined", [...new Set(waiting.declined)].join(" "));
    return true;
  }

  /** The claiming window's value. False when nothing claimed waits for it. */
  resolve(projectId: string, request: string, value: T): boolean {
    const waiting = this.#get(projectId, request);
    if (!waiting?.started) return false;
    waiting.resolve(value);
    return true;
  }

  /** Why the claiming window failed. False when nothing claimed waits for it. */
  fail(projectId: string, request: string, message: string): boolean {
    const waiting = this.#get(projectId, request);
    if (!waiting?.started) return false;
    waiting.reject(this.options.error("failed", message));
    return true;
  }

  /** What each claimed request waiting under this project was made with. */
  *claimed(projectId: string): Iterable<D> {
    for (const waiting of this.#waiting.values()) if (waiting.projectId === projectId && waiting.started) yield waiting.detail;
  }

  #get(projectId: string, request: string): Waiting<T, D> | undefined {
    const waiting = this.#waiting.get(request);
    return waiting?.projectId === projectId ? waiting : undefined;
  }

  #arm(request: string, waiting: Waiting<T, D>, ms: number, kind: ClaimFailure, message: string) {
    clearTimeout(waiting.timer);
    waiting.timer = setTimeout(() => this.#give(request, waiting, kind, message), ms);
  }

  /** Gives up on a request and tells the windows, so the one acting on it stops too. */
  #give(request: string, waiting: Waiting<T, D>, kind: ClaimFailure, message: string) {
    waiting.reject(this.options.error(kind, message));
    this.options.cancel(waiting.projectId, request);
  }
}
