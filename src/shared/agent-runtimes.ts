import type { AgentUsageLimit } from "./contracts.js";
/**
 * Coding agents: native CLIs (Claude Code, Codex, OpenCode) that run a
 * conversation's agent loop in place of OhMyGame's built-in Pi agent. A
 * conversation uses one when its model is one of the agent's models; the
 * model's provider is the agent's ID, so a model reference names both.
 */

// The suffix keeps these apart from model providers of the same name: Pi itself has an `opencode` provider.
export const AGENT_RUNTIME_IDS = [
  "claude-code-cli",
  "codex-cli",
  "opencode-cli",
] as const;
export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number];

export function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
  return (
    typeof value === "string" &&
    (AGENT_RUNTIME_IDS as readonly string[]).includes(value)
  );
}

/**
 * A native model's effort: the first preferred value the model offers, else
 * the model's first. Undefined for a model without efforts.
 */
export function nativeEffort(
  model: { nativeReasoningLevels?: readonly string[] } | undefined,
  ...preferred: Array<string | undefined>
): string | undefined {
  const offered = model?.nativeReasoningLevels ?? [];
  return (
    preferred.find((level) => level !== undefined && offered.includes(level)) ??
    offered[0]
  );
}

/** Where the agent's model requests are billed, as far as OhMyGame can tell. */
export type AgentRuntimeBilling =
  "subscription" | "api-key" | "provider" | "unknown";

export type AgentRuntimeAuthStatus = "signed-in" | "signed-out" | "unknown";

export type AgentRuntimeDiagnosticCode =
  | "not-installed"
  | "runtime-incompatible"
  | "signed-out"
  | "probe-failed"
  | "models-unavailable";

export interface AgentRuntimeDiagnostic {
  code: AgentRuntimeDiagnosticCode;
  /** English detail for logs and error reports; the interface shows its own text for the code. */
  message: string;
  /** A protocol field or CLI flag that the installed program lacks. */
  capability?: string;
  /** A command the person can run in a terminal to fix it, such as a sign-in. */
  command?: string;
}

/**
 * How freely a coding agent works. "standard" runs its commands in the CLI's
 * sandbox where it has one and asks about anything the policy cannot clear;
 * "full" turns the sandbox off and asks nothing, as OhMyGame's own agent does.
 * Planning is read-only either way.
 */
export const AGENT_PERMISSION_MODES = ["standard", "full"] as const;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

export interface AgentRuntimeStatus {
  id: AgentRuntimeId;
  name: string;
  enabled: boolean;
  installed: boolean;
  /** The executable that runs, resolved to an absolute path. */
  binaryPath?: string;
  version?: string;
  /** Version used for real acceptance; it is not a compatibility floor. */
  testedVersion?: string;
  auth: {
    status: AgentRuntimeAuthStatus;
    /** Account or plan text the CLI reports, such as an email address. */
    account?: string;
    billing: AgentRuntimeBilling;
  };
  /** Run without the person's own CLI settings, hooks, MCP servers and instructions. */
  isolateUserConfig: boolean;
  /** The CLI cannot be run fully isolated; part of the person's own configuration still applies. */
  partialIsolation?: boolean;
  /**
   * Whether the commands the agent runs are confined by an operating-system
   * sandbox, beyond OhMyGame's approvals. "none" means approvals alone.
   */
  commandSandbox: "os" | "none";
  permissionMode: AgentPermissionMode;
  /** The account's quota windows as last reported, by a conversation or a check of the CLI. */
  limits?: AgentUsageLimit[];
  diagnostics: AgentRuntimeDiagnostic[];
  checkedAt?: string;
}

export interface UpdateAgentRuntimeRequest {
  enabled?: boolean;
  isolateUserConfig?: boolean;
  permissionMode?: AgentPermissionMode;
  /** An executable to use instead of the one found on PATH; empty clears it. */
  binaryPath?: string;
}

export interface AgentRuntimeLoginResponse {
  /** A browser page that completes the sign-in, when the CLI hands one out. */
  url?: string;
  /** A command to run in a terminal instead, when the CLI only signs in interactively. */
  command?: string;
}

/** What an agent asks to be allowed to do. */
export type ApprovalKind = "command" | "file" | "tool" | "other";

export type ApprovalDecision = "allow" | "allow-session" | "deny";

export interface ApprovalRequestDetails {
  kind: ApprovalKind;
  /** The agent's own name for the tool. */
  tool: string;
  title?: string;
  command?: string;
  path?: string;
  paths?: Array<{ path: string; access: "read" | "write" }>;
  network?: boolean;
  reason?: string;
  /** Whether "allow for this conversation" can be offered. */
  canAllowSession: boolean;
  /**
   * What "allow for this conversation" covers when that is broader than this
   * exact request: every use of these commands, or reads in these folders.
   */
  sessionScope?: { commands?: string[]; readFolders?: string[] };
}

export interface AnswerApprovalRequest {
  decision: ApprovalDecision;
}
