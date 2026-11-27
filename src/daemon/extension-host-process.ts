import type { PluginSessionRequest, PluginSessionResults, PluginSessions } from "../shared/plugin-sessions.js";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "node:util";
import {
  EXTENSION_HOST_PROTOCOL_VERSION,
  validEngineStart,
  type NativeEngineSession,
  type NativeEngineStart,
  PROJECT_TYPE_HOOKS,
  HOST_MESSAGE_MAX_CHARS,
  isProgressLink,
  HOST_PROGRESS_INTERVAL_MS,
  HOST_RESULT_MAX_BYTES,
  type ExtensionHostPlugin,
  type HostMessage,
  type HostRequest,
  type PluginContext,
  type PluginGame,
  type PluginGameCallOptions,
  type PluginGameRequest,
  type PluginBrowserRequest,
  type PluginModelsHostRequest,
  type ToolHandler,
} from "../shared/extension-host-protocol.js";
import type { PluginModelInfo, PluginModelRequest, PluginModelResult } from "../shared/plugin-models.js";
import { panelStateIssue } from "../shared/plugin-panel-state.js";
import { errorMessageWithCause } from "../shared/network-errors.js";
import type { GameUseSnapshot, PlaytestAction } from "../shared/playtest.js";

// The extension host process: loads plugins' native entries on request and
// runs their tools. It is started by `ExtensionHosts` with an IPC channel and
// owns nothing the daemon depends on; when the channel closes, it exits.

interface LoadedPlugin {
  version: string;
  tools: Map<string, ToolHandler>;
  commands: Map<string, ToolHandler>;
  /** Project type hooks, keyed `<type>:<hook>`. */
  projectTypes: Map<string, ToolHandler>;
  /** Event hooks, by event. */
  hooks: Map<string, ToolHandler>;
  disposers: Array<() => void | Promise<void>>;
  deactivate?: () => void | Promise<void>;
  cancelRequests?: () => void;
}

const plugins = new Map<string, LoadedPlugin>();
const calls = new Map<number, AbortController>();
/** Activations and deactivations still running, which shutdown waits for. */
const lifecycle = new Set<Promise<unknown>>();
function track<T>(promise: Promise<T>): Promise<T> {
  lifecycle.add(promise);
  void promise.then(
    () => lifecycle.delete(promise),
    () => lifecycle.delete(promise),
  );
  return promise;
}
const projectArgument = process.argv.indexOf("--project");
const project =
  projectArgument < 0
    ? undefined
    : { folder: process.argv[projectArgument + 1] ?? "" };

function send(message: HostMessage) {
  if (process.connected) process.send?.(message, () => {});
}

const engineCalls = new Map<number, (error?: string) => void>();
let nextEngineCall = 1;

function requestEngine(message: Extract<HostMessage, { type: "engine-start" | "engine-stop" }>) {
  return new Promise<void>((resolve, reject) => {
    if (!process.connected) return reject(new Error("Extension host disconnected"));
    engineCalls.set(message.id, (error) => {
      engineCalls.delete(message.id);
      if (error !== undefined) reject(new Error(error));
      else resolve();
    });
    process.send?.(message, (error: Error | null) => {
      if (error) engineCalls.get(message.id)?.(error.message);
    });
  });
}

async function startEngine(plugin: string, options: NativeEngineStart, lifetime: AbortSignal): Promise<NativeEngineSession> {
  if (leaving || lifetime.aborted) throw new Error("The plugin is stopping");
  if (!validEngineStart(options)) throw new Error("Invalid native engine start options");
  const session = nextEngineCall++;
  const { executable, args, cwd, label } = options;
  await requestEngine({ type: "engine-start", id: session, plugin, options: { executable, args, cwd, label } });
  return { stop: () => requestEngine({ type: "engine-stop", id: nextEngineCall++, plugin, session }) };
}

const browserCalls = new Map<number, { finish(error?: Error): void }>();
let nextBrowserCall = 1;

