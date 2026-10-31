import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXTENSION_HOST_PROTOCOL_VERSION,
  PROJECT_TYPE_HOOKS,
  HOST_MESSAGE_MAX_CHARS,
  isProgressLink,
  HOST_PROGRESS_INTERVAL_MS,
  HOST_RESULT_MAX_BYTES,
  type ExtensionHostPlugin,
  type HostMessage,
  type HostRequest,
  type PluginContext,
  type ToolHandler,
} from "../shared/extension-host-protocol.js";

// The extension host process: loads plugins' native entries on request and
// runs their tools. It is started by `ExtensionHosts` with an IPC channel and
// owns nothing the daemon depends on; when the channel closes, it exits.

interface LoadedPlugin {
  version: string;
  tools: Map<string, ToolHandler>;
  commands: Map<string, ToolHandler>;
  /** Project type hooks, keyed `<type>:<hook>`. */
  projectTypes: Map<string, ToolHandler>;
  disposers: Array<() => void | Promise<void>>;
  deactivate?: () => void | Promise<void>;
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

const cut = (text: string) =>
  text.length > HOST_MESSAGE_MAX_CHARS
    ? `${text.slice(0, HOST_MESSAGE_MAX_CHARS - 1)}…`
    : text;

const errorMessage = (error: unknown) => {
  try {
    return cut(error instanceof Error ? error.message : String(error));
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
    disposers: [],
  };
  // Only what the manifest declares can be registered, so the index, the
  // agent and the person see every tool before it runs.
  const register = (
    kind: "tool" | "command" | "projectType",
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
  const context: PluginContext = {
    pluginId: plugin.id,
    version: plugin.version,
    ...(project ? { project } : {}),
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
    onDispose(dispose) {
      loaded.disposers.push(dispose);
    },
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
  loaded.tools.clear();
  loaded.commands.clear();
  loaded.projectTypes.clear();
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
    case "activate":
      if (leaving) {
        send({
          type: "error",
          id: message.id,
          message: "Extension host stopping",
        });
        return;
      }
      track(activate(message.id, message.plugin)).catch((error) =>
        send({ type: "error", id: message.id, message: errorMessage(error) }),
      );
      return;
    case "invoke": {
      const controller = new AbortController();
      calls.set(message.id, controller);
      invoke(message, controller)
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
    case "deactivate":
      track(deactivate(message.plugin)).then(
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
  // A plugin still activating gets its cleanup too, once it is active.
  while (lifecycle.size) await Promise.allSettled([...lifecycle]);
  await Promise.allSettled([...plugins.keys()].map(deactivate));
  process.exit(0);
}
process.on("disconnect", () => void leave());

send({ type: "ready", protocol: EXTENSION_HOST_PROTOCOL_VERSION });

