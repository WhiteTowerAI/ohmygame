export type PluginUiMethod =
  | "theme.get"
  | "project.info"
  | "storage.get"
  | "storage.set"
  | "selection.get"
  | "composer.fill"
  | "command.run"
  | "ui.toast"
  | "ui.confirm"
  | "browser.open"
  | "files.list"
  | "files.read"
  | "files.write"
  | "files.createFolder"
  | "files.move"
  | "files.delete"
  | "history.list"
  | "usage.get"
  | "net.fetch"
  | "context.set"
  | "models.list"
  | "models.complete"
  | "models.cancel"
  | "panel.open"
  | "library.add"
  | "assistant.run"
  | "assistant.history"
  | "assistant.clear";

/**
 * An HTTPS request made by the app, to a host the plugin's manifest lists in
 * `capabilities.network`. No cookies go along, a redirect comes back as the
 * answer rather than being followed, and it gives up after 30 seconds.
 */
export interface PluginUiFetch {
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** At most 30. */
  headers?: Record<string, string>;
  body?: string;
}

/** A `net.fetch` answer, its body as text of at most 5 MB. */
export interface PluginUiFetchResponse {
  status: number;
  statusText: string;
  url: string;
  /** Only content-type, content-length, etag, last-modified, location and retry-after. */
  headers: Record<string, string>;
  body: string;
}

/**
 * Puts text, files or both in the composer, for a plugin with the `composer`
 * capability. The person sends it; a page never can. Text goes after what is
 * already there; files join the ones already attached, within the same
 * limits as files the person attaches.
 */
export interface PluginUiComposerFill {
  /** At most 20,000 characters. */
  text?: string;
  /** At most 10 files. */
  attachments?: Array<{ name: string; data: string | Blob; type?: string }>;
}

/** A turn that changed the project's files, from `history.list` with the `project.history` capability. */
export interface PluginHistoryTurn {
  conversation: { id: string; title: string };
  /** When the message was sent, as an ISO date. */
  at?: string;
  /** What the person asked, cut to 2,000 characters. */
  message: string;
  changes: Array<{ path: string; kind: "added" | "modified" | "removed"; lines?: { added: number; removed: number } }>;
  /** The turn's changes were taken back with Undo. */
  undone?: boolean;
}

/** One day's use of one model in the project, from `usage.get` with the `project.usage` capability. */
export interface PluginUsageRow {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  durationMs: number;
}

/** Shows a toast the app draws, under the plugin's id. A plugin shows at most 5 in 10 seconds. */
export interface PluginUiToast {
  /** At most 500 characters. */
  message: string;
  tone?: "default" | "success" | "danger";
}

/**
 * Asks the person in a dialog the app draws, which says which plugin asks;
 * resolves to whether they agreed. A page that isn't showing can't ask, one
 * question waits at a time, and a plugin asks at most 5 in a minute.
 */
export interface PluginUiConfirm {
  /** At most 200 characters. */
  title: string;
  /** At most 1,000 characters. */
  message?: string;
  /** The agreeing button; at most 40 characters. */
  confirmLabel?: string;
}

/** A file or folder of the project. */
export interface PluginFileEntry {
  /** Relative to the project, with forward slashes. */
  path: string;
  kind: "file" | "folder";
  /** A file's size in bytes. */
  size?: number;
  /** When it last changed, as an ISO date. */
  modified: string;
  /** A media file's type, such as `image/png`. */
  mediaType?: string;
}

/**
 * The project's files, for a plugin whose manifest asks for `project.files`:
 * `read` for the first four, `write` for all. Paths are relative to the project.
 * Hidden files and folders are out of reach, and a page can't change the project
 * file, an agent's instructions or Canvas documents. Each change to a file is
 * one the person can undo, so a page changes only what the project's snapshots
 * keep (not what a `.gitignore` leaves out); an empty folder isn't kept. A
 * change is refused while an agent works in the project, except a `write` or
 * `delete` under the manifest's `projectFiles`: that waits, reads back at once,
 * and lands as one undoable change once the agent is done.
 */
export interface PluginFiles {
  /** A folder's entries, the project's root without a path; `recursive` skips generated folders such as `node_modules`. `truncated` means it stopped at 10,000. */
  list(path?: string, options?: { recursive?: boolean }): Promise<{ entries: PluginFileEntry[]; truncated: boolean }>;
  read(path: string): Promise<Blob>;
  text(path: string): Promise<string>;
  /** An address for `<img>`, `<audio>` or `<video>`; give it to `URL.revokeObjectURL` when done. */
  url(path: string): Promise<string>;
  /** Creates or replaces a file, and the folders it needs; at most 200 MB. Resolves to its path. */
  write(path: string, contents: string | Blob | ArrayBuffer | ArrayBufferView): Promise<string>;
  /** Creates a folder and the folders it needs; resolves to its path. */
  createFolder(path: string): Promise<string>;
  /** Moves or renames a file or folder, and refuses to replace anything. Resolves to its new path. */
  move(from: string, to: string): Promise<string>;
  /** Deletes a file, or a folder and everything in it. */
  delete(path: string): Promise<null>;
}

