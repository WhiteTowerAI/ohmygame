import { useEffect, useRef, useState } from "react";
import {
  accentTokens,
  PAGE_TOKENS,
  PLUGIN_ACCENT_MIN_CONTRAST,
  PLUGIN_UI_HANDSHAKE,
  PLUGIN_UI_PROTOCOL_VERSION,
  pluginUiRefusal,
  readPluginUiRequest,
  type PluginAccent,
  type PluginUiCapabilities,
  type PluginUiConfirm,
  type PluginUiEvent,
  type PluginUiRequest,
  type PluginUiToastTone,
} from "../shared/plugin-ui-protocol.js";
import "./plugin-frame.css";

export { accentTokens, PAGE_TOKENS, PLUGIN_ACCENT_MIN_CONTRAST };

// A plugin's page in a sandboxed frame. The frame gets only
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
  /** The plugin's brand colour, from its manifest. */
  accent?: PluginAccent;
  /** Shows a toast the app draws, under the plugin's id. */
  toast(message: string, tone?: PluginUiToastTone): void;
  /** Asks the person in a dialog the app draws; a page only learns the answer. */
  confirm(request: PluginUiConfirm): Promise<boolean>;
}

/** The app's current design tokens and appearance, as a page sees them. */
export function currentTheme(accent?: PluginAccent): Extract<PluginUiEvent, { event: "theme" }> {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const token of PAGE_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value) tokens[token] = value;
  }
  const appearance = root.dataset.appearance === "light" ? "light" : "dark";
  return {
    event: "theme",
    tokens: { ...tokens, ...accentTokens(accent, appearance, tokens) },
    appearance,
  };
}

/** Allows `limit` calls in any `windowMs`; returns whether this one may go ahead. */
export function rateLimit(limit: number, windowMs: number, now: () => number = Date.now): () => boolean {
  const calls: number[] = [];
  return () => {
    const time = now();
    while (calls.length && time - calls[0]! >= windowMs) calls.shift();
    if (calls.length >= limit) return false;
    calls.push(time);
    return true;
  };
}

/** How many toasts a plugin shows in `PLUGIN_TOAST_WINDOW_MS`, and questions it asks in `PLUGIN_CONFIRM_WINDOW_MS`, so it can't bury the app in them. */
export const PLUGIN_TOAST_LIMIT = 5;
export const PLUGIN_TOAST_WINDOW_MS = 10_000;
export const PLUGIN_CONFIRM_LIMIT = 5;
export const PLUGIN_CONFIRM_WINDOW_MS = 60_000;

const pluginLimits = new Map<string, { toast: () => boolean; confirm: () => boolean }>();

/** A plugin's limits, which all its panels share and reloading a page doesn't start over. */
function limitsOf(plugin: string) {
  let limits = pluginLimits.get(plugin);
  if (!limits) {
    limits = { toast: rateLimit(PLUGIN_TOAST_LIMIT, PLUGIN_TOAST_WINDOW_MS), confirm: rateLimit(PLUGIN_CONFIRM_LIMIT, PLUGIN_CONFIRM_WINDOW_MS) };
    pluginLimits.set(plugin, limits);
  }
  return limits;
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
      const { tokens, appearance } = currentTheme(context.accent);
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
    case "ui.toast":
      context.toast(params.message as string, params.tone as PluginUiToastTone | undefined);
      return null;
    case "ui.confirm":
      return context.confirm({
        title: params.title as string,
        ...(params.message === undefined ? {} : { message: params.message as string }),
        ...(params.confirmLabel === undefined ? {} : { confirmLabel: params.confirmLabel as string }),
      });
  }
}

/** A `plugin.command.progress` update; a new object for each one. */
export interface CommandProgress {
  command: string;
  message: string;
}

/** A `panel.toolbar` command that finished. */
export interface PluginToolbarRun {
  command: string;
  result?: unknown;
  error?: string;
}

