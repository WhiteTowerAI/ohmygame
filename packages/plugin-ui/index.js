// The bridge a plugin page uses to talk to OhMyGame. The app serves this file
// next to every plugin page at /_ohmygame/plugin-ui.js:
//
//   <link rel="stylesheet" href="/_ohmygame/plugin-ui.css">
//   <script type="module" src="./main.js"></script>
//
// with the page's script in its own file, since the page's policy allows no
// inline scripts:
//
//   import { connect } from "/_ohmygame/plugin-ui.js";
//   const host = await connect();
//   const project = await host.request("project.info");
//
// The page runs in a sandboxed frame with an opaque origin. The app sends it
// one end of a MessageChannel once it loads; everything goes through it.

const HANDSHAKE = "ohmygame-plugin-ui";
// How long a call to one of the page's tools waits for the page to handle it.
const TOOL_HANDLER_WAIT_MS = 10_000;

let connecting;

/** Waits for the app's port; resolves once, however often it is called. */
export function connect() {
  connecting ??= new Promise((resolve) => {
    const onMessage = (event) => {
      if (event.source !== window.parent || event.data?.type !== HANDSHAKE || !event.ports?.[0]) return;
      window.removeEventListener("message", onMessage);
      resolve(bridge(event.ports[0], event.data));
    };
    window.addEventListener("message", onMessage);
  });
  return connecting;
}

