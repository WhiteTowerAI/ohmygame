/**
 * Rules a player's browser runs for the room: the game's own rules from defineGame or
 * defineRealtimeGame, which the game service never runs. The service keeps the room —
 * seats, phase, sequence, reconnection and the saved state — and asks the hosting player
 * to apply the rules; it accepts only the game's part of the answer. docs/multiplayer.md
 * describes the exchange.
 */
import {
  isRecord,
  type MultiplayerGameState,
  type RealtimeAction,
  type RealtimeInput,
  type TurnCommand,
} from "./multiplayer-protocol.js";
import { nextTurn, type GameAdapter } from "./rules.js";

/** The adapterId of deployments whose rules run on a player's browser. */
export const HOST_ADAPTER_ID = "host";
/** The largest message a hosting player may send, in bytes of its JSON. */
export const HOST_MESSAGE_MAX_BYTES = 128 * 1024;
/** How long the service waits for the hosting player before another player hosts. */
export const HOST_REPLY_MS = 5000;

/** What the service asks the hosting player to apply to state. */
export type HostRequest = {
  requestId: string;
  /** The room's state, unfiltered. */
  state: MultiplayerGameState;
  now: number;
} & (
  | { kind: "command"; playerId: string; command: TurnCommand }
  | { kind: "join" | "leave"; playerId: string }
  /** A round starts; finished is the round before, when there is one. */
  | { kind: "round"; finished?: MultiplayerGameState }
  | { kind: "timeout" }
);
/** Views per seat for rules with playerView, keyed by player ID; "" is a spectator's. */
export type HostViews = Record<string, Record<string, unknown>>;
export interface HostReply {
  requestId: string;
  state?: MultiplayerGameState;
  views?: HostViews;
  /** Why the rules refused a command. */
  error?: string;
}

/** Whether rules from defineGame or defineRealtimeGame show players different things. */
export function hasPlayerView(rules: unknown): boolean {
  return isRecord(rules) && typeof rules.playerView === "function";
}

/** What each seat, and a spectator, may see of state. */
export function hostViews(adapter: GameAdapter, state: MultiplayerGameState): HostViews {
  const views: HostViews = {};
  for (const id of [...state.players.map((player) => player.playerId), ""]) {
    const view = adapter.viewFor ? adapter.viewFor(state, id || undefined) : state;
    views[id] = (view.game ?? {}) as Record<string, unknown>;
  }
  return views;
}

/** Applies one request with the rules, as the service would if it ran them. */
export function runHostRequest(adapter: GameAdapter, request: HostRequest, playerView: boolean): HostReply {
  const { requestId, state, now } = request;
  try {
    let next: MultiplayerGameState;
    switch (request.kind) {
      case "command": {
        const { playerId, command } = request;
        if (command.type === "start" || command.type === "restart") {
          const connected = state.players.filter((player) => player.connected).length;
          if (connected < adapter.players.min) {
            const { min, max } = adapter.players;
            throw new Error(`This game needs ${min === max ? `exactly ${min}` : `${min} to ${max}`} connected players to start.`);
          }
        }
        adapter.validateCommand(state, playerId, command);
        next = adapter.applyCommand(state, playerId, command);
        if ((command.type === "start" || command.type === "restart") && adapter.onRoundStart)
          next = adapter.onRoundStart(next, now, command.type === "restart" ? state : undefined);
        break;
      }
      case "join":
        next = adapter.onPlayerJoin ? adapter.onPlayerJoin(state, request.playerId, now) : state;
        break;
      case "leave":
        next = adapter.onPlayerLeave ? adapter.onPlayerLeave(state, request.playerId, now) : state;
        break;
      case "round":
        next = adapter.onRoundStart ? adapter.onRoundStart(state, now, request.finished) : state;
        break;
      case "timeout":
        if (adapter.onTurnTimeout) next = adapter.onTurnTimeout(state, now);
        else {
          next = structuredClone(state);
          nextTurn(next, now);
        }
        break;
    }
    return { requestId, state: next, ...(playerView ? { views: hostViews(adapter, next) } : {}) };
  } catch (cause) {
    return { requestId, error: cause instanceof Error ? cause.message.slice(0, 300) : "The rules refused the request." };
  }
}

