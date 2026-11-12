import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { EvalFlags, QuickJS, type JSValueHandle } from "quickjs-wasi";

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

// Builds `host` over two functions the script can't keep, and the function
// that calls a step. Requests, answers and results cross as JSON text, so no
// object of the app's reaches the script and nothing of the script's (such as
// a getter) runs outside its time limit. Evaluates to [host, call].
const PRELUDE = `(() => {
  const rawFetch = globalThis.__ohmygameFetch;
  const rawLog = globalThis.__ohmygameLog;
  delete globalThis.__ohmygameFetch;
  delete globalThis.__ohmygameLog;
  const host = Object.freeze({
    async fetch(url, init) {
      const answer = JSON.parse(await rawFetch(JSON.stringify({ ...(init ?? {}), url: String(url) })));
      const body = answer.body;
      return Object.freeze({
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        headers: Object.freeze(answer.headers),
        async text() { return body; },
        async json() { return JSON.parse(body); },
      });
    },
    log(message) { rawLog(String(message)); },
  });
  const call = async (exports, kind, step, args) => {
    const section = exports.default && exports.default[kind];
    const run = section && section[step];
    if (typeof run !== "function") throw new TypeError("it has no " + kind + "." + step);
    const value = await run.call(section, ...JSON.parse(args), host);
    return value === undefined ? "null" : JSON.stringify(value);
  };
  return [host, call];
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
  const vm = await QuickJS.create({
    wasm: await quickjsModule(),
    memoryLimit: MEDIA_SANDBOX_MEMORY_BYTES,
    interruptHandler: () => since !== undefined && (used + performance.now() - since > MEDIA_SANDBOX_CPU_MS || controller.signal.aborted),
  });
  // Every entry into the VM counts towards the script's own time.
  const inside = <T>(run: () => T): T => {
    since = performance.now();
    try {
      return run();
    } finally {
      used += performance.now() - since;
      since = undefined;
    }
  };
  const drain = () => inside(() => vm.executePendingJobs());
  const handles: JSValueHandle[] = [];
  const keep = (handle: JSValueHandle) => {
    handles.push(handle);
    return handle;
  };
  try {
    const fetchFunction = keep(vm.newFunction("__ohmygameFetch", (text) => {
      const deferred = vm.newPromise();
      let request: MediaFetchRequest;
      try {
        request = JSON.parse(text!.toString()) as MediaFetchRequest;
      } catch {
        deferred.reject(vm.newError("host.fetch takes a URL and an object"));
        return deferred.handle;
      }
      call.fetch(request, controller.signal).then(
        (answer) => {
          deferred.resolve(vm.newString(JSON.stringify(answer)));
          drain();
        },
        (cause: unknown) => {
          deferred.reject(vm.newError(cause instanceof Error ? cause.message : String(cause)));
          drain();
        },
      );
      return deferred.handle;
    }));
    vm.setProp(vm.global, "__ohmygameFetch", fetchFunction);
    const logFunction = keep(vm.newFunction("__ohmygameLog", (text) => {
      call.log?.(String(text?.toString() ?? "").slice(0, 2000));
      return vm.undefined;
    }));
    vm.setProp(vm.global, "__ohmygameLog", logFunction);
    const prelude = keep(inside(() => vm.evalCode(PRELUDE, "<ohmygame>")));
    const run = keep(inside(() => prelude.getProp("1")));

    const loading = keep(inside(() => vm.evalCode(call.source, call.file, EvalFlags.TYPE_MODULE)));
    drain();
    const loaded = await settle(vm.resolvePromise(loading), controller.signal);
    if ("error" in loaded) throw new MediaSandboxError(`${call.file} failed to load: ${describe(vm, keep(loaded.error))}`);
    const exports = keep(loaded.value);
    const calling = keep(inside(() => vm.callFunction(run, vm.undefined, exports, keep(vm.newString(call.kind)), keep(vm.newString(call.step)), keep(vm.newString(JSON.stringify(call.args))))));
    drain();
    const result = await settle(vm.resolvePromise(calling), controller.signal);
    if ("error" in result) throw new MediaSandboxError(`${call.file} ${call.kind}.${call.step} failed: ${describe(vm, keep(result.error))}`);
    const text = keep(result.value).toString();
    if (text.length > RESULT_MAX_CHARACTERS) throw new MediaSandboxError(`${call.file} ${call.kind}.${call.step} returned more than ${RESULT_MAX_CHARACTERS / 1024 / 1024} MB`);
    return JSON.parse(text) as unknown;
  } catch (cause) {
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new MediaSandboxError(`${call.file} was stopped`);
    if (cause instanceof MediaSandboxError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new MediaSandboxError(/interrupted/.test(message) ? `${call.file} ran for more than ${MEDIA_SANDBOX_CPU_MS / 1000} seconds` : `${call.file}: ${message}`);
  } finally {
    clearTimeout(timeout);
    call.signal?.removeEventListener("abort", stop);
    for (const handle of handles.reverse()) {
      try { handle.dispose(); } catch { /* already gone with its VM */ }
    }
    vm.dispose();
  }
}

/** Waits for the script, unless the call is stopped first. */
function settle<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** An error's message, read without running anything of the script's. */
function describe(vm: QuickJS, error: JSValueHandle): string {
  try {
    if (vm.typeof(error) === "string") return error.toString().slice(0, 1000);
    if (vm.typeof(error) !== "object") return "an error";
    const message = error.getOwnPropertyDescriptor("message");
    message?.get?.dispose();
    message?.set?.dispose();
    const value = message?.value;
    if (!value) return "an error";
    try {
      return vm.typeof(value) === "string" ? value.toString().slice(0, 1000) : "an error";
    } finally {
      value.dispose();
    }
  } catch {
    return "an error";
  }
}
