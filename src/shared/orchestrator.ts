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
  /** Set when ping-pong detection paused the run. */
  code: "ping-pong";
  message: string;
  roleIds: string[];
}

export interface OrchestratorConfig {
  version: number;
  goal: string;
  roles: OrchestratorRoleConfig[];
  updatedAt: string;
}

export interface OrchestratorState {
  config: OrchestratorConfig;
  status: OrchestratorStatus;
  roles: OrchestratorRoleState[];
  diagnostic?: OrchestratorDiagnostic;
}
