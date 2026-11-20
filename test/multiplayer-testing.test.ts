import { describe, expect, it } from "vitest";
import { defineGame, defineRealtimeGame } from "@ohmygame/game-sdk/game";
import { runRulesTests, SIMULATED_ROUND_RESTART_MS, simulateRoom, test } from "@ohmygame/game-sdk/testing";

/** Each player is dealt cards from a shuffled deck; on their turn they play one, and the first to empty their hand wins. */
const cards = defineGame({
  players: { min: 2, max: 3 },
  turnSeconds: 30,
  setup: (ctx) => {
    const deck = ctx.shuffle([1, 2, 3, 4, 5, 6]);
    return { hands: Object.fromEntries(ctx.players.map((id, index) => [id, deck.slice(index * 2, index * 2 + 2)])), pile: [] as number[], missed: [] as string[] };
  },
  moves: {
    play(G, ctx, { card }: { card: number }) {
      const hand = G.hands[ctx.playerId]!;
      if (!hand.includes(card)) throw new Error("You do not hold that card.");
      G.hands[ctx.playerId] = hand.filter((held) => held !== card);
      G.pile.push(card);
    },
    chat: { by: "any", run(G) { return G; } },
  },
  endIf: (G) => {
    const winner = Object.keys(G.hands).find((id) => G.hands[id]!.length === 0);
    return winner ? { winners: [winner] } : undefined;
  },
  timeout(G, ctx) {
    G.missed.push(ctx.playerId);
  },
  playerView: (G, _ctx, playerId) => ({
    hand: playerId ? G.hands[playerId] : [],
    others: Object.fromEntries(Object.entries(G.hands).filter(([id]) => id !== playerId).map(([id, hand]) => [id, hand.length])),
    pile: G.pile,
  }),
});

describe("simulated rooms for turn-based rules", () => {
  it("plays moves through the room, refusing what the rules and the room refuse", () => {
    const room = simulateRoom(cards, { players: ["a"] });
    expect(() => room.start()).toThrow("needs 2 to 3 connected players");
    room.join("b");
    expect(() => room.start("b")).toThrow("Only the room owner can start the match.");
    room.start();
    expect(room.phase).toBe("playing");
    expect(room.currentPlayer).toBe("a");

    const before = room.game;
    const [first] = (room.game!.hands as Record<string, number[]>).a!;
    expect(() => room.move("b", "play", { card: 1 })).toThrow("It is another player's turn.");
    expect(() => room.move("a", "play", { card: 99 })).toThrow("You do not hold that card.");
    expect(() => room.move("a", "fly")).toThrow("This game has no such move.");
    // A refused move leaves the room as it was.
    expect(room.game).toEqual(before);
    expect(room.currentPlayer).toBe("a");

    room.move("a", "play", { card: first });
    expect(room.currentPlayer).toBe("b");
    // A move anyone may make leaves the turn where it is.
    room.move("a", "chat");
    expect(room.currentPlayer).toBe("b");
    expect(() => room.join("c")).toThrow("This game has already started.");
  });

  it("shows each player only their own hand", () => {
    const room = simulateRoom(cards, { players: ["a", "b", "c"] }).start();
    const hands = room.game!.hands as Record<string, number[]>;
    expect(room.view("a")).toEqual({ hand: hands.a, others: { b: 2, c: 2 }, pile: [] });
    expect(JSON.stringify(room.view("b"))).not.toContain(JSON.stringify(hands.a));
    expect(room.view()).toEqual({ hand: [], others: { a: 2, b: 2, c: 2 }, pile: [] });
  });

  it("ends the match with the rules' result and restarts it", () => {
    const room = simulateRoom(cards, { players: ["a", "b"] }).start();
    const hands = () => room.game!.hands as Record<string, number[]>;
    for (const id of ["a", "b", "a"]) room.move(id, "play", { card: hands()[id]![0]! });
    expect(room.phase).toBe("finished");
    expect(room.winners).toEqual(["a"]);
    expect(() => room.move("b", "play", { card: hands().b![0]! })).toThrow("The match has ended.");
    room.restart();
    expect(room.phase).toBe("playing");
    expect(room.winners).toEqual([]);
  });

  it("times out turns on the room's clock", () => {
    const room = simulateRoom(cards, { players: ["a", "b"], now: 1_000 }).start();
    room.advance(29_999);
    expect(room.game!.missed).toEqual([]);
    room.advance(1);
    expect(room.game!.missed).toEqual(["a"]);
    expect(room.currentPlayer).toBe("b");
    // Each deadline that passes is a turn missed.
    room.advance(60_000);
    expect(room.game!.missed).toEqual(["a", "b", "a"]);
    expect(room.now).toBe(91_000);
  });

  it("draws the same random numbers for the same seed", () => {
    const deal = (seed: number) => simulateRoom(cards, { players: ["a", "b", "c"], seed }).start().game;
    expect(deal(7)).toEqual(deal(7));
    expect([1, 2, 3, 4, 5].map((seed) => JSON.stringify(deal(seed)))).not.toEqual(Array(5).fill(JSON.stringify(deal(1))));
    // The seed is the simulation's, not the game's.
    expect(simulateRoom(cards, { players: ["a", "b"] }).start().state).not.toHaveProperty("seed");
  });

  it("keeps a disconnected player's seat during a match and frees it before one", () => {
    const room = simulateRoom(cards, { players: ["a", "b", "c"] });
    room.leave("c");
    expect(room.players).toEqual(["a", "b"]);
    room.start();
    room.leave("b");
    expect(room.players).toEqual(["a", "b"]);
    expect(room.connected).toEqual(["a"]);
    expect(() => room.move("b", "chat")).toThrow("b is not connected.");
    room.join("b");
    room.move("b", "chat");
  });
});

