export type PluginUiMethod =
  | "theme.get"
  | "project.info"
  | "storage.get"
  | "storage.set"
  | "selection.get"
  | "composer.fill"
  | "command.run";

export interface PluginUiHost {
  plugin: { id: string; version: string; panel: string };
  locale: "en" | "zh-CN";
  request<T = unknown>(method: PluginUiMethod, params?: Record<string, unknown>): Promise<T>;
  on(event: "theme", listener: (theme: { tokens: Record<string, string>; appearance: "dark" | "light" }) => void): () => void;
  on(event: "visibility", listener: (value: { visible: boolean }) => void): () => void;
}

export function connect(): Promise<PluginUiHost>;
