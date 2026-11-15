import { describe, expect, it, vi } from "vitest";
import { HostLoop, mergeHostState, runHostRequest } from "@ohmygame/sdk/host";
import { compileGame, defineGame, defineRealtimeGame } from "@ohmygame/server";
import type { LockstepFrame, MultiplayerGameState } from "@ohmygame/sdk/protocol";
import { LockstepRunner } from "../packages/sdk/src/lockstep.js";
import { OwnPrediction } from "../packages/sdk/src/prediction.js";
import { createBuiltInAdapter } from "@ohmygame/games";

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

describe("lockstep rules", () => {
  it("shows a player's own input before its frame arrives, and corrects a guess about others", () => {
    const adapter = compileGame(defineRealtimeGame({
      players: { min: 1, max: 2 },
      tickMs: 100,
      setup: (ctx) => ({ x: Object.fromEntries(ctx.players.map((id) => [id, 0])) as Record<string, number> }),
      input: (value) => ({ dx: Number(value.dx) }),
      tick(G: { x: Record<string, number> }, ctx, inputs) {
        for (const id of ctx.players) G.x[id]! += inputs[id]?.dx ?? 0;
      },
    }));
    let now = 0;
    const shown: Record<string, number>[] = [];
    const runner = new LockstepRunner(adapter, {
      show: (state) => shown.push({ ...(state.game as { x: Record<string, number> }).x }),
      finish: () => {},
      checkpoint: () => {},
      reporter: () => false,
      resync: () => {},
      ping: () => {},
      playerId: () => "b",
      every: () => () => {},
    }, () => now);
    const x = () => shown.at(-1)!;
    const start = { ...room("playing"), players: room("playing").players.map((player) => ({ ...player, connected: true })), seed: 7 };
    runner.sync({ round: 1, tickMs: 100, start: { state: start, startedAt: 0 }, frames: [] });
    // Frames arrive 50 ms after the service sends them; player a holds dx 1 from frame 1.
    const frame = (n: number, inputs: LockstepFrame["inputs"], acks?: LockstepFrame["acks"]) => {
      now = n * 100 + 50;
      runner.receive({ round: 1, frame: n, inputs, ...(acks ? { acks } : {}) });
    };
    frame(1, { a: { dx: 1 } }, { a: 0 });
    frame(2, { a: { dx: 1 } });
    // Before the round trip is known, the page shows the newest frame.
    expect(x()).toEqual({ a: 2, b: 0 });
    runner.pong(now - 100);
    expect(runner.roundTrip).toBe(100);
    // Now it runs ahead to the frame an input sent now would count in: frame 3.
    expect((runner.shown!.game as { x: Record<string, number> }).x).toEqual({ a: 3, b: 0 });
    // b's input is for frame 4, and shows as soon as the page reaches it, before the service says so.
    expect(runner.input(0, { dx: 1 })).toEqual({ inputId: 0, frame: 4, input: { dx: 1 } });
    now = 330;
    expect((runner.shown!.game as { x: Record<string, number> }).x).toEqual({ a: 4, b: 1 });
    // The service counts it in frame 4 as asked: the frames agree with what was shown.
    frame(3, { a: { dx: 1 } });
    frame(4, { a: { dx: 1 }, b: { dx: 1 } }, { b: 0 });
    expect(runner.current!.game).toEqual({ x: { a: 4, b: 1 } });
    // a turned back in frame 5, which the guess could not know: the next frame corrects it.
    now = 520;
    expect((runner.shown!.game as { x: Record<string, number> }).x).toEqual({ a: 6, b: 3 });
    frame(5, { a: { dx: -1 }, b: { dx: 1 } }, { a: 1 });
    expect(x()).toEqual({ a: 2, b: 3 });
    // The service passes a's next input on as soon as it arrives, for frame 7: guessing up
    // to frame 8, the page turns a back at 7, so the frames that follow agree and nothing jumps.
    runner.receiveEarly({ round: 1, playerId: "a", inputId: 2, frame: 7, input: { dx: 1 } });
    now = 720;
    expect((runner.shown!.game as { x: Record<string, number> }).x).toEqual({ a: 4, b: 5 });
    frame(6, { a: { dx: -1 }, b: { dx: 1 } });
    frame(7, { a: { dx: 1 }, b: { dx: 1 } }, { a: 2 });
    expect(runner.current!.game).toEqual({ x: { a: 3, b: 4 } });
    expect(x()).toEqual({ a: 4, b: 5 });
  });
});

