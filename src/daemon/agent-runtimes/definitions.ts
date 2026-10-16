import type {
  AgentRuntimeId,
  AgentRuntimeTier,
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
  tier: AgentRuntimeTier;
  /** Executable names to look for, in order. */
  binaries: readonly string[];
  versionArgs: readonly string[];
  /** The oldest version whose protocol the adapter speaks. */
  minimumVersion: string;
  /** What to run in a terminal to sign in, when OhMyGame cannot start it itself. */
  loginCommand: string;
  installUrl: string;
}

export const AGENT_RUNTIME_DEFINITIONS: Record<
  AgentRuntimeId,
  AgentRuntimeDefinition
> = {
  "claude-code-cli": {
    id: "claude-code-cli",
    name: "Claude Code",
    tier: "full",
    binaries: ["claude"],
    versionArgs: ["--version"],
    minimumVersion: "2.0.0",
    loginCommand: "claude auth login",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
  },
  "codex-cli": {
    id: "codex-cli",
    name: "Codex",
    tier: "full",
    binaries: ["codex"],
    versionArgs: ["--version"],
    minimumVersion: "0.140.0",
    loginCommand: "codex login",
    installUrl: "https://developers.openai.com/codex/cli",
  },
  "opencode-cli": {
    id: "opencode-cli",
    name: "OpenCode",
    tier: "full",
    binaries: ["opencode"],
    versionArgs: ["--version"],
    minimumVersion: "1.0.0",
    loginCommand: "opencode auth login",
    installUrl: "https://opencode.ai/docs/",
  },
};

/** The first dotted version number a CLI prints, such as `2.1.301` from `2.1.301 (Claude Code)`. */
export function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/)?.[0];
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (value: string) =>
    value
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(version), parts(minimum)];
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}
