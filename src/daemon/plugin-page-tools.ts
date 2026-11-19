import type { RuntimeEventData } from "../shared/contracts.js";
import { WindowClaims } from "./window-claims.js";

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
  readonly #claims: WindowClaims<unknown, PageToolCall>;

  constructor(private readonly options: PluginPageToolsOptions) {
    this.#claims = new WindowClaims({
      windows: options.windows,
      cancel: (projectId, request) => options.publish(projectId, "plugin.page.tool.cancel", { request }),
      error: (kind, message) => new PageToolError(message, kind === "failed" ? 502 : kind === "unclaimed" || kind === "timeout" ? 504 : 409),
    });
  }

  call(call: PageToolCall): Promise<unknown> {
    if (call.signal?.aborted) return Promise.reject(new PageToolError("Cancelled", 409));
    if (!this.options.windows(call.projectId))
      return Promise.reject(new PageToolError(`${call.plugin}'s ${call.tool} runs in its panel, so the project must be open in OhMyGame. Ask the person to open it.`, 409));
    return this.#claims.request(call.projectId, call, {
      startMs: PAGE_TOOL_START_MS,
      unclaimed: `No window of OhMyGame took ${call.plugin}'s ${call.tool}. The project may not be showing there.`,
      ...(call.signal ? { signal: call.signal } : {}),
      publish: (request, expires) => this.options.publish(call.projectId, "plugin.page.tool", {
        request,
        plugin: call.plugin,
        version: call.version,
        panel: call.panel,
        tool: call.tool,
        input: call.input,
        expires,
      }),
    });
  }

  /**
   * The window's answer to a call. False when nothing waits for it under
   * this project, such as after it was cancelled or timed out.
   */
  answer(projectId: string, request: string, answer: PageToolAnswer): boolean {
    if ("started" in answer) {
      const call = this.#claims.detail(projectId, request);
      const ms = call?.timeoutMs ?? PAGE_TOOL_DEFAULT_MS;
      return !!call && this.#claims.claim(projectId, request, ms, `${call.plugin}'s ${call.tool} didn't answer in ${Math.round(ms / 1000)} seconds`);
    }
    if ("declined" in answer) return this.#claims.decline(projectId, request, answer.declined);
    if ("progress" in answer) {
      const call = this.#claims.detail(projectId, request);
      call?.onProgress?.(answer.progress);
      return !!call;
    }
    if ("error" in answer) return this.#claims.fail(projectId, request, answer.error);
    return this.#claims.resolve(projectId, request, answer.result);
  }

  /** Whether one of a panel's tools is running in a project, so the panel's file changes are the caller's. */
  running(projectId: string, plugin: string, panel: string): boolean {
    for (const call of this.#claims.claimed(projectId)) if (call.plugin === plugin && call.panel === panel) return true;
    return false;
  }
}