/** What a tool's handler gets besides its input. */
export interface PluginToolCall {
  /** Aborted when the caller gives up, such as when the person stops the agent. */
  signal: AbortSignal;
  /** Shows how the call is going; at most 2,000 characters each. */
  progress(message: string): void;
}

/**
 * The tools the manifest says this panel answers (`contributes.tools[].panel`,
 * API 2.35.0). The agent and the plugin's commands call them; the app shows
 * the panel and hands its page the call, with input its schema checked.
 */
export interface PluginTools {
  /**
   * Answers one tool; what the handler returns, as JSON, is its result, and
   * what it throws is the tool's error. A call that comes before the page
   * handles it waits up to 10 seconds. Returns a function that stops.
   */
  handle(name: string, handler: (input: any, call: PluginToolCall) => unknown | Promise<unknown>): () => void;
}

/**
 * What the person is looking at in the panel, for a plugin with the
 * `composer` capability (API 2.35.0): it shows in the composer, and the next
 * message carries it while the panel shows, unless the person removes it.
 */
export interface PluginContext {
  /** `label` is at most 120 characters, `text` at most 8,000; a new one replaces the last. */
  set(value: { label: string; text: string }): Promise<null>;
  clear(): Promise<null>;
}

/** A model the person set up, from `host.models.list()`. */
export interface PluginModel {
  provider: string;
  id: string;
  name: string;
  /** Whether it reads images. */
  images: boolean;
  /** The one a request without `model` uses. */
  default?: true;
}

export interface PluginModelMessage {
  role: "user" | "assistant";
  text: string;
  /**
   * In a user's message, for a model whose `images` is true: PNG, JPEG, WebP
   * or GIF, at most 8 in a request and 5 MB each. Send Blobs: base64 text
   * needs its `type`, and counts toward the request's 2 MB as JSON.
   */
  images?: Array<{ data: Blob; type?: string } | { data: string; type: string }>;
}

/**
 * One request to a model (API 2.35.0). Text is at most 200,000 characters in
 * all, over at most 40 messages, the last of them the user's.
 */
export interface PluginModelRequest {
  system?: string;
  messages: PluginModelMessage[];
  /** Asks for JSON and reads the answer as `json`; the request fails if it isn't JSON. */
  json?: boolean;
  /** 1 to 8,192; 2,048 when left out. */
  maxTokens?: number;
  /** One of `list()`; the default model when left out. */
  model?: { provider: string; id: string };
}

export interface PluginModelResult {
  text: string;
  json?: unknown;
  model: { provider: string; id: string };
  /** Tokens read and written, which count toward the person's usage. */
  usage: { input: number; output: number };
  stopReason: "stop" | "length";
}

/**
 * The person's language models, for a plugin with the `models` capability
 * (API 2.35.0). Each request counts toward their usage and is written in the
 * plugin's log. A request starts only while the panel shows; hiding it
 * doesn't stop one that runs. A plugin has at most 3 running at once and 30
 * a minute, and each has 2 minutes.
 */
export interface PluginModels {
  list(): Promise<PluginModel[]>;
  /** `signal` stops it; so does the page closing or reloading. */
  complete(request: PluginModelRequest, options?: { signal?: AbortSignal }): Promise<PluginModelResult>;
}

/** One of the plugin's tools the assistant used, and what it answered. */
export interface PluginAssistantToolUse {
  id: string;
  name: string;
  input: unknown;
  result: string;
  error?: true;
}

/** A panel's assistant conversation: the person's messages, and each of the assistant's steps. */
export type PluginAssistantEntry =
  | { role: "user"; text: string; /** How many images came with it; they aren't kept. */ images?: number; at: string }
  | { role: "assistant"; text: string; tools?: PluginAssistantToolUse[]; at: string };

/** How a run is going: the assistant's text in a step, then each tool it uses and its answer. */
export type PluginAssistantEvent =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool.result"; id: string; name: string; result: string; error?: true };

export interface PluginAssistant {
  /**
   * Says `text` to the assistant, with images for a model that reads them,
   * and resolves with its last text once it is done. It uses the plugin's
   * tools by their manifest names, at most 8 steps a run; each tool call is
   * a change the person can undo, refused while the project's agent works.
   * It starts only while the page shows, and one run goes at a time in a panel.
   */
  run(
    request: { text: string; images?: Array<{ data: Blob | string; type?: string }>; system?: string; model?: { provider: string; id: string }; maxTokens?: number },
    options?: { signal?: AbortSignal; onEvent?: (event: PluginAssistantEvent) => void },
  ): Promise<{ text: string; model: { provider: string; id: string }; usage: { input: number; output: number }; steps: number; stopped?: "steps" | "length" }>;
  /** The conversation so far, oldest first. */
  history(): Promise<PluginAssistantEntry[]>;
  /** Forgets the conversation, to start over. */
  clear(): Promise<null>;
}

