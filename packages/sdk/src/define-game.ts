/**
 * Turn-based rules as plain functions. The service runs them; clients only send a move's
 * name and arguments. Everything here is free of dependencies so a game's rules file can
 * import it on the service and its page can import the types.
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
  /** The game when the owner starts the match. */
  setup(ctx: GameContext): G;
  moves: Moves;
  /** Checked after every accepted move. A result ends the match. */
  endIf?(G: G, ctx: GameContext): GameResult | undefined;
  /** What one player may see, such as their own hand. playerId is undefined for a spectator. */
  playerView?(G: G, ctx: GameContext, playerId: string | undefined): object;
  /** Seconds before a turn is skipped. Defaults to 60. */
  turnSeconds?: number;
  /** Reserved for bots and automated testing; the service does not call it yet. */
  legalMoves?(G: G, ctx: GameContext, playerId: string): { move: keyof Moves & string; args?: object }[];
}

/** Checks the shape of the rules and returns them unchanged, with their types inferred. */
export function defineGame<G extends object, Moves extends Record<string, MoveDefinition<G>>>(
  definition: GameDefinition<G, Moves>,
): GameDefinition<G, Moves> {
  return definition;
}

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