/** Players walk on a line toward a goal at 10; a dash jumps them 3. The first to reach it wins. */
const race = defineRealtimeGame({
  players: { min: 2, max: 4 },
  tickMs: 100,
  setup: (ctx, previous?: { x: Record<string, number>; rounds: number }) => ({
    x: Object.fromEntries(ctx.players.map((id) => [id, 0])),
    rounds: (previous?.rounds ?? 0) + 1,
  }),
  input(value) {
    if (value.dir !== -1 && value.dir !== 0 && value.dir !== 1) throw new Error("dir must be -1, 0 or 1.");
    return { dir: value.dir as number };
  },
  action(value) {
    if (value.dash !== true) throw new Error("Only dashes.");
    return { dash: true };
  },
  tick(G, _ctx, inputs, _dt, actions) {
    for (const [id, input] of Object.entries(inputs)) G.x[id] = (G.x[id] ?? 0) + input.dir;
    for (const { playerId } of actions) G.x[playerId] = (G.x[playerId] ?? 0) + 3;
  },
  join(G, _ctx, playerId) {
    G.x[playerId] = 0;
  },
  leave(G, _ctx, playerId) {
    delete G.x[playerId];
  },
  endIf: (G) => {
    const winner = Object.keys(G.x).find((id) => G.x[id]! >= 10);
    return winner ? { winners: [winner] } : undefined;
  },
});

describe("simulated rooms for realtime rules", () => {
  it("steps the rules with each player's latest input and every action once", () => {
    const room = simulateRoom(race, { players: ["a", "b"] }).start();
    expect(() => room.input("a", { dir: 2 })).toThrow("dir must be -1, 0 or 1.");
    expect(() => room.action("a", { jump: true })).toThrow("Only dashes.");
    expect(() => room.move("a", "walk")).toThrow("Realtime rules take input and actions");
    room.input("a", { dir: 1 }).action("b", { dash: true }).tick(2);
    expect(room.game!.x).toEqual({ a: 2, b: 3 });
    expect(room.now).toBe(200);
  });

  it("drops an input once its player misses five ticks", () => {
    const room = simulateRoom(race, { players: ["a", "b"] }).start();
    room.input("a", { dir: 1 }).advance(1_000);
    // 100 ms ticks: the input counts for the ticks up to 500 ms after it was sent.
    expect(room.game!.x).toEqual({ a: 5, b: 0 });
  });

  it("restarts a finished drop-in round and lets players come and go", () => {
    const room = simulateRoom(race, { players: ["a"], dropIn: true });
    expect(room.phase).toBe("lobby");
    room.join("b");
    expect(room.phase).toBe("playing");
    expect(room.owner).toBe("");
    room.join("c");
    expect(room.game!.x).toEqual({ a: 0, b: 0, c: 0 });
    room.leave("c");
    expect(room.game!.x).toEqual({ a: 0, b: 0 });

    for (let index = 0; index < 4; index++) room.action("a", { dash: true }).tick();
    expect(room.phase).toBe("finished");
    expect(room.winners).toEqual(["a"]);
    room.advance(SIMULATED_ROUND_RESTART_MS - 100);
    expect(room.phase).toBe("finished");
    room.advance(100);
    expect(room.phase).toBe("playing");
    expect(room.game).toEqual({ x: { a: 0, b: 0 }, rounds: 2 });

    room.leave("b");
    expect(room.phase).toBe("lobby");
  });
});

describe("rules tests", () => {
  it("leaves the running to a runner that collects them, and keeps going after a failure", async () => {
    const scope = globalThis as { __OHMYGAME_RULES_TESTS__?: { tests: { name: string; run: () => unknown }[] } };
    scope.__OHMYGAME_RULES_TESTS__ = { tests: [] };
    try {
      test("passes", () => {});
      test("fails", () => { throw new Error("Wrong winner."); });
      test("waits", async () => { await Promise.resolve(); });
      expect(() => test("", () => {})).toThrow("test takes a name and a function.");
      const started: string[] = [];
      const results = await runRulesTests(scope.__OHMYGAME_RULES_TESTS__.tests as never, (name) => started.push(name));
      expect(started).toEqual(["passes", "fails", "waits"]);
      expect(results.map(({ name, ok, error }) => ({ name, ok, error }))).toEqual([
        { name: "passes", ok: true, error: undefined },
        { name: "fails", ok: false, error: "Wrong winner." },
        { name: "waits", ok: true, error: undefined },
      ]);
    } finally {
      delete scope.__OHMYGAME_RULES_TESTS__;
    }
  });
});
