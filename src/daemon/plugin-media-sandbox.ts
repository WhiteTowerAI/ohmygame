import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { EvalFlags, JSException, QuickJS, type JSValueHandle } from "quickjs-wasi";

// Runs a plugin's media adapter (docs/media-provider-plugins.md) in QuickJS
// compiled to WebAssembly. The script has no file system, processes, timers,
// modules or network of its own: its only way out is the `host` object, whose
// `fetch` the caller makes, adding the provider's key where the script asks.
// Each call starts a fresh VM, so nothing carries over between requests.

/** What an adapter's `host.fetch` asks for. */
export interface MediaFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON, with `content-type: application/json`. */
  json?: unknown;
  /** Sent as it is. */
  body?: string;
  /** Adds the provider's key as its manifest says. */
  auth?: boolean;
}

export interface MediaFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MediaSandboxCall {
  /** The adapter's source. */
  source: string;
  /** Its path in the package, for errors. */
  file: string;
  kind: string;
  step: string;
  /** Values the step receives before `host`, as JSON. */
  args: unknown[];
  fetch(request: MediaFetchRequest, signal: AbortSignal): Promise<MediaFetchResponse>;
  log?(message: string): void;
  signal?: AbortSignal;
}

export class MediaSandboxError extends Error {}

export const MEDIA_SANDBOX_MEMORY_BYTES = 64 * 1024 * 1024;
/** The script's own running time per call; waiting on `host.fetch` doesn't count. */
export const MEDIA_SANDBOX_CPU_MS = 2_000;
/** A call as a whole, waiting included. */
export const MEDIA_SANDBOX_CALL_MS = 120_000;
/** `host.fetch` requests a call may have open at once: answers wait in the app, outside the script's memory. */
export const MEDIA_SANDBOX_FETCHES = 4;

