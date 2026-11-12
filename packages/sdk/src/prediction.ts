/**
 * Predicting this page's own player in a realtime room whose rules the service runs. The
 * page passes the same rules, steps them with each input it sends, and shows the result at
 * once instead of a round trip later. Each tick's snapshot says, per seat, the newest input
 * that tick read (acks); the page starts again from that snapshot and replays the inputs
 * the service has not read yet. Where the service read inputs differently, such as two
 * arriving in one tick, the next snapshot corrects the guess.
 */
import type { MultiplayerGameState, MultiplayerSnapshot, RealtimeInput } from "./multiplayer-protocol.js";
import type { GameAdapter } from "./rules.js";

/** The most inputs replayed: about a second of ticks; older ones the service has long read. */
const PENDING_MAX_MS = 1000;

export interface PredictionHooks {
  playerId(): string | undefined;
  tickMs(): number;
}

export class OwnPrediction {
  private pending: { inputId: number; input: RealtimeInput }[] = [];
  private confirmed?: MultiplayerSnapshot;
  private ack = -1;
  private guess?: MultiplayerGameState;

  constructor(
    private readonly adapter: GameAdapter,
    private readonly hooks: PredictionHooks,
  ) {}

  /** The state to show: the newest snapshot with this page's unread inputs replayed on it. */
  get state(): MultiplayerGameState | undefined {
    return this.guess ?? this.confirmed?.state;
  }

  /** This page just sent `input` as `inputId`. */
  sent(inputId: number, input: RealtimeInput): void {
    this.pending.push({ inputId, input });
    const kept = Math.max(1, Math.ceil(PENDING_MAX_MS / this.hooks.tickMs()));
    if (this.pending.length > kept) this.pending.splice(0, this.pending.length - kept);
    // One more step on the guess, rather than replaying everything.
    const base = this.guess ?? this.confirmed?.state;
    if (base) this.guess = this.step(base, input);
  }

  /** A snapshot from the service: start again from it. */
  confirm(snapshot: MultiplayerSnapshot): void {
    this.confirmed = snapshot;
    const me = this.hooks.playerId();
    const seat = me === undefined ? -1 : snapshot.state.players.findIndex((player) => player.playerId === me);
    const ack = seat >= 0 ? snapshot.acks?.[seat] : undefined;
    if (ack !== undefined) this.ack = ack;
    this.pending = this.pending.filter((entry) => entry.inputId > this.ack);
    let state: MultiplayerGameState | undefined = snapshot.state;
    for (const { input } of this.pending) {
      state = this.step(state, input);
      if (!state) break;
    }
    this.guess = state;
  }

  reset(): void {
    this.pending = [];
    this.confirmed = undefined;
    this.ack = -1;
    this.guess = undefined;
  }

  /** The rules' tick with only this page's input, as the service's tick would read it; undefined outside a round or when the rules fail. */
  private step(state: MultiplayerGameState | undefined, input: RealtimeInput): MultiplayerGameState | undefined {
    const me = this.hooks.playerId();
    if (!state || state.phase !== "playing" || me === undefined || !this.adapter.step) return undefined;
    const now = Date.now();
    try {
      const next = this.adapter.step(state, new Map([[me, { input, at: now }]]), now, this.hooks.tickMs() / 1000, []);
      // Only the service ends a round.
      return next.phase === "playing" ? next : state;
    } catch {
      return undefined;
    }
  }
}
