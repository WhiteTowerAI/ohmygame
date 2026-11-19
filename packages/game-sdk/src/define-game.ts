/**
 * Game rules as plain functions: turn-based rules with defineGame, realtime rules with
 * defineRealtimeGame. The service runs them; clients only send a move or their input.
 * Everything here is free of dependencies so a game's rules file can import it on the
 * service and its page can import the types.
 */

export interface GameContext {
  /** Seated players in join order. */
  readonly players: readonly string[];
  readonly ownerId: string;
  /** The player whose turn it is. */
  readonly currentPlayer: string;
  /** A random number in [0, 1) from the service. Use it instead of Math.random. */
  random(): number;
  /** A shuffled copy, using random(). */
  shuffle<T>(items: readonly T[]): T[];
  /** The service's clock in milliseconds. Use it instead of Date.now. */
  now(): number;
}

export interface MoveContext extends GameContext {
  /** The player making this move. */
  readonly playerId: string;
  /** Who acts next. Without a call, a turn move passes the turn to the next seat. */
  setCurrentPlayer(playerId: string): void;
}

/**
 * Change G in place or return a new one. Throw an Error to reject the move; its message
 * reaches the player.
 */
export type MoveFunction<G, Args> = (G: G, ctx: MoveContext, args: Args) => G | void;

export interface MoveOptions<G, Args> {
  run: MoveFunction<G, Args>;
  /**
   * "current" (default): only the player whose turn it is, and the turn then passes on.
   * "owner": only the room owner, at any time. "any": any seated player, at any time.
   */
  by?: "current" | "owner" | "any";
  /** Also accepted after the game ended; when it is accepted, play continues. */
  afterEnd?: boolean;
}

// Each move names its own argument type, so the record cannot share one.
export type MoveDefinition<G> = MoveFunction<G, any> | MoveOptions<G, any>;

/** winners is empty for a draw. */
export interface GameResult {
  winners: string[];
  draw?: boolean;
}

export interface GameDefinition<G extends object, Moves extends Record<string, MoveDefinition<G>>> {
  /** Seats the rules support. A match starts once at least min players are connected. */
  players: { min: number; max: number };
  /**
   * The game when the owner starts a match. previous is the finished match's game when the
   * owner starts another one, so a score can carry over; it is undefined for the first.
   */
  setup(ctx: GameContext, previous?: G): G;
  moves: Moves;
  /** Checked after every accepted move. A result ends the match. */
  endIf?(G: G, ctx: GameContext): GameResult | undefined;
  /** What one player may see, such as their own hand. playerId is undefined for a spectator. */
  playerView?(G: G, ctx: GameContext, playerId: string | undefined): object;
  /** Seconds a player has for their turn. Defaults to 60. */
  turnSeconds?: number;
  /**
   * Runs when the current player's time runs out, with ctx.playerId the player who ran out
   * of time; endIf then runs as after a move, for example to make them lose. Change G in
   * place or return a new one. Without it, or when it chooses no one with
   * ctx.setCurrentPlayer, the turn passes to the next seat.
   */
  timeout?(G: G, ctx: MoveContext): G | void;
  /** Reserved for bots and automated testing; the service does not call it yet. */
  legalMoves?(G: G, ctx: GameContext, playerId: string): { move: keyof Moves & string; args?: object }[];
}

/** Checks the shape of the rules and returns them unchanged, with their types inferred. */
export function defineGame<G extends object, Moves extends Record<string, MoveDefinition<G>>>(
  definition: GameDefinition<G, Moves>,
): GameDefinition<G, Moves> {
  return definition;
}

/** What realtime rules see each tick: the players, and the service's randomness and clock. */
export interface RealtimeGameContext {
  /** Seated players in join order, connected or not. */
  readonly players: readonly string[];
  /** Seated players with an open connection. */
  readonly connected: readonly string[];
  /** The room owner; empty in a drop-in room. */
  readonly ownerId: string;
  /**
   * A random number in [0, 1). Use it instead of Math.random: in a lockstep room every
   * player's browser runs the rules and must draw the same numbers.
   */
  random(): number;
  shuffle<T>(items: readonly T[]): T[];
  /** The tick's time in milliseconds. Use it instead of Date.now, for the same reason. */
  now(): number;
}

/** One player's action, as tick reads it. */
export interface PlayerAction<Action> {
  playerId: string;
  action: Action;
}

