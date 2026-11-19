/**
 * Plays a game's own rules, from defineGame or defineRealtimeGame, in memory: no service, no
 * browser and no network. The rules run through the same adapter and request handling a
 * room uses, with a clock the test moves and seeded random numbers, so every run of a test
 * plays the same game. Use it to check moves are accepted and refused as intended, turns,
 * results, timeouts, ticks, and what each player may see.
 */
import type { GameDefinition, MoveDefinition, RealtimeGameDefinition } from "./define-game.js";
import { runHostRequest, type HostRequest } from "./host.js";
import type { MultiplayerGameState, RealtimeAction, RealtimeInput, TurnCommand } from "./multiplayer-protocol.js";
import { compileGame, tickMsOf, type GameAdapter } from "./rules.js";

/** How long a finished drop-in round shows its result before the room starts another, as on the service. */
export const SIMULATED_ROUND_RESTART_MS = 3000;

export interface SimulateRoomOptions {
  /** Player IDs in join order, all connected. In a room with an owner the first one owns it. */
  players: readonly string[];
  /** Seeds ctx.random and ctx.shuffle, so every run draws the same numbers. Defaults to 1. */
  seed?: number;
  /** The clock's start in milliseconds, as ctx.now() reads it. Defaults to 0. */
  now?: number;
  /**
   * A drop-in room: nobody owns it, a round starts once enough players are connected,
   * players join and leave a running round, and a finished round restarts by itself.
   */
  dropIn?: boolean;
  /** Seats in the room. Defaults to the rules' players.max. */
  maxClients?: number;
}

/** A request the room makes of the rules, without what apply adds. */
type SimulatedRequest = HostRequest extends infer Request ? Request extends HostRequest ? Omit<Request, "requestId" | "state" | "now"> : never : never;

type AnyRules = GameDefinition<object, Record<string, MoveDefinition<object>>> | RealtimeGameDefinition<object, object, object>;

/**
 * A room playing the rules. Every method that the rules or the room refuse throws an Error
 * with the message the player would get, and leaves the room as it was.
 */
export class SimulatedRoom {
  private readonly adapter: GameAdapter;
  private readonly realtime: boolean;
  private readonly tickMs: number;
  private readonly dropIn: boolean;
  private readonly maxClients: number;
  private readonly seed: number;
  private clock: number;
  private current: MultiplayerGameState;
  private readonly inputs = new Map<string, { input: RealtimeInput; at: number }>();
  private actions: { playerId: string; action: RealtimeAction }[] = [];
  private commands = 0;
  /** When the last round finished, for a drop-in room's restart. */
  private finishedAt?: number;
  /** Time advanced toward the next realtime tick. */
  private pending = 0;

  constructor(rules: AnyRules, options: SimulateRoomOptions) {
    this.clock = options.now ?? 0;
    this.adapter = compileGame(rules, { clock: () => this.clock });
    this.realtime = this.adapter.mode === "realtime";
    this.tickMs = tickMsOf(this.adapter);
    this.dropIn = options.dropIn ?? false;
    this.maxClients = options.maxClients ?? this.adapter.players.max;
    this.seed = options.seed ?? 1;
    if (!Number.isInteger(this.seed)) throw new Error("seed must be a whole number.");
    if (!Number.isInteger(this.maxClients) || this.maxClients < 1 || this.maxClients > this.adapter.players.max)
      throw new Error(`maxClients must be a whole number from 1 to the rules' ${this.adapter.players.max} players.`);
    if (!options.players.length) throw new Error("A room needs at least one player.");
    this.current = this.adapter.initialState();
    for (const playerId of options.players) this.join(playerId);
  }

