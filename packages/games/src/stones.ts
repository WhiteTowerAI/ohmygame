import { compileGame, defineGame, type GameAdapter } from "@ohmygame/server";

export const STONES = 21;
export interface StonesState {
  remaining: number;
  /** Who took stones last; once the pile is empty, the winner. */
  lastTaker: string;
  [key: string]: unknown;
}

/** A take-away race: players take one to three stones in turn, and whoever takes the last wins. */
export const stonesRules = defineGame({
  players: { min: 2, max: 32 },
  setup: (): StonesState => ({ remaining: STONES, lastTaker: "" }),
  moves: {
    take(G, ctx, args: { count: 1 | 2 | 3 }) {
      const { count } = args;
      if (Object.keys(args).length !== 1 || !Number.isInteger(count) || count < 1 || count > 3)
        throw new Error("Take one to three stones.");
      if (count > G.remaining) throw new Error("There are not enough stones remaining.");
      G.remaining -= count;
      G.lastTaker = ctx.playerId;
    },
  },
  endIf: (G) => (G.remaining === 0 ? { winners: [G.lastTaker] } : undefined),
});

export function createStonesAdapter(): GameAdapter {
  return compileGame(stonesRules);
}
