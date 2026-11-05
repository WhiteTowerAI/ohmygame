import { pluginAgentRuntimeId, type PluginAgentRuntimeId } from "../shared/agent-runtimes.js";
import type { AgentRuntimeDefinition } from "./agent-runtimes/definitions.js";
import { localizePluginString, type PluginIndexEntry } from "./plugin-index.js";

// The coding agents installed plugins add (`contributes.agents`). Each joins
// Settings → Agents beside the built-in ones while its plugin is installed and
// not disabled everywhere; per-project switches don't apply, as for model
// providers. OhMyGame starts the agent itself and speaks the Agent Client
// Protocol with it; the plugin only says how to start it.

/** The agents of the installed plugins, as the agent runtimes define them. */
export function pluginAgentDefinitions(
  entries: readonly PluginIndexEntry[],
): Array<AgentRuntimeDefinition & { id: PluginAgentRuntimeId }> {
  return entries.flatMap((entry) =>
    (entry.manifest.contributes?.agents ?? []).map((agent) => ({
      id: pluginAgentRuntimeId(entry.id, agent.id),
      // Agent names are proper names, and errors sent to the agent stay in English.
      name: localizePluginString(entry, agent.title, "en"),
      binaries: [agent.command],
      versionArgs: ["--version"],
      ...(agent.loginCommand ? { loginCommand: agent.loginCommand } : {}),
      ...(agent.installUrl ? { installUrl: agent.installUrl } : {}),
      acp: { plugin: entry.id, args: agent.args ?? [], launch: commandLine([agent.command, ...agent.args ?? []]) },
    })),
  );
}

/** A command line for the person to read: an argument that isn't plain is quoted, so spaces and line breaks show. */
function commandLine(parts: readonly string[]): string {
  return parts.map((part) => /^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)).join(" ");
}
