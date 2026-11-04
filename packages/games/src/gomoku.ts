import { compileGame, defineGame, type GameAdapter } from "@ohmygame/server";
import {
  GOMOKU_SIZE,
  gomokuWinningLine,
  initialGomokuState,
  isGomokuPoint,
  type GomokuPoint,
  type GomokuState,
} from "./gomoku-board.js";

/** Players send a coordinate; only the service places stones and decides victory. */
export const gomokuRules = defineGame({
  // Black and white: the board, the colours and the scores have no third seat.
  players: { min: 2, max: 2 },
  // Another match keeps the score; black, the first seat, moves first again.
  setup: (_ctx, previous?: GomokuState): GomokuState => ({
    ...initialGomokuState(),
    blackWins: previous?.blackWins ?? 0,
    whiteWins: previous?.whiteWins ?? 0,
  }),
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
  },
  // Running out of time loses the match; skipping the turn would give the other colour two stones.
  timeout(G, ctx) {
    const cell = ctx.players[0] === ctx.playerId ? 1 : 2;
    G.forfeit = cell;
    if (cell === 1) G.whiteWins++;
    else G.blackWins++;
  },
  endIf(G, ctx) {
    if (G.forfeit) return { winners: [G.forfeit === 1 ? ctx.players[1]! : ctx.players[0]!] };
    const [first] = G.winningLine;
    if (first) return { winners: [G.board[first.r * GOMOKU_SIZE + first.c] === 1 ? ctx.players[0]! : ctx.players[1]!] };
    if (G.history.length === GOMOKU_SIZE ** 2) return { winners: [], draw: true };
    return undefined;
  },
});

/** The board is empty in the lobby, so players see it before the owner starts. */
export function createGomokuAdapter(): GameAdapter {
  const rules = compileGame(gomokuRules);
  return { ...rules, initialState: () => ({ ...rules.initialState(), game: initialGomokuState() }) };
}
