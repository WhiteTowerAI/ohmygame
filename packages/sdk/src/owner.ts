/**
 * A player's part of an owner round. Each page runs its own player and sets their state;
 * the service passes every player's state on once a tick, changes shared data one request
 * at a time, and passes messages on. The page shows its own state at once and everyone
 * else's as it arrives, so nothing it shows is ever taken back except a shared change it
 * lost to another player. docs/multiplayer.md describes the exchange.
 */
import {
  isOwnerFrame,
  isSequence,
  isOwnerSharedUpdate,
  isOwnerState,
  isOwnerSync,
  isRecord,
  type OwnerPatch,
  type OwnerSharedChange,
} from "./multiplayer-protocol.js";
import { TickPacer, type TickClock } from "./pacing.js";

/** How long a shared request waits for the service before it counts as refused. */
export const OWNER_SHARED_TIMEOUT_MS = 5000;
/**
 * How far a page that comes back to a round numbers its state past the version the service
 * last had: copies sent straight to other pages may have gone further than that one.
 */
const SEQ_RESUME_GAP = 100;
/** States sent straight to other pages go out at most this often; the newest one wins. */
export const OWNER_DIRECT_INTERVAL_MS = 33;

/** A player's whole state sent straight from their page to another. */
export interface OwnerDirectState {
  round: number;
  seq: number;
  state: Record<string, unknown>;
}

export interface OwnerHooks {
  send(type: "owner.state" | "owner.shared", value: unknown): void;
  /** Sends this page's whole state straight to the players it reaches directly, if any. */
  sendDirect?(packet: OwnerDirectState): void;
  /** The round changed: show it. */
  show(): void;
  playerId(): string | undefined;
  tickMs(): number;
  /** Where the service's tick falls, so this page's state reaches it just before. */
  clock: TickClock;
}

/** What an owner round shows the game, as snapshot.state.game. */
export interface OwnerGame extends Record<string, unknown> {
  /** Every player's state: this page's own as it last set it, everyone else's as the service last passed it on. */
  players: Record<string, Record<string, unknown>>;
  shared: Record<string, unknown>;
}

export class OwnerSession {
  private round?: number;
  private readonly others = new Map<string, Record<string, unknown>>();
  private shared = new Map<string, unknown>();
  private own: Record<string, unknown> = {};
  /** The state the service holds for this page, so only changed keys are sent. */
  private sent: Record<string, unknown> = {};
  private readonly pacer: TickPacer;
  private readonly waiting = new Map<string, { done: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  private requests = 0;
  /** This page's state version: each setState counts one. */
  private seq = 0;
  /** The newest version of each other player's state this page shows. */
  private readonly versions = new Map<string, number>();
  /** Players who left this round, whose late direct states are dropped. */
  private readonly departed = new Set<string>();
  private directAt = 0;
  private directTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly hooks: OwnerHooks) {
    this.pacer = new TickPacer(hooks.clock, hooks.tickMs, () => this.flush());
  }

  /** Whether a round is running and this page has it. */
  get active(): boolean {
    return this.round !== undefined;
  }

  game(): OwnerGame {
    const players: Record<string, Record<string, unknown>> = Object.fromEntries(this.others);
    const me = this.hooks.playerId();
    if (me !== undefined) players[me] = this.own;
    return { players, shared: Object.fromEntries(this.shared) };
  }

  /** A round started, or this page arrived or came back during one. */
  sync(value: unknown): void {
    if (!isOwnerSync(value)) return;
    const me = this.hooks.playerId();
    const newRound = value.round !== this.round;
    this.round = value.round;
    this.others.clear();
    this.versions.clear();
    this.departed.clear();
    for (const [id, state] of Object.entries(value.players)) if (id !== me && isRecord(state)) this.others.set(id, state);
    for (const [id, seq] of Object.entries(value.seqs ?? {})) if (id !== me && isSequence(seq)) this.versions.set(id, seq);
    this.shared = new Map(Object.entries(value.shared));
    const held = me === undefined ? undefined : value.players[me];
    this.sent = isRecord(held) ? { ...held } : {};
    const heldSeq = me === undefined ? undefined : value.seqs?.[me];
    if (heldSeq !== undefined) this.seq = Math.max(this.seq, heldSeq + SEQ_RESUME_GAP);
    // A new round starts empty; back in the same round, the page carries on with its own state.
    if (newRound) this.own = { ...this.sent };
    this.flush();
    this.hooks.show();
  }

