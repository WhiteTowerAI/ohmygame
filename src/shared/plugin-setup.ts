import type { AgentModelRef } from "./contracts.js";
export interface PluginSetupMessage {
  role: "user" | "assistant";
  text: string;
}
export interface PluginSetupState {
  id: string;
  pluginId?: string;
  messages: PluginSetupMessage[];
  busy: boolean;
  activity?: string;
  error?: string;
}
export interface PluginSetupPrompt {
  prompt: string;
  model: AgentModelRef;
}
