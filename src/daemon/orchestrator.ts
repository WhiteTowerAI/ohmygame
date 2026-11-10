import type { AgentModelRef, CheckpointChangeItem, ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import {
  ORCHESTRATOR_MAX_ROLES,
  ORCHESTRATOR_ROLE_ID_PATTERN,
  ORCHESTRATOR_STORE_VERSION,
  type OrchestratorConfig,
  type OrchestratorPendingMessage,
  type OrchestratorRoleState,
  type OrchestratorRosterEntry,
  type OrchestratorState,
} from "../shared/orchestrator.js";
import {
  OrchestratorStoreUnreadableError,
  loadOrchestratorConfig,
  removeOrchestratorConfig,
  saveOrchestratorConfig,
} from "./orchestrator-store.js";

export interface OrchestratorDeps {
  events: Pick<RuntimeEventBus, "publish">;
  /** Creates a conversation for a role and titles it after the role. Returns its id. */
  createConversation(project: ProjectState, title: string, model: AgentModelRef): Promise<string>;
  /** Sends a prompt to a role's conversation and returns the turn, so it can be cancelled. */
  prompt(project: ProjectState, conversationId: string, text: string): Promise<{ turnId: string }>;
  cancel(projectId: string, conversationId: string, turnId: string): Promise<void>;
  /** Archives a conversation rather than deleting it, so a disbanded team's history stays readable. */
  archiveConversation(project: ProjectState, conversationId: string): Promise<void>;
  now(): string;
}

interface Run {
  project: ProjectState;
  state: OrchestratorState;
  /** Messages waiting for a busy role, by conversation id, oldest first. */
  pending: Map<string, OrchestratorPendingMessage[]>;
  /** Agent-to-agent messages since a writer last changed a file. */
  messagesWithoutWrite: number;
}

/** Rounds (a message each way) two roles may trade with no file changing before the run pauses. */
export const PING_PONG_LIMIT = 3;

/** Thrown for a request the team's current state does not allow, such as changing a running team. */
export class OrchestratorConflictError extends Error {}

/**
 * Runs a project's team: one conversation per role, the writer carrying the work
 * forward turn after turn, and messages passed between roles. Everything here is
 * in memory and rebuilt from orchestrator.json when the daemon starts.
 */
export class OrchestratorSupervisor {
  readonly #runs = new Map<string, Run>();

  constructor(private readonly deps: OrchestratorDeps) {}

  state(projectId: string): OrchestratorState | undefined {
    return this.#runs.get(projectId)?.state;
  }

  roleFor(projectId: string, conversationId: string): OrchestratorRoleState | undefined {
    return this.#runs.get(projectId)?.state.roles.find((role) => role.conversationId === conversationId);
  }

  /** A conversation no role owns is an ordinary one, so it may write. */
  isWriterConversation(projectId: string, conversationId: string): boolean {
    const role = this.roleFor(projectId, conversationId);
    return role ? role.config.capability === "writer" : true;
  }

  personaFor(projectId: string, conversationId: string): string | undefined {
    return this.roleFor(projectId, conversationId)?.config.persona;
  }

  roster(projectId: string): OrchestratorRosterEntry[] {
    return (
      this.#runs.get(projectId)?.state.roles.map((role) => ({
        id: role.config.id,
        name: role.config.name,
        capability: role.config.capability,
        status: role.status,
        persona: role.config.persona,
      })) ?? []
    );
  }

  /** What has arrived for a conversation since its last turn drained it. */
  pendingFor(projectId: string, conversationId: string): OrchestratorPendingMessage[] {
    return this.#runs.get(projectId)?.pending.get(conversationId) ?? [];
  }

  async configure(project: ProjectState, config: OrchestratorConfig): Promise<OrchestratorState> {
    await this.load(project);
    const current = this.#runs.get(project.id);
    if (current?.state.status === "running") throw new OrchestratorConflictError("Stop the team before changing it");
    // Saving over a store this build cannot read would discard what a newer OhMyGame wrote.
    if (current?.state.diagnostic?.code === "store-unreadable") throw new OrchestratorConflictError(current.state.diagnostic.message);
    if (config.roles.length > ORCHESTRATOR_MAX_ROLES) throw new Error(`A team has at most ${ORCHESTRATOR_MAX_ROLES} roles`);
    const ids = new Set<string>();
    for (const role of config.roles) {
      if (!ORCHESTRATOR_ROLE_ID_PATTERN.test(role.id)) throw new Error(`"${role.id}" is not a valid role id`);
      if (ids.has(role.id)) throw new Error(`Two roles are both called "${role.id}"`);
      ids.add(role.id);
    }
    if (!config.roles.some((role) => role.capability === "writer")) throw new Error("A team needs one role that can write files");
    // A role that stays on the team keeps its conversation, so its history carries on.
    const previous = conversationsOf(current?.state);
    const conversations = Object.fromEntries(config.roles.flatMap((role) => (previous[role.id] ? [[role.id, previous[role.id]!]] : [])));
    const saved: OrchestratorConfig = {
      version: ORCHESTRATOR_STORE_VERSION,
      goal: config.goal,
      roles: config.roles,
      ...(Object.keys(conversations).length ? { conversations } : {}),
      updatedAt: this.deps.now(),
    };
    await saveOrchestratorConfig(project, saved);
    this.#runs.set(project.id, { project, state: idleState(saved, "idle"), pending: new Map(), messagesWithoutWrite: 0 });
    return this.#publish(project.id);
  }

  async start(project: ProjectState): Promise<OrchestratorState> {
    await this.load(project);
    const run = this.#runs.get(project.id);
    if (!run || !run.state.roles.length) throw new Error("Set up the team before starting it");
    if (run.state.status === "running") return run.state;
    run.project = project;
    run.pending.clear();
    run.messagesWithoutWrite = 0;
    const roles: OrchestratorRoleState[] = [];
    for (const role of run.state.roles) {
      // A run that was stopped keeps its conversations, so starting again continues where it left off.
      const conversationId = role.conversationId ?? (await this.deps.createConversation(project, role.config.name, role.config.model));
      roles.push({ config: role.config, conversationId, status: "idle" });
    }
    const config: OrchestratorConfig = { ...run.state.config, conversations: conversationsOf({ roles }) };
    await saveOrchestratorConfig(project, config);
    run.state = { config, roles, status: "running" };
    const writer = roles.find((role) => role.config.capability === "writer")!;
    try {
      await this.#promptRole(run, writer, openingPrompt(config.goal));
    } catch (cause) {
      // Another conversation in the project is busy; the team waits to be started again.
      run.state = { ...run.state, status: "stopped", roles: roles.map((role) => ({ ...role, status: "idle" as const })) };
      this.#publish(project.id);
      throw new OrchestratorConflictError(cause instanceof Error ? cause.message : String(cause));
    }
    return this.#publish(project.id);
  }

  async stop(projectId: string): Promise<OrchestratorState | undefined> {
    const run = this.#runs.get(projectId);
    if (!run || run.state.status !== "running") return run?.state;
    const busy = run.state.roles.filter((role) => role.conversationId && role.lastTurnId && role.status === "running");
    run.state = { ...run.state, status: "stopped", roles: run.state.roles.map((role) => ({ ...role, status: "idle" as const })) };
    run.pending.clear();
    this.#publish(projectId);
    await Promise.all(busy.map((role) => this.deps.cancel(projectId, role.conversationId!, role.lastTurnId!).catch(() => {})));
    return run.state;
  }

  /**
   * Rebuilds a project's team from what was saved, once. A run that was going when
   * the app closed is not going now: nothing resumes it by itself. A file this
   * build cannot read stays as it is, and the team shows why instead of looking empty.
   */
  async load(project: ProjectState): Promise<void> {
    if (this.#runs.has(project.id)) return;
    let config: OrchestratorConfig | undefined;
    try {
      config = await loadOrchestratorConfig(project);
    } catch (cause) {
      if (!(cause instanceof OrchestratorStoreUnreadableError)) throw cause;
      this.#runs.set(project.id, {
        project,
        state: {
          config: { version: ORCHESTRATOR_STORE_VERSION, goal: "", roles: [], updatedAt: this.deps.now() },
          status: "error",
          roles: [],
          diagnostic: { code: "store-unreadable", message: cause.message, roleIds: [] },
        },
        pending: new Map(),
        messagesWithoutWrite: 0,
      });
      return;
    }
    if (!config) return;
    this.#runs.set(project.id, { project, state: idleState(config, "stopped"), pending: new Map(), messagesWithoutWrite: 0 });
  }

  /** Rebuilds every project's team at startup. */
  async loadAll(projects: readonly ProjectState[]): Promise<void> {
    for (const project of projects) await this.load(project);
  }

  /** The saved state, loading it on first ask. Undefined when the project has no team. */
  async loaded(project: ProjectState): Promise<OrchestratorState | undefined> {
    await this.load(project);
    return this.state(project.id);
  }

  /** Disbands the team. Its conversations are archived, not deleted, so their history stays readable. */
  async remove(project: ProjectState): Promise<void> {
    await this.load(project);
    const run = this.#runs.get(project.id);
    if (run?.state.status === "running") throw new OrchestratorConflictError("Stop the team before removing it");
    // An unreadable store is kept: removing it would discard what a newer OhMyGame saved.
    if (run?.state.diagnostic?.code === "store-unreadable") throw new OrchestratorConflictError(run.state.diagnostic.message);
    for (const role of run?.state.roles ?? []) {
      if (role.conversationId) await this.deps.archiveConversation(project, role.conversationId).catch(() => {});
    }
    this.#runs.delete(project.id);
    await removeOrchestratorConfig(project);
  }

  /** Forgets a project's team without touching its files, for a project that was deleted. */
  forget(projectId: string): void {
    this.#runs.delete(projectId);
  }

  async deliver(projectId: string, fromConversationId: string, toRoleId: string, text: string): Promise<{ delivered: boolean; queued: boolean }> {
    const run = this.#runs.get(projectId);
    if (!run) throw new Error("This project has no team");
    if (run.state.status !== "running") throw new Error("The team is not running");
    const from = run.state.roles.find((role) => role.conversationId === fromConversationId);
    if (!from) throw new Error("The sending conversation is not on this team");
    const to = run.state.roles.find((role) => role.config.id === toRoleId);
    if (!to?.conversationId) throw new Error(`No agent called "${toRoleId}". Use list_agents.`);
    if (to === from) throw new Error("That is you.");
    // Two roles replying to each other without anything being written is a fault, not progress.
    if (++run.messagesWithoutWrite > PING_PONG_LIMIT * 2) {
      run.state = {
        ...run.state,
        status: "error",
        diagnostic: {
          code: "ping-pong",
          roleIds: [from.config.id, to.config.id].sort(),
          message: `${from.config.name} and ${to.config.name} kept messaging each other without any file changing, so the team paused. Start it again once the goal or the roles are clearer.`,
        },
      };
      run.pending.clear();
      this.#publish(projectId);
      throw new Error(`The team paused: ${from.config.name} and ${to.config.name} are messaging each other without progress. Stop working.`);
    }
    this.deps.events.publish(projectId, "orchestrator.message", { fromRoleId: from.config.id, toRoleId: to.config.id, text }, { conversationId: to.conversationId });
    const message: OrchestratorPendingMessage = { fromRoleId: from.config.id, fromName: from.config.name, text };
    const queue = () => {
      run.pending.set(to.conversationId!, [...(run.pending.get(to.conversationId!) ?? []), message]);
      return { delivered: true, queued: true };
    };
    if (to.status === "running") return queue();
    // Another writer is still working, so this one waits for its turn with the message.
    if (to.config.capability === "writer" && run.state.roles.some((role) => role !== to && role.config.capability === "writer" && role.status === "running")) return queue();
    await this.#promptRole(run, to, teammatePrompt([message]));
    return { delivered: true, queued: false };
  }

  async completeGoal(projectId: string, conversationId: string, summary: string): Promise<void> {
    const run = this.#runs.get(projectId);
    const role = run?.state.roles.find((item) => item.conversationId === conversationId);
    if (!run || !role) throw new Error("This project has no team");
    if (role.config.capability !== "writer") throw new Error("Only a writer role can end the run");
    if (run.state.status !== "running") throw new Error("The team is not running");
    run.pending.clear();
    // Turns still going end by themselves; nothing new starts once the run is complete.
    run.state = { ...run.state, status: "completed", summary };
    this.#publish(projectId);
  }

  /** Drains what arrived for a role, oldest first. */
  drain(projectId: string, conversationId: string): OrchestratorPendingMessage[] {
    const run = this.#runs.get(projectId);
    const messages = run?.pending.get(conversationId) ?? [];
    run?.pending.delete(conversationId);
    return messages;
  }

  /** Called when a turn closes. The writer carries on unless the run already ended. */
  async turnEnded(project: ProjectState, end: { conversationId: string; status: "completed" | "failed" | "cancelled"; changes: CheckpointChangeItem[] }): Promise<void> {
    const run = this.#runs.get(project.id);
    const role = run?.state.roles.find((item) => item.conversationId === end.conversationId);
    if (!run || !role) return;
    if (role.status !== "idle") {
      role.status = "idle";
      if (run.state.status !== "running") this.#publish(project.id);
    }
    if (run.state.status !== "running") return;
    if (end.changes.length && role.config.capability === "writer") run.messagesWithoutWrite = 0;
    if (role.config.capability !== "writer") {
      // An advisor acts when a teammate addresses it; one that stopped short just goes quiet.
      this.#publish(project.id);
      return;
    }
    if (end.status !== "completed") {
      // The writer's turn failed or someone stopped it, so the team stops rather than retrying blindly.
      run.state = { ...run.state, status: "stopped" };
      this.#publish(project.id);
      return;
    }
    // With several writers, one that teammates wrote to while it had to wait goes next; otherwise this one carries on.
    const next = run.state.roles.find((item) => item !== role && item.config.capability === "writer" && item.conversationId && run.pending.get(item.conversationId)?.length) ?? role;
    const messages = this.drain(project.id, next.conversationId!);
    const text = messages.length ? teammatePrompt(messages) : continuePrompt(run.state.config.goal);
    try {
      await this.#promptRole(run, next, text);
    } catch {
      run.state = { ...run.state, status: "stopped" };
      this.#publish(project.id);
    }
  }

  async close(): Promise<void> {
    for (const projectId of [...this.#runs.keys()]) await this.stop(projectId);
    this.#runs.clear();
  }

  async #promptRole(run: Run, role: OrchestratorRoleState, text: string): Promise<void> {
    role.status = "running";
    try {
      role.lastTurnId = (await this.deps.prompt(run.project, role.conversationId!, text)).turnId;
    } catch (cause) {
      role.status = "idle";
      throw cause;
    }
    this.#publish(run.project.id);
  }

  #publish(projectId: string): OrchestratorState {
    const state = this.#runs.get(projectId)!.state;
    this.deps.events.publish(projectId, "orchestrator.state", { state: structuredClone(state) });
    return state;
  }
}

