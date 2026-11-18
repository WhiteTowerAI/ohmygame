import { randomUUID } from "node:crypto";
import type { RuntimeEventData } from "../shared/contracts.js";

/** How long the project's windows have to take the call, one of them by claiming it. */
export const PAGE_TOOL_START_MS = 15_000;
/** How long a page has to answer once it has the call, when the tool sets no `timeoutSeconds`. */
export const PAGE_TOOL_DEFAULT_MS = 60_000;

export interface PageToolCall {
  projectId: string;
  /** `publisher/name`. */
  plugin: string;
  version: string;
  panel: string;
  tool: string;
  input: unknown;
  signal?: AbortSignal;
  /** How long the page has once it has the call. */
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

/** Why a page tool call failed, with the status a route answers with. */
export class PageToolError extends Error {
  constructor(message: string, readonly statusCode: 409 | 502 | 504) {
    super(message);
  }
}

/**
 * A window's answer: `started` claims the call before its page hears of it,
 * and only the window that claimed it answers after that; `declined` says why
 * a window can't take it, such as the panel being hidden there.
 */
export type PageToolAnswer = { started: true } | { declined: string } | { progress: string } | { result: unknown } | { error: string };

interface Waiting {
  call: PageToolCall;
  started: boolean;
  declined: string[];
  timer?: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface PluginPageToolsOptions {
  publish<T extends "plugin.page.tool" | "plugin.page.tool.cancel">(projectId: string, type: T, data: RuntimeEventData[T]): void;
  /** How many windows of the app have the project open, each of which may take a call. */
  windows(projectId: string): number;
}

/**
 * Tools a plugin's panel page answers (`contributes.tools[].panel`). The
 * daemon has no page of its own, so a call goes to the project's open window
 * as an event. One window claims it with `answer`, then shows the panel,
 * hands its page the call and answers with the result; the others let it
 * go. While a call runs, the panel's own file changes belong to whoever made
 * the call (an agent's turn, an outside agent or a command), as a native
 * tool's writes do.
 */
export class PluginPageTools {
  readonly #waiting = new Map<string, Waiting>();

  constructor(private readonly options: PluginPageToolsOptions) {}

  call(call: PageToolCall): Promise<unknown> {
    if (call.signal?.aborted) return Promise.reject(new PageToolError("Cancelled", 409));
    if (!this.options.windows(call.projectId))
      return Promise.reject(new PageToolError(`${call.plugin}'s ${call.tool} runs in its panel, so the project must be open in OhMyGame. Ask the person to open it.`, 409));
    const request = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const settle = () => {
        clearTimeout(waiting.timer);
        call.signal?.removeEventListener("abort", abort);
        this.#waiting.delete(request);
      };
      const waiting: Waiting = {
        call,
        started: false,
        declined: [],
        resolve: (value) => { settle(); resolve(value); },
        reject: (error) => { settle(); reject(error); },
      };
      const abort = () => this.#give(request, waiting, new PageToolError("Cancelled", 409));
      this.#waiting.set(request, waiting);
      this.#arm(request, waiting, PAGE_TOOL_START_MS, `No window of OhMyGame took ${call.plugin}'s ${call.tool}. The project may not be showing there.`);
      call.signal?.addEventListener("abort", abort, { once: true });
      this.options.publish(call.projectId, "plugin.page.tool", {
        request,
        plugin: call.plugin,
        version: call.version,
        panel: call.panel,
        tool: call.tool,
        input: call.input,
        expires: Date.now() + PAGE_TOOL_START_MS,
      });
    });
  }

  /**
   * The window's answer to a call. False when nothing waits for it under
   * this project, such as after it was cancelled or timed out.
   */
  answer(projectId: string, request: string, answer: PageToolAnswer): boolean {
    const waiting = this.#waiting.get(request);
    if (!waiting || waiting.call.projectId !== projectId) return false;
    if ("started" in answer) {
      // Another window took it already.
      if (waiting.started) return false;
      waiting.started = true;
      const ms = waiting.call.timeoutMs ?? PAGE_TOOL_DEFAULT_MS;
      this.#arm(request, waiting, ms, `${waiting.call.plugin}'s ${waiting.call.tool} didn't answer in ${Math.round(ms / 1000)} seconds`);
    } else if ("declined" in answer) {
      if (waiting.started) return true;
      waiting.declined.push(answer.declined);
      // Once every open window has said why, nobody is left to take it.
      if (waiting.declined.length >= this.options.windows(projectId)) this.#give(request, waiting, new PageToolError(answer.declined, 409));
    } else if ("progress" in answer) waiting.call.onProgress?.(answer.progress);
    else if ("error" in answer) waiting.reject(new PageToolError(answer.error, 502));
    else waiting.resolve(answer.result);
    return true;
  }

  /** Whether one of a panel's tools is running in a project, so the panel's file changes are the caller's. */
  running(projectId: string, plugin: string, panel: string): boolean {
    for (const waiting of this.#waiting.values())
      if (waiting.call.projectId === projectId && waiting.call.plugin === plugin && waiting.call.panel === panel && waiting.started) return true;
    return false;
  }

  #arm(request: string, waiting: Waiting, ms: number, message: string) {
    clearTimeout(waiting.timer);
    waiting.timer = setTimeout(() => this.#give(request, waiting, new PageToolError(message, 504)), ms);
  }

  /** Gives up on a call and tells the window, so the page stops too. */
  #give(request: string, waiting: Waiting, error: PageToolError) {
    waiting.reject(error);
    this.options.publish(waiting.call.projectId, "plugin.page.tool.cancel", { request });
  }
}
