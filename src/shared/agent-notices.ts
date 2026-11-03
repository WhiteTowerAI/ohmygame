/**
 * What the agent needs the user to hear about while they are not looking: a
 * request to approve, a question, a plan to review, a finished turn, or a
 * failed one. The daemon records them; the desktop app shows them as system
 * notifications. A notice never carries prompt or reply text.
 */
export type AgentNoticeKind = "approval" | "question" | "plan" | "completed" | "failed";

/** The kinds that wait for the user until they act on them. */
export type AgentWaitingKind = Extract<AgentNoticeKind, "approval" | "question" | "plan">;

export interface AgentNotice {
  /** Increases within one daemon process; see `AgentNoticesResponse.epoch`. */
  seq: number;
  kind: AgentNoticeKind;
  projectId: string;
  /** The project's name when the notice was recorded; `null` when the project is gone. */
  projectName: string | null;
  conversationId: string;
  /** Identifies what a waiting notice is about, so it can be withdrawn once answered. */
  waitingId?: string;
  at: number;
}

/** Something the user still has to act on. */
export interface AgentWaiting {
  id: string;
  kind: AgentWaitingKind;
  projectId: string;
  conversationId: string;
}

export interface AgentNoticesResponse {
  /**
   * Changes every time the daemon starts. A reader that sees a new epoch
   * resumes from `latestSeq` without showing anything, so a restart never
   * replays old notices.
   */
  epoch: string;
  /** Highest `seq` recorded so far; 0 when there is none. */
  latestSeq: number;
  /** Notices after the requested `after`, oldest first. */
  notices: AgentNotice[];
  /** Everything still waiting for the user, oldest first. */
  waiting: AgentWaiting[];
}