export interface PluginUiHost {
  plugin: { id: string; version: string; panel: string };
  locale: "en" | "zh-CN";
  files: PluginFiles;
  tools: PluginTools;
  context: PluginContext;
  models: PluginModels;
  /**
   * The panel's assistant, with `capabilities.models` (API 2.35.0): the
   * person's model, run by the app in a loop with this plugin's own tools,
   * its conversation kept for this panel in this project apart from the
   * project's chats. The page draws it; each step counts toward the
   * plugin's model limits. Only an installed plugin's panel has one.
   */
  assistant: PluginAssistant;
  /**
   * Imports a `.js` or `.mjs` module of the project, such as
   * `pixelfx/effects/ricochet.js`, from a folder the manifest's
   * `ui.projectModules` names (API 2.35.0). Once a `.js` or `.mjs` file of
   * the project changes, the next import loads it, and what it imports, as
   * they are now.
   */
  modules: { import<T = any>(path: string): Promise<T> };
  /**
   * The state this panel was opened with before the page loaded (API 2.35.0),
   * such as where to go; undefined when it wasn't given one. Later openings
   * come as the `open` event.
   */
  opened: unknown;
  panels: {
    /**
     * Shows one of the plugin's own panels, this one included, while this
     * page shows (API 2.35.0). With `state`, JSON of at most 16,000
     * characters, its page hears it: as `opened` when it loads, or the `open`
     * event when it already has.
     */
    open(panel: string, options?: { state?: unknown }): Promise<null>;
  };
  /**
   * The person's Library, with `capabilities.library` (API 2.35.0), where a
   * page puts what it makes instead of a download. Each file is listed as
   * added by the plugin, and the person sees a toast as it comes.
   */
  library: {
    /**
     * Adds a PNG, JPEG or WebP image, sound, video or 3D model of at most
     * 200 MB, named with its type, such as `ricochet.png`: a File keeps its
     * own name unless given one. `prompt`, at most 1,000 characters, says
     * what it was made from. Only while the page shows; a plugin adds at
     * most 2 at once and 20 a minute.
     */
    add(file: Blob | File, options?: { name?: string; prompt?: string }): Promise<{ id: string; name: string; mediaType: "image" | "video" | "audio" | "model" }>;
  };
  request(method: "ui.toast", params: PluginUiToast): Promise<null>;
  request(method: "ui.confirm", params: PluginUiConfirm): Promise<boolean>;
  /** Opens an HTTP(S) address in a new Browser tab and reveals the panel. Desktop project pages only; visible pages may ask at most 5 times in 10 seconds. No page access is granted. */
  request(method: "browser.open", params: { url: string }): Promise<null>;
  request(method: "composer.fill", params: PluginUiComposerFill): Promise<null>;
  /** The project's latest turns that changed files, newest first; `limit` is 1 to 100, 20 when left out. */
  request(method: "history.list", params?: { limit?: number }): Promise<{ turns: PluginHistoryTurn[] }>;
  request(method: "usage.get"): Promise<{ rows: PluginUsageRow[] }>;
  request(method: "net.fetch", params: PluginUiFetch): Promise<PluginUiFetchResponse>;
  request<T = unknown>(method: PluginUiMethod, params?: Record<string, unknown>): Promise<T>;
  /** The app's design tokens (`--color-surface`, `--text-md`…), already set on `:root`, and its appearance. */
  on(event: "theme", listener: (theme: { tokens: Record<string, string>; appearance: "dark" | "light" }) => void): () => void;
  on(event: "visibility", listener: (value: { visible: boolean }) => void): () => void;
  /**
   * Something changed the project's files, such as an agent, the page itself,
   * or an edit outside OhMyGame. `paths` names them when the app knows, with
   * `truncated` when there were more than it sends at once.
   */
  on(event: "files", listener: (value: { paths?: string[]; truncated?: boolean }) => void): () => void;
  /** How one of the plugin's commands, by its manifest id, is going while it runs. */
  on(event: "progress", listener: (value: { command: string; message: string }) => void): () => void;
  /** A command the person ran from the panel's toolbar finished; it has `error` if it failed. */
  on(event: "command", listener: (value: { command: string; result?: unknown; error?: string }) => void): () => void;
  /** The panel was opened again with a state while the page was loaded, by a command, a page or the plugin's native code. */
  on(event: "open", listener: (value: { state: unknown }) => void): () => void;
}

export function connect(): Promise<PluginUiHost>;
