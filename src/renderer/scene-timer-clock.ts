export class SceneTimerClock {
  #durationMs: number;
  #elapsedMs: number;
  #startedAt?: number;

  constructor(initialTimeMs: number, durationMs: number) {
    this.#durationMs = durationMs;
    this.#elapsedMs = Math.min(initialTimeMs, durationMs);
  }

  setDuration(durationMs: number): void {
    this.#durationMs = durationMs;
    this.#elapsedMs = Math.min(this.#elapsedMs, durationMs);
  }

  resume(now: number): void {
    this.#startedAt ??= now;
  }

  pause(now: number): void {
    this.#elapsedMs = this.elapsed(now);
    this.#startedAt = undefined;
  }

  elapsed(now: number): number {
    const runningMs = this.#startedAt === undefined ? 0 : Math.max(0, now - this.#startedAt);
    return Math.min(this.#durationMs, this.#elapsedMs + runningMs);
  }

  remaining(now: number): number {
    return Math.max(0, this.#durationMs - this.elapsed(now));
  }
}
