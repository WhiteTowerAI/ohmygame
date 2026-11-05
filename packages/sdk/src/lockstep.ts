/**
 * Runs a lockstep round in a player's browser. The service numbers frames of everyone's
 * input and passes them on; every page steps the same rules from the same start, with the
 * same random numbers and clock, so every page reaches the same state with one trip of
 * delay for everyone. docs/multiplayer.md describes the exchange.
 */
import {
  isLockstepFrame,
  isLockstepSync,
  type LockstepEvent,
  type LockstepFrame,
  type LockstepReport,
  type LockstepSync,
  type MultiplayerGameState,
  type RealtimeInput,
} from "./multiplayer-protocol.js";
import type { GameAdapter } from "./rules.js";

/** How often a reporting page sends the service a checkpoint, for players who arrive later. */
export const LOCKSTEP_CHECKPOINT_MS = 2000;

export interface LockstepHooks {
  /** The round's state after a frame, to show. */
  show(state: MultiplayerGameState): void;
  /** The rules ended the round at this frame. */
  finish(report: LockstepReport): void;
  /** A state to keep for players who arrive later, when this page reports them. */
  checkpoint(report: LockstepReport): void;
  /** Whether this page reports checkpoints now: one page in the room does. */
  reporter(): boolean;
  /** A frame went missing, so the page asks the service to bring it up to date. */
  resync(): void;
}

export class LockstepRunner {
  private round?: number;
  private frame = 0;
  private state?: MultiplayerGameState;
  private startedAt = 0;
  private tickMs = 50;
  private finished = false;

  constructor(
    private readonly adapter: GameAdapter,
    private readonly hooks: LockstepHooks,
  ) {}

  /** The round's state this page has reached, or undefined between rounds. */
  get current(): MultiplayerGameState | undefined {
    return this.state;
  }

  /** Starts or catches up with a round. */
  sync(value: unknown): void {
    if (!isLockstepSync(value) || !this.adapter.onRoundStart) return;
    const { start } = value;
    this.round = value.round;
    this.tickMs = value.tickMs;
    this.startedAt = start.startedAt;
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
    this.hooks.show(this.state);
  }

  /** Applies the round's next frame. */
  receive(value: unknown): void {
    if (!isLockstepFrame(value) || !this.state || value.round !== this.round || value.frame <= this.frame) return;
    if (value.frame !== this.frame + 1) {
      this.hooks.resync();
      return;
    }
    this.apply(value, true);
    this.hooks.show(this.state);
  }

  reset(): void {
    this.round = undefined;
    this.state = undefined;
    this.frame = 0;
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
