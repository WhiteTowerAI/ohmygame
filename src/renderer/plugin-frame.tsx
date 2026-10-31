import { useEffect, useRef, useState } from "react";
import { THEME_TOKENS } from "../shared/plugin-manifest.js";
import {
  PLUGIN_UI_HANDSHAKE,
  PLUGIN_UI_PROTOCOL_VERSION,
  pluginUiRefusal,
  readPluginUiRequest,
  type PluginUiCapabilities,
  type PluginUiEvent,
  type PluginUiRequest,
} from "../shared/plugin-ui-protocol.js";

// A format 2 plugin's page in a sandboxed frame. The frame gets only
// `allow-scripts`: an opaque origin, no popups, no navigation of the app, no
// forms. Once it loads, the host transfers one end of a MessageChannel with
// the handshake; every request comes back on that port and is checked
// against the plugin's capabilities. Only the frame's first load gets a port:
// a page that loads again, by reloading or by going elsewhere, is put back as
// a new frame at the panel's URL, which loads first and connects. The desktop
// app also keeps a plugin frame from navigating outside its plugin's files.

export interface PluginPageContext {
  plugin: { id: string; version: string; panel: string };
  locale: "en" | "zh-CN";
  capabilities: PluginUiCapabilities;
  /** The plugin's own command ids, the only ones its page may run. */
  commands: readonly string[];
  project: () => { name: string; type: string };
  selection?: () => unknown;
  /** Fills the composer with text; the page can never send it. */
  fillComposer?: (text: string) => void;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  runCommand(command: string, input?: unknown): Promise<unknown>;
}

/** The app's current colour tokens and appearance, as a page sees them. */
export function currentTheme(): Extract<PluginUiEvent, { event: "theme" }> {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value) tokens[token] = value;
  }
  return {
    event: "theme",
    tokens,
    appearance: root.dataset.appearance === "light" ? "light" : "dark",
  };
}

/** Answers one checked request; throwing sends the page the error's message. */
export async function handlePluginUiRequest(
  request: PluginUiRequest,
  context: PluginPageContext,
): Promise<unknown> {
  const refusal = pluginUiRefusal(request.method, context.capabilities);
  if (refusal) throw new Error(refusal);
  const params = request.params ?? {};
  switch (request.method) {
    case "theme.get": {
      const { tokens, appearance } = currentTheme();
      return { tokens, appearance };
    }
    case "project.info":
      return context.project();
    case "storage.get":
      return context.storage.get(params.key as string);
    case "storage.set":
      await context.storage.set(params.key as string, params.value);
      return null;
    case "selection.get":
      return context.selection?.() ?? null;
    case "composer.fill":
      if (!context.fillComposer) throw new Error("There is no composer here");
      context.fillComposer(params.text as string);
      return null;
    case "command.run":
      if (!context.commands.includes(params.command as string))
        throw new Error(`${context.plugin.id} has no command ${String(params.command)}`);
      return context.runCommand(params.command as string, params.input);
  }
}

/** Connects a loaded frame; returns how to send it events and how to disconnect. */
export function connectPluginFrame(
  frame: Window,
  context: PluginPageContext,
): { send(event: PluginUiEvent): void; close(): void } {
  const channel = new MessageChannel();
  const port = channel.port1;
  port.onmessage = ({ data }) => {
    const read = readPluginUiRequest(data);
    if (!read.ok) {
      if (read.id !== undefined) port.postMessage({ id: read.id, error: read.error });
      return;
    }
    handlePluginUiRequest(read.request, context).then(
      (result) => port.postMessage({ id: read.request.id, result: result ?? null }),
      (error: unknown) =>
        port.postMessage({
          id: read.request.id,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  // The frame's origin is opaque, so the handshake can't name it; it goes
  // to this frame's window only, and nothing in it is secret.
  frame.postMessage(
    {
      type: PLUGIN_UI_HANDSHAKE,
      protocol: PLUGIN_UI_PROTOCOL_VERSION,
      plugin: context.plugin,
      locale: context.locale,
      theme: currentTheme(),
    },
    "*",
    [channel.port2],
  );
  return {
    send: (event) => port.postMessage(event),
    close: () => port.close(),
  };
}

export function PluginFrame({
  url,
  title,
  context,
  visible = true,
}: {
  url: string;
  title: string;
  context: PluginPageContext;
  visible?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [mount, setMount] = useState(0);
  const connection = useRef<ReturnType<typeof connectPluginFrame> | undefined>(undefined);
  const latest = useRef(context);
  latest.current = context;
  // The context changes every render; requests read the latest one.
  const stable: PluginPageContext = {
    get plugin() { return latest.current.plugin; },
    get locale() { return latest.current.locale; },
    get capabilities() { return latest.current.capabilities; },
    get commands() { return latest.current.commands; },
    project: () => latest.current.project(),
    selection: () => latest.current.selection?.(),
    fillComposer: (text) => {
      if (!latest.current.fillComposer) throw new Error("There is no composer here");
      latest.current.fillComposer(text);
    },
    storage: {
      get: (key) => latest.current.storage.get(key),
      set: (key, value) => latest.current.storage.set(key, value),
    },
    runCommand: (command, input) => latest.current.runCommand(command, input),
  };

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let loaded = false;
    const onLoad = () => {
      if (loaded) {
        connection.current?.close();
        connection.current = undefined;
        setMount((value) => value + 1);
        return;
      }
      loaded = true;
      if (element.contentWindow) connection.current = connectPluginFrame(element.contentWindow, stable);
    };
    element.addEventListener("load", onLoad);
    // Theme changes reach the page as they happen.
    const observer = new MutationObserver(() => connection.current?.send(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance", "style", "class"] });
    return () => {
      element.removeEventListener("load", onLoad);
      observer.disconnect();
      connection.current?.close();
      connection.current = undefined;
    };
  }, [url, mount]);

  useEffect(() => {
    connection.current?.send({ event: "visibility", visible });
  }, [visible]);

  return (
    <iframe
      key={`${url}#${mount}`}
      ref={frame}
      className="plugin-frame"
      src={url}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow=""
    />
  );
}
