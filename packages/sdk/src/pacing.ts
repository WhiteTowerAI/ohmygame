/**
 * Timing what a page sends at most once a tick (a realtime input, an owner room's player
 * state) so it reaches the service just before the service's tick reads it. Sent at a random
 * moment, it waits up to a whole tick on the service, and what it carries is that much older
 * when the tick runs; sent just in time, it waits a few milliseconds. The page learns where
 * the tick falls from when the service's tick messages arrive, and the round trip from pings.
 * Until it knows both, it sends once a tick from its own first send, as it always did.
 */

/** The window of tick arrivals the phase is taken from. */
const ARRIVAL_WINDOW_MS = 2000;
/** Round trips kept, of which the middle one counts. */
const TRIP_SAMPLES = 5;
/** How often a page that paces its sends measures the round trip. */
export const PING_INTERVAL_MS = 2000;

const clock = () => (typeof performance === "undefined" ? Date.now() : performance.now());

/** Where the service's tick falls on this page's clock, and how long a trip to it takes. */
export class TickClock {
  private arrivals: number[] = [];
  private trips: number[] = [];

  constructor(private readonly tickMs: () => number) {}

  /** A message the service sends on its tick arrived at `at`. */
  arrived(at: number = clock()): void {
    this.arrivals.push(at);
    while (this.arrivals.length > 1 && this.arrivals[0]! < at - ARRIVAL_WINDOW_MS) this.arrivals.shift();
  }

  /** The service answered a ping this page sent at `sentAt`. */
  pong(sentAt: unknown, now: number = clock()): void {
    if (typeof sentAt !== "number" || !Number.isFinite(sentAt) || sentAt > now) return;
    this.trips.push(now - sentAt);
    if (this.trips.length > TRIP_SAMPLES) this.trips.shift();
  }

  get roundTrip(): number | undefined {
    if (!this.trips.length) return undefined;
    return [...this.trips].sort((a, b) => a - b)[Math.floor(this.trips.length / 2)];
  }

  /**
   * The first moment at or after `earliest` to send, so the message reaches the service a
   * little before one of its ticks; undefined while the tick or the round trip is unknown.
   */
  nextSend(earliest: number): number | undefined {
    const trip = this.roundTrip;
    const tick = this.tickMs();
    if (trip === undefined || this.arrivals.length < 3) return undefined;
    // The circular mean of arrival times on the tick's cycle: robust to the odd message that
    // is not a tick, and to the wrap-around a plain average of times modulo the tick gets wrong.
    let sin = 0;
    let cos = 0;
    for (const at of this.arrivals) {
      const angle = (2 * Math.PI * at) / tick;
      sin += Math.sin(angle);
      cos += Math.cos(angle);
    }
    if (Math.hypot(sin, cos) < 0.5 * this.arrivals.length) return undefined; // too scattered to tell
    const arrival = ((Math.atan2(sin, cos) / (2 * Math.PI)) * tick + tick) % tick;
    // A tick message arrives half a trip after its tick; a send reaches the service half a
    // trip after it leaves. So send a whole trip before the arrival, and a margin earlier.
    const margin = Math.min(20, Math.max(8, tick * 0.15));
    const slot = arrival - trip - margin;
    return slot + Math.ceil((earliest - slot) / tick) * tick;
  }

  reset(): void {
    this.arrivals = [];
  }
}

/**
 * Sends something at most twice a tick and keeps sending it once a tick while there is more:
 * at once when the last send was at least half a tick ago, then at the tick clock's moments.
 */
export class TickPacer {
  private timer?: ReturnType<typeof setTimeout>;
  private lastSent = -Infinity;

  /** `flush` sends what is waiting and says whether there was anything. */
  constructor(
    private readonly tickClock: TickClock,
    private readonly tickMs: () => number,
    private readonly flush: () => boolean,
  ) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** There is something to send: send it now if the pace allows, and keep going. */
  wake(): void {
    if (this.timer) return;
    if (clock() - this.lastSent >= this.tickMs() / 2) this.fire();
    else this.schedule();
  }

  /**
   * Sends now even while running, unless the last send was under half a tick ago: for a
   * change that should not wait for the next tick's send. Says whether it sent.
   */
  hurry(): boolean {
    if (clock() - this.lastSent < this.tickMs() / 2) return false;
    clearTimeout(this.timer);
    this.fire();
    return true;
  }

  /** Something went out by another way, such as a resync, and counts toward the pace. */
  sent(): void {
    this.lastSent = clock();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fire(): void {
    this.timer = undefined;
    if (!this.flush()) return;
    this.lastSent = clock();
    this.schedule();
  }

  private schedule(): void {
    const tick = this.tickMs();
    const at = this.tickClock.nextSend(this.lastSent + tick / 2) ?? this.lastSent + tick;
    this.timer = setTimeout(() => this.fire(), Math.max(0, at - clock()));
  }
}