/** Connects a loaded frame; returns how to send it events and how to disconnect. */
export function connectPluginFrame(
  frame: Window,
  context: PluginPageContext,
  /** Called when the page's bridge has applied the app's theme. */
  onReady?: () => void,
): { send(event: PluginUiEvent): void; close(): void } {
  const channel = new MessageChannel();
  const port = channel.port1;
  port.onmessage = ({ data }) => {
    if ((data as { event?: unknown } | null)?.event === "ready") {
      onReady?.();
      return;
    }
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
      theme: currentTheme(context.accent),
    },
    "*",
    [channel.port2],
  );
  return {
    send: (event) => port.postMessage(event),
    close: () => port.close(),
  };
}

/** How long after its page loads a frame shows, when the page's bridge hasn't said it is ready. */
export const PLUGIN_FRAME_REVEAL_AFTER_LOAD_MS = 500;
/** The longest a frame stays hidden, loaded or not. */
export const PLUGIN_FRAME_REVEAL_LATEST_MS = 3000;

export function PluginFrame({
  url,
  title,
  context,
  visible = true,
  progress,
  onToolbarRun,
}: {
  url: string;
  title: string;
  context: PluginPageContext;
  visible?: boolean;
  /** The latest progress of a plugin command; the page hears its own plugin's. */
  progress?: CommandProgress;
  /** Listens for commands run from a panel's toolbar; the page hears its own plugin's. Each is told once, however close together they finish. */
  onToolbarRun?: (listener: (run: PluginToolbarRun) => void) => () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [mount, setMount] = useState(0);
  const connection = useRef<ReturnType<typeof connectPluginFrame> | undefined>(undefined);
  const latest = useRef(context);
  latest.current = context;
  const shown = useRef(visible);
  shown.current = visible;
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
    get accent() { return latest.current.accent; },
    toast: (message, tone) => {
      if (!limitsOf(latest.current.plugin.id).toast()) throw new Error("This plugin is showing too many toasts");
      latest.current.toast(message, tone);
    },
    confirm: (request) => {
      // A hidden page can't ask: the person wouldn't know what the question is about.
      if (!shown.current) return Promise.reject(new Error("This page isn't showing, so it can't ask"));
      if (!limitsOf(latest.current.plugin.id).confirm()) return Promise.reject(new Error("This plugin is asking too often"));
      return latest.current.confirm(request);
    },
  };

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let loaded = false;
    // The frame shows once its page has the app's theme, so the page's own
    // defaults never flash: when the page's bridge says so, a moment after a
    // page without one loads, and after a few seconds in any case, so a page
    // that never finishes loading still shows.
    const reveal = () => {
      element.dataset.ready = "";
    };
    const timers = [setTimeout(reveal, PLUGIN_FRAME_REVEAL_LATEST_MS)];
    const onLoad = () => {
      if (loaded) {
        connection.current?.close();
        connection.current = undefined;
        setMount((value) => value + 1);
        return;
      }
      loaded = true;
      timers.push(setTimeout(reveal, PLUGIN_FRAME_REVEAL_AFTER_LOAD_MS));
      if (element.contentWindow) connection.current = connectPluginFrame(element.contentWindow, stable, reveal);
    };
    element.addEventListener("load", onLoad);
    // Theme changes reach the page as they happen.
    const observer = new MutationObserver(() => connection.current?.send(currentTheme(stable.accent)));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance", "style", "class"] });
    return () => {
      timers.forEach(clearTimeout);
      element.removeEventListener("load", onLoad);
      observer.disconnect();
      connection.current?.close();
      connection.current = undefined;
    };
  }, [url, mount]);

  useEffect(() => {
    connection.current?.send({ event: "visibility", visible });
  }, [visible]);

  useEffect(() => {
    const prefix = `${latest.current.plugin.id}:`;
    if (progress?.command.startsWith(prefix))
      connection.current?.send({ event: "progress", command: progress.command.slice(prefix.length), message: progress.message });
  }, [progress]);

  useEffect(() => onToolbarRun?.(({ command, ...outcome }) => {
    const prefix = `${latest.current.plugin.id}:`;
    if (command.startsWith(prefix)) connection.current?.send({ event: "command", command: command.slice(prefix.length), ...outcome });
  }), [onToolbarRun]);

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