let wasm: Promise<WebAssembly.Module> | undefined;
function quickjsModule(): Promise<WebAssembly.Module> {
  wasm ??= readFile(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm"))
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((cause) => {
      wasm = undefined;
      throw cause;
    });
  return wasm;
}

// Builds `host` over two functions the script can't keep, and the functions
// the app calls. Requests, answers and results cross as JSON text, so no
// object of the app's reaches the script, and the app reads nothing of the
// script's but strings: whatever could run the script's code (a getter, a
// replaced JSON.stringify) runs in the VM, within its limits. Each request
// waits on a promise of the script's own, which the app settles by its id.
// Evaluates to [call, settle, describe].
const PRELUDE = `(() => {
  const rawFetch = globalThis.__ohmygameFetch;
  const rawLog = globalThis.__ohmygameLog;
  delete globalThis.__ohmygameFetch;
  delete globalThis.__ohmygameLog;
  const { stringify, parse } = JSON;
  const NativePromise = Promise;
  const pending = new Map();
  let next = 0;
  const host = Object.freeze({
    async fetch(url, init) {
      const id = String(++next);
      const text = await new NativePromise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          rawFetch(id, stringify({ ...(init ?? {}), url: String(url) }));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
      const answer = parse(text);
      const body = answer.body;
      return Object.freeze({
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        headers: Object.freeze(answer.headers),
        async text() { return body; },
        async json() { return parse(body); },
      });
    },
    log(message) { rawLog(String(message)); },
  });
  const call = async (exports, kind, step, args) => {
    const section = exports.default && exports.default[kind];
    const run = section && section[step];
    if (typeof run !== "function") throw new TypeError("it has no " + kind + "." + step);
    const value = await run.call(section, ...parse(args), host);
    return value === undefined ? "null" : stringify(value);
  };
  const settle = (id, ok, text) => {
    const request = pending.get(id);
    pending.delete(id);
    if (request) ok ? request.resolve(text) : request.reject(new Error(text));
  };
  const describe = (error) => {
    try {
      const message = typeof error === "string" ? error : error && error.message;
      return typeof message === "string" ? message.slice(0, 1000) : "an error";
    } catch {
      return "an error";
    }
  };
  return [call, settle, describe];
})()`;

/** The most a step may return, as JSON. */
const RESULT_MAX_CHARACTERS = 48 * 1024 * 1024;

/** Runs `default[kind][step](...args, host)` and resolves to what it returns, as JSON. */
export async function runMediaAdapter(call: MediaSandboxCall): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new MediaSandboxError(`${call.file} took longer than ${MEDIA_SANDBOX_CALL_MS / 1000} seconds`)), MEDIA_SANDBOX_CALL_MS);
  const stop = () => controller.abort(call.signal?.reason);
  call.signal?.addEventListener("abort", stop, { once: true });
  if (call.signal?.aborted) stop();
  let used = 0;
  let since: number | undefined;
  let closed = false;
  const vm = await QuickJS.create({
    wasm: await quickjsModule(),
    memoryLimit: MEDIA_SANDBOX_MEMORY_BYTES,
    interruptHandler: () => since !== undefined && (used + performance.now() - since > MEDIA_SANDBOX_CPU_MS || controller.signal.aborted),
  });
  const tooLong = () => new MediaSandboxError(`${call.file} ran for more than ${MEDIA_SANDBOX_CPU_MS / 1000} seconds`);
  // Every entry into the VM counts towards the script's own time.
  const inside = <T>(run: () => T): T => {
    since = performance.now();
    try {
      return run();
    } catch (cause) {
      if (cause instanceof JSException) cause.handle.dispose();
      throw used + performance.now() - since > MEDIA_SANDBOX_CPU_MS ? tooLong() : cause;
    } finally {
      used += performance.now() - since;
      since = undefined;
    }
  };
  const drain = () => inside(() => vm.executePendingJobs());
  /** Calls a function of the prelude's with strings and booleans, and reads the string it returns. */
  const invoke = (fn: JSValueHandle, ...args: Array<string | boolean | JSValueHandle>): string | undefined => {
    const values = args.map((arg) => typeof arg === "string" ? vm.newString(arg) : typeof arg === "boolean" ? (arg ? vm.true : vm.false) : arg);
    try {
      const result = inside(() => vm.callFunction(fn, vm.undefined, ...values));
      try {
        return vm.typeof(result) === "string" ? result.toString() : undefined;
      } finally {
        result.dispose();
      }
    } finally {
      values.forEach((value, index) => { if (typeof args[index] === "string") value.dispose(); });
    }
  };
  const handles: JSValueHandle[] = [];
  const keep = (handle: JSValueHandle) => {
    handles.push(handle);
    return handle;
  };
  let open = 0;
  try {
    const fetchFunction = keep(vm.newFunction("__ohmygameFetch", (id, text) => {
      if (vm.typeof(id) !== "string" || vm.typeof(text) !== "string") throw new TypeError("host.fetch takes a URL and an object");
      const request = id.toString();
      if (open >= MEDIA_SANDBOX_FETCHES) throw new TypeError(`host.fetch allows ${MEDIA_SANDBOX_FETCHES} requests at a time`);
      let parsed: MediaFetchRequest;
      try {
        parsed = JSON.parse(text.toString()) as MediaFetchRequest;
      } catch {
        throw new TypeError("host.fetch takes a URL and an object");
      }
      const deliver = (ok: boolean, answer: string) => {
        // The call is over, or stopped: nothing is left to tell.
        if (closed || controller.signal.aborted) return;
        try {
          invoke(settle, request, ok, answer);
          drain();
        } catch (cause) {
          controller.abort(cause instanceof MediaSandboxError ? cause : new MediaSandboxError(`${call.file}: ${cause instanceof Error ? cause.message : String(cause)}`));
        }
      };
      open += 1;
      call.fetch(parsed, controller.signal).finally(() => { open -= 1; }).then(
        (answer) => deliver(true, JSON.stringify(answer)),
        (cause: unknown) => deliver(false, cause instanceof Error ? cause.message : String(cause)),
      );
      return vm.undefined;
    }));
    vm.setProp(vm.global, "__ohmygameFetch", fetchFunction);
    const logFunction = keep(vm.newFunction("__ohmygameLog", (text) => {
      if (vm.typeof(text) === "string") call.log?.(text.toString().slice(0, 2000));
      return vm.undefined;
    }));
    vm.setProp(vm.global, "__ohmygameLog", logFunction);
    const prelude = keep(inside(() => vm.evalCode(PRELUDE, "<ohmygame>")));
    const [run, settle, describeFunction] = ["0", "1", "2"].map((index) => keep(prelude.getProp(index))) as [JSValueHandle, JSValueHandle, JSValueHandle];
    const describe = (error: JSValueHandle) => invoke(describeFunction, keep(error)) ?? "an error";

    const loading = keep(inside(() => vm.evalCode(call.source, call.file, EvalFlags.TYPE_MODULE)));
    drain();
    const loaded = await waitFor(vm.resolvePromise(loading), controller.signal);
    if ("error" in loaded) throw new MediaSandboxError(`${call.file} failed to load: ${describe(loaded.error)}`);
    const exports = keep(loaded.value);
    const args = [call.kind, call.step, JSON.stringify(call.args)].map((value) => keep(vm.newString(value)));
    const calling = keep(inside(() => vm.callFunction(run, vm.undefined, exports, ...args)));
    drain();
    const result = await waitFor(vm.resolvePromise(calling), controller.signal);
    if ("error" in result) throw new MediaSandboxError(`${call.file} ${call.kind}.${call.step} failed: ${describe(result.error)}`);
    const value = keep(result.value);
    const json = vm.typeof(value) === "string" ? value.toString() : undefined;
    if (json === undefined) throw new MediaSandboxError(`${call.file} ${call.kind}.${call.step} returned what isn't data`);
    if (json.length > RESULT_MAX_CHARACTERS) throw new MediaSandboxError(`${call.file} ${call.kind}.${call.step} returned more than ${RESULT_MAX_CHARACTERS / 1024 / 1024} MB`);
    return JSON.parse(json) as unknown;
  } catch (cause) {
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new MediaSandboxError(`${call.file} was stopped`);
    if (cause instanceof MediaSandboxError) throw cause;
    if (used > MEDIA_SANDBOX_CPU_MS) throw tooLong();
    throw new MediaSandboxError(`${call.file}: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    closed = true;
    clearTimeout(timeout);
    call.signal?.removeEventListener("abort", stop);
    // Requests still out stop too.
    controller.abort(new MediaSandboxError(`${call.file} finished`));
    for (const handle of handles.reverse()) {
      try { handle.dispose(); } catch { /* already gone with its VM */ }
    }
    vm.dispose();
  }
}

/** Waits for the script, unless the call is stopped first. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
