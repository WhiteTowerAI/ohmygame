import { getRandomValues } from "node:crypto";
import {
  isRealtimeGameDefinition,
  type GameContext,
  type GameDefinition,
  type MoveContext,
  type MoveDefinition,
  type MoveOptions,
  type RealtimeGameContext,
  type RealtimeGameDefinition,
} from "@ohmygame/sdk/game";
import {
  isRecord,
  MULTIPLAYER_MAX_CLIENTS,
  type MultiplayerGameState,
  type TurnCommand,
} from "@ohmygame/sdk/protocol";
import type { GameAdapter } from "./adapters.js";
import { checkTickMs, createRoomAdapter, finishMatch, TURN_SECONDS } from "./game.js";

const ROOM_COMMANDS = new Set<TurnCommand["type"]>(["start", "close", "kick"]);

function random(): number {
  return getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

function seatAfter(state: MultiplayerGameState, playerId: string): string {
  const index = state.players.findIndex((player) => player.playerId === playerId);
  return state.players[(index + 1) % state.players.length]?.playerId ?? "";
}

function context(state: MultiplayerGameState, now: number): GameContext {
  return {
    players: state.players.map((player) => player.playerId),
    ownerId: state.ownerId,
    currentPlayer: state.currentPlayerId,
    random,
    shuffle(items) {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index--) {
        const other = Math.floor(random() * (index + 1));
        [copy[index], copy[other]] = [copy[other]!, copy[index]!];
      }
      return copy;
    },
    now: () => now,
  };
}

