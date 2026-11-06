/**
 * Runs a lockstep round in a player's browser. The service numbers frames of everyone's
 * input and passes them on; every page steps the same rules from the same start, with the
 * same random numbers and clock, so every page reaches the same state.
 *
 * A frame takes a trip to arrive, so the page also runs ahead of the frames it has
 * (rollback): it estimates which frame an input sent now reaches the service in, asks
 * for its input to count in the frame after that, and shows the rules stepped that far
 * from the newest frame, with its own inputs and everyone else's last one. Each frame
 * that arrives replaces the guess, which corrects what it got wrong: another player who
 * changed their input since. docs/multiplayer.md describes the exchange.
 */
import {
  isLockstepFrame,
  isLockstepSync,
  type LockstepEvent,
  type LockstepFrame,
  type LockstepInput,
  type LockstepReport,
  type LockstepSync,
  type MultiplayerGameState,
  type RealtimeInput,
} from "./multiplayer-protocol.js";
import type { GameAdapter } from "./rules.js";

/** How often a reporting page sends the service a checkpoint, for players who arrive later. */
export const LOCKSTEP_CHECKPOINT_MS = 2000;
/** How often a page measures its round trip while a round plays. */
export const LOCKSTEP_PING_MS = 2000;
/** The furthest a page runs ahead of the frames it has. The service allows a little more. */
export const LOCKSTEP_MAX_AHEAD_MS = 1000;
/** Arrival times of the frames this recent tell where the service's clock is. */
const CLOCK_WINDOW_MS = 4000;
/** Round trips measured, of which the middle one counts. */
const PING_SAMPLES = 5;

export interface LockstepHooks {
  /** The round's state to show: the newest frame's, or a guess ahead of it. */
  show(state: MultiplayerGameState): void;
  /** The rules ended the round at this frame. */
  finish(report: LockstepReport): void;
  /** A state to keep for players who arrive later, when this page reports them. */
  checkpoint(report: LockstepReport): void;
  /** Whether this page reports checkpoints now: one page in the room does. */
  reporter(): boolean;
  /** A frame went missing, so the page asks the service to bring it up to date. */
  resync(): void;
  /** Measures the round trip: the service answers with the same number. */
  ping(sentAt: number): void;
  /** The player this page plays, once the room has said. */
  playerId(): string | undefined;
  /** Calls tick every ms until the returned function is called. */
  every(ms: number, tick: () => void): () => void;
}

interface SentInput {
  inputId: number;
  frame: number;
  input: RealtimeInput;
}

export class LockstepRunner {
  private round?: number;
  /** The newest frame from the service, and the state after it. */
  private frame = 0;
  private state?: MultiplayerGameState;
  private startedAt = 0;
  private tickMs = 50;
  private finished = false;
  /** Each player's input in the newest frame, and the frame it first counted in. */
  private held = new Map<string, { input: RealtimeInput; frame: number }>();
  /** This page's inputs the service has not yet counted. */
  private sent: SentInput[] = [];
  /** When recent frames arrived, less their number of ticks: the earliest is the clock. */
  private arrivals: { at: number; base: number }[] = [];
  private trips: number[] = [];
  private stopClock?: () => void;
  private lastShown?: string;
  /** The frame last shown ahead to, so a check between frames redraws only when it moves on. */
  private shownFrame = -1;

