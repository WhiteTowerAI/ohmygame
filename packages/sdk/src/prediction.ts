/**
 * Client-side prediction for realtime rules a player's browser hosts. Another player's input
 * takes two trips before it shows: to the hosting player and back. Every page has the rules,
 * so a player who is not hosting runs them ahead of the newest state from the host, with
 * their own inputs as they pressed them and everyone else's last known input, and shows
 * the tick their latest input reaches the host's rules. Each new state from the host
 * replaces the prediction, which corrects what the guess got wrong, such as where food
 * appeared, since rules draw fresh random numbers.
 */
import type { MultiplayerGameState, RealtimeFrame, RealtimeInput } from "./multiplayer-protocol.js";
import type { GameAdapter } from "./rules.js";

/** The furthest ahead a player runs the rules, as a guess further ahead is mostly wrong. */
export const MAX_PREDICTION_MS = 1000;
/** A round trip measures this much from the newest one, so one slow trip moves it little. */
const ROUND_TRIP_WEIGHT = 0.25;

interface SentInput {
  id: number;
  input: RealtimeInput;
  at: number;
  measured?: boolean;
}

export class Predictor {
  private sent: SentInput[] = [];
  /** From an input leaving this page to the host's state that read it reaching the page. */
  private roundTrip?: number;
  private base?: { state: MultiplayerGameState; frame: RealtimeFrame; at: number };
  private lastShown?: string;

  constructor(
    private readonly adapter: GameAdapter,
    private readonly tickMs: number,
    private readonly playerId: () => string | undefined,
  ) {}

  /** The round trip measured so far, in milliseconds. */
  get latency(): number | undefined {
    return this.roundTrip;
  }

  /** Notes an input this page sent with its inputId. */
  sentInput(id: number, input: RealtimeInput, at = Date.now()): void {
    this.sent.push({ id, input, at });
    const keep = at - 2 * MAX_PREDICTION_MS - Math.max(250, 5 * this.tickMs);
    while (this.sent.length > 1 && this.sent[0]!.at < keep) this.sent.shift();
  }

  /** Takes a new state from the host and returns what to show now. */
  receive(state: MultiplayerGameState, frame: RealtimeFrame, now = Date.now()): MultiplayerGameState {
    const me = this.playerId();
    const ack = me === undefined ? undefined : frame.acks[me];
    const read = ack === undefined ? undefined : this.sent.find((entry) => entry.id === ack);
    if (read && !read.measured) {
      read.measured = true;
      const sample = now - read.at;
      this.roundTrip = this.roundTrip === undefined ? sample : this.roundTrip + ROUND_TRIP_WEIGHT * (sample - this.roundTrip);
    }
    this.base = { state, frame, at: now };
    this.lastShown = undefined;
    return this.predict(now) ?? state;
  }

  /**
   * The state to show now, or undefined while it is unchanged or there is nothing to
   * predict from. Called every tick between states from the host.
   */
  advance(now = Date.now()): MultiplayerGameState | undefined {
    return this.predict(now);
  }

  /** Forgets the round, as when it ends or this player starts hosting. */
  reset(): void {
    this.base = undefined;
    this.lastShown = undefined;
  }

  private predict(now: number): MultiplayerGameState | undefined {
    const base = this.base;
    const me = this.playerId();
    if (!base || this.roundTrip === undefined || me === undefined || !this.adapter.step || base.state.phase !== "playing") return undefined;
    // The host made base about half a round trip before it arrived here, and an input sent
    // now reaches the host's rules about half a round trip from now.
    const ahead = Math.min(this.roundTrip + now - base.at, MAX_PREDICTION_MS);
    const ticks = Math.max(0, Math.round(ahead / this.tickMs));
    const lifetime = Math.max(250, 5 * this.tickMs);
    let state = base.state;
    for (let tick = 1; tick <= ticks; tick++) {
      // The input the host's rules read at this tick: the newest one sent half a round
      // trip before the tick ran there, while it still counts.
      const sentBy = base.at - this.roundTrip + tick * this.tickMs;
      const inputs = new Map<string, { input: RealtimeInput; at: number }>();
      for (const [id, input] of Object.entries(base.frame.inputs)) if (id !== me) inputs.set(id, { input, at: now });
      const sent = this.sentBefore(sentBy);
      // Before the first input this page still remembers, the host held what base read.
      const mine = sent ? (sentBy - sent.at <= lifetime ? sent.input : undefined) : tick * this.tickMs <= lifetime ? base.frame.inputs[me] : undefined;
      if (mine) inputs.set(me, { input: mine, at: now });
      const next = this.adapter.step(state, inputs, now, this.tickMs / 1000, []);
      // Only the host's rules end a round.
      if (next.phase !== "playing") break;
      state = next;
    }
    const shown = JSON.stringify(state);
    if (shown === this.lastShown) return undefined;
    this.lastShown = shown;
    return state;
  }

  /** The newest input this page sent by time. */
  private sentBefore(time: number): SentInput | undefined {
    for (let index = this.sent.length - 1; index >= 0; index--) if (this.sent[index]!.at <= time) return this.sent[index];
    return undefined;
  }
}
