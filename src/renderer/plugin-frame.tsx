import { useEffect, useRef, useState } from "react";
import {
  accentTokens,
  PAGE_TOKENS,
  PLUGIN_ACCENT_MIN_CONTRAST,
  PLUGIN_UI_HANDSHAKE,
  PLUGIN_UI_PROTOCOL_VERSION,
  pageFilePaths,
  pluginUiRefusal,
  readPluginUiRequest,
  readPluginUiToolMessage,
  type PluginAccent,
  type PluginUiCapabilities,
  type PluginUiConfirm,
  type PluginUiEvent,
  type PluginUiRequest,
  type PluginUiToastTone,
  type PluginUiAttachment,
} from "../shared/plugin-ui-protocol.js";
import { PLUGIN_BROWSER_LIMIT, PLUGIN_BROWSER_WINDOW_MS } from "../shared/browser.js";
import { authorizePluginBrowserOpen } from "./api.js";
import { t } from "./i18n.js";
import { Button, Dialog } from "./ui/index.js";
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
  /** Fills the composer with text and files; the page can never send it. */
  fillComposer?: (text: string, files: File[]) => void;
  /** What the page says the person is looking at, which the next message carries; undefined clears it. */
  setContext?: (value: { label: string; text: string } | undefined) => void;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  /** The project's files, as far as `capabilities["project.files"]` allows; the daemon checks too. */
  files: {
    list(options: { path?: string; recursive?: boolean }): Promise<unknown>;
    read(path: string): Promise<Blob>;
    write(path: string, contents: Blob): Promise<string>;
    createFolder(path: string): Promise<string>;
    move(from: string, to: string): Promise<string>;
    delete(path: string): Promise<void>;
  };
  runCommand(command: string, input?: unknown): Promise<unknown>;
  /** The project's latest turns that changed files, with `project.history`. */
  history(limit?: number): Promise<unknown>;
  /** What the project's conversations used, with `project.usage`. */
  usage(): Promise<unknown>;
  /** An HTTPS request to a host the page's `capabilities.net` names, made by the daemon. */
  fetch?(request: { url: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<unknown>;
  /** The plugin's brand colour, from its manifest. */
  accent?: PluginAccent;
  /** Shows a toast the app draws, under the plugin's id. */
  toast(message: string, tone?: PluginUiToastTone): void;
  /** Asks the person in a dialog the app draws; a page only learns the answer. */
  confirm(request: PluginUiConfirm): Promise<boolean>;
  /** Opens an address in a new tab of the project's Browser panel and shows it; absent outside the desktop app. */
  openBrowser?(url: string): void | Promise<void>;
  /** Installed project plugins share their open limit with native code in the daemon. */
  browserQuotaProject?: string;
  /** Hears an error the page didn't catch, for its plugin's log. */
  reportError?(message: string): void;
  /** Turns the plugin off everywhere, as from a panel that stopped responding. */
  turnOff?(): void;
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

export { PLUGIN_BROWSER_LIMIT, PLUGIN_BROWSER_WINDOW_MS };

const pluginLimits = new Map<string, { toast: () => boolean; confirm: () => boolean; browser: () => boolean }>();

/** A plugin's limits, which all its panels share and reloading a page doesn't start over. */
function limitsOf(plugin: string) {
  let limits = pluginLimits.get(plugin);
  if (!limits) {
    limits = { toast: rateLimit(PLUGIN_TOAST_LIMIT, PLUGIN_TOAST_WINDOW_MS), confirm: rateLimit(PLUGIN_CONFIRM_LIMIT, PLUGIN_CONFIRM_WINDOW_MS), browser: rateLimit(PLUGIN_BROWSER_LIMIT, PLUGIN_BROWSER_WINDOW_MS) };
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
    case "composer.fill": {
      if (!context.fillComposer) throw new Error("There is no composer here");
      const attachments = (params.attachments ?? []) as PluginUiAttachment[];
      context.fillComposer(
        (params.text as string | undefined) ?? "",
        attachments.map(({ name, data, type }) => new File([data], name, { type: type ?? (data instanceof Blob ? data.type : "") })),
      );
      return null;
    }
    case "context.set":
      if (!context.setContext) throw new Error("There is no conversation here");
      context.setContext(params.label === undefined ? undefined : { label: (params.label as string).trim(), text: params.text as string });
      return null;
    case "history.list":
      return context.history(params.limit as number | undefined);
    case "usage.get":
      return context.usage();
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
    case "files.list":
      return context.files.list({
        ...(params.path === undefined ? {} : { path: params.path as string }),
        ...(params.recursive === undefined ? {} : { recursive: params.recursive as boolean }),
      });
    case "files.read":
      return context.files.read(params.path as string);
    case "files.write": {
      const { data } = params;
      return context.files.write(params.path as string, data instanceof Blob ? data : new Blob([data as string]));
    }
    case "files.createFolder":
      return context.files.createFolder(params.path as string);
    case "files.move":
      return context.files.move(params.from as string, params.to as string);
    case "files.delete":
      await context.files.delete(params.path as string);
      return null;
    case "browser.open":
      if (!context.openBrowser) throw new Error("The browser is only in the desktop app");
      await context.openBrowser(params.url as string);
      return null;
    case "net.fetch":
      if (!context.fetch) throw new Error("This page can't reach the network");
      return context.fetch({
        url: params.url as string,
        ...(params.method === undefined ? {} : { method: params.method as string }),
        ...(params.headers === undefined ? {} : { headers: params.headers as Record<string, string> }),
        ...(params.body === undefined ? {} : { body: params.body as string }),
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

/** Hands a page a call to one of the tools its panel answers. */
export interface PageToolHost {
  /**
   * Resolves to the page's result, or rejects with its error. `onAccepted`
   * runs once the page has a handler for the tool; until then nothing ran.
   */
  call(name: string, input: unknown, hooks: { onAccepted(): void; onProgress(message: string): void }, signal: AbortSignal): Promise<unknown>;
}

/** Connects a loaded frame; returns how to send it events, call its tools and disconnect. */
export function connectPluginFrame(
  frame: Window,
  context: PluginPageContext,
  /** Called when the page's bridge has applied the app's theme. */
  onReady?: () => void,
  /** The bridge answering a `ping`, and an error the page didn't catch. */
  hooks: { onPong?: () => void; onError?: (message: string) => void } = {},
): { send(event: PluginUiEvent): void; close(): void; tools: PageToolHost } {
  const channel = new MessageChannel();
  const port = channel.port1;
  let nextCall = 0;
  const calls = new Map<number, { accepted: boolean; onAccepted(): void; onProgress(message: string): void; resolve(value: unknown): void; reject(error: Error): void }>();
  port.onmessage = ({ data }) => {
    const tool = readPluginUiToolMessage(data);
    if (tool) {
      const call = calls.get(tool.toolCall);
      if (!call) return;
      if ("accepted" in tool) {
        if (!call.accepted) {
          call.accepted = true;
          call.onAccepted();
        }
      } else if ("progress" in tool) {
        if (call.accepted) call.onProgress(tool.progress);
      } else if ("error" in tool) call.reject(new Error(tool.error));
      else call.resolve(tool.result);
      return;
    }
    const event = (data as { event?: unknown; message?: unknown } | null)?.event;
    if (event === "ready") {
      onReady?.();
      return;
    }
    if (event === "pong") {
      hooks.onPong?.();
      return;
    }
    if (event === "error") {
      const message = (data as { message?: unknown }).message;
      hooks.onError?.(typeof message === "string" ? message.slice(0, 4000) : "Error");
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
    close: () => {
      port.close();
      for (const call of [...calls.values()]) call.reject(new Error("The panel's page closed or reloaded before it answered"));
    },
    tools: {
      call: (name, input, hooks, signal) => new Promise<unknown>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("Cancelled"));
          return;
        }
        const id = nextCall++;
        const settle = () => {
          calls.delete(id);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          settle();
          port.postMessage({ toolCall: id, cancel: true });
          reject(new Error("Cancelled"));
        };
        calls.set(id, {
          accepted: false,
          onAccepted: hooks.onAccepted,
          onProgress: hooks.onProgress,
          resolve: (value) => { settle(); resolve(value); },
          reject: (error) => { settle(); reject(error); },
        });
        signal.addEventListener("abort", abort, { once: true });
        port.postMessage({ toolCall: id, name, input });
      }),
    },
  };
}

/** How often a showing page's bridge is asked whether it still answers. */
export const PLUGIN_FRAME_PING_MS = 5_000;
/** A showing page that hasn't answered for this long is said to have stopped responding. */
export const PLUGIN_FRAME_HANG_MS = 15_000;
/** A page's uncaught errors reach its log at most this often, so one in a loop can't flood it. */
export const PLUGIN_FRAME_ERROR_INTERVAL_MS = 2_000;

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
  filesRevision,
  fileChange,
  onToolbarRun,
  onTools,
}: {
  url: string;
  title: string;
  context: PluginPageContext;
  visible?: boolean;
  /** The latest progress of a plugin command; the page hears its own plugin's. */
  progress?: CommandProgress;
  /** Grows when the project's files may have changed; a page that can use them hears of it. */
  filesRevision?: number;
  /** The latest files the app saw change in the project, a new object for each; a page that can use them hears which. */
  fileChange?: { paths: string[]; truncated?: boolean };
  /** Listens for commands run from a panel's toolbar; the page hears its own plugin's. Each is told once, however close together they finish. */
  onToolbarRun?: (listener: (run: PluginToolbarRun) => void) => () => void;
  /** Hears how to call the page's tools while it is connected, and undefined once it isn't. */
  onTools?: (host: PageToolHost | undefined) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [mount, setMount] = useState(0);
  const connection = useRef<ReturnType<typeof connectPluginFrame> | undefined>(undefined);
  const latest = useRef(context);
  latest.current = context;
  const toolsListener = useRef(onTools);
  toolsListener.current = onTools;
  const shown = useRef(visible);
  shown.current = visible;
  // A page with the bridge answers pings; one that stops is offered a reload.
  const bridged = useRef(false);
  const lastPong = useRef(0);
  const lastError = useRef(0);
  const [hung, setHung] = useState(false);
  // The context changes every render; requests read the latest one.
  const stable: PluginPageContext = {
    get plugin() { return latest.current.plugin; },
    get locale() { return latest.current.locale; },
    get capabilities() { return latest.current.capabilities; },
    get commands() { return latest.current.commands; },
    project: () => latest.current.project(),
    selection: () => latest.current.selection?.(),
    fillComposer: (text, files) => {
      if (!latest.current.fillComposer) throw new Error("There is no composer here");
      latest.current.fillComposer(text, files);
    },
    get setContext() { return latest.current.setContext; },
    history: (limit) => latest.current.history(limit),
    usage: () => latest.current.usage(),
    get fetch() { return latest.current.fetch; },
    storage: {
      get: (key) => latest.current.storage.get(key),
      set: (key, value) => latest.current.storage.set(key, value),
    },
    files: {
      list: (options) => latest.current.files.list(options),
      read: (path) => latest.current.files.read(path),
      write: (path, contents) => latest.current.files.write(path, contents),
      createFolder: (path) => latest.current.files.createFolder(path),
      move: (from, to) => latest.current.files.move(from, to),
      delete: (path) => latest.current.files.delete(path),
    },
    runCommand: (command, input) => latest.current.runCommand(command, input),
    get accent() { return latest.current.accent; },
    toast: (message, tone) => {
      if (!limitsOf(latest.current.plugin.id).toast()) throw new Error("This plugin is showing too many toasts");
      latest.current.toast(message, tone);
    },
    get openBrowser() {
      const open = latest.current.openBrowser;
      if (!open) return undefined;
      return async (url: string) => {
        // A hidden page can't take the person somewhere they didn't choose to look.
        const { plugin, browserQuotaProject } = latest.current;
        const connectedPage = connection.current;
        if (!shown.current) throw new Error("This page isn't showing, so it can't open a page");
        if (browserQuotaProject) {
          await authorizePluginBrowserOpen(browserQuotaProject, plugin.id);
          if (!shown.current || connection.current !== connectedPage || latest.current.browserQuotaProject !== browserQuotaProject || latest.current.plugin.id !== plugin.id)
            throw new Error("This page isn't showing, so it can't open a page");
        } else if (!limitsOf(plugin.id).browser()) {
          throw new Error("This plugin is opening too many pages");
        }
        await open(url);
      };
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
    bridged.current = false;
    const hooks = {
      onPong: () => {
        lastPong.current = Date.now();
        setHung(false);
      },
      onError: (message: string) => {
        const now = Date.now();
        if (now - lastError.current < PLUGIN_FRAME_ERROR_INTERVAL_MS) return;
        lastError.current = now;
        latest.current.reportError?.(message);
      },
    };
    const ready = () => {
      bridged.current = true;
      lastPong.current = Date.now();
      reveal();
    };
    const timers = [setTimeout(reveal, PLUGIN_FRAME_REVEAL_LATEST_MS)];
    const disconnect = () => {
      if (!connection.current) return;
      connection.current.close();
      connection.current = undefined;
      // What the page said the person is looking at went with it.
      latest.current.setContext?.(undefined);
      toolsListener.current?.(undefined);
    };
    const onLoad = () => {
      if (loaded) {
        disconnect();
        setMount((value) => value + 1);
        return;
      }
      loaded = true;
      timers.push(setTimeout(reveal, PLUGIN_FRAME_REVEAL_AFTER_LOAD_MS));
      if (element.contentWindow) {
        connection.current = connectPluginFrame(element.contentWindow, stable, ready, hooks);
        toolsListener.current?.(connection.current.tools);
      }
    };
    element.addEventListener("load", onLoad);
    // Theme changes reach the page as they happen.
    const observer = new MutationObserver(() => connection.current?.send(currentTheme(stable.accent)));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance", "style", "class"] });
    return () => {
      timers.forEach(clearTimeout);
      element.removeEventListener("load", onLoad);
      observer.disconnect();
      disconnect();
    };
  }, [url, mount]);

  useEffect(() => {
    connection.current?.send({ event: "visibility", visible });
  }, [visible]);

  // Only while it shows: a hidden page may be throttled, and nobody waits on it.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!bridged.current || !shown.current || document.hidden) {
        lastPong.current = Date.now();
        return;
      }
      if (Date.now() - lastPong.current > PLUGIN_FRAME_HANG_MS) setHung(true);
      connection.current?.send({ event: "ping" });
    }, PLUGIN_FRAME_PING_MS);
    return () => clearInterval(timer);
  }, []);

  const reload = () => {
    setHung(false);
    // The effect's cleanup disconnects the page when the frame mounts again.
    setMount((value) => value + 1);
  };

  useEffect(() => {
    const prefix = `${latest.current.plugin.id}:`;
    if (progress?.command.startsWith(prefix))
      connection.current?.send({ event: "progress", command: progress.command.slice(prefix.length), message: progress.message });
  }, [progress]);

  const heardFiles = useRef(filesRevision);
  useEffect(() => {
    if (heardFiles.current === filesRevision) return;
    heardFiles.current = filesRevision;
    if (latest.current.capabilities["project.files"]) connection.current?.send({ event: "files" });
  }, [filesRevision]);

  const heardChange = useRef(fileChange);
  useEffect(() => {
    if (heardChange.current === fileChange || !fileChange) return;
    heardChange.current = fileChange;
    if (!latest.current.capabilities["project.files"]) return;
    const paths = pageFilePaths(fileChange.paths);
    if (paths.length || fileChange.truncated) connection.current?.send({ event: "files", paths, ...(fileChange.truncated ? { truncated: true } : {}) });
  }, [fileChange]);

  useEffect(() => onToolbarRun?.(({ command, ...outcome }) => {
    const prefix = `${latest.current.plugin.id}:`;
    if (command.startsWith(prefix)) connection.current?.send({ event: "command", command: command.slice(prefix.length), ...outcome });
  }), [onToolbarRun]);

  return (
    <>
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
      {hung && visible ? <Dialog open size="sm" title={t("pluginFrame.notRespondingTitle", { name: title })} onClose={() => {
        lastPong.current = Date.now();
        setHung(false);
      }} footer={<>
        {context.turnOff ? <Button variant="ghost" onClick={() => { setHung(false); context.turnOff?.(); }}>{t("pluginFrame.turnOff")}</Button> : null}
        <Button onClick={() => { lastPong.current = Date.now(); setHung(false); }}>{t("pluginFrame.wait")}</Button>
        <Button variant="primary" onClick={reload}>{t("pluginFrame.reload")}</Button>
      </>}>
        <p>{t("pluginFrame.notRespondingHint")}</p>
      </Dialog> : null}
    </>
  );
}