function openBrowser(plugin: string, url: string, lifetime: AbortSignal): Promise<void> {
  if (typeof url !== "string") return Promise.reject(new Error("A page needs a web address"));
  return showInWindow(plugin, { operation: "open", url }, lifetime, "Browser");
}

/** One of the plugin's panels, as `context.panels.open` shows it; the daemon checks it is the plugin's. */
function openPanel(plugin: string, panel: string, options: { state?: unknown } | undefined, lifetime: AbortSignal): Promise<void> {
  if (typeof panel !== "string") return Promise.reject(new Error("panels.open needs the id of one of the plugin's panels"));
  // Checked here, before it is sent, so a state that isn't JSON fails as such.
  const issue = options?.state === undefined ? undefined : panelStateIssue(options.state);
  if (issue) return Promise.reject(new Error(issue));
  return showInWindow(plugin, { operation: "panel", panel, ...(options?.state !== undefined ? { state: options.state } : {}) }, lifetime, "Panel");
}

/** Shows something in the project's window, a Browser page or a panel, which the daemon checks and answers. */
function showInWindow(plugin: string, request: PluginBrowserRequest, lifetime: AbortSignal, kind: "Browser" | "Panel"): Promise<void> {
  const invocation = runningPlugin.getStore()?.signal;
  const signal = AbortSignal.any([lifetime, ...(invocation ? [invocation] : []), AbortSignal.timeout(30_000)]);
  if (signal.aborted || leaving) return Promise.reject(new Error(`${kind} request cancelled`));
  if (browserCalls.size >= 64) return Promise.reject(new Error(`Too many ${kind.toLowerCase()} requests`));
  const id = nextBrowserCall++;
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      browserCalls.delete(id);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      send({ type: "browser-cancel", id });
      finish(new Error(`${kind} request cancelled`));
    };
    browserCalls.set(id, { finish });
    signal.addEventListener("abort", abort, { once: true });
    send({ type: "browser", id, plugin, request });
  });
}

const sessionCalls = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let nextSessionCall = 1;
function pluginSessions(plugin: string, lifetime: AbortSignal): PluginSessions {
  return {
    request<R extends PluginSessionRequest>(request: R, options?: { signal?: AbortSignal }): Promise<PluginSessionResults[R["operation"]]> {
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30_000), ...(options?.signal ? [options.signal] : [])]);
      if (signal.aborted || leaving) return Promise.reject(new Error("Session request cancelled"));
      if (sessionCalls.size >= 64) return Promise.reject(new Error("Too many session requests"));
      const id = nextSessionCall++;
      return new Promise((resolve, reject) => {
        const abort = () => {
          sessionCalls.delete(id);
          send({ type: "sessions-cancel", id });
          reject(signal.reason);
        };
        const cleanup = () => signal.removeEventListener("abort", abort);
        sessionCalls.set(id, {
          resolve: (value) => { cleanup(); resolve(value as PluginSessionResults[R["operation"]]); },
          reject: (error) => { cleanup(); reject(error); },
        });
        signal.addEventListener("abort", abort, { once: true });
        send({ type: "sessions", id, plugin, request });
      });
    },
  };
}

/** `context.models` requests waiting for the daemon's `models-reply`. */
const modelCalls = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let nextModelCall = 1;

function askModels(plugin: string, request: PluginModelsHostRequest, lifetime: AbortSignal, signal?: AbortSignal): Promise<unknown> {
  const stop = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
  if (stop.aborted) return Promise.reject(stop.reason ?? new Error("Model request cancelled"));
  if (leaving) return Promise.reject(new Error("Extension host stopping"));
  const id = nextModelCall++;
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (!modelCalls.delete(id)) return;
      send({ type: "models-cancel", id });
      reject(stop.reason ?? new Error("Model request cancelled"));
    };
    const settled = () => stop.removeEventListener("abort", abort);
    modelCalls.set(id, {
      resolve: (value) => { settled(); resolve(value); },
      reject: (error) => { settled(); reject(error); },
    });
    stop.addEventListener("abort", abort, { once: true });
    send({ type: "models", id, plugin, request });
  });
}

