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
  port.onmessage = ({ data }) => {
    if (data && typeof data.event === "string") {
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
  if (hello.theme) applyTheme(hello.theme);
  // The app keeps the frame hidden until the page has its theme.
  port.postMessage({ event: "ready" });
  return {
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
    /** `theme`, `visibility` and `progress` events; returns a function that stops listening. */
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name)?.delete(listener);
    },
  };
}

/** The app's colour tokens, so `plugin-ui.css` and the page match the app. */
function applyTheme({ tokens, appearance }) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens ?? {}))
    if (/^--[a-z0-9-]{1,40}$/.test(name)) root.style.setProperty(name, value);
  if (appearance === "dark" || appearance === "light") root.dataset.appearance = appearance;
}
