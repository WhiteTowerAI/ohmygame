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
  | "files.delete";

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
  request<T = unknown>(method: PluginUiMethod, params?: Record<string, unknown>): Promise<T>;
  /** The app's design tokens (`--color-surface`, `--text-md`…), already set on `:root`, and its appearance. */
  on(event: "theme", listener: (theme: { tokens: Record<string, string>; appearance: "dark" | "light" }) => void): () => void;
  on(event: "visibility", listener: (value: { visible: boolean }) => void): () => void;
  /** Something changed the project's files, such as an agent or the page itself. */
  on(event: "files", listener: () => void): () => void;
  /** How one of the plugin's commands, by its manifest id, is going while it runs. */
  on(event: "progress", listener: (value: { command: string; message: string }) => void): () => void;
  /** A command the person ran from the panel's toolbar finished; it has `error` if it failed. */
  on(event: "command", listener: (value: { command: string; result?: unknown; error?: string }) => void): () => void;
}

export function connect(): Promise<PluginUiHost>;
