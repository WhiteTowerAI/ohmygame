import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSessionEvent,
  type SessionEntry,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import path from "node:path";
import type { ConversationItem, ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";

export interface CodingSession {
  readonly messages: readonly unknown[];
  prompt(prompt: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setActiveToolsByName?(toolNames: string[]): void;
}

export type SessionFactory = (project: ProjectState) => Promise<CodingSession>;
export type AgentRunResult = "completed" | "cancelled";

export function loadConversation(workspacePath: string, before?: string): ConversationItem[] {
  const sessionDirectory = path.join(path.dirname(workspacePath), "session");
  const entries = SessionManager.continueRecent(workspacePath, sessionDirectory).getBranch();
  return conversationItems(before ? entries.filter((entry) => entry.timestamp < before) : entries);
}

export function conversationItems(entries: readonly SessionEntry[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const tools = new Map<string, Extract<ConversationItem, { kind: "tool" }>>();
  let assistant: Extract<ConversationItem, { kind: "assistant" }> | undefined;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      assistant = undefined;
      const text = textContent(message.content);
      if (text) items.push({ id: entry.id, kind: "user", text });
      continue;
    }
    if (message.role === "assistant") {
      if (!assistant) {
        assistant = { id: entry.id, kind: "assistant", text: "", status: "complete" };
        items.push(assistant);
      }
      assistant.text += textContent(message.content);
      if (message.stopReason === "error") {
        assistant.status = "error";
        assistant.error = message.errorMessage || "The model request failed";
      } else if (message.stopReason === "aborted") {
        assistant.status = "cancelled";
      }
      for (const content of message.content) {
        if (content.type !== "toolCall") continue;
        const tool: Extract<ConversationItem, { kind: "tool" }> = {
          id: entry.id + ":" + content.id,
          kind: "tool",
          toolCallId: content.id,
          toolName: content.name,
          status: "error",
        };
        tools.set(content.id, tool);
        items.push(tool);
      }
      continue;
    }
    if (message.role === "toolResult") {
      const tool = tools.get(message.toolCallId);
      if (tool) tool.status = message.isError ? "error" : "complete";
    }
  }

  return items.filter((item) => item.kind !== "assistant" || item.text || item.status !== "complete");
}

interface AgentManagerOptions {
  createSession?: SessionFactory;
  activeToolNames?: () => string[];
}

interface ManagedSession {
  session: CodingSession;
  unsubscribe: () => void;
}

export class AgentManager {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #activeProjects = new Map<string, ProjectState>();
  readonly #runs = new Set<Promise<AgentRunResult>>();
  #closing = false;

  constructor(
    private readonly events: RuntimeEventBus,
    private readonly options: AgentManagerOptions = {},
  ) {}

  prompt(project: ProjectState, prompt: string): Promise<AgentRunResult> {
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

  async #runPrompt(project: ProjectState, prompt: string): Promise<AgentRunResult> {
    try {
      const managed = await this.#getSession(project);
      if (isCancelling(project)) {
        this.#markCancelled(project);
        return "cancelled";
      }

      managed.session.setActiveToolsByName?.(this.options.activeToolNames?.() ?? BASE_TOOL_NAMES);
      await managed.session.prompt(prompt);
      if (isCancelling(project)) {
        this.#markCancelled(project);
        return "cancelled";
      }

      const sessionError = lastAssistantError(managed.session.messages);
      if (sessionError) {
        throw new Error(sessionError);
      }

      project.agent = { status: "idle" };
      this.events.publish(project.id, "agent.completed", {});
      return "completed";
    } catch (cause) {
      if (isCancelling(project)) {
        this.#markCancelled(project);
        return "cancelled";
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

  #finishRun(projectId: string, run: Promise<AgentRunResult>): void {
    this.#runs.delete(run);
    this.#activeProjects.delete(projectId);
  }

  async #getSession(project: ProjectState): Promise<ManagedSession> {
    const existing = this.#sessions.get(project.id);
    if (existing) return existing;

    const session = await (this.options.createSession ?? ((state) => createPiSession(state.workspacePath)))(project);
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

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(
      item && typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
    ))
    .map((item) => item.text)
    .join("");
}

const BASE_TOOL_NAMES = ["read", "write", "edit", "bash"];

export async function createPiSession(
  workspacePath: string,
  customTools: ToolDefinition[] = [],
): Promise<CodingSession> {
  // Trusted-local phase: cwd guides Pi but is not an OS security boundary.
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir: getAgentDir(),
    appendSystemPrompt: [
      "This workspace may be empty. Do not create files for casual conversation or questions that do not require code. " +
      "When the user asks you to build a game or web app in this workspace, create it as a complete Vite-based browser project whose package.json has non-empty scripts.dev and scripts.build commands, with the build producing a static dist/index.html. " +
      "Do not leave a long-running development server active; the host starts the preview after your turn.",
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: workspacePath,
    customTools,
    resourceLoader,
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
