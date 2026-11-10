import type { AgentModelRef, AgentStatus } from "./contracts.js";

/** Bumped only with a migration step in orchestrator-store.ts. */
export const ORCHESTRATOR_STORE_VERSION = 1;
export const ORCHESTRATOR_MAX_ROLES = 8;
export const ORCHESTRATOR_ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** A writer may change files; an advisor may only read and talk. */
export type OrchestratorRoleCapability = "writer" | "advisor";

export interface OrchestratorRoleConfig {
  /** Stable slug, used in messages and events. */
  id: string;
  name: string;
  /** Appended to this role's system prompt. */
  persona: string;
  capability: OrchestratorRoleCapability;
  model: AgentModelRef;
}

export interface OrchestratorRoleState {
  config: OrchestratorRoleConfig;
  /** Filled in when the run starts. */
  conversationId?: string;
  status: AgentStatus;
  lastTurnId?: string;
}

export type OrchestratorStatus = "idle" | "running" | "stopped" | "completed" | "error";

export interface OrchestratorDiagnostic {
  /** `ping-pong` when two roles only messaged each other; `store-unreadable` when the saved team could not be read. */
  code: "ping-pong" | "store-unreadable";
  message: string;
  roleIds: string[];
}

export interface OrchestratorConfig {
  version: number;
  goal: string;
  roles: OrchestratorRoleConfig[];
  /** Role id to the conversation backing it, once a run has started; kept so a later run continues them. */
  conversations?: Record<string, string>;
  updatedAt: string;
}

export interface OrchestratorState {
  config: OrchestratorConfig;
  status: OrchestratorStatus;
  roles: OrchestratorRoleState[];
  diagnostic?: OrchestratorDiagnostic;
  /** What the writer said was achieved, once it marked the goal complete. */
  summary?: string;
}

/** One teammate as the team tools describe it. */
export interface OrchestratorRosterEntry {
  id: string;
  name: string;
  capability: OrchestratorRoleCapability;
  status: AgentStatus;
  persona: string;
}

/** A message from one role, waiting for the next turn of the role it was sent to. */
export interface OrchestratorPendingMessage {
  fromRoleId: string;
  fromName: string;
  text: string;
}
