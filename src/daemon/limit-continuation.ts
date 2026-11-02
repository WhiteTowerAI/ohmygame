import type { AgentUsageLimit, LimitResume } from "../shared/contracts.js";
import { limitResumeAt } from "../shared/limit-resume.js";

/** How often a continue that is due looks again while another conversation holds the project. */
const PROJECT_BUSY_RETRY_MS = 30_000;

export interface LimitContinuationSnapshot {
  /** The coding agent and account the limits belong to. */
  account: string;
  limits?: readonly AgentUsageLimit[];
  enabled: boolean;
  projectBusy: boolean;
  send(): void;
}

/** Undefined once the conversation can't take a message: it is gone, off the coding agents, or its project isn't ready. */
type LimitContinuationLookup = (projectId: string, conversationId: string) => Promise<LimitContinuationSnapshot | undefined>;

interface Scheduled {
  projectId: string;
  conversationId: string;
  failedAt: number;
  account?: string;
  at?: number;
  skipped: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Continues conversations that stopped at a usage limit, once it resets. The
 * schedule lives in memory, so it runs while OhMyGame is open, whichever
 * conversation is showing, and ends when OhMyGame quits. Anything else that
 * happens to the conversation ends it through `changed`.
 */
export class LimitContinuations {
  readonly #scheduled = new Map<string, Scheduled>();

  constructor(private readonly lookup: LimitContinuationLookup) {}

  changed(projectId: string, conversationId: string, limitReached: boolean): void {
    this.#remove(key(projectId, conversationId));
    if (!limitReached) return;
    const scheduled: Scheduled = { projectId, conversationId, failedAt: Date.now(), skipped: false };
    this.#scheduled.set(key(projectId, conversationId), scheduled);
    this.#settleInBackground(scheduled);
  }

  /** A limit report can come after the failure it explains. */
  limitsReported(): void {
    for (const scheduled of this.#scheduled.values()) {
      if (scheduled.at === undefined) this.#settleInBackground(scheduled);
    }
  }

  /** What the composer shows. */
  async status(projectId: string, conversationId: string): Promise<LimitResume | undefined> {
    const scheduled = this.#scheduled.get(key(projectId, conversationId));
    const snapshot = scheduled && await this.#settle(scheduled);
    if (!snapshot || scheduled?.at === undefined) return undefined;
    return { at: scheduled.at, state: !snapshot.enabled ? "off" : scheduled.skipped ? "skipped" : "armed" };
  }

  /** The person began writing a message, so what to say next is theirs. */
  skip(projectId: string, conversationId: string): void {
    const scheduled = this.#scheduled.get(key(projectId, conversationId));
    if (scheduled) scheduled.skipped = true;
  }

  close(): void {
    for (const id of [...this.#scheduled.keys()]) this.#remove(id);
  }

  /** Works out when it is due. Undefined when it was replaced or has ended meanwhile. */
  async #settle(scheduled: Scheduled): Promise<LimitContinuationSnapshot | undefined> {
    const snapshot = await this.lookup(scheduled.projectId, scheduled.conversationId);
    if (!this.#applies(scheduled, snapshot)) return undefined;
    scheduled.account = snapshot.account;
    scheduled.at ??= limitResumeAt(snapshot.limits, scheduled.failedAt);
    if (scheduled.at !== undefined) scheduled.timer ??= this.#start(scheduled, scheduled.at - Date.now());
    return snapshot;
  }

  #settleInBackground(scheduled: Scheduled): void {
    void this.#settle(scheduled).catch((cause) => console.warn("Could not schedule the continue after a usage limit", cause));
  }

  /** Asked straight after each lookup, with nothing awaited in between. Ends a schedule that no longer applies. */
  #applies(scheduled: Scheduled, snapshot: LimitContinuationSnapshot | undefined): snapshot is LimitContinuationSnapshot {
    const id = key(scheduled.projectId, scheduled.conversationId);
    if (this.#scheduled.get(id) !== scheduled) return false;
    if (snapshot && (scheduled.account ?? snapshot.account) === snapshot.account) return true;
    this.#remove(id);
    return false;
  }

  #start(scheduled: Scheduled, delay: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.#due(scheduled).catch((cause) => console.warn("Could not continue after a usage limit", cause));
    }, delay);
  }

  async #due(scheduled: Scheduled): Promise<void> {
    const snapshot = await this.lookup(scheduled.projectId, scheduled.conversationId);
    if (!this.#applies(scheduled, snapshot)) return;
    if (snapshot.enabled && !scheduled.skipped && snapshot.projectBusy) {
      scheduled.timer = this.#start(scheduled, PROJECT_BUSY_RETRY_MS);
      return;
    }
    this.#remove(key(scheduled.projectId, scheduled.conversationId));
    // Nothing is awaited since the lookup, so no message of the person's can have started in between.
    if (snapshot.enabled && !scheduled.skipped) snapshot.send();
  }

  #remove(id: string): void {
    clearTimeout(this.#scheduled.get(id)?.timer);
    this.#scheduled.delete(id);
  }
}

function key(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`;
}
