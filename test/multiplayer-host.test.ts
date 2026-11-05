import { describe, expect, it, vi } from "vitest";
import { HostLoop, mergeHostState, runHostRequest } from "@ohmygame/sdk/host";
import { Predictor } from "../packages/sdk/src/prediction.js";
import { compileGame, defineGame, defineRealtimeGame } from "@ohmygame/server";
import type { MultiplayerGameState } from "@ohmygame/sdk/protocol";

function room(phase: MultiplayerGameState["phase"]): MultiplayerGameState {
  return {
    phase,
    ownerId: "a",
    currentPlayerId: "a",
    winnerPlayerId: "",
    turnDeadline: 1000,
    players: [
      { playerId: "a", displayName: "A", connected: true, x: 0, y: 0 },
      { playerId: "b", displayName: "B", connected: false, x: 0, y: 0 },
    ],
    game: { score: 0 },
  };
}

describe("hosted rules", () => {
  it("takes only the game's part of a hosting player's answer", () => {
    const forged: MultiplayerGameState = {
      ...room("finished"),
      ownerId: "intruder",
      currentPlayerId: "b",
      winnerPlayerId: "intruder",
      winnerPlayerIds: ["a", "intruder"],
      players: [
        { playerId: "a", displayName: "Renamed", connected: false, x: 7, y: 8 },
        { playerId: "intruder", displayName: "Intruder", connected: true, x: 1, y: 1 },
      ],
      game: { score: 99 },
    };
    const merged = mergeHostState(forged, room("playing"), room("playing"));
    // Seats, names, connections and the owner stay the room's; winners must hold a seat.
    expect(merged.ownerId).toBe("a");
    expect(merged.players).toEqual([
      { playerId: "a", displayName: "A", connected: true, x: 7, y: 8 },
      { playerId: "b", displayName: "B", connected: false, x: 0, y: 0 },
    ]);
    expect(merged.winnerPlayerIds).toEqual(["a"]);
    expect(merged.winnerPlayerId).toBe("");
    expect(merged).toMatchObject({ phase: "finished", currentPlayerId: "b", game: { score: 99 } });

    // A host cannot close the room, and the room's own phase change wins over a late answer.
    expect(mergeHostState({ ...forged, phase: "closed" }, room("playing"), room("playing")).phase).toBe("playing");
    expect(mergeHostState(forged, room("lobby"), room("playing")).phase).toBe("lobby");
    // A realtime tick changes the phase only while a round plays.
    expect(mergeHostState(forged, room("playing")).phase).toBe("finished");
    expect(mergeHostState({ ...forged, phase: "playing" }, room("finished")).phase).toBe("finished");
  });

  it("applies a command as the service would, with its seat check and the rules' refusal", () => {
    const adapter = compileGame(defineGame({
      players: { min: 2, max: 2 },
      setup: () => ({ moves: 0 }),
      moves: { go: (G: { moves: number }) => void G.moves++ },
    }));
    const lobby = { ...room("lobby"), currentPlayerId: "" };
    delete lobby.game;
    const start = { commandId: "s", expectedSequence: 0, type: "start" as const };
    expect(runHostRequest(adapter, { requestId: "1", kind: "command", playerId: "a", command: start, state: lobby, now: 0 }, false))
      .toEqual({ requestId: "1", error: "This game needs exactly 2 connected players to start." });
    const both = { ...lobby, players: lobby.players.map((player) => ({ ...player, connected: true })) };
    const started = runHostRequest(adapter, { requestId: "2", kind: "command", playerId: "a", command: start, state: both, now: 0 }, false);
    expect(started.state).toMatchObject({ phase: "playing", currentPlayerId: "a", game: { moves: 0 } });
    const late = runHostRequest(adapter, {
      requestId: "3",
      kind: "command",
      playerId: "b",
      command: { commandId: "g", expectedSequence: 1, type: "action", payload: { action: "go" } },
      state: started.state!,
      now: 0,
    }, false);
    expect(late).toEqual({ requestId: "3", error: "It is another player's turn." });
  });

  it("shows each tick of its loop at once and makes up ticks a held-back timer missed", () => {
    vi.useFakeTimers();
    try {
      const adapter = compileGame(defineRealtimeGame({
        players: { min: 1, max: 2 },
        tickMs: 100,
        setup: () => ({ ticks: 0 }),
        input: (value) => ({ go: value.go === true }),
        tick: (G: { ticks: number }) => void G.ticks++,
      }));
      const sent: number[] = [];
      const shown: number[] = [];
      const ticks = (state: MultiplayerGameState) => (state.game as { ticks: number }).ticks;
      const loop = new HostLoop(adapter, 100, false, (state) => sent.push(ticks(state)), (state) => shown.push(ticks(state)));
      loop.start({ ...room("playing"), game: { ticks: 0 } });
      expect(shown).toEqual([0]);
      vi.advanceTimersByTime(200);
      expect(sent).toEqual([1, 2]);
      // The page's timer slept for most of a second, as a hidden page's does: the next
      // wake-up makes up the ticks, at most five, and sends only the result.
      vi.setSystemTime(Date.now() + 700);
      vi.advanceTimersByTime(100);
      expect(sent).toEqual([1, 2, 7]);
      expect(shown).toEqual([0, 1, 2, 7]);
      vi.advanceTimersByTime(100);
      expect(sent.at(-1)).toBe(8);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the host's rules ahead for another player, so their own input shows at once", () => {
    const adapter = compileGame(defineRealtimeGame({
      players: { min: 2, max: 2 },
      tickMs: 100,
      setup: () => ({ x: {} as Record<string, number> }),
      input: (value) => ({ dx: Number(value.dx) }),
      tick(G: { x: Record<string, number> }, ctx, inputs) {
        for (const id of ctx.players) G.x[id] = (G.x[id] ?? 0) + (inputs[id]?.dx ?? 0);
      },
    }));
    const predictor = new Predictor(adapter, 100, () => "b");
    const at = (x: Record<string, number>) => ({ ...room("playing"), players: room("playing").players.map((player) => ({ ...player, playerId: player.playerId })), game: { x } });
    const x = (state: MultiplayerGameState) => (state.game as { x: Record<string, number> }).x;
    // Before a round trip is measured there is nothing to predict with.
    expect(x(predictor.receive(at({ a: 0, b: 0 }), { inputs: {}, acks: {} }, 0))).toEqual({ a: 0, b: 0 });
    predictor.sentInput(0, { dx: 1 }, 0);
    // The host read input 0 in a state that took 300 ms to come back: the page shows three
    // ticks further on, with its own input and the other player's last one.
    const shown = predictor.receive(at({ a: 3, b: 2 }), { inputs: { a: { dx: 1 }, b: { dx: 1 } }, acks: { b: 0 } }, 300);
    expect(predictor.latency).toBe(300);
    expect(x(shown)).toEqual({ a: 6, b: 5 });
    expect(x(predictor.advance(400)!)).toEqual({ a: 7, b: 6 });
    // A new input counts from the next tick shown, not a round trip later.
    predictor.sentInput(1, { dx: -1 }, 400);
    expect(x(predictor.advance(400)!)).toEqual({ a: 7, b: 4 });
    // Unchanged, it shows nothing new; after the round, nothing at all.
    expect(predictor.advance(400)).toBeUndefined();
    expect(predictor.receive({ ...at({ a: 9, b: 9 }), phase: "finished" }, { inputs: {}, acks: {} }, 500).phase).toBe("finished");
    expect(predictor.advance(600)).toBeUndefined();
  });
});
