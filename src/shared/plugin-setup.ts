import type { AgentModelRef, AgentReasoningLevel, Turn } from "./contracts.js";
import type { PluginMcpResult, PluginIcon } from "./plugins.js";
import type { PluginIconMediaType } from "./plugin-icons.js";
export type PluginIconChange =
  | { icon: PluginIcon | null }
  | { image: { mediaType: PluginIconMediaType; data: string } };
export type PluginIconUpdate = PluginIconChange & { revision: string };
export type PluginSetupMode = "create" | "configure" | "edit";
export interface PluginSetupSummary {
  id: string;
  mode?: PluginSetupMode;
  pluginId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "working" | "ready" | "installed" | "interrupted" | "error";
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
}
export interface PluginSetupState extends PluginSetupSummary {
  turns: Turn[];
  busy: boolean;
  error?: string;
}
export interface PluginSetupPrompt {
  prompt: string;
  model: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
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