/** A plugin's `context.models`; the daemon checks each request and that the plugin may ask. */
function pluginModels(plugin: string, lifetime: AbortSignal): NonNullable<PluginContext["models"]> {
  return Object.freeze({
    list: () => askModels(plugin, { operation: "list" }, lifetime) as Promise<PluginModelInfo[]>,
    complete: (request: PluginModelRequest, options: { signal?: AbortSignal } = {}) => {
      // A request made while a call runs stops with it, as well as on its own signal.
      const call = runningPlugin.getStore()?.signal;
      const signal = call && options.signal ? AbortSignal.any([call, options.signal]) : call ?? options.signal;
      return askModels(plugin, { operation: "complete", request }, lifetime, signal) as Promise<PluginModelResult>;
    },
  });
}

/** `context.game` requests waiting for the daemon's `game-reply`. */
const gameCalls = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let nextGameCall = 1;

function askGame(plugin: string, request: PluginGameRequest, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Game request cancelled"));
  if (leaving) return Promise.reject(new Error("Extension host stopping"));
  const id = nextGameCall++;
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (!gameCalls.has(id)) return;
      // The daemon may have opened the session already; one that arrives late is closed.
      if (request.operation === "open")
        gameCalls.set(id, {
          resolve: (value) => {
            const session = (value as { sessionId?: unknown } | null)?.sessionId;
            if (typeof session === "string")
              void askGame(plugin, { operation: "close", session }).catch(() => {});
          },
          reject: () => {},
        });
      else gameCalls.delete(id);
      send({ type: "game-cancel", id });
      reject(signal?.reason ?? new Error("Game request cancelled"));
    };
    const settled = () => signal?.removeEventListener("abort", abort);
    gameCalls.set(id, {
      resolve: (value) => { settled(); resolve(value); },
      reject: (error) => { settled(); reject(error); },
    });
    signal?.addEventListener("abort", abort, { once: true });
    send({ type: "game", id, plugin, request });
  });
}

/** A plugin's `context.game`: each method one request to the daemon. */
function pluginGame(plugin: string): PluginGame {
  const ask = <T>(request: PluginGameRequest, options?: PluginGameCallOptions) =>
    askGame(plugin, request, options?.signal) as Promise<T>;
  return Object.freeze({
    open: async (options: PluginGameCallOptions & { viewport?: { width: number; height: number }; path?: string; networkControl?: boolean } = {}) => {
      const snapshot = await ask<GameUseSnapshot>(
        {
          operation: "open",
          ...(options.viewport ? { viewport: options.viewport } : {}),
          ...(typeof options.path === "string" ? { path: options.path } : {}),
          ...(options.networkControl === true ? { networkControl: true } : {}),
        },
        options,
      );
      const session = snapshot.sessionId;
      return Object.freeze({
        id: session,
        capabilities: snapshot.capabilities,
        snapshot,
        inspect: (call?: PluginGameCallOptions) => ask({ operation: "inspect", session }, call),
        act: (actions: never[], call?: PluginGameCallOptions) => ask({ operation: "act", session, actions }, call),
        capture: (call?: PluginGameCallOptions) => ask({ operation: "capture", session }, call),
        captureFrame: (frame: number, call?: PluginGameCallOptions) => ask({ operation: "captureFrame", session, frame }, call),
        recordStart: (call?: PluginGameCallOptions) => ask({ operation: "recordStart", session }, call),
        recordStop: (call?: PluginGameCallOptions) => ask({ operation: "recordStop", session }, call),
        reload: (call?: PluginGameCallOptions) => ask({ operation: "reload", session }, call),
        setOnline: (online: boolean, call?: PluginGameCallOptions) => ask({ operation: "network", session, online }, call),
        close: async (call?: PluginGameCallOptions) => { await ask({ operation: "close", session }, call); },
      });
    },
    actTogether: (players: { session: { id: string }; actions: PlaytestAction[] }[], call?: PluginGameCallOptions) =>
      ask({ operation: "actTogether", players: players.map((player) => ({ session: player.session.id, actions: player.actions })) }, call),
  }) as PluginGame;
}

