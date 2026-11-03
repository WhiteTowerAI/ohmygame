import { defineGame } from "@ohmygame/sdk/game";
import {
  GOMOKU_SIZE,
  gomokuWinningLine,
  initialGomokuState,
  isGomokuPoint,
  type GomokuPoint,
  type GomokuState,
} from "@ohmygame/sdk/games/gomoku";
import type { GameAdapter } from "./adapters.js";
import { compileGame } from "./define-game.js";

/** Players send a coordinate; only the service places stones and decides victory. */
export const gomokuRules = defineGame({
  // Black and white: the board, the colours and the scores have no third seat.
  players: { min: 2, max: 2 },
  setup: (): GomokuState => initialGomokuState(),
  moves: {
    move(G, ctx, args: { point: GomokuPoint }) {
      if (Object.keys(args).length !== 1 || !isGomokuPoint(args.point))
        throw new Error("Choose a valid board coordinate.");
      const { point } = args;
      if (G.board[point.r * GOMOKU_SIZE + point.c] !== 0)
        throw new Error("This intersection is occupied.");
      const cell = ctx.players[0] === ctx.playerId ? 1 : 2;
      G.board[point.r * GOMOKU_SIZE + point.c] = cell;
      G.history.push({ ...point });
      G.winningLine = gomokuWinningLine(G.board, point);
      if (G.winningLine.length) {
        if (cell === 1) G.blackWins++;
        else G.whiteWins++;
      }
    },
    /** The owner starts a new match at any time; black moves first and the score carries over. */
    reset: {
      by: "owner",
      afterEnd: true,
      run(G, ctx, args: Record<string, never>) {
        if (Object.keys(args).length || ctx.players.length !== 2)
          throw new Error("Only the room owner can start a new match.");
        ctx.setCurrentPlayer(ctx.players[0]!);
        return { ...initialGomokuState(), blackWins: G.blackWins, whiteWins: G.whiteWins };
      },
    },
  },
  endIf(G, ctx) {
    const [first] = G.winningLine;
    if (first) return { winners: [G.board[first.r * GOMOKU_SIZE + first.c] === 1 ? ctx.players[0]! : ctx.players[1]!] };
    if (G.history.length === GOMOKU_SIZE ** 2) return { winners: [], draw: true };
    return undefined;
  },
});

/** The lobby shows the empty intersections as the remaining count. */
export function createGomokuAdapter(): GameAdapter {
  const rules = compileGame(gomokuRules);
  const withRemaining = (state: ReturnType<GameAdapter["initialState"]>) => ({
    ...state,
    remaining: GOMOKU_SIZE ** 2 - ((state.game as GomokuState | undefined)?.history.length ?? 0),
  });
  return {
    ...rules,
    initialState: () => withRemaining({ ...rules.initialState(), game: initialGomokuState() }),
    applyCommand: (state, playerId, command) => withRemaining(rules.applyCommand(state, playerId, command)),
  };
}