function idleState(config: OrchestratorConfig, status: "idle" | "stopped"): OrchestratorState {
  return {
    config,
    status,
    roles: config.roles.map((role) => ({
      config: role,
      ...(config.conversations?.[role.id] ? { conversationId: config.conversations[role.id] } : {}),
      status: "idle" as const,
    })),
  };
}

function conversationsOf(state: Pick<OrchestratorState, "roles"> | undefined): Record<string, string> {
  return Object.fromEntries((state?.roles ?? []).flatMap((role) => (role.conversationId ? [[role.config.id, role.conversationId]] : [])));
}

/** The first thing the writer is told. English, because it goes to the model. */
export function openingPrompt(goal: string): string {
  return `You are working as part of a team on this project.\n\nGoal: ${goal}\n\nStart on the goal now. Use send_message_to_agent when a teammate should weigh in, and mark_goal_complete when the goal is met.`;
}

/** What the writer is told when it finished a turn and nobody wrote to it. */
export function continuePrompt(goal: string): string {
  return `Carry on with the goal: ${goal}\n\nCheck what is in the project now, do the next thing it needs, and use mark_goal_complete when it is genuinely done.`;
}

/** Teammate messages, oldest first, as the next prompt. */
export function teammatePrompt(messages: readonly OrchestratorPendingMessage[]): string {
  const lines = messages.map((message) => `- ${message.fromName}: ${message.text}`).join("\n");
  return `Messages from your teammates:\n${lines}\n\nRespond to what they raised, then carry on with the goal.`;
}