function bridge(port, hello) {
  let next = 0;
  const pending = new Map();
  const listeners = new Map();
  const emit = (name, value) => listeners.get(name)?.forEach((listener) => listener(value));
  // Tools the page answers for its panel, as the manifest's `tools[].panel` names them.
  const handlers = new Map();
  const handlerWaits = new Map();
  const toolCalls = new Map();
  const answerTool = (toolCall, message) => {
    try {
      port.postMessage({ toolCall, ...message });
    } catch (error) {
      // A result that can't be copied, such as one holding a function or an
      // element, is the tool's error; a closed port has nowhere to send either.
      try {
        port.postMessage({ toolCall, error: `The tool's answer can't be sent: ${String(error?.message ?? error).slice(0, 500)}. Return JSON.` });
      } catch {
        // Closed.
      }
    }
  };
  const handlerFor = (name) => {
    const handler = handlers.get(name);
    if (handler) return Promise.resolve(handler);
    // A page may start handling its tools only once it has loaded what they need.
    return new Promise((resolve) => {
      const waiting = { resolve, timer: setTimeout(() => {
        handlerWaits.get(name)?.delete(waiting);
        resolve(undefined);
      }, TOOL_HANDLER_WAIT_MS) };
      if (!handlerWaits.has(name)) handlerWaits.set(name, new Set());
      handlerWaits.get(name).add(waiting);
    });
  };
  const runTool = async (toolCall, name, input) => {
    const controller = new AbortController();
    toolCalls.set(toolCall, controller);
    try {
      const handler = await handlerFor(name);
      if (controller.signal.aborted) return;
      if (!handler) {
        answerTool(toolCall, { error: `This page doesn't handle the tool ${name}. Call host.tools.handle("${name}", …) when it loads.` });
        return;
      }
      answerTool(toolCall, { accepted: true });
      const progress = (message) => {
        if (!controller.signal.aborted) answerTool(toolCall, { progress: String(message).slice(0, 2000) });
      };
      const result = await handler(input, { signal: controller.signal, progress });
      if (!controller.signal.aborted) answerTool(toolCall, { result: result === undefined ? null : result });
    } catch (error) {
      if (!controller.signal.aborted) answerTool(toolCall, { error: String(error?.message ?? error).slice(0, 4000) || "The tool failed" });
    } finally {
      toolCalls.delete(toolCall);
    }
  };
  port.onmessage = ({ data }) => {
    if (data && Number.isSafeInteger(data.toolCall)) {
      if (data.cancel === true) toolCalls.get(data.toolCall)?.abort();
      else if (typeof data.name === "string") void runTool(data.toolCall, data.name, data.input);
      return;
    }
    if (data && typeof data.event === "string") {
      // The app checks the page still answers; a page stuck in a loop can't, so it is offered a reload.
      if (data.event === "ping") {
        port.postMessage({ event: "pong" });
        return;
      }
      if (data.event === "theme") applyTheme(data);
      emit(data.event, data);
      return;
    }
    const call = pending.get(data?.id);
    if (!call) return;
    pending.delete(data.id);
    if ("error" in data) call.reject(new Error(data.error));
    else call.resolve(data.result);
  };
  port.start();
  // Errors the page doesn't catch go to its plugin's log in the app.
  const report = (error) => {
    try {
      port.postMessage({ event: "error", message: String(error?.stack ?? error?.message ?? error).slice(0, 4000) });
    } catch {
      // A closed port has nowhere to send it.
    }
  };
  window.addEventListener("error", (event) => report(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => report(event.reason));
  if (hello.theme) applyTheme(hello.theme);
  // The app keeps the frame hidden until the page has its theme.
  port.postMessage({ event: "ready" });
  const api = {
    /** Which plugin and project the page is for. */
    plugin: hello.plugin,
    locale: hello.locale,
    /** Calls the app; rejects with the app's reason when it refuses. */
    request(method, params) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage(params === undefined ? { id, method } : { id, method, params });
      });
    },
    /**
     * Answers the tools the manifest says this panel answers
     * (`contributes.tools[].panel`), which the agent and commands call. The
     * handler gets the input the tool's schema checked, and `{ signal,
     * progress }`; what it returns, as JSON, is the tool's result. Returns a
     * function that stops handling it.
     */
    tools: {
      handle(name, handler) {
        if (typeof handler !== "function") throw new TypeError("A tool's handler is a function");
        handlers.set(name, handler);
        for (const waiting of handlerWaits.get(name) ?? []) {
          clearTimeout(waiting.timer);
          waiting.resolve(handler);
        }
        handlerWaits.delete(name);
        return () => {
          if (handlers.get(name) === handler) handlers.delete(name);
        };
      },
    },
    /**
     * What the person is looking at in this panel, for a plugin with the
     * `composer` capability. The app shows it in the composer and the next
     * message carries it, while the panel shows; `clear` takes it back.
     */
    context: {
      set(value) {
        return api.request("context.set", { label: value?.label, text: value?.text });
      },
      clear() {
        return api.request("context.set", {});
      },
    },
    /**
     * The language models the person set up, for a plugin with the `models`
     * capability. Each request runs on their providers and counts toward
     * their usage, so ask only for what the person asked for, while the panel
     * shows.
     */
    models: {
      list() {
        return api.request("models.list");
      },
      async complete(request, { signal } = {}) {
        signal?.throwIfAborted();
        const call = `call-${next}-${Math.random().toString(36).slice(2, 10)}`;
        const stop = () => void api.request("models.cancel", { call }).catch(() => {});
        signal?.addEventListener("abort", stop, { once: true });
        try {
          return await api.request("models.complete", { ...request, call });
        } finally {
          signal?.removeEventListener("abort", stop);
        }
      },
    },
    /** `theme`, `visibility`, `progress`, `command` and `files` events; returns a function that stops listening. */
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name)?.delete(listener);
    },
    /** The project's files, for a plugin with the `project.files` capability. */
    files: {
      list(path, options = {}) {
        return api.request("files.list", { ...(path ? { path } : {}), ...options });
      },
      /** A file's contents as a Blob. */
      read(path) {
        return api.request("files.read", { path });
      },
      async text(path) {
        return (await api.request("files.read", { path })).text();
      },
      /** An address for `<img>`, `<audio>` or `<video>`; give it to `URL.revokeObjectURL` when done. */
      async url(path) {
        return URL.createObjectURL(await api.request("files.read", { path }));
      },
      write(path, contents) {
        return api.request("files.write", { path, data: contents instanceof Blob ? contents : new Blob([contents]) });
      },
      createFolder(path) {
        return api.request("files.createFolder", { path });
      },
      move(from, to) {
        return api.request("files.move", { from, to });
      },
      delete(path) {
        return api.request("files.delete", { path });
      },
    },
  };
  return api;
}

/** The app's colour tokens, so `plugin-ui.css` and the page match the app. */
function applyTheme({ tokens, appearance }) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens ?? {}))
    if (/^--[a-z0-9-]{1,40}$/.test(name)) root.style.setProperty(name, value);
  if (appearance === "dark" || appearance === "light") root.dataset.appearance = appearance;
}
