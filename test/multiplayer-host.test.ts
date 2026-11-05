import { describe, expect, it, vi } from "vitest";
import { HostLoop, mergeHostState, runHostRequest } from "@ohmygame/sdk/host";
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
});