  /** The game as the rules keep it, unfiltered: G. */
  get game(): Record<string, unknown> | undefined {
    return this.current.game === undefined ? undefined : structuredClone(this.current.game);
  }
  /** The whole room state players receive, without any player's view applied. */
  get state(): MultiplayerGameState {
    const state = structuredClone(this.current);
    delete state.seed;
    return state;
  }
  get phase(): MultiplayerGameState["phase"] {
    return this.current.phase;
  }
  /** The player whose turn it is, in turn-based rules. */
  get currentPlayer(): string {
    return this.current.currentPlayerId;
  }
  get owner(): string {
    return this.current.ownerId;
  }
  /** The winners of the finished match; empty for a draw or while it plays. */
  get winners(): string[] {
    if (this.current.winnerPlayerIds) return [...this.current.winnerPlayerIds];
    return this.current.winnerPlayerId ? [this.current.winnerPlayerId] : [];
  }
  /** Seated players in join order, connected or not. */
  get players(): string[] {
    return this.current.players.map((player) => player.playerId);
  }
  get connected(): string[] {
    return this.current.players.filter((player) => player.connected).map((player) => player.playerId);
  }
  /** The room's clock in milliseconds. */
  get now(): number {
    return this.clock;
  }

  /** What one player receives of the game: their playerView, or G without one. undefined is a spectator. */
  view(playerId?: string): Record<string, unknown> | undefined {
    const shown = this.adapter.viewFor ? this.adapter.viewFor(this.current, playerId) : this.current;
    return shown.game === undefined ? undefined : structuredClone(shown.game);
  }

  /** The owner starts the match. A drop-in room starts its rounds by itself. */
  start(by = this.current.ownerId): this {
    return this.command(by, { type: "start" });
  }
  /** The owner starts another match once one has finished. */
  restart(by = this.current.ownerId): this {
    return this.command(by, { type: "restart" });
  }
  /** The owner removes a player. */
  kick(by: string, playerId: string): this {
    return this.command(by, { type: "kick", payload: { playerId } });
  }

  /** A player makes a move of turn-based rules, as client.moves[name](args) sends it. */
  move(playerId: string, name: string, args: Record<string, unknown> = {}): this {
    if (this.realtime) throw new Error("Realtime rules take input and actions, not moves.");
    return this.command(playerId, { type: "action", payload: { ...args, action: name } });
  }

  /** A player's latest input to realtime rules, as client.sendInput sends it. It counts until they miss five ticks. */
  input(playerId: string, value: RealtimeInput): this {
    this.requireRealtime("input");
    this.requireConnected(playerId);
    this.adapter.validateInput?.(value, playerId);
    this.inputs.set(playerId, { input: structuredClone(value), at: this.clock });
    return this;
  }

  /** A one-off action to realtime rules, as client.sendAction sends it; the next tick reads it once. */
  action(playerId: string, value: RealtimeAction): this {
    this.requireRealtime("actions");
    this.requireConnected(playerId);
    if (!this.adapter.validateAction) throw new Error("This game takes no actions.");
    this.adapter.validateAction(value, playerId);
    this.actions.push({ playerId, action: structuredClone(value) });
    return this;
  }

  /** Runs realtime rules for this many ticks, moving the clock one tick each. */
  tick(count = 1): this {
    this.requireRealtime("ticks");
    if (!Number.isInteger(count) || count < 0) throw new Error("tick takes a whole number of ticks.");
    for (let index = 0; index < count; index++) {
      this.clock += this.tickMs;
      this.step();
      this.restartRound();
    }
    return this;
  }

  /**
   * Moves the clock: turn-based rules time out each turn whose deadline passes, realtime
   * rules tick as often as fit, and a finished drop-in round restarts after its pause.
   */
  advance(ms: number): this {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("advance takes milliseconds of zero or more.");
    if (this.realtime) {
      this.pending += ms;
      const ticks = Math.floor(this.pending / this.tickMs);
      this.pending -= ticks * this.tickMs;
      this.tick(ticks);
      this.clock += this.pending;
      this.pending = 0;
      this.restartRound();
      return this;
    }
    const end = this.clock + ms;
    while (this.current.phase === "playing" && this.current.turnDeadline <= end) {
      this.clock = Math.max(this.clock, this.current.turnDeadline);
      this.apply({ kind: "timeout" });
    }
    this.clock = end;
    this.restartRound();
    return this;
  }

