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

/** Full adapters handle approvals and context lifecycle; availability still depends on the CLI and account. */
export type AgentRuntimeTier = "full" | "basic";

/** Where the agent's model requests are billed, as far as OhMyGame can tell. */
export type AgentRuntimeBilling =
  "subscription" | "api-key" | "provider" | "unknown";

export type AgentRuntimeAuthStatus = "signed-in" | "signed-out" | "unknown";

export type AgentRuntimeDiagnosticCode =
  | "not-installed"
  | "version-unsupported"
  | "signed-out"
  | "probe-failed"
  | "models-unavailable"
  | "user-config-not-isolated";

export interface AgentRuntimeDiagnostic {
  code: AgentRuntimeDiagnosticCode;
  /** English detail for logs and error reports; the interface shows its own text for the code. */
  message: string;
  /** A command the person can run in a terminal to fix it, such as a sign-in. */
  command?: string;
}

export interface AgentRuntimeStatus {
  id: AgentRuntimeId;
  name: string;
  tier: AgentRuntimeTier;
  enabled: boolean;
  installed: boolean;
  /** The executable that runs, resolved to an absolute path. */
  binaryPath?: string;
  version?: string;
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
  diagnostics: AgentRuntimeDiagnostic[];
  checkedAt?: string;
}

export interface UpdateAgentRuntimeRequest {
  enabled?: boolean;
  isolateUserConfig?: boolean;
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
}

export interface AnswerApprovalRequest {
  decision: ApprovalDecision;
}