/** The game must stay plain data: it is saved, sent to players and restored after a restart. */
function plainGame(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${source} must return an object.`);
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    throw new Error(`${source} must return plain data.`);
  }
}

function checkPlayers({ min, max }: { min: number; max: number }): void {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > MULTIPLAYER_MAX_CLIENTS)
    throw new Error(`players must be whole numbers from 1 to ${MULTIPLAYER_MAX_CLIENTS}, with min no more than max.`);
}

/**
 * Turns rules from defineGame or defineRealtimeGame into the adapter rooms run. The room
 * keeps its own lobby, start, close and kick commands; for turn-based rules every other
 * command is a move named by payload.action, and realtime rules read each player's input.
 */
export function compileGame<G extends object, Moves extends Record<string, MoveDefinition<G>>>(
  definition: GameDefinition<G, Moves>,
): GameAdapter;
export function compileGame<G extends object, Input extends object>(
  definition: RealtimeGameDefinition<G, Input>,
): GameAdapter;
export function compileGame(
  definition: GameDefinition<object, Record<string, MoveDefinition<object>>> | RealtimeGameDefinition<object, object>,
): GameAdapter;
export function compileGame(
  definition: GameDefinition<object, Record<string, MoveDefinition<object>>> | RealtimeGameDefinition<object, object>,
): GameAdapter {
  return isRealtimeGameDefinition(definition) ? compileRealtimeGame(definition) : compileTurnGame(definition);
}

function compileTurnGame<G extends object, Moves extends Record<string, MoveDefinition<G>>>(
  definition: GameDefinition<G, Moves>,
): GameAdapter {
  const moves: Record<string, MoveDefinition<G>> = definition.moves;
  checkPlayers(definition.players);
  const { min, max } = definition.players;
  const turnMs = (definition.turnSeconds ?? TURN_SECONDS) * 1000;
  if (!Number.isFinite(turnMs) || turnMs <= 0) throw new Error("turnSeconds must be positive.");
  const room = createRoomAdapter("turn-based", { min, max });
  // The room validates and then applies the same command; a move runs once, so its random draws hold.
  const validated = new WeakMap<TurnCommand, MultiplayerGameState>();

  function play(state: MultiplayerGameState, playerId: string, command: TurnCommand): MultiplayerGameState {
    const { action, ...args } = command.payload ?? {};
    const entry = typeof action === "string" && Object.hasOwn(moves, action) ? moves[action] : undefined;
    if (!entry) throw new Error("This game has no such move.");
    const move: MoveOptions<G, unknown> = typeof entry === "function" ? { run: entry } : entry;
    const by = move.by ?? "current";
    if (state.phase === "finished" ? !move.afterEnd : state.phase !== "playing")
      throw new Error(state.phase === "finished" ? "The match has ended." : "The match has not started.");
    if (!state.players.some((player) => player.playerId === playerId)) throw new Error("Only seated players can move.");
    if (by === "owner" && playerId !== state.ownerId) throw new Error("Only the room owner can do that.");
    if (by === "current" && playerId !== state.currentPlayerId) throw new Error("It is another player's turn.");
    const now = Date.now();
    const next = structuredClone(state);
    let chosen: string | undefined;
    const ctx: MoveContext = {
      ...context(next, now),
      playerId,
      setCurrentPlayer(id) {
        if (!next.players.some((player) => player.playerId === id)) throw new Error("setCurrentPlayer needs a seated player.");
        chosen = id;
      },
    };
    const draft = structuredClone(next.game ?? {}) as G;
    const returned = move.run(draft, ctx, args);
    next.game = plainGame(returned === undefined ? draft : returned, `The ${action} move`);
    const result = definition.endIf?.(next.game as G, context(next, now));
    if (result) finishMatch(next, result.winners);
    else {
      next.phase = "playing";
      next.winnerPlayerId = "";
      delete next.winnerPlayerIds;
      next.currentPlayerId = chosen ?? (by === "current" ? seatAfter(next, playerId) : next.currentPlayerId);
      next.turnDeadline = now + turnMs;
    }
    return next;
  }

  return {
    mode: "turn-based",
    players: { min, max },
    initialState: room.initialState,
    validateCommand(state, playerId, command) {
      if (ROOM_COMMANDS.has(command.type)) return room.validateCommand(state, playerId, command);
      if (command.type !== "action") throw new Error("This game only accepts its moves.");
      validated.set(command, play(state, playerId, command));
    },
    applyCommand(state, playerId, command) {
      if (!ROOM_COMMANDS.has(command.type)) return validated.get(command) ?? play(state, playerId, command);
      const next = room.applyCommand(state, playerId, command);
      const now = Date.now();
      if (command.type === "start") {
        next.game = plainGame(definition.setup(context(next, now)), "setup");
        next.turnDeadline = now + turnMs;
      } else if (command.type === "kick" && state.phase === "playing") {
        // The removed player's turn passes on with a full turn; the rules may now decide the match.
        if (next.currentPlayerId !== state.currentPlayerId) next.turnDeadline = now + turnMs;
        const result = definition.endIf?.(next.game as G, context(next, now));
        if (result) finishMatch(next, result.winners);
      }
      return next;
    },
    onTurnTimeout(state, now) {
      const next = structuredClone(state);
      // A missed turn is skipped; the service remains the time authority.
      next.currentPlayerId = seatAfter(next, next.currentPlayerId);
      next.turnDeadline = now + turnMs;
      return next;
    },
    viewFor(state, playerId) {
      if (!definition.playerView || state.game === undefined) return state;
      return {
        ...state,
        game: plainGame(definition.playerView(state.game as G, context(state, Date.now()), playerId), "playerView"),
      };
    },
  };
}

function realtimeContext(state: MultiplayerGameState, now: number): RealtimeGameContext {
  const { players, ownerId, random, shuffle } = context(state, now);
  return {
    players,
    connected: state.players.filter((player) => player.connected).map((player) => player.playerId),
    ownerId,
    random,
    shuffle,
    now: () => now,
  };
}

/**
 * Realtime rules run on the room's tick. Each round starts from setup, and the room's
 * own commands work as for any rules; the game's players act only through their input.
 */
function compileRealtimeGame<G extends object, Input extends object>(
  definition: RealtimeGameDefinition<G, Input>,
): GameAdapter {
  checkPlayers(definition.players);
  if (definition.tickMs !== undefined) checkTickMs(definition.tickMs);
  if (typeof definition.input !== "function") throw new Error("Realtime rules need an input function that reads each player's input.");
  const room = createRoomAdapter("realtime", definition.players);
  /** Runs one of the rules' functions on a copy of the game and keeps the result if it is plain data. */
  const update = (
    state: MultiplayerGameState,
    now: number,
    source: string,
    run: (G: G, ctx: RealtimeGameContext) => G | void,
  ): MultiplayerGameState => {
    const next = structuredClone(state);
    const ctx = realtimeContext(next, now);
    const draft = structuredClone(next.game ?? {}) as G;
    const returned = run(draft, ctx);
    next.game = plainGame(returned === undefined ? draft : returned, source);
    const result = definition.endIf?.(next.game as G, ctx);
    if (result) finishMatch(next, result.winners);
    return next;
  };
  const begin = (state: MultiplayerGameState, now: number): MultiplayerGameState => {
    const next = structuredClone(state);
    next.game = plainGame(definition.setup(realtimeContext(next, now)), "setup");
    return next;
  };
  const running = (state: MultiplayerGameState) => state.phase === "playing" && state.game !== undefined;
  return {
    ...room,
    tickMs: definition.tickMs,
    validateInput(input, playerId) {
      definition.input(input, playerId);
    },
    step(state, inputs, now, dt) {
      if (!running(state)) return state;
      const read: Record<string, Input> = {};
      for (const [playerId, { input }] of inputs) {
        try {
          read[playerId] = definition.input(input, playerId);
        } catch {
          /* An input the rules reject for this player is ignored. */
        }
      }
      return update(state, now, "tick", (G, ctx) => definition.tick(G, ctx, read, dt));
    },
    applyCommand(state, playerId, command) {
      const next = room.applyCommand(state, playerId, command);
      const now = Date.now();
      if (command.type === "start") return begin(next, now);
      const removed = command.type === "kick" ? command.payload?.playerId : undefined;
      if (removed && running(next) && definition.leave)
        return update(next, now, "leave", (G, ctx) => definition.leave!(G, ctx, removed));
      return next;
    },
    onRoundStart: (state, now) => begin(state, now),
    onPlayerJoin(state, playerId, now) {
      if (!running(state) || !definition.join) return state;
      return update(state, now, "join", (G, ctx) => definition.join!(G, ctx, playerId));
    },
    onPlayerLeave(state, playerId, now) {
      if (!running(state) || !definition.leave) return state;
      return update(state, now, "leave", (G, ctx) => definition.leave!(G, ctx, playerId));
    },
    viewFor(state, playerId) {
      if (!definition.playerView || state.game === undefined) return state;
      return {
        ...state,
        game: plainGame(definition.playerView(state.game as G, realtimeContext(state, Date.now()), playerId), "playerView"),
      };
    },
  };
}
