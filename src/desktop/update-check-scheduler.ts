import type { DesktopUpdateCheckOutcome } from "./updater.js";

export interface ScheduledUpdateCheck {
  check(automatic?: boolean): Promise<DesktopUpdateCheckOutcome>;
}

/** An app left open still learns about a release published hours later. */
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60_000;
/** Focus re-checks at most this often, so alt-tabbing does not hit the feed. */
const FOCUS_CHECK_INTERVAL_MS = 30 * 60_000;
/** A failed check gets these bounded retries, then waits for focus or the period. */
const CHECK_RETRY_DELAYS_MS = [60_000, 5 * 60_000];

export class DesktopUpdateCheckScheduler {
  #running = false;
  #stopped = false;
  #lastCheckAt = 0;
  #retryIndex = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly target: ScheduledUpdateCheck,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.#lastCheckAt = this.now();
    this.#schedule(0);
  }

  onFocus(): void {
    if (this.#running || this.#stopped) return;
    if (this.now() - this.#lastCheckAt < FOCUS_CHECK_INTERVAL_MS) return;
    void this.#run();
  }

  /** A manual check also resets the focus throttle and the retry ladder. */
  async manual(): Promise<DesktopUpdateCheckOutcome> {
    this.#lastCheckAt = this.now();
    const outcome = await this.target.check();
    this.#arm(outcome);
    return outcome;
  }

  stop(): void {
    this.#stopped = true;
    this.#cancel();
  }

  async #run(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    this.#lastCheckAt = this.now();
    let outcome: DesktopUpdateCheckOutcome = "checked";
    try {
      outcome = await this.target.check(true);
    } catch {
      outcome = "failed";
    } finally {
      this.#running = false;
    }
    this.#arm(outcome);
  }

  #arm(outcome: DesktopUpdateCheckOutcome): void {
    if (this.#stopped) return;
    if (outcome !== "failed") {
      this.#retryIndex = 0;
      this.#schedule(PERIODIC_CHECK_INTERVAL_MS);
      return;
    }
    this.#schedule(
      CHECK_RETRY_DELAYS_MS[this.#retryIndex] ?? PERIODIC_CHECK_INTERVAL_MS,
    );
    this.#retryIndex += 1;
  }

  #schedule(delayMs: number): void {
    this.#cancel();
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#run();
    }, delayMs);
  }

  #cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
