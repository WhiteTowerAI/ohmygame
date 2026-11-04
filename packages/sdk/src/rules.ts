/**
 * Runs rules from defineGame and defineRealtimeGame: the room's own commands, and the
 * compiler that turns rules into the adapter a room calls. The game service uses it, and so
 * does the browser of a player who hosts a game whose rules run there. Free of Node APIs.
 */
import {
  isRealtimeGameDefinition,
  type GameContext,
  type PlayerAction,
  type GameDefinition,
  type MoveContext,
  type MoveDefinition,
  type MoveOptions,
  type RealtimeGameContext,
  type RealtimeGameDefinition,
} from "./define-game.js";
import {
  DEFAULT_TICK_MS,
  isRecord,
  MULTIPLAYER_MAX_CLIENTS,
  MULTIPLAYER_MIN_CLIENTS,
  TICK_MS_RANGE,
  type MultiplayerGameAdapter,
  type MultiplayerGameState,
  type MultiplayerMode,
  type TurnCommand,
} from "./multiplayer-protocol.js";

/** Rules as a room calls them. */
export type GameAdapter = MultiplayerGameAdapter<MultiplayerGameState, TurnCommand>;

export const TURN_SECONDS = 60;

/** A realtime adapter's tick in milliseconds: its own, or the default. */
export function tickMsOf(adapter: { tickMs?: number }): number {
  return adapter.tickMs ?? DEFAULT_TICK_MS;
}
/** Throws unless the tick is a whole number of milliseconds the service can run. */
export function checkTickMs(tickMs: number): void {
  if (!Number.isInteger(tickMs) || tickMs < TICK_MS_RANGE.min || tickMs > TICK_MS_RANGE.max)
    throw new Error(`tickMs must be a whole number from ${TICK_MS_RANGE.min} to ${TICK_MS_RANGE.max}.`);
}

export function nextTurn(state: MultiplayerGameState, now = Date.now()): void {
  const index = state.players.findIndex(
    (player) => player.playerId === state.currentPlayerId,
  );
  state.currentPlayerId =
    state.players[(index + 1) % state.players.length]?.playerId ?? "";
  state.turnDeadline = now + TURN_SECONDS * 1000;
}

/** Ends the match with these winners: one, several for a team, or none for a draw. */
export function finishMatch(state: MultiplayerGameState, winners: readonly string[]): void {
  state.phase = "finished";
  state.winnerPlayerIds = [...winners];
  state.winnerPlayerId = winners.length === 1 ? winners[0]! : "";
}

/**
 * The room's own commands: the owner starts, restarts once a match has finished, closes and
 * removes players. The room sets up each round through onRoundStart. Rules build on it
 * and handle their game's commands themselves; any other command is rejected. A match left
 * with fewer than players.min seats after a removal ends without a winner.
 */
export function createRoomAdapter(
  mode: MultiplayerMode,
  players: { min: number; max: number } = { min: MULTIPLAYER_MIN_CLIENTS, max: MULTIPLAYER_MAX_CLIENTS },
): MultiplayerGameAdapter<MultiplayerGameState, TurnCommand> {
  return {
    mode,
    players,
    initialState: () => ({
      phase: "lobby",
      ownerId: "",
      currentPlayerId: "",
      winnerPlayerId: "",
      turnDeadline: 0,
      players: [],
    }),
    validateCommand(state, playerId, command) {
      if (state.phase === "closed") throw new Error("The room is closed.");
      if (command.type === "close" || command.type === "kick") {
        if (state.ownerId !== playerId)
          throw new Error("Only the room owner can manage this room.");
        if (
          command.type === "kick" &&
          (!state.players.some(
            (p) => p.playerId === command.payload?.playerId,
          ) ||
            command.payload?.playerId === playerId)
        )
          throw new Error("Choose another player to remove.");
      } else if (command.type === "start" || command.type === "restart") {
        // The room checks the player count against the adapter's seats.
        if (state.ownerId !== playerId)
          throw new Error("Only the room owner can start the match.");
        if (command.type === "start" && state.phase !== "lobby")
          throw new Error("The match has already started.");
        if (command.type === "restart" && state.phase !== "finished")
          throw new Error("Finish this match before starting another.");
      } else throw new Error("This game does not support that action.");
    },
    applyCommand(state, _playerId, command) {
      const next = structuredClone(state);
      if (command.type === "close") next.phase = "closed";
      else if (command.type === "kick") {
        const id = command.payload!.playerId!;
        if (next.currentPlayerId === id) nextTurn(next);
        next.players = next.players.filter((p) => p.playerId !== id);
        if (next.phase === "playing" && next.players.length < players.min) finishMatch(next, []);
      } else if (command.type === "start" || command.type === "restart") {
        next.phase = "playing";
        next.winnerPlayerId = "";
        delete next.winnerPlayerIds;
        next.currentPlayerId = next.players[0]!.playerId;
        next.turnDeadline = Date.now() + TURN_SECONDS * 1000;
      }
      return next;
    },
  };
}

