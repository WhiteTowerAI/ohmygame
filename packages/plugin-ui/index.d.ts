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
  | "files.list"
  | "files.read"
  | "files.write"
  | "files.createFolder"
  | "files.move"
  | "files.delete"
  | "history.list"
  | "usage.get"
  | "net.fetch";

/**
 * An HTTPS request made by the app, for a project panel whose `panel.json`
 * lists the host in `net`. No cookies go along, a redirect comes back as the
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
 * change is refused while an agent works in the project.
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

export interface PluginUiHost {
  plugin: { id: string; version: string; panel: string };
  locale: "en" | "zh-CN";
  files: PluginFiles;
  request(method: "ui.toast", params: PluginUiToast): Promise<null>;
  request(method: "ui.confirm", params: PluginUiConfirm): Promise<boolean>;
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
}

export function connect(): Promise<PluginUiHost>;
