import { describe, expect, it } from "vitest";
import { createBuiltInAdapter } from "@ohmygame/games";
import { compileGame, defineGame, type GameAdapter } from "@ohmygame/server";
import type { MultiplayerGameState, RealtimeInput } from "@ohmygame/sdk/protocol";

/** A started match for these rules, as the room makes one: seats, start, then round setup. */
function started(adapter: GameAdapter, seats: string[]): MultiplayerGameState {
  const lobby = adapter.initialState();
  lobby.ownerId = seats[0]!;
  lobby.players = seats.map((playerId, index) => ({ playerId, displayName: playerId, connected: true, x: index, y: 0 }));
  const command = { commandId: "start", expectedSequence: 0, type: "start" as const };
  adapter.validateCommand(lobby, seats[0]!, command);
  const state = adapter.applyCommand(lobby, seats[0]!, command);
  return adapter.onRoundStart ? adapter.onRoundStart(state, Date.now()) : state;
}

describe("built-in rules", () => {
  it("makes a gomoku player who runs out of time lose, and keeps the score for the next match", () => {
    const gomoku = createBuiltInAdapter("gomoku");
    const match = started(gomoku, ["black", "white"]);
    expect(match.currentPlayerId).toBe("black");
    const timedOut = gomoku.onTurnTimeout!(match, Date.now());
    expect(timedOut.phase).toBe("finished");
    expect(timedOut.winnerPlayerIds).toEqual(["white"]);
    expect(timedOut.game).toMatchObject({ forfeit: 1, whiteWins: 1, blackWins: 0 });
    const next = gomoku.onRoundStart!({ ...timedOut, phase: "playing" }, Date.now(), timedOut);
    expect(next.game).toMatchObject({ whiteWins: 1, blackWins: 0, history: [] });
    expect(next.game).not.toHaveProperty("forfeit");
  });

  it("passes the turn on for rules without a timeout, and lets rules choose otherwise", () => {
    const base = { players: { min: 3, max: 3 }, setup: () => ({ missed: [] as string[] }), moves: {} };
    const skip = compileGame(defineGame(base));
    const match = started(skip, ["a", "b", "c"]);
    expect(skip.onTurnTimeout!(match, Date.now())).toMatchObject({ phase: "playing", currentPlayerId: "b" });
    const back = compileGame(defineGame({
      ...base,
      timeout(G, ctx) {
        G.missed.push(ctx.playerId);
        ctx.setCurrentPlayer(ctx.players[2]!);
      },
    }));
    const chosen = back.onTurnTimeout!(started(back, ["a", "b", "c"]), Date.now());
    expect(chosen).toMatchObject({ phase: "playing", currentPlayerId: "c", game: { missed: ["a"] } });
  });

  it("lets everyone who reaches the arena goal in the same tick win together", () => {
    const arena = createBuiltInAdapter("arena");
    const state = started(arena, ["first", "second", "third"]);
    // Two racers one step from the goal on opposite sides, the third far away.
    state.players[0]!.x = 50;
    state.players[0]!.y = 46.5;
    state.players[1]!.x = 50;
    state.players[1]!.y = 53.5;
    state.players[2]!.x = 10;
    state.players[2]!.y = 10;
    const toward = (y: number): { input: RealtimeInput; at: number } => ({ input: { x: 0, y }, at: Date.now() });
    const inputs = new Map([["first", toward(1)], ["second", toward(-1)], ["third", toward(1)]]);
    const next = arena.step!(state, inputs, Date.now(), 0.05, []);
    expect(next.phase).toBe("finished");
    expect(next.winnerPlayerIds).toEqual(["first", "second"]);
    expect(next.winnerPlayerId).toBe("");
  });
});