  constructor(
    private readonly adapter: GameAdapter,
    private readonly hooks: LockstepHooks,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** The newest frame's state, or undefined between rounds. */
  get current(): MultiplayerGameState | undefined {
    return this.state;
  }
  /** The state to show now: a guess ahead of the newest frame once the round trip is known. */
  get shown(): MultiplayerGameState | undefined {
    return this.state && this.predict(this.clock());
  }
  /** The measured round trip in milliseconds, once there is one. */
  get roundTrip(): number | undefined {
    if (!this.trips.length) return undefined;
    return [...this.trips].sort((a, b) => a - b)[Math.floor(this.trips.length / 2)];
  }

  /** Starts or catches up with a round. */
  sync(value: unknown): void {
    if (!isLockstepSync(value) || !this.adapter.onRoundStart) return;
    const { start } = value;
    const sameRound = value.round === this.round;
    this.round = value.round;
    this.tickMs = value.tickMs;
    this.startedAt = start.startedAt;
    if (!sameRound) this.sent = [];
    this.arrivals = [];
    this.held.clear();
    if (value.checkpoint) {
      this.state = structuredClone(value.checkpoint.state);
      this.frame = value.checkpoint.frame;
    } else {
      const finished = start.previous ? { ...start.state, game: start.previous } : undefined;
      this.state = this.adapter.onRoundStart(structuredClone(start.state), start.startedAt, finished);
      this.frame = 0;
    }
    this.finished = this.state.phase !== "playing";
    for (const frame of value.frames as LockstepSync["frames"]) if (frame.frame > this.frame) this.apply(frame, false);
    this.startClock();
    this.show(true);
  }

  /** Applies the round's next frame. */
  receive(value: unknown): void {
    if (!isLockstepFrame(value) || !this.state || value.round !== this.round || value.frame <= this.frame) return;
    if (value.frame !== this.frame + 1) {
      this.hooks.resync();
      return;
    }
    const now = this.clock();
    this.arrivals.push({ at: now, base: now - value.frame * this.tickMs });
    while (this.arrivals.length > 1 && this.arrivals[0]!.at < now - CLOCK_WINDOW_MS) this.arrivals.shift();
    this.apply(value, true);
    this.show(true);
  }

  /** The service's answer to a ping sent at sentAt. */
  pong(sentAt: unknown): void {
    if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) return;
    const trip = this.clock() - sentAt;
    if (trip < 0 || trip > 10_000) return;
    this.trips.push(trip);
    if (this.trips.length > PING_SAMPLES) this.trips.shift();
  }

  /**
   * The message for an input this page sends now: for the frame after the one it shows,
   * so it appears at the page's next tick and counts in the same frame on the service.
   */
  input(inputId: number, input: RealtimeInput): LockstepInput {
    const frame = this.state?.phase === "playing" ? Math.max(this.frame + 1, this.aheadFrame(this.clock()) + 1) : this.frame + 1;
    this.sent.push({ inputId, frame, input });
    return { inputId, frame, input };
  }

  reset(): void {
    this.round = undefined;
    this.state = undefined;
    this.frame = 0;
    this.sent = [];
    this.held.clear();
    this.arrivals = [];
    this.lastShown = undefined;
    this.shownFrame = -1;
    this.stopClock?.();
    this.stopClock = undefined;
  }

  private startClock(): void {
    if (this.stopClock) return;
    let pinged = -Infinity;
    // Advances the guess between frames, checking a few times a frame so it moves on close
    // to when the frame starts, and keeps the round trip measured.
    const stopTicks = this.hooks.every(Math.max(10, Math.round(this.tickMs / 4)), () => {
      const now = this.clock();
      if (now - pinged >= LOCKSTEP_PING_MS && this.state?.phase === "playing") {
        pinged = now;
        this.hooks.ping(now);
      }
      this.show(false);
    });
    this.stopClock = stopTicks;
  }

  private show(changed: boolean): void {
    if (!this.state) return;
    const now = this.clock();
    const target = this.aheadFrame(now);
    if (!changed && target === this.shownFrame) return;
    this.shownFrame = target;
    const state = this.predict(now);
    const text = JSON.stringify(state);
    if (!changed && text === this.lastShown) return;
    this.lastShown = text;
    this.hooks.show(state);
  }

  /**
   * The frame an input sent now reaches the service in: the frame the service is at as
   * the newest frames' arrival tells, plus half a round trip; never past the most a page
   * may run ahead. The newest frame itself before the round trip is known.
   */
  private aheadFrame(now: number): number {
    const trip = this.roundTrip;
    if (trip === undefined || !this.arrivals.length) return this.frame;
    const base = Math.min(...this.arrivals.map((arrival) => arrival.base));
    // base is when frame 0 would have arrived, which is half a trip after the service sent it.
    const frame = Math.ceil((now - base + trip) / this.tickMs);
    return Math.min(Math.max(frame, this.frame), this.frame + Math.floor(LOCKSTEP_MAX_AHEAD_MS / this.tickMs));
  }

