import { randomUUID } from "node:crypto";
import type { AgentNotice, AgentNoticeKind, AgentNoticesResponse, AgentWaiting } from "../shared/agent-notices.js";
import type { RuntimeEvent, ThreadItem } from "../shared/contracts.js";

/**
 * Notices for the desktop app: what the agent needs the user to hear about
 * wherever they are. It reads runtime events from every project and keeps a
 * small log in memory, so a restart never replays notices from before it.
 * Stopped turns produce none.
 */
export class AgentNoticeLog {
  readonly epoch = randomUUID();
  readonly #notices: AgentNotice[] = [];
  readonly #waiting = new Map<string, AgentWaiting>();
  #latestSeq = 0;

  constructor(
    private readonly projectName: (projectId: string) => string | null,
    private readonly options: { capacity?: number; now?: () => number } = {},
  ) {}

  /** Runs inside event publishing, so a failure here must never reach the agent that published. */
  event(event: RuntimeEvent): void {
    try {
      this.#record(event);
    } catch {
      // A notice is lost; the turn goes on.
    }
  }

  read(after: number): AgentNoticesResponse {
    return {
      epoch: this.epoch,
      latestSeq: this.#latestSeq,
      notices: this.#notices.filter((notice) => notice.seq > after),
      waiting: [...this.#waiting.values()],
    };
  }

  #record(event: RuntimeEvent): void {
    const conversationId = event.conversationId;
    if (!conversationId) return;
    const key = conversationKey(event.projectId, conversationId);
    switch (event.type) {
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.#item(event.projectId, conversationId, event.data.item);
        return;
      case "agent.completed":
        this.#clearRequests(key);
        this.#add("completed", event.projectId, conversationId, { resultEventId: event.id });
        return;
      case "agent.error":
        this.#clearRequests(key);
        this.#add("failed", event.projectId, conversationId, { resultEventId: event.id });
        return;
      case "agent.cancelled":
        this.#clearRequests(key);
        return;
      default:
        return;
    }
  }

  #item(projectId: string, conversationId: string, item: ThreadItem): void {
    if (item.type !== "approvalRequest" && item.type !== "userInputRequest") return;
    const id = `${conversationKey(projectId, conversationId)}:${item.id}`;
    if (item.status !== "inProgress") {
      this.#waiting.delete(id);
      return;
    }
    if (this.#waiting.has(id)) return;
    // Claude Code asks its questions through a tool that waits for approval.
    const kind = item.type === "approvalRequest" && item.request.tool !== "AskUserQuestion" ? "approval" : "question";
    this.#waiting.set(id, { id, kind, projectId, conversationId });
    this.#add(kind, projectId, conversationId, { waitingId: id });
  }

  /** A turn that ended no longer waits on its approvals or questions. */
  #clearRequests(key: string): void {
    for (const [id, waiting] of this.#waiting) {
      if (conversationKey(waiting.projectId, waiting.conversationId) === key) this.#waiting.delete(id);
    }
  }

  #add(kind: AgentNoticeKind, projectId: string, conversationId: string, detail: Pick<AgentNotice, "waitingId" | "resultEventId"> = {}): void {
    this.#notices.push({
      seq: ++this.#latestSeq,
      kind,
      projectId,
      projectName: this.projectName(projectId),
      conversationId,
      ...detail,
      at: (this.options.now ?? Date.now)(),
    });
    const capacity = this.options.capacity ?? 200;
    if (this.#notices.length > capacity) this.#notices.splice(0, this.#notices.length - capacity);
  }
}

function conversationKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`;
}
