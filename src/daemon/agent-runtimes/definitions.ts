import { existsSync } from "node:fs";
import path from "node:path";
import type {
  AgentRuntimeBinarySource,
  AgentRuntimeId,
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
  testedVersion: string;
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
    testedVersion: "1.18.33",
    loginCommand: "opencode auth login",
    installUrl: "https://opencode.ai/docs/",
  },
};

/**
 * Codex confines commands with its own sandbox and Claude Code with its
 * native one (Seatbelt on macOS, bubblewrap on Linux), which OhMyGame turns
 * on; OpenCode has none. Windows support is not established for either.
 * Claude Code runs commands unconfined when bubblewrap or socat is missing.
 */
export function commandSandbox(
  id: AgentRuntimeId,
  platform: NodeJS.Platform = process.platform,
  onPath: (program: string) => boolean = programOnPath,
): "os" | "none" {
  if (id === "opencode-cli") return "none";
  if (platform === "darwin") return "os";
  if (platform !== "linux") return "none";
  return id === "codex-cli" || (onPath("bwrap") && onPath("socat"))
    ? "os"
    : "none";
}

function programOnPath(program: string): boolean {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((folder) => !!folder && existsSync(path.join(folder, program)));
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
