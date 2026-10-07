import type { GameRuntimeAdapter, PlaytestRequest, PlaytestResult } from "../shared/playtest.js";

/** Restricts an agent's tools and cleanup to windows it opened. */
export class OwnedPlaytestDriver implements GameRuntimeAdapter {
  readonly #sessions = new Set<string>();
  readonly #pending = new Set<Promise<PlaytestResult>>();

  constructor(private readonly driver: GameRuntimeAdapter) {}

  get available() { return this.driver.available; }
  get capabilities() { return this.driver.capabilities; }

  async request(request: PlaytestRequest, signal?: AbortSignal): Promise<PlaytestResult> {
    if (request.operation === "closeAll") {
      await this.cleanup();
      return { operation: "closeAll" };
    }
    if (request.operation !== "open" && !this.#sessions.has(request.sessionId)) {
      throw new Error("Game session does not belong to this conversation");
    }
    const pending = this.driver.request(request, signal);
    this.#pending.add(pending);
    try {
      const result = await pending;
      if (result.operation === "open") this.#sessions.add(result.snapshot.sessionId);
      if (request.operation === "close") this.#sessions.delete(request.sessionId);
      return result;
    } finally {
      this.#pending.delete(pending);
    }
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(this.#pending);
    await Promise.allSettled([...this.#sessions].map(async (sessionId) => {
      await this.driver.request({ operation: "close", sessionId });
      this.#sessions.delete(sessionId);
    }));
  }

  close(): void { void this.cleanup(); }
}