  /** A player takes a seat, or reconnects to theirs. */
  join(playerId: string): this {
    if (!playerId) throw new Error("A player needs an ID.");
    const seated = this.current.players.find((player) => player.playerId === playerId);
    if (seated) {
      seated.connected = true;
      return this;
    }
    if (this.current.players.length >= this.maxClients) throw new Error("The room is full.");
    if (this.current.phase !== "lobby" && !this.dropIn) throw new Error("This game has already started.");
    const state = structuredClone(this.current);
    state.players.push({ playerId, displayName: playerId, connected: true, x: 5 + (state.players.length * 80) / this.maxClients, y: 5 });
    if (!state.ownerId && !this.dropIn) state.ownerId = playerId;
    this.current = state;
    if (state.phase === "playing") this.apply({ kind: "join", playerId });
    if (this.dropIn && this.current.phase === "lobby" && this.enoughPlayers()) this.startRound();
    return this;
  }

  /**
   * A player's connection closes. Before a match, and in a drop-in room, they give up
   * their seat; during a match their seat waits for them, and turn timeouts skip them.
   */
  leave(playerId: string): this {
    const seated = this.current.players.find((player) => player.playerId === playerId);
    if (!seated) throw new Error(`${playerId} is not in the room.`);
    this.inputs.delete(playerId);
    let state = structuredClone(this.current);
    state.players.find((player) => player.playerId === playerId)!.connected = false;
    if (state.phase === "lobby" || this.dropIn) {
      state.players = state.players.filter((player) => player.playerId !== playerId);
      if (state.ownerId === playerId) state.ownerId = state.players[0]?.playerId ?? "";
      if (!state.players.length) state.phase = "closed";
      else if (state.phase === "playing") {
        this.current = state;
        this.apply({ kind: "leave", playerId });
        state = this.current;
        if (this.dropIn && state.phase === "playing" && !this.enoughPlayers()) state = { ...state, phase: "lobby" };
      }
    }
    this.current = state;
    return this;
  }

  private command(playerId: string, command: Omit<TurnCommand, "commandId" | "expectedSequence">): this {
    this.requireConnected(playerId);
    const before = this.current;
    const full: TurnCommand = { commandId: `simulated-${++this.commands}`, expectedSequence: 0, ...command };
    // The room sets the round's seed, so the rules' random numbers repeat run after run.
    if (command.type === "start" || command.type === "restart") this.current = { ...this.current, seed: this.seed };
    try {
      this.apply({ kind: "command", playerId, command: full });
    } catch (cause) {
      this.current = before;
      throw cause;
    }
    if (command.type === "start" || command.type === "restart") this.roundBegan();
    return this;
  }

  private apply(request: SimulatedRequest): void {
    const reply = runHostRequest(this.adapter, { requestId: "simulated", state: this.current, now: this.clock, ...request } as HostRequest, false);
    if (reply.error !== undefined || !reply.state) throw new Error(reply.error ?? "The rules refused the request.");
    this.current = reply.state;
    this.noteFinish();
  }

  private step(): void {
    if (this.current.phase !== "playing" || !this.adapter.step) return;
    // An input counts until the player has missed five ticks, as on the service.
    const lifetime = Math.max(250, 5 * this.tickMs);
    for (const [playerId, held] of this.inputs) if (this.clock - held.at > lifetime) this.inputs.delete(playerId);
    const actions = this.actions;
    this.actions = [];
    this.current = this.adapter.step(this.current, this.inputs, this.clock, this.tickMs / 1000, actions);
    this.noteFinish();
  }

  private startRound(finished?: MultiplayerGameState): void {
    const state: MultiplayerGameState = { ...structuredClone(this.current), phase: "playing", winnerPlayerId: "", currentPlayerId: "", seed: this.seed };
    delete state.winnerPlayerIds;
    this.current = state;
    this.apply({ kind: "round", ...(finished ? { finished } : {}) });
    this.roundBegan();
  }

  /** Every round starts clean: no input or action carries over. */
  private roundBegan(): void {
    this.inputs.clear();
    this.actions = [];
    this.finishedAt = undefined;
  }

  private noteFinish(): void {
    if (this.current.phase === "finished") this.finishedAt ??= this.clock;
  }

