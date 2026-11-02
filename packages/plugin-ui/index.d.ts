export type PluginUiMethod =
  | "theme.get"
  | "project.info"
  | "storage.get"
  | "storage.set"
  | "selection.get"
  | "composer.fill"
  | "command.run"
  | "ui.toast"
  | "ui.confirm";

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

export interface PluginUiHost {
  plugin: { id: string; version: string; panel: string };
  locale: "en" | "zh-CN";
  request(method: "ui.toast", params: PluginUiToast): Promise<null>;
  request(method: "ui.confirm", params: PluginUiConfirm): Promise<boolean>;
  request<T = unknown>(method: PluginUiMethod, params?: Record<string, unknown>): Promise<T>;
  /** The app's design tokens (`--color-surface`, `--text-md`…), already set on `:root`, and its appearance. */
  on(event: "theme", listener: (theme: { tokens: Record<string, string>; appearance: "dark" | "light" }) => void): () => void;
  on(event: "visibility", listener: (value: { visible: boolean }) => void): () => void;
  /** How one of the plugin's commands, by its manifest id, is going while it runs. */
  on(event: "progress", listener: (value: { command: string; message: string }) => void): () => void;
  /** A command the person ran from the panel's toolbar finished; it has `error` if it failed. */
  on(event: "command", listener: (value: { command: string; result?: unknown; error?: string }) => void): () => void;
}

export function connect(): Promise<PluginUiHost>;
