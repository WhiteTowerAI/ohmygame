import { randomUUID } from "node:crypto";
import type { AgentNotice, AgentNoticeKind, AgentNoticesResponse, AgentWaiting } from "../shared/agent-notices.js";
import type { RuntimeEvent, ThreadItem } from "../shared/contracts.js";

/**
 * How long a planning turn's end waits for the plan to be offered for review.
 * The plan state follows the turn's closing snapshot, which can take up to 30
 * seconds; after that the turn is announced as an ordinary finished turn.
 */
const PLAN_REVIEW_WAIT_MS = 45_000;

/**
 * Notices for the desktop app: what the agent needs the user to hear about
 * wherever they are. It reads runtime events from every project and keeps a
 * small log in memory, so a restart never replays notices from before it.
 * Stopped turns produce none.
 */
export class AgentNoticeLog {
  readonly #epoch = randomUUID();
  readonly #notices: AgentNotice[] = [];
  readonly #waiting = new Map<string, AgentWaiting>();
  /** Each conversation's plan mode, to know whether a finished turn leaves a plan to review. */
  readonly #planModes = new Map<string, string>();
  readonly #planTurnEnds = new Map<string, ReturnType<typeof setTimeout>>();
  #latestSeq = 0;

  constructor(
    private readonly projectName: (projectId: string) => string | null,
    private readonly options: { capacity?: number; planReviewWaitMs?: number; now?: () => number } = {},
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
      epoch: this.#epoch,
      latestSeq: this.#latestSeq,
      notices: this.#notices.filter((notice) => notice.seq > after),
      waiting: [...this.#waiting.values()],
    };
  }

  close(): void {
    for (const timer of this.#planTurnEnds.values()) clearTimeout(timer);
    this.#planTurnEnds.clear();
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
      case "plan.mode.changed": {
        this.#planModes.set(key, event.data.mode);
        const id = `plan:${key}`;
        if (event.data.mode !== "awaiting_approval") {
          this.#waiting.delete(id);
          if (this.#planTurnEnds.has(key)) this.#endTurn(event.projectId, conversationId, "completed");
          return;
        }
        this.#waiting.set(id, { id, kind: "plan", projectId: event.projectId, conversationId });
        // Only a planning turn that just ended announces its plan; a plan restored with its conversation does not.
        if (this.#planTurnEnds.has(key)) this.#endTurn(event.projectId, conversationId, "plan", id);
        return;
      }
      case "agent.started":
        this.#cancelTurnEnd(key);
        return;
      case "agent.completed":
        this.#clearRequests(key);
        if (this.#planModes.get(key) === "planning") {
          this.#cancelTurnEnd(key);
          const timer = setTimeout(() => this.#endTurn(event.projectId, conversationId, "completed"), this.options.planReviewWaitMs ?? PLAN_REVIEW_WAIT_MS);
          timer.unref?.();
          this.#planTurnEnds.set(key, timer);
          return;
        }
        this.#add("completed", event.projectId, conversationId);
        return;
      case "agent.error":
        this.#clearRequests(key);
        this.#cancelTurnEnd(key);
        this.#add("failed", event.projectId, conversationId);
        return;
      case "agent.cancelled":
        this.#clearRequests(key);
        this.#cancelTurnEnd(key);
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
    this.#add(kind, projectId, conversationId, id);
  }

  #endTurn(projectId: string, conversationId: string, kind: AgentNoticeKind, waitingId?: string): void {
    this.#cancelTurnEnd(conversationKey(projectId, conversationId));
    this.#add(kind, projectId, conversationId, waitingId);
  }

  #cancelTurnEnd(key: string): void {
    const timer = this.#planTurnEnds.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#planTurnEnds.delete(key);
  }

  /** A turn that ended no longer waits on its approvals or questions. */
  #clearRequests(key: string): void {
    for (const [id, waiting] of this.#waiting) {
      if (waiting.kind !== "plan" && conversationKey(waiting.projectId, waiting.conversationId) === key) this.#waiting.delete(id);
    }
  }

  #add(kind: AgentNoticeKind, projectId: string, conversationId: string, waitingId?: string): void {
    this.#notices.push({
      seq: ++this.#latestSeq,
      kind,
      projectId,
      projectName: this.projectName(projectId),
      conversationId,
      ...(waitingId ? { waitingId } : {}),
      at: (this.options.now ?? Date.now)(),
    });
    const capacity = this.options.capacity ?? 200;
    if (this.#notices.length > capacity) this.#notices.splice(0, this.#notices.length - capacity);
  }
}

function conversationKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`;
}