describe("lockstep actions", () => {
  it("shows a player's own action before its frame arrives, once, and drops one no frame carries", () => {
    const adapter = compileGame(defineRealtimeGame({
      players: { min: 1, max: 2 },
      tickMs: 100,
      setup: () => ({ jumps: {} as Record<string, number> }),
      input: () => ({}),
      action: (value) => ({ jump: value.jump === true }),
      tick(G: { jumps: Record<string, number> }, _ctx, _inputs, _dt, actions) {
        for (const { playerId } of actions) G.jumps[playerId] = (G.jumps[playerId] ?? 0) + 1;
      },
    }));
    let now = 0;
    const runner = new LockstepRunner(adapter, {
      show: () => {},
      finish: () => {},
      checkpoint: () => {},
      reporter: () => false,
      resync: () => {},
      ping: () => {},
      playerId: () => "b",
      every: () => () => {},
    }, () => now);
    const jumps = () => (runner.shown!.game as { jumps: Record<string, number> }).jumps;
    const start = { ...room("playing"), players: room("playing").players.map((player) => ({ ...player, connected: true })), seed: 7 };
    runner.sync({ round: 1, tickMs: 100, start: { state: start, startedAt: 0 }, frames: [] });
    const frame = (n: number, actions?: LockstepFrame["actions"]) => {
      now = n * 100 + 50;
      runner.receive({ round: 1, frame: n, inputs: {}, ...(actions ? { actions } : {}) });
    };
    frame(1);
    frame(2);
    runner.pong(now - 100);
    // Sent now, the jump counts in frame 4, which the page shows from 330 ms.
    runner.action({ jump: true });
    expect(jumps()).toEqual({});
    now = 330;
    expect(jumps()).toEqual({ b: 1 });
    frame(3);
    frame(4, [{ playerId: "b", action: { jump: true } }]);
    // The frame carried it: the guess does not count it a second time.
    expect(runner.current!.game).toEqual({ jumps: { b: 1 } });
    now = 520;
    expect(jumps()).toEqual({ b: 1 });
    // A jump no frame carries within the furthest the page runs ahead was refused.
    runner.action({ jump: true });
    now = 720;
    expect(jumps()).toEqual({ b: 2 });
    for (let n = 5; n <= 17; n++) frame(n);
    expect(jumps()).toEqual({ b: 1 });
  });
});

describe("predicting a player's own moves in a room the service runs", () => {
  const snapshot = (sequence: number, x: number, acks?: number[]) => ({
    roomId: "r", gameId: "g", deploymentId: "d", mode: "realtime" as const, sequence, serverTime: new Date().toISOString(),
    state: { ...room("playing"), players: [{ playerId: "a", displayName: "A", connected: true, x, y: 50 }] },
    ...(acks ? { acks } : {}),
  });

  it("steps each input at once, and replays the ones the service has not read on its snapshots", () => {
    // Roam walks 12 units a second: 0.6 a 50 ms tick.
    const prediction = new OwnPrediction(createBuiltInAdapter("roam"), { playerId: () => "a", tickMs: () => 50 });
    prediction.confirm(snapshot(1, 50));
    prediction.sent(0, { x: 1, y: 0 });
    prediction.sent(1, { x: 1, y: 0 });
    expect(prediction.state!.players[0]!.x).toBeCloseTo(51.2);
    // The service read input 0; input 1 is replayed on its position.
    prediction.confirm(snapshot(2, 50.6, [0]));
    expect(prediction.state!.players[0]!.x).toBeCloseTo(51.2);
    // Where the service disagrees, its position wins.
    prediction.confirm(snapshot(3, 50.5, [0]));
    expect(prediction.state!.players[0]!.x).toBeCloseTo(51.1);
    prediction.confirm(snapshot(4, 51.1, [1]));
    expect(prediction.state!.players[0]!.x).toBeCloseTo(51.1);
    // A snapshot without acks, such as a seat taken, keeps the last one.
    prediction.sent(2, { x: 1, y: 0 });
    prediction.confirm(snapshot(5, 51.1));
    expect(prediction.state!.players[0]!.x).toBeCloseTo(51.7);
    // Outside a round nothing is guessed.
    prediction.confirm({ ...snapshot(6, 51.1), state: { ...snapshot(6, 51.1).state, phase: "finished" } });
    expect(prediction.state!.phase).toBe("finished");
  });
});
