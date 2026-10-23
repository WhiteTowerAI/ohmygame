import type {
  AgentPermissionMode,
  AgentRuntimeId,
} from "../../shared/agent-runtimes.js";
import { commandSandbox, versionAtLeast } from "./definitions.js";

/** The prefix survives native turn records and session replay, which store error text. */
export class AgentRuntimeCompatibilityError extends Error {
  readonly code = "AGENT_RUNTIME_INCOMPATIBLE";

  constructor(
    detail: string,
    readonly capability?: string,
  ) {
    super(
      detail.startsWith("Local CLI compatibility: ")
        ? detail
        : `Local CLI compatibility: ${detail}`,
    );
    this.name = "AgentRuntimeCompatibilityError";
  }
}

export class AgentRuntimeProbeError extends Error {
  readonly code = "AGENT_RUNTIME_PROBE_FAILED";

  constructor(detail: string) {
    super(`Local CLI check failed: ${detail}`);
    this.name = "AgentRuntimeProbeError";
  }
}

/** A startup failure occurred before a model turn; keep its local origin on replay. */
export function runtimeStartupError(cause: unknown): Error {
  if (
    cause instanceof AgentRuntimeCompatibilityError ||
    cause instanceof AgentRuntimeProbeError
  )
    return cause;
  return new AgentRuntimeProbeError(
    cause instanceof Error ? cause.message : String(cause),
  );
}

/**
 * Only use a version rule when a required behavior cannot be read back from
 * the CLI. Keep its source and the mode that needs it beside the rule.
 */
export function checkRuntimeVersionRequirement(
  id: AgentRuntimeId,
  version: string | undefined,
  permissionMode: AgentPermissionMode,
  sandbox = commandSandbox(id),
): void {
  if (id === "opencode-cli") {
    // V2 deliberately replaced the server contract; V1 is no longer supported.
    // https://opencode.ai/v2/docs/migrate-v1/
    if (!version)
      throw new AgentRuntimeProbeError(
        "OpenCode did not report its v2 API version. Check the CLI and retry.",
      );
    if (!versionAtLeast(version, "2.1.0") || versionAtLeast(version, "3.0.0-0"))
      throw new AgentRuntimeCompatibilityError(
        `OpenCode ${version} is unsupported. Install OpenCode 2.1.0 or a newer 2.x version and check again.`,
        "OpenCode HTTP API v2 (>=2.1.0 <3)",
      );
    return;
  }
  if (
    id !== "claude-code-cli" ||
    permissionMode !== "standard" ||
    sandbox !== "os"
  )
    return;
  // Introduced in 2.1.83; older versions can silently ignore this setting.
  // https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2183
  if (!version)
    throw new AgentRuntimeProbeError(
      "Claude Code did not report its version. OhMyGame could not verify sandbox.failIfUnavailable, required for Standard permissions on this platform. Check the CLI and retry.",
    );
  if (!versionAtLeast(version, "2.1.83"))
    throw new AgentRuntimeCompatibilityError(
      `Claude Code ${version} does not support sandbox.failIfUnavailable, required for Standard permissions on this platform. This feature requires Claude Code 2.1.83 or newer. Update Claude Code and check again in Settings.`,
      "sandbox.failIfUnavailable (>= 2.1.83)",
    );
}

/** A failed launch is not evidence of incompatibility unless the CLI rejects the command. */
export function cliProbeError(name: string, detail: string): Error {
  return /unknown (?:argument|option|command)|unrecognized (?:argument|option|command)|unexpected argument|method not found|unsupported (?:method|control request)/i.test(
    detail,
  )
    ? new AgentRuntimeCompatibilityError(`${name}: ${detail}`)
    : new Error(detail);
}
