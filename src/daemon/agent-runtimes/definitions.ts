import {
  AGENT_RUNTIME_IDS,
  isBuiltInAgentRuntimeId,
  type AgentRuntimeBinarySource,
  type AgentRuntimeId,
  type BuiltInAgentRuntimeId,
  type PluginAgentRuntimeId,
} from "../../shared/agent-runtimes.js";

/**
 * What OhMyGame knows about a coding agent CLI before running it: how to find
 * it, read its version and sign it in. Everything about how a session talks
 * to it lives in its protocol adapter. A new CLI starts as one entry here
 * and an adapter; nothing in the Provider, media, canvas or plugin code
 * changes for it.
 */
export interface AgentRuntimeDefinition {
  id: AgentRuntimeId;
  name: string;
  /** Executable names to look for, in order. */
  binaries: readonly string[];
  /**
   * Copies other apps install outside PATH, such as the Codex that ships in the
   * ChatGPT app. `~` is the home folder.
   */
  bundledPaths?: Partial<
    Record<
      NodeJS.Platform,
      readonly {
        path: string;
        source: AgentRuntimeBinarySource;
      }[]
    >
  >;
  versionArgs: readonly string[];
  /** A real acceptance run, not a minimum version or a guarantee about later releases. */
  testedVersion?: string;
  /** What to run in a terminal to sign in, when OhMyGame cannot start it itself. */
  loginCommand?: string;
  installUrl?: string;
  /** An agent a plugin adds: the plugin, and the arguments that start the Agent Client Protocol on stdio. */
  acp?: { plugin: string; args: readonly string[] };
}

export const AGENT_RUNTIME_DEFINITIONS: Record<
  BuiltInAgentRuntimeId,
  AgentRuntimeDefinition
> = {
  "claude-code-cli": {
    id: "claude-code-cli",
    name: "Claude Code",
    binaries: ["claude"],
    versionArgs: ["--version"],
    testedVersion: "2.1.302",
    loginCommand: "claude auth login",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
  },
  "codex-cli": {
    id: "codex-cli",
    name: "Codex",
    binaries: ["codex"],
    bundledPaths: {
      darwin: ["/Applications", "~/Applications"].flatMap((directory) =>
        [
          { app: "Codex", source: "codex-app" as const },
          { app: "ChatGPT", source: "chatgpt-app" as const },
        ].map(({ app, source }) => ({
          path: `${directory}/${app}.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`,
          source,
        })),
      ),
    },
    versionArgs: ["--version"],
    testedVersion: "0.163.0",
    loginCommand: "codex login",
    installUrl: "https://developers.openai.com/codex/cli",
  },
  "opencode-cli": {
    id: "opencode-cli",
    name: "OpenCode",
    binaries: ["opencode"],
    versionArgs: ["--version"],
    testedVersion: "2.1.0",
    loginCommand: "opencode auth login",
    installUrl: "https://opencode.ai/v2/docs/",
  },
};

const pluginAgents = new Map<PluginAgentRuntimeId, AgentRuntimeDefinition>();

/** Replaces the agents that installed plugins add; returns those added, changed or removed. */
export function setPluginAgentDefinitions(
  definitions: readonly (AgentRuntimeDefinition & { id: PluginAgentRuntimeId })[],
): PluginAgentRuntimeId[] {
  const next = new Map(definitions.map((definition) => [definition.id, definition]));
  const changed = [...new Set([...pluginAgents.keys(), ...next.keys()])].filter(
    (id) => JSON.stringify(pluginAgents.get(id)) !== JSON.stringify(next.get(id)),
  );
  pluginAgents.clear();
  for (const [id, definition] of next) pluginAgents.set(id, definition);
  return changed;
}

/** The built-in agents, then those installed plugins add. */
export function agentRuntimeIds(): AgentRuntimeId[] {
  return [...AGENT_RUNTIME_IDS, ...pluginAgents.keys()];
}

/** An agent's definition, or undefined for a plugin agent whose plugin is gone. */
export function findAgentRuntimeDefinition(
  id: AgentRuntimeId,
): AgentRuntimeDefinition | undefined {
  return isBuiltInAgentRuntimeId(id)
    ? AGENT_RUNTIME_DEFINITIONS[id]
    : pluginAgents.get(id);
}

export function agentRuntimeDefinition(
  id: AgentRuntimeId,
): AgentRuntimeDefinition {
  const definition = findAgentRuntimeDefinition(id);
  if (!definition)
    throw new Error(
      "The plugin that adds this coding agent is not installed or is turned off",
    );
  return definition;
}

/** The first dotted version number a CLI prints, such as `2.1.301` from `2.1.301 (Claude Code)`. */
export function parseVersion(output: string): string | undefined {
  return output.match(
    /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/,
  )?.[0];
}

/** SemVer precedence: a release outranks its prereleases; build metadata is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => {
    const [core, ...prereleaseParts] = value.split("+", 1)[0]!.split("-");
    const prerelease = prereleaseParts.join("-") || undefined;
    return {
      core: core!.split(".").map(BigInt),
      prerelease: prerelease?.split("."),
    };
  };
  const left = parts(a),
    right = parts(b);
  for (let i = 0; i < 3; i++) {
    const x = left.core[i] ?? 0n,
      y = right.core[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (!left.prerelease || !right.prerelease)
    return left.prerelease ? -1 : right.prerelease ? 1 : 0;
  for (
    let i = 0;
    i < Math.max(left.prerelease.length, right.prerelease.length);
    i++
  ) {
    const x = left.prerelease[i],
      y = right.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}