  private restartRound(): void {
    if (!this.dropIn || this.current.phase !== "finished" || this.finishedAt === undefined) return;
    if (this.clock - this.finishedAt < SIMULATED_ROUND_RESTART_MS) return;
    if (this.enoughPlayers()) this.startRound(structuredClone(this.current));
    else {
      this.current = { ...this.current, phase: "lobby" };
      this.finishedAt = undefined;
    }
  }

  private enoughPlayers(): boolean {
    return this.connected.length >= this.adapter.players.min;
  }

  private requireConnected(playerId: string): void {
    const seated = this.current.players.find((player) => player.playerId === playerId);
    if (!seated) throw new Error(`${playerId} is not in the room.`);
    if (!seated.connected) throw new Error(`${playerId} is not connected.`);
  }

  private requireRealtime(what: string): void {
    if (!this.realtime) throw new Error(`Turn-based rules take moves, not ${what}.`);
  }
}

/** One test, as test() registers it. */
export interface RulesTest {
  name: string;
  run: () => void | Promise<void>;
}

/**
 * Where OhMyGame's rules test runner collects tests: it sets this before it loads a test
 * file, then runs them itself. Without it, the tests run on their own once the file has
 * loaded, so `node server/rules.test.ts` works too.
 */
interface RulesTestRegistry {
  tests: RulesTest[];
}
const REGISTRY_KEY = "__OHMYGAME_RULES_TESTS__";

/** What running tests found: each test's name, and why it failed when it did. */
export interface RulesTestResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

/** Runs tests one after another; a failure does not stop the rest. */
export async function runRulesTests(tests: readonly RulesTest[], onStart?: (name: string) => void): Promise<RulesTestResult[]> {
  const results: RulesTestResult[] = [];
  for (const { name, run } of tests) {
    onStart?.(name);
    const started = Date.now();
    try {
      await run();
      results.push({ name, ok: true, ms: Date.now() - started });
    } catch (cause) {
      results.push({ name, ok: false, error: cause instanceof Error ? cause.message : String(cause), ms: Date.now() - started });
    }
  }
  return results;
}

let ownTests: RulesTest[] | undefined;

/**
 * A test of the rules: throw, for example with node:assert, to fail it. OhMyGame's
 * multiplayer_rules_test runs a game's server/rules.test.ts this way; under plain Node the
 * file's tests run by themselves once it has loaded, and a failure sets the exit code.
 */
export function test(name: string, run: () => void | Promise<void>): void {
  if (!name || typeof run !== "function") throw new Error("test takes a name and a function.");
  const registry = (globalThis as { [REGISTRY_KEY]?: RulesTestRegistry })[REGISTRY_KEY];
  if (registry) {
    registry.tests.push({ name, run });
    return;
  }
  if (!ownTests) {
    ownTests = [];
    const tests = ownTests;
    setTimeout(() => {
      void runRulesTests(tests).then((results) => {
        for (const result of results) console.log(`${result.ok ? "ok" : "FAILED"} - ${result.name}${result.error ? `\n  ${result.error}` : ""}`);
        const failed = results.filter((result) => !result.ok).length;
        console.log(`${results.length - failed} passed, ${failed} failed`);
        const scope = globalThis as { process?: { exitCode?: number } };
        if (failed && scope.process) scope.process.exitCode = 1;
      });
    }, 0);
  }
  ownTests.push({ name, run });
}

/**
 * A room playing the rules with these players, in memory. For example:
 *
 *     const room = simulateRoom(rules, { players: ["a", "b"] }).start();
 *     room.move("a", "place", { cell: 4 });
 *     assert.throws(() => room.move("a", "place", { cell: 5 }), /another player's turn/);
 *     assert.deepEqual(room.view("b").hand, ...);
 */
export function simulateRoom<G extends object, Moves extends Record<string, MoveDefinition<G>>>(
  rules: GameDefinition<G, Moves>,
  options: SimulateRoomOptions,
): SimulatedRoom;
export function simulateRoom<G extends object, Input extends object, Action extends object>(
  rules: RealtimeGameDefinition<G, Input, Action>,
  options: SimulateRoomOptions,
): SimulatedRoom;
export function simulateRoom(rules: AnyRules, options: SimulateRoomOptions): SimulatedRoom {
  return new SimulatedRoom(rules, options);
}