const cut = (text: string) =>
  text.length > HOST_MESSAGE_MAX_CHARS
    ? `${text.slice(0, HOST_MESSAGE_MAX_CHARS - 1)}…`
    : text;

// What a plugin prints through `console` while its code runs (activating, a
// call, or what those started) goes to the daemon under its id, for its log.
// Anything else, such as a child process's output, stays the host's.
const runningPlugin = new AsyncLocalStorage<{ plugin: string; signal?: AbortSignal }>();
for (const [method, level] of [["log", "info"], ["info", "info"], ["debug", "info"], ["warn", "warn"], ["error", "error"]] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const plugin = runningPlugin.getStore()?.plugin;
    if (!plugin || !process.connected) {
      original(...args);
      return;
    }
    let text: string;
    try {
      text = format(...args);
    } catch {
      text = "(a value that couldn't be printed)";
    }
    send({ type: "log", plugin, level, text: cut(text) });
  };
}

// A failed request says why, such as a connect timeout, not only "fetch failed".
const errorMessage = (error: unknown) => {
  try {
    return cut(errorMessageWithCause(error));
  } catch {
    return "Plugin error";
  }
};

async function activate(id: number, plugin: ExtensionHostPlugin) {
  const started = performance.now();
  const entry = path.resolve(plugin.root, plugin.entry);
  const relative = path.relative(plugin.root, entry);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Plugin entry must be inside the plugin");
  // Another version of it may still be loaded; it goes first.
  await deactivate(plugin.id);
  const loaded: LoadedPlugin = {
    version: plugin.version,
    tools: new Map(),
    commands: new Map(),
    projectTypes: new Map(),
    hooks: new Map(),
    disposers: [],
  };
  // Only what the manifest declares can be registered, so the index, the
  // agent and the person see every tool before it runs.
  const register = (
    kind: "tool" | "command" | "projectType" | "hook",
    declared: string[],
    handlers: Map<string, ToolHandler>,
    name: string,
    handler: ToolHandler,
  ) => {
    if (!declared.includes(name))
      throw new Error(`${plugin.id} does not declare a ${kind} named ${name}`);
    if (typeof handler !== "function")
      throw new Error(`The ${kind} ${name} needs a handler function`);
    if (handlers.has(name))
      throw new Error(`The ${kind} ${name} is already registered`);
    handlers.set(name, handler);
    return {
      dispose: () => {
        if (handlers.get(name) === handler) handlers.delete(name);
      },
    };
  };
  const lifetime = new AbortController();
  loaded.cancelRequests = () => lifetime.abort(new Error("Plugin deactivated"));
  const context: PluginContext = {
    pluginId: plugin.id,
    version: plugin.version,
    ...(project ? {
      project,
      browser: { open: (url: string) => openBrowser(plugin.id, url, lifetime.signal) },
      nativeSessions: { start: (options: NativeEngineStart) => startEngine(plugin.id, options, lifetime.signal) },
    } : {}),
    ...(project && plugin.panels ? { panels: { open: (panel: string, options?: { state?: unknown }) => openPanel(plugin.id, panel, options, lifetime.signal) } } : {}),
    dataFolder: plugin.dataFolder,
    configuration: Object.freeze(plugin.configuration ?? {}),
    ...(plugin.sessions && !project ? { sessions: pluginSessions(plugin.id, lifetime.signal) } : {}),
    ...(plugin.models ? { models: pluginModels(plugin.id, lifetime.signal) } : {}),
    registerTool: (name, handler) =>
      register("tool", plugin.tools, loaded.tools, name, handler),
    registerCommand: (name, handler) =>
      register("command", plugin.commands, loaded.commands, name, handler),
    registerProjectType: (id, hooks) => {
      if (!plugin.projectTypes.includes(id))
        throw new Error(
          `${plugin.id} does not contribute a project type named ${id}`,
        );
      const disposables = Object.entries(hooks ?? {}).map(([hook, handler]) => {
        if (!(PROJECT_TYPE_HOOKS as readonly string[]).includes(hook))
          throw new Error(`${hook} is not a project type hook`);
        const name = `${id}:${hook}`;
        return register(
          "projectType",
          [name],
          loaded.projectTypes,
          name,
          handler as ToolHandler,
        );
      });
      return { dispose: () => disposables.forEach((item) => item.dispose()) };
    },
    registerHook: (event, handler) =>
      register("hook", plugin.hooks, loaded.hooks, event, handler),
    onDispose(dispose) {
      loaded.disposers.push(dispose);
    },
    // The daemon checks again on every request that the plugin may play.
    ...(plugin.game && project ? { game: pluginGame(plugin.id) } : {}),
  };
  const module = (await import(pathToFileURL(entry).href)) as {
    activate?: (context: PluginContext) => unknown;
    deactivate?: () => void | Promise<void>;
  };
  if (typeof module.activate !== "function")
    throw new Error("Plugin entry does not export activate()");
  try {
    await module.activate(context);
  } catch (error) {
    // Undo what it registered before it failed.
    await disposeAll(loaded);
    throw error;
  }
  loaded.deactivate = module.deactivate;
  plugins.set(plugin.id, loaded);
  send({
    type: "activated",
    id,
    tools: [...loaded.tools.keys()],
    commands: [...loaded.commands.keys()],
    ms: performance.now() - started,
  });
}