/**
 * Realtime rules: the service calls tick at a fixed rate with each player's latest input,
 * whether or not anyone is pressing anything. A player who stops sending drops out of
 * inputs after five ticks, so keep anything that should persist, such as a snake's
 * heading, in G. Something that happens once, such as firing or jumping, is an action:
 * tick reads each action exactly once.
 */
export interface RealtimeGameDefinition<G extends object, Input extends object, Action extends object = never> {
  /** Seats the rules support. A round starts once at least min players are connected. */
  players: { min: number; max: number };
  /** Milliseconds between ticks, 20 to 1000. Defaults to 50. */
  tickMs?: number;
  /**
   * The game when a round starts: the owner starts or restarts the match, or a drop-in
   * room starts or restarts a round. previous is the finished round's game when there is
   * one, so a score can carry over.
   */
  setup(ctx: RealtimeGameContext, previous?: G): G;
  /**
   * Reads one input as the player sent it, such as { dir: "up" }, and returns it in the
   * shape tick reads. Throw an Error to reject it; its message reaches the player.
   */
  input(value: Record<string, unknown>, playerId: string): Input;
  /**
   * Reads one action as the player sent it with sendAction, such as { fire: true }, and
   * returns it in the shape tick reads. Throw an Error to refuse it; its message reaches
   * the player. Without it the game takes no actions.
   */
  action?(value: Record<string, unknown>, playerId: string): Action;
  /**
   * Advances the game by dt seconds. Change G in place or return a new one. actions holds
   * every action since the last tick, in the order they arrived; the next tick will not
   * see them again.
   */
  tick(
    G: G,
    ctx: RealtimeGameContext,
    inputs: Readonly<Record<string, Input>>,
    dt: number,
    actions: readonly PlayerAction<Action>[],
  ): G | void;
  /** A player takes a seat while a round is running, as in a drop-in room. */
  join?(G: G, ctx: RealtimeGameContext, playerId: string): G | void;
  /** A player gives up their seat while a round is running: they left a drop-in room or were removed. */
  leave?(G: G, ctx: RealtimeGameContext, playerId: string): G | void;
  /** Checked after every tick. A result ends the round; a drop-in room then starts another. */
  endIf?(G: G, ctx: RealtimeGameContext): GameResult | undefined;
  /** What one player may see. playerId is undefined for a spectator. */
  playerView?(G: G, ctx: RealtimeGameContext, playerId: string | undefined): object;
}

/** Checks the shape of realtime rules and returns them unchanged, with their types inferred. */
export function defineRealtimeGame<G extends object, Input extends object, Action extends object = never>(
  definition: RealtimeGameDefinition<G, Input, Action>,
): RealtimeGameDefinition<G, Input, Action> {
  return definition;
}

/** Whether rules are realtime rules from defineRealtimeGame. */
export function isRealtimeGameDefinition(value: unknown): value is RealtimeGameDefinition<object, object, object> {
  return typeof value === "object" && value !== null && typeof (value as { tick?: unknown }).tick === "function";
}

/** The input client.sendInput takes for a game: what its rules' input function returns. */
export type ClientInput<Game> = Game extends { input(value: never, playerId: never): infer Input extends object }
  ? Input
  : Record<string, unknown>;

/** The action client.sendAction takes for a game: what its rules' action function returns. */
export type ClientAction<Game> = Game extends { action?(value: never, playerId: never): infer Action extends object }
  ? Action
  : Record<string, unknown>;

// A move is a function or { run }; its third parameter is the move's arguments.
type MoveArgs<M> = M extends { run: (G: never, ctx: never, args: infer A) => unknown }
  ? A
  : M extends (G: never, ctx: never, args: infer A) => unknown
    ? A
    : never;

/** client.moves for a game: one function per move, taking that move's arguments. */
export type ClientMoves<Game> = Game extends { moves: infer Moves extends object }
  ? {
      [K in keyof Moves & string]: unknown extends MoveArgs<Moves[K]>
        ? (args?: Record<string, unknown>) => string
        : {} extends MoveArgs<Moves[K]>
          ? (args?: MoveArgs<Moves[K]>) => string
          : (args: MoveArgs<Moves[K]>) => string;
    }
  : Record<string, (args?: Record<string, unknown>) => string>;
