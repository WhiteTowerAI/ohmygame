import type { ProjectType } from "./contracts.js";
import type { McpServerDefinition, PluginConfigurationField } from "./plugins.js";

/**
 * An MCP server the person added themselves, available to every project's
 * agent (or only the project types it is limited to). Plugins bring their
 * own MCP servers; connections are the person's.
 */
export interface ConnectionSummary {
  id: string;
  displayName: string;
  transport: "stdio" | "http";
  enabled: boolean;
  status: "enabled" | "disabled" | "not-configured" | "connected" | "failed" | "needs-auth";
  toolCount?: number;
  /** Only these project types use it; absent for every project. */
  projectTypes?: ProjectType[];
  configurationStatus: "ready" | "needs-configuration";
  /** Where it came from when the app moved it here. */
  migratedFrom?: { type: "plugin"; pluginId: string; serverId: string };
}

export interface CreateConnectionRequest {
  displayName: string;
  definition: McpServerDefinition;
  configuration?: Record<string, PluginConfigurationField>;
}

export interface UpdateConnectionRequest {
  displayName?: string;
  enabled?: boolean;
}