  /** Other players' states that changed this tick. */
  frame(value: unknown): void {
    if (!isOwnerFrame(value) || value.round !== this.round) return;
    const me = this.hooks.playerId();
    for (const [id, patch] of Object.entries(value.players ?? {})) {
      if (id === me || !isRecord(patch)) continue;
      // A newer state already came straight from the player's page. A patch builds on the
      // service's previous frame, which this page's version is at least as new as, so a
      // newer patch still applies on top of a direct state.
      const seq = isSequence(patch.seq) ? patch.seq : undefined;
      if (seq !== undefined && seq <= (this.versions.get(id) ?? -1)) continue;
      const next = { ...this.others.get(id), ...(isRecord(patch.set) ? patch.set : undefined) };
      if (Array.isArray(patch.delete)) for (const key of patch.delete) if (typeof key === "string") delete next[key];
      this.others.set(id, next);
      if (seq !== undefined) this.versions.set(id, seq);
    }
    for (const id of value.left ?? [])
      if (typeof id === "string") {
        this.others.delete(id);
        this.versions.delete(id);
        this.departed.add(id);
      }
    // The service sends frames on its tick.
    this.hooks.clock.arrived();
    this.hooks.show();
  }

  /** A player's whole state straight from their page, shown if it is newer than what this page has. */
  direct(from: string, value: unknown): void {
    if (!isRecord(value) || value.round !== this.round || !isSequence(value.seq) || !isOwnerState(value.state)) return;
    if (from === this.hooks.playerId() || this.departed.has(from) || value.seq <= (this.versions.get(from) ?? -1)) return;
    this.others.set(from, value.state);
    this.versions.set(from, value.seq);
    this.hooks.show();
  }

  sharedUpdate(value: unknown): void {
    if (!isOwnerSharedUpdate(value) || value.round !== this.round) return;
    for (const change of value.changes) {
      if (!isRecord(change) || typeof change.key !== "string") continue;
      if (change.value === undefined) this.shared.delete(change.key);
      else this.shared.set(change.key, change.value);
    }
    this.hooks.show();
  }

  sharedResult(value: unknown): void {
    if (!isRecord(value) || typeof value.requestId !== "string") return;
    const waiting = this.waiting.get(value.requestId);
    if (!waiting) return;
    this.waiting.delete(value.requestId);
    clearTimeout(waiting.timer);
    waiting.done(value.ok === true);
  }

  /**
   * Sets this player's state, which shows at once. It goes to the service at most once a
   * tick, timed to reach it just before its tick, with only the top-level keys that changed,
   * and keeps going while the page keeps changing it.
   */
  setState(state: Record<string, unknown>): void {
    if (!isOwnerState(state)) throw new Error("A player's state must be a small plain object of JSON data.");
    this.own = structuredClone(state);
    this.seq++;
    this.pacer.wake();
    this.sendDirect();
    this.hooks.show();
  }

  /** Asks the service to change shared data; resolves whether it did. */
  updateShared(changes: OwnerSharedChange[]): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    const requestId = `${Date.now().toString(36)}-${(this.requests++).toString(36)}`;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        done(false);
      }, OWNER_SHARED_TIMEOUT_MS);
      this.waiting.set(requestId, { done, timer });
      this.hooks.send("owner.shared", { requestId, changes });
    });
  }

  reset(): void {
    this.round = undefined;
    this.others.clear();
    this.shared.clear();
    this.own = {};
    this.sent = {};
    this.versions.clear();
    this.departed.clear();
    clearTimeout(this.directTimer);
    this.directTimer = undefined;
    this.pacer.stop();
    for (const { done, timer } of this.waiting.values()) {
      clearTimeout(timer);
      done(false);
    }
    this.waiting.clear();
  }

  /**
   * Sends the whole state straight to the players reached directly, without waiting for
   * the service's tick, at most every OWNER_DIRECT_INTERVAL_MS; a change within that goes
   * out at its end.
   */
  private sendDirect(): void {
    if (!this.hooks.sendDirect || !this.active || this.directTimer) return;
    const wait = this.directAt + OWNER_DIRECT_INTERVAL_MS - Date.now();
    const send = () => {
      this.directTimer = undefined;
      if (!this.active) return;
      this.directAt = Date.now();
      this.hooks.sendDirect?.({ round: this.round!, seq: this.seq, state: this.own });
    };
    if (wait <= 0) send();
    else this.directTimer = setTimeout(send, wait);
  }

  /** Sends the keys of this page's state that changed since the service last had it; whether there were any. */
  private flush(): boolean {
    if (!this.active) return false;
    const patch: OwnerPatch = {};
    for (const [key, value] of Object.entries(this.own))
      if (JSON.stringify(value) !== JSON.stringify(this.sent[key])) (patch.set ??= {})[key] = value;
    for (const key of Object.keys(this.sent)) if (!Object.hasOwn(this.own, key)) (patch.delete ??= []).push(key);
    if (!patch.set && !patch.delete) return false;
    patch.seq = this.seq;
    this.hooks.send("owner.state", patch);
    this.sent = structuredClone(this.own);
    this.pacer.sent();
    return true;
  }
}