  /** The newest frame's state stepped ahead to the frame an input sent now would count in. */
  private predict(now: number): MultiplayerGameState {
    const state = this.state!;
    const me = this.hooks.playerId();
    if (state.phase !== "playing" || me === undefined || !this.adapter.step) return state;
    const target = this.aheadFrame(now);
    const lifetime = Math.ceil(Math.max(250, 5 * this.tickMs) / this.tickMs);
    let guess = state;
    for (let frame = this.frame + 1; frame <= target; frame++) {
      const at = this.startedAt + frame * this.tickMs;
      const inputs = new Map<string, { input: RealtimeInput; at: number }>();
      // Everyone else keeps their last input, until it would run out on the service too.
      for (const [playerId, held] of this.held)
        if (playerId !== me && frame - held.frame <= lifetime) inputs.set(playerId, { input: held.input, at });
      const mine = this.mine(frame);
      if (mine && frame - mine.frame <= lifetime) inputs.set(me, { input: mine.input, at });
      const next = this.adapter.step(guess, inputs, at, this.tickMs / 1000, []);
      // Only a frame from the service ends a round.
      if (next.phase !== "playing") break;
      guess = next;
    }
    return guess;
  }

  /** This page's input at a frame ahead of the newest: its newest due by then, else the one the service holds. */
  private mine(frame: number): { input: RealtimeInput; frame: number } | undefined {
    let latest: SentInput | undefined;
    for (const entry of this.sent) {
      // An input that missed its frame counts from the frame after the newest.
      const due = Math.max(entry.frame, this.frame + 1);
      if (due <= frame && (!latest || entry.inputId > latest.inputId)) latest = { ...entry, frame: due };
    }
    if (latest) return latest;
    const me = this.hooks.playerId();
    return me === undefined ? undefined : this.held.get(me);
  }

  private apply(frame: LockstepFrame, live: boolean): void {
    if (frame.frame !== this.frame + 1 || !this.state) return;
    // Every page reads the same clock: the round's start and the frame's number.
    const now = this.startedAt + frame.frame * this.tickMs;
    let state = this.state;
    if (state.phase === "playing") {
      for (const event of frame.events ?? []) state = this.seat(state, event, now);
      const inputs = new Map<string, { input: RealtimeInput; at: number }>();
      for (const [playerId, input] of Object.entries(frame.inputs)) inputs.set(playerId, { input, at: now });
      state = this.adapter.step!(state, inputs, now, this.tickMs / 1000, frame.actions ?? []);
    }
    // What each player holds after this frame, and since when, for guessing ahead of it.
    for (const playerId of [...this.held.keys()]) if (!Object.hasOwn(frame.inputs, playerId)) this.held.delete(playerId);
    for (const [playerId, input] of Object.entries(frame.inputs)) {
      const counted = frame.acks?.[playerId] !== undefined || !this.held.has(playerId);
      this.held.set(playerId, { input, frame: counted ? frame.frame : this.held.get(playerId)!.frame });
    }
    const me = this.hooks.playerId();
    const acked = me === undefined ? undefined : frame.acks?.[me];
    if (acked !== undefined) this.sent = this.sent.filter((entry) => entry.inputId > acked);
    this.state = state;
    this.frame = frame.frame;
    if (!live) return;
    const report = { round: this.round!, frame: this.frame, state };
    if (state.phase !== "playing") {
      if (!this.finished) this.hooks.finish(report);
      this.finished = true;
    } else if (this.frame % Math.max(1, Math.round(LOCKSTEP_CHECKPOINT_MS / this.tickMs)) === 0 && this.hooks.reporter()) {
      this.hooks.checkpoint(report);
    }
  }

  /** A seat change, applied as the service applies it, before the frame's tick. */
  private seat(state: MultiplayerGameState, event: LockstepEvent, now: number): MultiplayerGameState {
    if (event.type === "join") {
      if (state.players.some((player) => player.playerId === event.player.playerId)) return state;
      const joined = { ...state, players: [...state.players, structuredClone(event.player)] };
      return this.adapter.onPlayerJoin ? this.adapter.onPlayerJoin(joined, event.player.playerId, now) : joined;
    }
    if (event.type === "leave") {
      if (!state.players.some((player) => player.playerId === event.playerId)) return state;
      const left = { ...state, players: state.players.filter((player) => player.playerId !== event.playerId) };
      return this.adapter.onPlayerLeave ? this.adapter.onPlayerLeave(left, event.playerId, now) : left;
    }
    return {
      ...state,
      players: state.players.map((player) => player.playerId === event.playerId ? { ...player, connected: event.connected } : player),
    };
  }
}