async function disposeAll(loaded: LoadedPlugin) {
  loaded.cancelRequests?.();
  loaded.tools.clear();
  loaded.commands.clear();
  loaded.projectTypes.clear();
  loaded.hooks.clear();
  for (const dispose of loaded.disposers.splice(0).reverse())
    await Promise.resolve()
      .then(dispose)
      .catch(() => {});
}

async function deactivate(pluginId: string) {
  const loaded = plugins.get(pluginId);
  if (!loaded) return;
  plugins.delete(pluginId);
  await disposeAll(loaded);
  await Promise.resolve()
    .then(() => loaded.deactivate?.())
    .catch(() => {});
}

async function invoke(
  request: Extract<HostRequest, { type: "invoke" }>,
  controller: AbortController,
) {
  const loaded = plugins.get(request.plugin);
  const handler = (
    request.kind === "command"
      ? loaded?.commands
      : request.kind === "projectType"
        ? loaded?.projectTypes
        : request.kind === "hook"
          ? loaded?.hooks
          : loaded?.tools
  )?.get(request.name);
  if (!handler)
    throw new Error(
      `${request.plugin} has no ${request.kind} named ${request.name}`,
    );
  let lastProgress = -Infinity;
  const value = await handler(request.input, {
    signal: controller.signal,
    progress: (message, options) => {
      // Progress is a hint: frequent updates are dropped, long ones cut. A
      // link the person needs always goes through.
      const url = isProgressLink(options?.url) ? options?.url : undefined;
      const now = performance.now();
      if (!url && now - lastProgress < HOST_PROGRESS_INTERVAL_MS) return;
      lastProgress = now;
      send({ type: "progress", id: request.id, message: cut(String(message)), ...(url ? { url } : {}) });
    },
    ...(request.turn ? { turn: request.turn } : {}),
    ...(request.build ? { build: Object.freeze({ ...request.build }) } : {}),
    configuration: Object.freeze({ ...request.configuration }),
  });
  // Serializing here both bounds the size and turns values IPC can't carry
  // (BigInt, cycles) into the call's error rather than a lost reply.
  const size = Buffer.byteLength(JSON.stringify(value ?? null));
  if (size > HOST_RESULT_MAX_BYTES)
    throw new Error(
      `The result is ${Math.ceil(size / 1024 / 1024)} MB; results are limited to ${HOST_RESULT_MAX_BYTES / 1024 / 1024} MB`,
    );
  if (controller.signal.aborted)
    send({
      type: "error",
      id: request.id,
      message: "Plugin call cancelled",
      cancelled: true,
    });
  else send({ type: "result", id: request.id, value });
}