const HOST_PHASES = new Set(["lobby", "playing", "finished"]);

/**
 * The room state after a hosting player's answer. The service keeps what it owns: seats and
 * their connections, the owner, and any phase it set itself while the player worked, such as
 * closing the room. From the player it takes the game, positions, whose turn it is, the
 * deadline and winners among the seats. base is the state the request carried; a realtime
 * tick has none, and changes the phase only while a round is playing.
 */
export function mergeHostState(
  host: MultiplayerGameState,
  room: MultiplayerGameState,
  base?: MultiplayerGameState,
): MultiplayerGameState {
  const seats = new Set(room.players.map((player) => player.playerId));
  const hostPlayers = new Map(host.players.map((player) => [player.playerId, player]));
  const phaseSettled = base ? base.phase === room.phase : room.phase === "playing";
  const phase = phaseSettled && HOST_PHASES.has(host.phase) ? host.phase : room.phase;
  const winners = (host.winnerPlayerIds ?? []).filter((id) => seats.has(id));
  const next: MultiplayerGameState = {
    ...room,
    phase,
    currentPlayerId: seats.has(host.currentPlayerId) ? host.currentPlayerId : "",
    turnDeadline: Number.isFinite(host.turnDeadline) ? host.turnDeadline : room.turnDeadline,
    winnerPlayerId: seats.has(host.winnerPlayerId) ? host.winnerPlayerId : "",
    players: room.players.map((player) => {
      const placed = hostPlayers.get(player.playerId);
      return placed && Number.isFinite(placed.x) && Number.isFinite(placed.y) ? { ...player, x: placed.x, y: placed.y } : player;
    }),
  };
  if (host.winnerPlayerIds) next.winnerPlayerIds = winners;
  else delete next.winnerPlayerIds;
  if (host.game === undefined) delete next.game;
  else next.game = host.game;
  return next;
}

/** One player's input as the hosting player keeps it. */
interface HeldInput {
  input: RealtimeInput;
  at: number;
}

/**
 * The realtime loop a hosting player's browser runs: every tick it steps the rules with the
 * players' latest inputs and the actions since the last tick, and sends the new state.
 */
export class HostLoop {
  private state?: MultiplayerGameState;
  private readonly inputs = new Map<string, HeldInput>();
  private actions: { playerId: string; action: RealtimeAction }[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly adapter: GameAdapter,
    private readonly tickMs: number,
    private readonly playerView: boolean,
    private readonly send: (state: MultiplayerGameState, views?: HostViews) => void,
  ) {}

  start(state: MultiplayerGameState): void {
    this.state = state;
    this.timer ??= setInterval(() => this.tick(), this.tickMs);
  }
  /** The room changed without this player's rules, for example a seat was taken. */
  sync(state: MultiplayerGameState): void {
    if (!this.state) return;
    this.state = this.state.phase === "playing" && state.phase === "playing" ? mergeHostState(this.state, state) : state;
    if (state.phase !== "playing") {
      this.inputs.clear();
      this.actions = [];
    }
  }
  input(playerId: string, input: RealtimeInput): void {
    this.inputs.set(playerId, { input, at: Date.now() });
  }
  action(playerId: string, action: RealtimeAction): void {
    this.actions.push({ playerId, action });
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.state = undefined;
    this.inputs.clear();
    this.actions = [];
  }

  private tick(): void {
    const state = this.state;
    if (!state || state.phase !== "playing" || !this.adapter.step) return;
    const now = Date.now();
    // An input counts until the player has missed five ticks, as on the service.
    const lifetime = Math.max(250, 5 * this.tickMs);
    for (const [id, held] of this.inputs) if (now - held.at > lifetime) this.inputs.delete(id);
    const actions = this.actions;
    this.actions = [];
    const next = this.adapter.step(state, this.inputs, now, this.tickMs / 1000, actions);
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    this.state = next;
    this.send(next, this.playerView ? hostViews(this.adapter, next) : undefined);
  }
}