const ROOM_COMMANDS = new Set<TurnCommand["type"]>(["start", "restart", "close", "kick"]);

function random(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
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
 * keeps its own lobby, start, restart, close and kick commands; for turn-based rules every other
 * command is a move named by payload.action, and realtime rules read each player's input.
 */
export function compileGame<G extends object, Moves extends Record<string, MoveDefinition<G>>>(
  definition: GameDefinition<G, Moves>,
): GameAdapter;
export function compileGame<G extends object, Input extends object, Action extends object>(
  definition: RealtimeGameDefinition<G, Input, Action>,
): GameAdapter;
export function compileGame(
  definition: GameDefinition<object, Record<string, MoveDefinition<object>>> | RealtimeGameDefinition<object, object, object>,
): GameAdapter;
export function compileGame(
  definition: GameDefinition<object, Record<string, MoveDefinition<object>>> | RealtimeGameDefinition<object, object, object>,
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
      if (command.type === "kick" && state.phase === "playing") {
        // The removed player's turn passes on with a full turn; the rules may now decide the match.
        if (next.currentPlayerId !== state.currentPlayerId) next.turnDeadline = now + turnMs;
        const result = definition.endIf?.(next.game as G, context(next, now));
        if (result) finishMatch(next, result.winners);
      }
      return next;
    },
    // The room calls it after start and restart, with the finished match on a restart.
    onRoundStart(state, now, finished) {
      const next = structuredClone(state);
      const previous = finished?.game === undefined ? undefined : (structuredClone(finished.game) as G);
      next.game = plainGame(definition.setup(context(next, now), previous), "setup");
      next.turnDeadline = now + turnMs;
      return next;
    },
    onTurnTimeout(state, now) {
      const next = structuredClone(state);
      const late = next.currentPlayerId;
      let chosen: string | undefined;
      if (definition.timeout && next.game !== undefined) {
        // The rules decide what a missed turn costs; the service remains the time authority.
        const ctx: MoveContext = {
          ...context(next, now),
          playerId: late,
          setCurrentPlayer(id) {
            if (!next.players.some((player) => player.playerId === id)) throw new Error("setCurrentPlayer needs a seated player.");
            chosen = id;
          },
        };
        const draft = structuredClone(next.game) as G;
        const returned = definition.timeout(draft, ctx);
        next.game = plainGame(returned === undefined ? draft : returned, "timeout");
        const result = definition.endIf?.(next.game as G, context(next, now));
        if (result) {
          finishMatch(next, result.winners);
          return next;
        }
      }
      next.currentPlayerId = chosen ?? seatAfter(next, late);
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
function compileRealtimeGame<G extends object, Input extends object, Action extends object>(
  definition: RealtimeGameDefinition<G, Input, Action>,
): GameAdapter {
  checkPlayers(definition.players);
  if (definition.tickMs !== undefined) checkTickMs(definition.tickMs);
  if (typeof definition.input !== "function") throw new Error("Realtime rules need an input function that reads each player's input.");
  const readAction = definition.action;
  if (readAction !== undefined && typeof readAction !== "function") throw new Error("action must be a function that reads one action.");
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
  const begin = (state: MultiplayerGameState, now: number, finished?: MultiplayerGameState): MultiplayerGameState => {
    const next = structuredClone(state);
    const previous = finished?.game === undefined ? undefined : (structuredClone(finished.game) as G);
    next.game = plainGame(definition.setup(realtimeContext(next, now), previous), "setup");
    return next;
  };
  const running = (state: MultiplayerGameState) => state.phase === "playing" && state.game !== undefined;
  return {
    ...room,
    tickMs: definition.tickMs,
    validateInput(input, playerId) {
      definition.input(input, playerId);
    },
    ...(readAction
      ? {
          validateAction(action: Record<string, unknown>, playerId: string) {
            readAction(action, playerId);
          },
        }
      : {}),
    step(state, inputs, now, dt, actions) {
      if (!running(state)) return state;
      const read: Record<string, Input> = {};
      for (const [playerId, { input }] of inputs) {
        try {
          read[playerId] = definition.input(input, playerId);
        } catch {
          /* An input the rules reject for this player is ignored. */
        }
      }
      const acted: PlayerAction<Action>[] = [];
      // The room only queues actions when the rules read them.
      for (const { playerId, action } of readAction ? actions : []) {
        try {
          acted.push({ playerId, action: readAction!(action, playerId) });
        } catch {
          /* The room checked it on arrival; an action refused now is dropped. */
        }
      }
      return update(state, now, "tick", (G, ctx) => definition.tick(G, ctx, read, dt, acted));
    },
    applyCommand(state, playerId, command) {
      const next = room.applyCommand(state, playerId, command);
      const now = Date.now();
      const removed = command.type === "kick" ? command.payload?.playerId : undefined;
      if (removed && running(next) && definition.leave)
        return update(next, now, "leave", (G, ctx) => definition.leave!(G, ctx, removed));
      return next;
    },
    onRoundStart: (state, now, finished) => begin(state, now, finished),
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
