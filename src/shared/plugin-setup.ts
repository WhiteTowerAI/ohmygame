import type { PluginMcpResult, PluginIcon, StorePlugin } from "./plugins.js";
import type { PluginIconMediaType } from "./plugin-icons.js";
export type PluginIconChange =
  | { icon: PluginIcon | null }
  | { image: { mediaType: PluginIconMediaType; data: string } };
export type PluginIconUpdate = PluginIconChange & { revision: string };
export type PluginSetupMode = "create" | "edit";
/** A workspace's title until its first message names it. */
export const NEW_PLUGIN_TITLE = "New plugin";

export interface PluginSetupSummary {
  id: string;
  /** The hidden project that holds its conversations. */
  projectId: string;
  mode?: PluginSetupMode;
  pluginId?: string;
  title: string;
  /** Its draft's icon, in the list of workspaces. */
  icon?: PluginIcon;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "working" | "ready" | "installed";
}

/** What a valid draft would install. */
export interface PluginDraftPlugin {
  id: string;
  version: string;
  displayName: string;
  description: string;
  icon?: PluginIcon;
  /** It only adds Skills, so it applies by itself to the projects it suits. */
  appWide: boolean;
  /** What it asks the person to allow. */
  asks: string[];
  skills: Array<{ id: string; name: string; description: string }>;
  mcpServers: Array<{ id: string; title: string }>;
  settings: boolean;
  adds: StorePlugin["adds"];
}

export interface PluginDraft {
  path?: string;
  revision?: string;
  installedRevision?: string;
  plugin?: PluginDraftPlugin;
  files: Array<{ path: string; size: number }>;
  errors: string[];
  checks?: Record<string, { revision: string; result: PluginMcpResult }>;
}