process.on("message", (message: HostRequest) => {
  switch (message.type) {
    case "engine-reply":
      engineCalls.get(message.id)?.(message.error);
      return;
    case "activate":
      if (leaving) {
        send({
          type: "error",
          id: message.id,
          message: "Extension host stopping",
        });
        return;
      }
      track(runningPlugin.run({ plugin: message.plugin.id }, () => activate(message.id, message.plugin))).catch((error) =>
        send({ type: "error", id: message.id, message: errorMessage(error) }),
      );
      return;
    case "invoke": {
      const controller = new AbortController();
      calls.set(message.id, controller);
      runningPlugin.run({ plugin: message.plugin, signal: controller.signal }, () => invoke(message, controller))
        .catch((error) =>
          send({
            type: "error",
            id: message.id,
            message: errorMessage(error),
            cancelled: controller.signal.aborted,
          }),
        )
        .finally(() => calls.delete(message.id));
      return;
    }
    case "cancel":
      calls.get(message.id)?.abort(new Error("Plugin call cancelled"));
      return;
    case "browser-reply":
      browserCalls.get(message.id)?.finish(message.error === undefined ? undefined : new Error(message.error));
      return;
    case "sessions-reply": {
      const call = sessionCalls.get(message.id);
      sessionCalls.delete(message.id);
      if (message.error !== undefined) call?.reject(new Error(message.error));
      else call?.resolve(message.value);
      return;
    }
    case "models-reply": {
      const call = modelCalls.get(message.id);
      modelCalls.delete(message.id);
      if (message.error !== undefined) call?.reject(new Error(message.error));
      else call?.resolve(message.value);
      return;
    }
    case "game-reply": {
      const call = gameCalls.get(message.id);
      gameCalls.delete(message.id);
      if (message.error !== undefined) call?.reject(new Error(message.error));
      else call?.resolve(message.value);
      return;
    }
    case "deactivate":
      track(runningPlugin.run({ plugin: message.plugin }, () => deactivate(message.plugin))).then(
        () => send({ type: "result", id: message.id, value: null }),
        (error) =>
          send({ type: "error", id: message.id, message: errorMessage(error) }),
      );
      return;
    case "shutdown":
      void leave();
      return;
    case "stats": {
      const memory = process.memoryUsage();
      send({
        type: "stats",
        id: message.id,
        stats: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          plugins: [...plugins.keys()],
        },
      });
    }
  }
});

// Asked to stop, or without the daemon to serve: cancel what is running,
// clean up and leave. The daemon stops the process if this takes too long.
let leaving = false;
async function leave() {
  if (leaving) return;
  leaving = true;
  for (const controller of calls.values())
    controller.abort(new Error("Extension host stopping"));
  for (const call of gameCalls.values()) call.reject(new Error("Extension host stopping"));
  gameCalls.clear();
  for (const call of sessionCalls.values()) call.reject(new Error("Extension host stopping"));
  sessionCalls.clear();
  for (const [id, call] of browserCalls) {
    send({ type: "browser-cancel", id });
    call.finish(new Error("Extension host stopping"));
  }
  // A plugin still activating gets its cleanup too, once it is active.
  while (lifecycle.size) await Promise.allSettled([...lifecycle]);
  await Promise.allSettled([...plugins.keys()].map(deactivate));
  process.exit(0);
}
process.on("disconnect", () => {
  for (const finish of engineCalls.values()) finish("Extension host disconnected");
  void leave();
});

send({ type: "ready", protocol: EXTENSION_HOST_PROTOCOL_VERSION });

