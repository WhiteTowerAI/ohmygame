import path from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { AgentModelRef, ConversationSummary, ProjectState } from "../shared/contracts.js";

const UNTITLED_CONVERSATION = "New conversation";
const TITLE_MAX_LENGTH = 80;

export interface StoredConversation {
  summary: ConversationSummary;
  sessionPath: string;
}

export class ConversationManager {
  readonly #pending = new Map<string, { stored: StoredConversation; manager: SessionManager; titled: boolean }>();

  async list(project: ProjectState): Promise<ConversationSummary[]> {
    const persisted = (await this.#sessions(project)).map((session) => summary(project.id, session));
    const persistedIds = new Set(persisted.map((conversation) => conversation.id));
    for (const conversationId of persistedIds) this.#pending.delete(key(project.id, conversationId));
    const pending = [...this.#pending.values()]
      .map(({ stored }) => stored.summary)
      .filter((conversation) => conversation.projectId === project.id && !persistedIds.has(conversation.id));
    return [...persisted, ...pending].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(project: ProjectState, model?: AgentModelRef): Promise<StoredConversation> {
    const manager = SessionManager.create(project.workspacePath, sessionDirectory(project));
    if (model) manager.appendModelChange(model.provider, model.id);
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) throw new Error("Pi did not create a persistent session");
    const stored = {
      sessionPath,
      summary: {
        id: manager.getSessionId(),
        projectId: project.id,
        title: UNTITLED_CONVERSATION,
        createdAt: manager.getHeader()?.timestamp ?? new Date().toISOString(),
        updatedAt: manager.getHeader()?.timestamp ?? new Date().toISOString(),
        messageCount: 0,
      },
    };
    this.#pending.set(key(project.id, stored.summary.id), { stored, manager, titled: false });
    return stored;
  }

  async get(project: ProjectState, conversationId: string): Promise<StoredConversation | undefined> {
    const session = (await this.#sessions(project)).find((candidate) => candidate.id === conversationId);
    if (session) {
      this.#pending.delete(key(project.id, conversationId));
      return { summary: summary(project.id, session), sessionPath: session.path };
    }
    return this.#pending.get(key(project.id, conversationId))?.stored;
  }

  async rename(project: ProjectState, conversationId: string, title: string): Promise<ConversationSummary | undefined> {
    const stored = await this.get(project, conversationId);
    if (!stored) return undefined;
    const normalized = normalizeTitle(title);
    if (!normalized) throw new Error("Conversation title must not be empty");
    const pending = this.#pending.get(key(project.id, conversationId));
    const manager = pending?.manager ?? SessionManager.open(stored.sessionPath, sessionDirectory(project), project.workspacePath);
    manager.appendSessionInfo(normalized);
    if (pending) {
      pending.titled = true;
      pending.stored = {
        ...pending.stored,
        summary: { ...pending.stored.summary, title: normalized, updatedAt: new Date().toISOString() },
      };
      return pending.stored.summary;
    }
    return (await this.get(project, conversationId))?.summary;
  }

  setInitialTitle(projectId: string, conversationId: string, prompt: string): void {
    const pending = this.#pending.get(key(projectId, conversationId));
    if (!pending || pending.titled) return;
    pending.titled = true;
    pending.stored = {
      ...pending.stored,
      summary: {
        ...pending.stored.summary,
        title: defaultConversationTitle(prompt),
        updatedAt: new Date().toISOString(),
      },
    };
  }

  open(project: ProjectState, stored: StoredConversation): SessionManager {
    const pending = this.#pending.get(key(project.id, stored.summary.id));
    if (pending) return pending.manager;
    return SessionManager.open(stored.sessionPath, sessionDirectory(project), project.workspacePath);
  }

  model(project: ProjectState, stored: StoredConversation): AgentModelRef | undefined {
    const model = this.open(project, stored).buildSessionContext().model;
    return model ? { provider: model.provider, id: model.modelId } : undefined;
  }

  setModel(project: ProjectState, stored: StoredConversation, model: AgentModelRef): void {
    this.open(project, stored).appendModelChange(model.provider, model.id);
  }

  async #sessions(project: ProjectState): Promise<SessionInfo[]> {
    return SessionManager.list(project.workspacePath, sessionDirectory(project));
  }
}

function key(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`;
}

export function defaultConversationTitle(firstMessage: string): string {
  const normalized = normalizeTitle(firstMessage);
  return normalized && normalized !== "(no messages)" ? normalized : UNTITLED_CONVERSATION;
}

function summary(projectId: string, session: SessionInfo): ConversationSummary {
  return {
    id: session.id,
    projectId,
    title: session.name?.trim() || defaultConversationTitle(session.firstMessage),
    createdAt: session.created.toISOString(),
    updatedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
  };
}

function sessionDirectory(project: ProjectState): string {
  return path.join(path.dirname(project.workspacePath), "session");
}

function normalizeTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim();
  if (title.length <= TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}
