import { createAgentSession, SessionManager, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import { SnapshotManager } from "./snapshots.js";

export interface CodingSession {
  readonly messages: readonly unknown[];
  prompt(prompt: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export type SessionFactory = (workspacePath: string) => Promise<CodingSession>;

interface AgentManagerOptions {
  createSession?: SessionFactory;
  snapshots?: SnapshotManager;
}

interface ManagedSession {
  session: CodingSession;
  unsubscribe: () => void;
}

export class AgentManager {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #activeProjects = new Map<string, ProjectState>();
  readonly #runs = new Set<Promise<void>>();
  #closing = false;

  constructor(
    private readonly events: RuntimeEventBus,
    private readonly options: AgentManagerOptions = {},
  ) {}

  prompt(project: ProjectState, prompt: string): Promise<void> {
    if (!prompt.trim()) return Promise.reject(new Error("Prompt must not be empty"));
    if (this.#closing) return Promise.reject(new Error("Agent manager is closing"));
    if (project.agent.status !== "idle" && project.agent.status !== "error") {
      return Promise.reject(new Error("Agent is already running"));
    }

    project.agent = { status: "running" };
    this.#activeProjects.set(project.id, project);
    this.events.publish(project.id, "agent.started", { prompt });
    const run = this.#runPrompt(project, prompt);
    this.#runs.add(run);
    void run.then(
      () => this.#finishRun(project.id, run),
      () => this.#finishRun(project.id, run),
    );
    return run;
  }

  async #runPrompt(project: ProjectState, prompt: string): Promise<void> {
    let captured = false;
    try {
      await this.options.snapshots?.capture(project);
      captured = true;
      const managed = await this.#getSession(project);
      if (isCancelling(project)) {
        await this.options.snapshots?.finalize(project);
        captured = false;
        this.#markCancelled(project);
        return;
      }

      await managed.session.prompt(prompt);
      if (isCancelling(project)) {
        await this.options.snapshots?.finalize(project);
        captured = false;
        this.#markCancelled(project);
        return;
      }

      const sessionError = lastAssistantError(managed.session.messages);
      if (sessionError) {
        await this.options.snapshots?.finalize(project);
        captured = false;
        this.#markError(project, sessionError);
        return;
      }

      await this.options.snapshots?.finalize(project);
      captured = false;
      project.agent = { status: "idle" };
      this.events.publish(project.id, "agent.completed", {});
    } catch (cause) {
      if (captured) await this.options.snapshots?.finalize(project).catch(() => {});
      if (isCancelling(project)) {
        this.#markCancelled(project);
        return;
      }
      const error = cause instanceof Error ? cause.message : String(cause);
      this.#markError(project, error);
      throw cause;
    }
  }

  async cancel(project: ProjectState): Promise<void> {
    if (project.agent.status !== "running") return;
    project.agent = { status: "cancelling" };
    await this.#sessions.get(project.id)?.session.abort();
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const project of this.#activeProjects.values()) {
      if (project.agent.status === "running") project.agent = { status: "cancelling" };
    }
    const sessions = [...this.#sessions.values()];
    await Promise.allSettled(sessions.map(({ session }) => session.abort()));
    await Promise.allSettled([...this.#runs]);
    for (const managed of sessions) {
      managed.unsubscribe();
      managed.session.dispose();
    }
    this.#sessions.clear();
  }

  #finishRun(projectId: string, run: Promise<void>): void {
    this.#runs.delete(run);
    this.#activeProjects.delete(projectId);
  }

  async #getSession(project: ProjectState): Promise<ManagedSession> {
    const existing = this.#sessions.get(project.id);
    if (existing) return existing;

    const session = await (this.options.createSession ?? createPiSession)(project.workspacePath);
    if (this.#closing) {
      session.dispose();
      throw new Error("Agent manager is closing");
    }
    const unsubscribe = session.subscribe((event) => this.#forwardEvent(project.id, event));
    const managed = { session, unsubscribe };
    this.#sessions.set(project.id, managed);
    return managed;
  }

  #forwardEvent(projectId: string, event: AgentSessionEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.events.publish(projectId, "assistant.delta", { delta: event.assistantMessageEvent.delta });
    } else if (event.type === "auto_retry_start") {
      this.events.publish(projectId, "agent.retrying", {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        error: event.errorMessage,
      });
    } else if (event.type === "tool_execution_start") {
      this.events.publish(projectId, "tool.started", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    } else if (event.type === "tool_execution_end") {
      this.events.publish(projectId, "tool.completed", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      });
    }
  }

  #markCancelled(project: ProjectState): void {
    project.agent = { status: "idle" };
    this.events.publish(project.id, "agent.cancelled", {});
  }

  #markError(project: ProjectState, error: string): void {
    project.agent = { status: "error", error };
    this.events.publish(project.id, "agent.error", { error });
  }
}

function isCancelling(project: ProjectState): boolean {
  return project.agent.status === "cancelling";
}

async function createPiSession(workspacePath: string): Promise<CodingSession> {
  // Trusted-local phase: cwd guides Pi but is not an OS security boundary.
  const { session } = await createAgentSession({
    cwd: workspacePath,
    tools: ["read", "write", "edit", "bash"],
    sessionManager: SessionManager.continueRecent(workspacePath, path.join(path.dirname(workspacePath), "session")),
  });
  return session;
}

export function lastAssistantError(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    if (candidate.role !== "assistant") continue;
    if (candidate.stopReason === "error") {
      return typeof candidate.errorMessage === "string" && candidate.errorMessage
        ? candidate.errorMessage
        : "The model request failed";
    }
    return undefined;
  }
  return undefined;
}
