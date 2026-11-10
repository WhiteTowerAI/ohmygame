import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { Client, Room } from "@colyseus/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileGame, createMultiplayerServer, defineGame, defineRealtimeGame, MemoryGameDataStore, startDevServer } from "@ohmygame/server";
import { resolveGameAdapter, type GameAdapter } from "@ohmygame/server/adapters";
import { loadRulesDefinition } from "../packages/server/src/dev.js";
import { createBuiltInAdapter, createBuiltInAdapters, gomokuRules } from "@ohmygame/games";
import { MultiplayerClient } from "../src/renderer/multiplayer-client.js";
import { isGomokuState } from "@ohmygame/games/gomoku";
import { LocalMultiplayerRuntime } from "../src/daemon/local-multiplayer.js";
import { FakePeerConnection } from "./fake-peer-connection.js";
import {
  applyStateChanges,
  multiplayerRoomType,
  type MultiplayerManifestConfig,
  type MultiplayerSnapshot,
  type SnapshotDelta,
  type TurnCommand,
  type TurnCommandResult,
} from "@ohmygame/sdk/protocol";

const config: MultiplayerManifestConfig = {
  enabled: true,
  mode: "turn-based",
  gameId: "stones",
  deploymentId: "v1",
  protocolVersion: 1,
  serverUrl: "https://games.example.test",
  authPolicy: "guest-or-account",
  roomPolicy: "invite-or-public",
  maxClients: 3,
  reconnectSeconds: 2,
  adapterId: "stones",
};
type Peer = {
  room: Room;
  snapshot?: MultiplayerSnapshot;
  ready?: { playerId: string; inviteCode?: string };
  results: TurnCommandResult[];
};
const wait = (assertion: () => unknown) =>
  vi.waitFor(assertion, { timeout: 5000, interval: 10 });
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    key: (index) => [...entries.keys()][index] ?? null,
  };
}

describe("multiplayer service over HTTP and WebSocket", () => {
  let directory: string;
  let service: ReturnType<typeof createMultiplayerServer>;
  let endpoint: string;
  let peers: Peer[];
  let wrappers: MultiplayerClient[];
  const deployments = [
    config,
    { ...config, deploymentId: "v2" },
    { ...config, gameId: "private", roomPolicy: "invite-only" as const },
    { ...config, gameId: "arena", mode: "realtime" as const, adapterId: "arena" },
    { ...config, gameId: "gomoku", adapterId: "gomoku", maxClients: 2 },
  ];
  async function start() {
    service = createMultiplayerServer({
      deployments,
      adapters: createBuiltInAdapters(),
      auth: { guestSecret: "a".repeat(32) },
      databasePath: path.join(directory, "rooms.sqlite"),
      host: "127.0.0.1",
      port: 0,
      maxRooms: 10,
      logger: false,
    });
    await service.start();
    endpoint = `http://127.0.0.1:${service.port}`;
  }
  beforeEach(async () => {
    process.env.NO_PROXY = "127.0.0.1,localhost";
    peers = [];
    wrappers = [];
    directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-multiplayer-test-"),
    );
    await start();
  });
  afterEach(async () => {
    for (const wrapper of wrappers) wrapper.dispose();
    for (const { room } of peers) {
      room.reconnection.enabled = false;
      room.removeAllListeners();
      void room.leave(true).catch(() => {});
    }
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function transport(token?: string) {
    const client = new Client(endpoint);
    client.auth.token =
      token ??
      (
        (await fetch(`${endpoint}/v1/guests`, { method: "POST" }).then((r) =>
          r.json(),
        )) as { token: string }
      ).token;
    return client;
  }
  function joinOptions(settings = config) {
    return {
      gameId: settings.gameId,
      deploymentId: settings.deploymentId,
      protocolVersion: 1,
      displayName: "Player",
    };
  }
  async function peer(
    client: Client,
    settings = config,
    roomId?: string,
    roomCode?: string,
  ): Promise<Peer> {
    const room = roomId
      ? await client.joinById(roomId, { ...joinOptions(settings), roomCode })
      : await client.create(multiplayerRoomType(settings), {
          ...joinOptions(settings),
          creationKey: randomUUID(),
        });
    const result: Peer = { room, results: [] };
    room.reconnection.enabled = false;
    room.onMessage("snapshot", (value) => {
      result.snapshot = value;
    });
    // Realtime ticks arrive as changes to the snapshot before, as the SDK applies them.
    room.onMessage("snapshot.delta", (value: SnapshotDelta) => {
      if (result.snapshot?.sequence === value.base)
        result.snapshot = { ...result.snapshot, sequence: value.sequence, serverTime: value.serverTime, state: applyStateChanges(result.snapshot.state, value.changes), acks: value.acks };
    });
    room.onMessage("ready", (value) => {
      result.ready = value;
    });
    room.onMessage("event", () => {});
    room.onMessage("command.result", (value) => {
      result.results.push(value);
    });
    room.onMessage("input.error", () => {});
    room.send("sync");
    peers.push(result);
    await wait(() => {
      expect(result.snapshot).toBeDefined();
      expect(result.ready?.playerId).toBeTruthy();
    });
    return result;
  }
  async function command(
    actor: Peer,
    type: TurnCommand["type"],
    payload?: TurnCommand["payload"],
    override?: Partial<TurnCommand>,
  ) {
    const value: TurnCommand = {
      commandId: randomUUID(),
      expectedSequence: actor.snapshot!.sequence,
      type,
      ...(payload ? { payload } : {}),
      ...override,
    };
    const length = actor.results.length;
    actor.room.send("command", value);
    await wait(() => expect(actor.results.length).toBe(length + 1));
    return { value, result: actor.results.at(-1)! };
  }
  async function match(settings = config) {
    const first = await peer(await transport(), settings);
    const second = await peer(
      await transport(),
      settings,
      first.room.roomId,
      first.ready!.inviteCode,
    );
    await wait(() => expect(first.snapshot!.state.players).toHaveLength(2));
    const start = await command(first, "start");
    expect(start.result.accepted).toBe(true);
    await wait(() => expect(second.snapshot!.state.phase).toBe("playing"));
    return [first, second] as const;
  }

  const take = (count: number) => ({ action: "take", count });
  const pile = (actor: Peer) => (actor.snapshot!.state.game as { remaining: number }).remaining;

  it("runs an authoritative match and preserves both accepted and rejected results", async () => {
    const [first, second] = await match();
    expect(pile(first)).toBe(21);
    const wrongTurn = await command(second, "action", take(3));
    expect(wrongTurn.result.error?.code).toBe("not_your_turn");
    const taken = await command(first, "action", take(3));
    expect(taken.result.accepted).toBe(true);
    await wait(() => expect(pile(second)).toBe(18));
    const replay = await command(first, "action", take(3), taken.value);
    expect(replay.result).toEqual(taken.result);
    const rejectedReplay = await command(second, "action", take(3), wrongTurn.value);
    expect(rejectedReplay.result).toEqual(wrongTurn.result);
    expect(pile(first)).toBe(18);
    const stale = await command(second, "action", take(1), {
      expectedSequence: 0,
    });
    expect(stale.result.error?.code).toBe("sequence_conflict");
    let next = second;
    while (next.snapshot!.state.phase === "playing") {
      const result = await command(next, "action", take(Math.min(3, pile(next))));
      expect(result.result.accepted).toBe(true);
      await wait(() =>
        expect(first.snapshot!.sequence).toBe(result.result.sequence),
      );
      await wait(() =>
        expect(second.snapshot!.sequence).toBe(result.result.sequence),
      );
      next = next === first ? second : first;
    }
    expect(first.snapshot!.state.phase).toBe("finished");
    expect(first.snapshot!.state.winnerPlayerId).toBe(first.ready!.playerId);
    expect(first.snapshot!.state.winnerPlayerIds).toEqual([first.ready!.playerId]);
  });

  it("plays stones as defineGame moves: no pass, and the owner restarts the race once it ends", async () => {
    const [first, second] = await match();
    // Turn-based connections may send ten messages a second; pace this player's commands.
    const paced = async (...args: Parameters<typeof command>) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return command(...args);
    };
    expect((await paced(first, "action", { action: "pass" })).result.error?.message).toBe("This game has no such move.");
    expect((await paced(first, "action", take(4))).result.error?.message).toBe("Take one to three stones.");
    expect((await paced(first, "restart")).result.error?.message).toBe("Finish this match before starting another.");
    let next = first;
    while (next.snapshot!.state.phase === "playing") {
      const result = await paced(next, "action", take(Math.min(3, pile(next))));
      expect(result.result.accepted).toBe(true);
      await wait(() => expect(first.snapshot!.sequence).toBe(result.result.sequence));
      await wait(() => expect(second.snapshot!.sequence).toBe(result.result.sequence));
      next = next === first ? second : first;
    }
    const winner = first.snapshot!.state.winnerPlayerId;
    expect(first.snapshot!.state.winnerPlayerIds).toEqual([winner]);
    expect((await paced(second, "restart")).result.error?.message).toBe("Only the room owner can start the match.");
    expect((await paced(first, "start")).result.error?.message).toBe("The match has already started.");
    expect((await paced(first, "restart")).result.accepted).toBe(true);
    await wait(() => expect(second.snapshot!.state.phase).toBe("playing"));
    expect(pile(second)).toBe(21);
    expect(second.snapshot!.state.currentPlayerId).toBe(first.ready!.playerId);
    expect(second.snapshot!.state.winnerPlayerId).toBe("");
    expect(second.snapshot!.state.winnerPlayerIds).toBeUndefined();
  });

  it("lets a game's publisher register its deployment, which plays at once and outlives a restart", async () => {
    await service.stop();
    const owners = new Map([["owner-token", "game-1"]]);
    const start = () => {
      service = createMultiplayerServer({
        deployments: [],
        adapters: createBuiltInAdapters(),
        auth: { guestSecret: "a".repeat(32) },
        databasePath: path.join(directory, "registered.sqlite"),
        host: "127.0.0.1",
        port: 0,
        logger: false,
        registration: { publicUrl: "https://games.example.test", verifyOwner: async (gameId, token) => owners.get(token) === gameId, maxPerGame: 2 },
      });
      return service.start().then(() => { endpoint = `http://127.0.0.1:${service.port}`; });
    };
    await start();
    const register = (gameId: string, token: string | undefined, body: Record<string, unknown>) =>
      fetch(`${endpoint}/v1/games/${gameId}/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    const settings = { mode: "turn-based", adapterId: "stones", maxClients: 3, roomPolicy: "invite-or-public", reconnectSeconds: 120 };
    expect((await register("game-1", "someone-else", settings)).status).toBe(403);
    expect((await register("game-1", undefined, settings)).status).toBe(403);
    const created = await register("game-1", "owner-token", settings);
    expect(created.status).toBe(201);
    const deployment = await created.json() as MultiplayerManifestConfig;
    expect(deployment).toMatchObject({ gameId: "game-1", serverUrl: "https://games.example.test", authPolicy: "guest-or-account", adapterId: "stones", maxClients: 3 });
    // The same settings find the same deployment; others make a new one, up to the game's limit.
    expect(await (await register("game-1", "owner-token", settings)).json()).toEqual(deployment);
    // "public", the older name, is the same deployment.
    expect(await (await register("game-1", "owner-token", { ...settings, roomPolicy: "public" })).json()).toEqual(deployment);
    expect((await register("game-1", "owner-token", { ...settings, adapterId: "missing" })).status).toBe(400);
    expect((await register("game-1", "owner-token", { ...settings, maxClients: 2 })).status).toBe(201);
    expect((await register("game-1", "owner-token", { ...settings, maxClients: 4 })).status).toBe(409);
    expect((await register("game-1", "owner-token", { ...settings, code: "evil" })).status).toBe(400);
    // Its rooms open at once, and the deployment survives a restart.
    const [first] = await match(deployment);
    expect(first.snapshot!.state.phase).toBe("playing");
    await service.stop();
    await start();
    expect(await (await fetch(`${endpoint}/v1/games/game-1/deployments/${deployment.deploymentId}`)).json()).toEqual(deployment);
  });

  it("counts a finished built-in match for its winner on the match board", async () => {
    const store = new MemoryGameDataStore();
    const deployment = await customService("ranked-stones", createBuiltInAdapter("stones"), {}, { gameData: { store } });
    const [first, second] = await match(deployment);
    const paced = async (...args: Parameters<typeof command>) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return command(...args);
    };
    let next = first;
    while (next.snapshot!.state.phase === "playing") {
      const result = await paced(next, "action", take(Math.min(3, pile(next))));
      await wait(() => expect(first.snapshot!.sequence).toBe(result.result.sequence));
      next = next === first ? second : first;
    }
    const winner = first.snapshot!.state.winnerPlayerId;
    const boards = (store as unknown as { boards: Map<string, { scores: Map<string, { name: string; score: number; public: boolean }> }> }).boards;
    await wait(() => expect(boards.get("ranked-stones\u0000match.wins")?.scores.size).toBe(1));
    const [entry] = [...boards.get("ranked-stones\u0000match.wins")!.scores.values()];
    // Guests are counted for themselves only, as with submitted scores.
    expect(entry).toMatchObject({ score: 1, public: false, name: first.snapshot!.state.players.find((player) => player.playerId === winner)!.displayName });
  });

  it("ends a match without a winner when a removal leaves too few seats", async () => {
    const [owner, other] = await match();
    expect((await command(owner, "kick", { playerId: other.ready!.playerId })).result.accepted).toBe(true);
    await wait(() => expect(owner.snapshot!.state.phase).toBe("finished"));
    expect(owner.snapshot!.state.winnerPlayerId).toBe("");
    expect(owner.snapshot!.state.winnerPlayerIds).toEqual([]);
  });

  it("synchronizes Gomoku, rejects invalid moves, declares a winner and restarts with the score kept", async () => {
    const [black, white] = await match(deployments[4]!);
    const send: typeof command = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 120));
      return command(...args);
    };
    expect(isGomokuState(black.snapshot!.state.game)).toBe(true);
    expect((await send(white, "action", { action: "move", point: { r: 0, c: 0 } })).result.error?.code).toBe("not_your_turn");
    expect((await send(black, "action", { action: "move", point: { r: -1, c: 0 } })).result.accepted).toBe(false);
    expect((await send(black, "action", { action: "move", point: { r: 0, c: 0 }, board: [] })).result.accepted).toBe(false);
    let firstMove: TurnCommand | undefined;
    for (let column = 0; column < 5; column++) {
      const move = await send(black, "action", { action: "move", point: { r: 7, c: column } });
      expect(move.result.accepted).toBe(true);
      firstMove ??= move.value;
      await wait(() => expect(white.snapshot!.sequence).toBe(move.result.sequence));
      if (column === 0) {
        expect((await send(white, "action", { action: "move", point: { r: 7, c: 0 } })).result.accepted).toBe(false);
        expect((await send(black, "action", firstMove.payload, firstMove)).result.sequence).toBe(move.result.sequence);
      }
      if (column < 4) {
        const reply = await send(white, "action", { action: "move", point: { r: 8, c: column } });
        expect(reply.result.accepted).toBe(true);
        await wait(() => expect(black.snapshot!.sequence).toBe(reply.result.sequence));
      }
    }
    expect(white.snapshot!.state.winnerPlayerId).toBe(black.ready!.playerId);
    expect(white.snapshot!.state.phase).toBe("finished");
    expect(white.snapshot!.state.game?.winningLine).toHaveLength(5);
    expect((await send(white, "restart")).result.accepted).toBe(false);
    const reset = await send(black, "restart");
    expect(reset.result.accepted).toBe(true);
    await wait(() => expect(white.snapshot!.sequence).toBe(reset.result.sequence));
    expect(white.snapshot!.state.game?.history).toEqual([]);
    expect(white.snapshot!.state.game?.blackWins).toBe(1);
    expect(white.snapshot!.state.currentPlayerId).toBe(black.ready!.playerId);
  });

  it("protects invitations, snapshots, deployments and single control ownership", async () => {
    const privateConfig = deployments[2]!;
    const ownerTransport = await transport();
    const owner = await peer(ownerTransport, privateConfig);
    const outsider = await transport();
    await expect(
      outsider.joinById(owner.room.roomId, joinOptions(privateConfig)),
    ).rejects.toThrow();
    await expect(
      ownerTransport.joinById(owner.room.roomId, joinOptions(privateConfig)),
    ).rejects.toThrow(/another tab/);
    await expect(
      outsider.joinById(owner.room.roomId, {
        ...joinOptions(privateConfig),
        deploymentId: "v2",
        roomCode: owner.ready!.inviteCode,
      }),
    ).rejects.toThrow(/deployment/);
    const forbidden = await fetch(
      `${endpoint}/v1/rooms/${owner.room.roomId}/snapshot`,
      { headers: { Authorization: `Bearer ${outsider.auth.token}` } },
    );
    expect(forbidden.status).toBe(403);
    const allowed = await fetch(
      `${endpoint}/v1/rooms/${owner.room.roomId}/snapshot`,
      { headers: { Authorization: `Bearer ${ownerTransport.auth.token}` } },
    );
    const snapshot = await allowed.json();
    expect(allowed.status).toBe(200);
    expect(JSON.stringify(snapshot)).not.toMatch(/inviteCode|userId|token/i);
    expect(
      await fetch(`${endpoint}/v1/games/private/rooms?deploymentId=v1`).then(
        (r) => r.json(),
      ),
    ).toEqual([]);
    const resolution = await fetch(`${endpoint}/v1/rooms/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${outsider.auth.token}`,
      },
      body: JSON.stringify({
        ...joinOptions(privateConfig),
        roomCode: owner.ready!.inviteCode,
      }),
    }).then((r) => r.json());
    expect(resolution).toEqual({ roomId: owner.room.roomId });
    const joined = await peer(
      outsider,
      privateConfig,
      owner.room.roomId,
      owner.ready!.inviteCode,
    );
    expect(joined.snapshot!.state.players).toHaveLength(2);
    await wait(() => expect(owner.snapshot!.sequence).toBe(joined.snapshot!.sequence));
    expect(await command(joined, "close").then((r) => r.result.accepted)).toBe(
      false,
    );
    expect(
      await command(owner, "kick", { playerId: joined.ready!.playerId }).then(
        (r) => r.result.accepted,
      ),
    ).toBe(true);
    await wait(() => expect(owner.snapshot!.state.players).toHaveLength(1));
    await expect(
      outsider.joinById(owner.room.roomId, {
        ...joinOptions(privateConfig),
        roomCode: owner.ready!.inviteCode,
      }),
    ).rejects.toThrow(/removed/);
  });

  it("enforces concurrent seat limits without affecting another room", async () => {
    const owner = await peer(await transport());
    const clients = await Promise.all([
      transport(),
      transport(),
      transport(),
      transport(),
    ]);
    const attempts = await Promise.allSettled(
      clients.map((client) => peer(client, config, owner.room.roomId)),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    await wait(() => expect(owner.snapshot!.state.players).toHaveLength(3));
    const other = await peer(await transport());
    expect(other.snapshot!.state.players).toHaveLength(1);
  });

  it("ends a match after a removal only when the rules' minimum seats are no longer met", () => {
    const seat = (playerId: string) => ({ playerId, displayName: playerId, connected: true, x: 0, y: 0 });
    const kick = { commandId: "k", expectedSequence: 0, type: "kick" as const, payload: { playerId: "b" } };
    for (const [id, phase] of [["roam", "playing"], ["arena", "finished"]] as const) {
      const rules = createBuiltInAdapter(id);
      const state = { ...rules.initialState(), phase: "playing" as const, ownerId: "a", players: [seat("a"), seat("b")] };
      rules.validateCommand(state, "a", kick);
      const next = rules.applyCommand(state, "a", kick);
      expect(next.phase).toBe(phase);
      // Nobody won a race that ended because a player was removed.
      expect(next.winnerPlayerId).toBe("");
    }
  });

  it("checks a deployment's room size against the seats its rules declare", () => {
    const gomoku = deployments[4]!;
    const builtIn = createBuiltInAdapters();
    expect(resolveGameAdapter(gomoku, builtIn).players).toEqual({ min: 2, max: 2 });
    expect(() => resolveGameAdapter({ ...gomoku, maxClients: 3 }, builtIn)).toThrow("The gomoku rules need exactly 2 players.");
    expect(() => resolveGameAdapter({ ...gomoku, mode: "realtime" }, builtIn)).toThrow("does not match the game mode");
    // The service plays only the rules it is given.
    expect(() => resolveGameAdapter(gomoku)).toThrow("No server rules adapter registered for gomoku.");
    const trio: GameAdapter = { ...createBuiltInAdapter("stones"), players: { min: 3, max: 3 } };
    expect(resolveGameAdapter({ ...config, adapterId: "trio", maxClients: 3 }, { trio })).toBe(trio);
    expect(() => resolveGameAdapter({ ...config, adapterId: "trio", maxClients: 4 }, { trio })).toThrow("The trio rules need exactly 3 players.");
  });

  /** A service whose only deployment plays the given rules, for adapters the service does not ship. */
  async function customService(
    adapterId: string,
    adapter: GameAdapter,
    settings: Partial<MultiplayerManifestConfig>,
    serverOptions: Partial<Parameters<typeof createMultiplayerServer>[0]> = {},
  ) {
    await service.stop();
    const deployment: MultiplayerManifestConfig = { ...config, gameId: adapterId, adapterId, ...settings };
    service = createMultiplayerServer({
      ...serverOptions,
      deployments: [deployment],
      adapters: { [adapterId]: adapter },
      auth: { guestSecret: "a".repeat(32) },
      databasePath: path.join(directory, `${adapterId}.sqlite`),
      host: "127.0.0.1",
      port: 0,
      logger: false,
    });
    await service.start();
    endpoint = `http://127.0.0.1:${service.port}`;
    return deployment;
  }

  it("runs rules written with defineGame: hidden hands, the service's shuffle, typed moves and a team win", async () => {
    const hiddenHands = defineGame({
      players: { min: 3, max: 3 },
      setup(ctx) {
        const deck = ctx.shuffle([1, 2, 3, 4, 5, 6]);
        return {
          hands: Object.fromEntries(ctx.players.map((id, seat) => [id, deck.slice(seat * 2, seat * 2 + 2)])) as Record<string, number[] | number>,
          played: [] as { playerId: string; card: number }[],
          team: [ctx.players[1]!, ctx.players[2]!],
        };
      },
      moves: {
        play(G, ctx, { card }: { card: number }) {
          const hand = G.hands[ctx.playerId] as number[];
          if (!hand.includes(card)) throw new Error("That card is not in your hand.");
          hand.splice(hand.indexOf(card), 1);
          G.played.push({ playerId: ctx.playerId, card });
        },
      },
      endIf: (G) => (G.played.length === 3 ? { winners: G.team } : undefined),
      // Each player sees their own cards and only how many the others hold.
      playerView: (G, _ctx, playerId) => ({
        ...G,
        hands: Object.fromEntries(Object.entries(G.hands).map(([id, hand]) => [id, id === playerId ? hand : (hand as number[]).length])),
      }),
    });
    const deployment = await customService("hidden", compileGame(hiddenHands), { maxClients: 3 });
    const results = new Map<string, TurnCommandResult>();
    const seats = Array.from({ length: 3 }, () => {
      const wrapper = new MultiplayerClient<typeof hiddenHands>(
        { manifest: deployment, storage: memoryStorage(), identityStorage: memoryStorage(), transport: new Client(endpoint) },
        { onCommandResult: (result) => results.set(result.commandId, result) },
      );
      wrappers.push(wrapper);
      return wrapper;
    });
    const [owner, left, right] = seats as [typeof seats[0], typeof seats[0], typeof seats[0]];
    const result = (commandId: string) => vi.waitFor(() => results.get(commandId) ?? Promise.reject(new Error("pending")), { timeout: 5000, interval: 10 });
    await owner.createRoom();
    await wait(() => expect(owner.roomCode).toMatch(/^[A-F0-9]{16}$/));
    await left.joinRoom({ roomCode: owner.roomCode });
    await right.joinRoom({ roomCode: owner.roomCode });
    await wait(() => expect(owner.snapshot?.state.players).toHaveLength(3));
    expect((await result(owner.sendCommand("start"))).accepted).toBe(true);
    await wait(() => expect(seats.every((seat) => seat.snapshot?.state.phase === "playing")).toBe(true));

    type Game = ReturnType<typeof hiddenHands.setup>;
    const view = (seat: MultiplayerClient<typeof hiddenHands>) => seat.snapshot!.state.game as unknown as Game;
    const own = seats.map((seat) => view(seat).hands[seat.playerId!] as number[]);
    expect(own.flat().sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const seat of seats)
      for (const other of seats.filter((candidate) => candidate !== seat))
        expect(view(seat).hands[other.playerId!]).toBe(2);

    // Wrong turn, a card the player lacks and a move the rules do not have are rejected.
    expect((await result(left.moves.play({ card: own[1]![0]! }))).error?.code).toBe("not_your_turn");
    const missing = [1, 2, 3, 4, 5, 6].find((card) => !own[0]!.includes(card))!;
    expect((await result(owner.moves.play({ card: missing }))).error?.message).toBe("That card is not in your hand.");
    expect((await result(owner.sendCommand("action", { action: "cheat" }))).error?.message).toBe("This game has no such move.");
    if (Math.random() > 1) {
      // @ts-expect-error play takes a card number.
      owner.moves.play({ card: "ace" });
      // @ts-expect-error the rules have no such move.
      owner.moves.cheat();
      const board = null as unknown as MultiplayerClient<typeof gomokuRules>;
      // @ts-expect-error a new match is the room's restart command, not a move.
      board.moves.reset();
      board.moves.move({ point: { r: 7, c: 7 } });
      // @ts-expect-error a move needs its point.
      board.moves.move();
    }

    for (const [index, seat] of seats.entries()) {
      await wait(() => expect(seat.snapshot?.state.currentPlayerId).toBe(seat.playerId));
      expect((await result(seat.moves.play({ card: own[index]![0]! }))).accepted).toBe(true);
    }
    await wait(() => expect(owner.snapshot?.state.phase).toBe("finished"));
    expect(owner.snapshot!.state.winnerPlayerIds).toEqual([left.playerId, right.playerId]);
    expect(owner.snapshot!.state.winnerPlayerId).toBe("");
    expect((await result(owner.moves.play({ card: own[0]![1]! }))).error?.message).toBe("The match has ended.");
  });

  it("serves a game's own server/rules.ts locally and reloads it when the rules change", async () => {
    await service.stop();
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-rules-workspace-"));
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const port = (holder.address() as AddressInfo).port;
    await new Promise((resolve) => holder.close(resolve));
    const deployment: MultiplayerManifestConfig = { ...config, gameId: "counter", adapterId: "counter", maxClients: 2, serverUrl: `http://127.0.0.1:${port}` };
    await mkdir(path.join(workspace, "server"));
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "multiplayer.json"), JSON.stringify({ multiplayer: deployment }));
    // Rules may import the game's own code, and need no OhMyGame package installed.
    await writeFile(path.join(workspace, "src", "start.ts"), "export const START: number = 1;\n");
    const rules = (start: string) => `import { defineGame } from "@ohmygame/server";
import { START } from "../src/start.ts";
export default defineGame({
  players: { min: 1, max: 2 },
  setup: () => ({ count: ${start} }),
  moves: { add(G: { count: number }, _ctx, { by }: { by: number }) { G.count += by; } },
});
`;
    await writeFile(path.join(workspace, "server", "rules.ts"), rules("START"));
    const logs: string[] = [];
    const dev = await startDevServer({ workspace, log: (message) => logs.push(message) });
    const play = async () => {
      const client = new MultiplayerClient({ manifest: deployment, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() });
      wrappers.push(client);
      await client.createRoom();
      await wait(() => expect(client.snapshot?.state.phase).toBe("lobby"));
      client.sendCommand("start");
      await wait(() => expect(client.snapshot?.state.phase).toBe("playing"));
      return client;
    };
    try {
      const first = await play();
      expect(first.snapshot!.state.game).toEqual({ count: 1 });
      first.moves.add({ by: 2 });
      await wait(() => expect(first.snapshot!.state.game).toEqual({ count: 3 }));
      first.dispose();

      await writeFile(path.join(workspace, "server", "rules.ts"), rules("100"));
      await wait(() => expect(logs.some((line) => line.startsWith("Rules reloaded"))).toBe(true));
      expect((await play()).snapshot!.state.game).toEqual({ count: 100 });

      await writeFile(path.join(workspace, "server", "rules.ts"), "export default {");
      await wait(() => expect(logs.some((line) => line.startsWith("The rules did not load"))).toBe(true));
      expect((await fetch(`${deployment.serverUrl}/healthz`)).ok).toBe(true);
    } finally {
      await dev.stop();
    }

    // A rules file needs an adapter ID no registered rules use, and an unregistered ID needs a rules file.
    await writeFile(path.join(workspace, "server", "rules.ts"), rules("1"));
    await writeFile(path.join(workspace, "multiplayer.json"), JSON.stringify({ multiplayer: { ...deployment, adapterId: "gomoku" } }));
    await expect(startDevServer({ workspace, watch: false, adapters: createBuiltInAdapters() })).rejects.toThrow("needs its own adapterId");
    await rm(path.join(workspace, "server"), { recursive: true });
    await writeFile(path.join(workspace, "multiplayer.json"), JSON.stringify({ multiplayer: deployment }));
    await expect(startDevServer({ workspace, watch: false })).rejects.toThrow("Write server/rules.ts");
    await rm(workspace, { recursive: true, force: true });
    await start();
  });

  it("starts a match only once the rules' minimum players are connected", async () => {
    const trio = await customService("trio", { ...createBuiltInAdapter("stones"), players: { min: 3, max: 3 } }, { maxClients: 3 });
    const owner = await peer(await transport(), trio);
    await peer(await transport(), trio, owner.room.roomId, owner.ready!.inviteCode);
    await wait(() => expect(owner.snapshot!.state.players).toHaveLength(2));
    const early = await command(owner, "start");
    expect(early.result.error?.message).toBe("This game needs exactly 3 connected players to start.");
    await peer(await transport(), trio, owner.room.roomId, owner.ready!.inviteCode);
    await wait(() => expect(owner.snapshot!.state.players).toHaveLength(3));
    expect((await command(owner, "start")).result.accepted).toBe(true);
  });

  it("sends each player only the state the rules let them see", async () => {
    const rules = createBuiltInAdapter("stones");
    const hands: GameAdapter = {
      ...rules,
      // The room sets up each round through onRoundStart, after the start command.
      onRoundStart: (state) => ({
        ...state,
        game: { hands: Object.fromEntries(state.players.map((p) => [p.playerId, [`secret-${p.playerId}`]])) },
      }),
      viewFor(state, playerId) {
        const all = (state.game?.hands ?? {}) as Record<string, string[]>;
        if (!state.game) return state;
        return {
          ...state,
          game: {
            hands: playerId && all[playerId] ? { [playerId]: all[playerId] } : {},
            handSizes: Object.fromEntries(Object.entries(all).map(([id, cards]) => [id, cards.length])),
          },
        };
      },
    };
    const deployment = await customService("hands", hands, { maxClients: 3 });
    const ownerTransport = await transport();
    const owner = await peer(ownerTransport, deployment);
    const guest = await peer(await transport(), deployment, owner.room.roomId, owner.ready!.inviteCode);
    const received = { owner: [] as string[], guest: [] as string[] };
    owner.room.onMessage("snapshot", (value) => received.owner.push(JSON.stringify(value)));
    guest.room.onMessage("snapshot", (value) => received.guest.push(JSON.stringify(value)));
    await wait(() => expect(owner.snapshot!.state.players).toHaveLength(2));
    expect((await command(owner, "start")).result.accepted).toBe(true);
    const ownerId = owner.ready!.playerId;
    const guestId = guest.ready!.playerId;
    await wait(() => expect(guest.snapshot!.state.game).toEqual({
      hands: { [guestId]: [`secret-${guestId}`] },
      handSizes: { [ownerId]: 1, [guestId]: 1 },
    }));
    await wait(() => expect(owner.snapshot!.state.game?.hands).toEqual({ [ownerId]: [`secret-${ownerId}`] }));
    // No message, including the ones sent before and after the deal, carries another seat's hand.
    expect(received.owner.join("")).not.toContain(`secret-${guestId}`);
    expect(received.guest.join("")).not.toContain(`secret-${ownerId}`);
    const http = await fetch(`${endpoint}/v1/rooms/${owner.room.roomId}/snapshot`, {
      headers: { Authorization: `Bearer ${ownerTransport.auth.token}` },
    }).then((response) => response.json()) as MultiplayerSnapshot;
    expect(http.state.game?.hands).toEqual({ [ownerId]: [`secret-${ownerId}`] });
  });

  /** A realtime drop-in deployment of the arena rules, or of rules built on them. */
  function dropIn(
    settings: Partial<MultiplayerManifestConfig> = {},
    serverOptions: Partial<Parameters<typeof createMultiplayerServer>[0]> = {},
    adapter = createBuiltInAdapter("arena"),
  ) {
    return customService("drop", adapter, { mode: "realtime", roomPolicy: "drop-in", maxClients: 3, ...settings }, serverOptions);
  }
  function player(
    manifest: MultiplayerManifestConfig,
    options: Partial<ConstructorParameters<typeof MultiplayerClient>[0]> = {},
    callbacks: ConstructorParameters<typeof MultiplayerClient>[1] = {},
  ) {
    const wrapper = new MultiplayerClient({
      manifest,
      storage: memoryStorage(),
      identityStorage: memoryStorage(),
      transport: new Client(endpoint),
      // Other tests leave players alone on purpose; only the merge tests let them move.
      mergeCheckMs: 60_000,
      ...options,
    }, callbacks);
    wrappers.push(wrapper);
    return wrapper;
  }

  it("quick play fills the open room, opens another when it is full, and joins a round in progress", async () => {
    const deployment = await dropIn();
    const [first, second, third, fourth] = [player(deployment), player(deployment), player(deployment), player(deployment)];
    await first.quickPlay({ displayName: "First" });
    await wait(() => expect(first.snapshot?.state.phase).toBe("lobby"));
    expect(first.snapshot!.state.ownerId).toBe("");
    await second.quickPlay();
    expect(second.roomId).toBe(first.roomId);
    // The second seat meets the arena's minimum, so the room starts the round itself.
    await wait(() => expect(first.snapshot?.state.phase).toBe("playing"));
    await third.quickPlay();
    expect(third.roomId).toBe(first.roomId);
    await wait(() => expect(third.snapshot?.state.players).toHaveLength(3));
    expect(third.snapshot!.state.phase).toBe("playing");
    await wait(() => expect(third.roomCode).toMatch(/^[A-F0-9]{16}$/));
    for (const seat of third.snapshot!.state.players)
      expect(Math.hypot(seat.x - 50, seat.y - 50)).toBeCloseTo(35);
    await fourth.quickPlay();
    expect(fourth.roomId).not.toBe(first.roomId);
    await wait(() => expect(fourth.snapshot?.state.players).toHaveLength(1));
    await expect(player(config).quickPlay()).rejects.toThrow("drop-in deployment");
  });

  it("opens only the rooms that simultaneous quick plays need", async () => {
    const deployment = await dropIn();
    const players = Array.from({ length: 7 }, () => player(deployment));
    await Promise.all(players.map((wrapper) => wrapper.quickPlay()));
    const rooms = new Map<string, number>();
    for (const wrapper of players) rooms.set(wrapper.roomId!, (rooms.get(wrapper.roomId!) ?? 0) + 1);
    expect([...rooms.values()].sort()).toEqual([1, 3, 3]);
  });

  it("holds a reconnecting seat, then frees it for a newcomer", async () => {
    const deployment = await dropIn({ maxClients: 2, reconnectSeconds: 1 });
    const [first, second] = [player(deployment), player(deployment)];
    await first.quickPlay();
    await second.quickPlay();
    await wait(() => expect(first.snapshot?.state.phase).toBe("playing"));
    await wait(() => expect(first.roomCode).toBeTruthy());
    second.dispose();
    await wait(() => expect(first.snapshot?.state.players.filter((p) => p.connected)).toHaveLength(1));
    const elsewhere = player(deployment);
    await elsewhere.quickPlay();
    expect(elsewhere.roomId).not.toBe(first.roomId);
    // An invitation to a full room fails instead of moving the friend to another room.
    await expect(player(deployment).joinRoom({ roomCode: first.roomCode })).rejects.toThrow();
    await wait(() => expect(first.snapshot?.state.players).toHaveLength(1));
    expect(first.snapshot!.state.phase).toBe("lobby");
    const friend = player(deployment);
    await friend.joinRoom({ roomCode: first.roomCode });
    expect(friend.roomId).toBe(first.roomId);
    await wait(() => expect(first.snapshot?.state.phase).toBe("playing"));
  });

  it("restarts a finished drop-in round after a pause", async () => {
    const arena = createBuiltInAdapter("arena");
    const firstToMove: GameAdapter = {
      ...arena,
      step: (state, inputs) => inputs.size ? { ...state, phase: "finished", winnerPlayerId: [...inputs.keys()][0]! } : state,
    };
    const deployment = await dropIn({}, { roundRestartMs: 200 }, firstToMove);
    const [first, second] = [player(deployment), player(deployment)];
    await first.quickPlay();
    await second.quickPlay();
    await wait(() => expect(first.snapshot?.state.phase).toBe("playing"));
    first.sendInput({ x: 1, y: 0 });
    await wait(() => expect(second.snapshot?.state.phase).toBe("finished"));
    expect(second.snapshot!.state.winnerPlayerId).toBe(first.playerId);
    await wait(() => expect(second.snapshot?.state.phase).toBe("playing"));
    expect(second.snapshot!.state.winnerPlayerId).toBe("");
  });

  it("tells quick play when the service cannot open another room", async () => {
    const deployment = await dropIn({ maxClients: 2 }, { maxRooms: 1 });
    await player(deployment).quickPlay();
    await player(deployment).quickPlay();
    const started = Date.now();
    await expect(player(deployment, { roomLimitRetryMs: [100, 100] }).quickPlay()).rejects.toMatchObject({ code: "room_limit", message: expect.stringContaining("room limit") });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it("brings players who are each alone in a drop-in room together", async () => {
    const deployment = await dropIn({}, {}, createBuiltInAdapter("roam"));
    const [first, second] = [player(deployment, { mergeCheckMs: 200 }), player(deployment, { mergeCheckMs: 200 })];
    // A direct create opens a second room, as returning to a held seat can.
    await first.quickPlay({ displayName: "First" });
    await second.createRoom({ displayName: "Second" });
    expect(second.roomId).not.toBe(first.roomId);
    await wait(() => expect(first.roomId).toBe(second.roomId));
    await wait(() => expect(first.snapshot?.state.players.filter((p) => p.connected)).toHaveLength(2));
    // Whoever moved receives the new room's snapshot a moment after the other player sees them arrive.
    await wait(() => expect(second.snapshot?.state.players.map((p) => p.displayName).sort()).toEqual(["First", "Second"]));
    expect(first.status).toBe("connected");
    expect(second.status).toBe("connected");
  });

  it("moves only a lonely player, into the busiest room with a free seat", async () => {
    const deployment = await dropIn({}, {}, createBuiltInAdapter("roam"));
    const [host, guest] = [player(deployment, { mergeCheckMs: 200 }), player(deployment, { mergeCheckMs: 200 })];
    await host.quickPlay();
    await guest.quickPlay();
    const busy = host.roomId;
    const statuses: string[] = [];
    const loner = new MultiplayerClient(
      { manifest: deployment, storage: memoryStorage(), identityStorage: memoryStorage(), transport: new Client(endpoint), mergeCheckMs: 200 },
      { onStatus: (status) => statuses.push(status) },
    );
    wrappers.push(loner);
    await loner.createRoom();
    expect(loner.roomId).not.toBe(busy);
    await wait(() => expect(loner.roomId).toBe(busy));
    await wait(() => expect(host.snapshot?.state.players.filter((p) => p.connected)).toHaveLength(3));
    expect([host.roomId, guest.roomId]).toEqual([busy, busy]);
    // Moving rooms reconnects without reporting a closed connection to the game.
    expect(statuses).not.toContain("closed");
  });

  it("paces per-frame input to the server tick so a held key keeps a player connected", async () => {
    const deployment = await dropIn({}, {}, createBuiltInAdapter("roam"));
    const [walker, watcher] = [player(deployment), player(deployment)];
    await walker.quickPlay();
    await watcher.quickPlay();
    await wait(() => expect(watcher.snapshot?.state.players).toHaveLength(2));
    const seat = () => watcher.snapshot!.state.players.find((p) => p.playerId === walker.playerId)!;
    const start = seat().x;
    const send = vi.spyOn(Room.prototype, "send");
    try {
      // 60 calls a second, as a game loop makes while a key is held.
      const frames = setInterval(() => walker.sendInput({ x: 1, y: 0 }), 1000 / 60);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      clearInterval(frames);
      const inputs = send.mock.calls.filter(([type]) => type === "input").length;
      expect(inputs).toBeGreaterThan(30);
      expect(inputs).toBeLessThanOrEqual(42);
    } finally {
      send.mockRestore();
    }
    await wait(() => expect(seat().x - start).toBeGreaterThan(15));
    expect(seat().connected).toBe(true);
    expect(walker.status).toBe("connected");
  });

  it("closes a flooding connection at once instead of holding its seat", async () => {
    const deployment = await dropIn({ reconnectSeconds: 60 });
    const watcher = player(deployment);
    await watcher.quickPlay();
    const flooder = await (await transport()).joinOrCreate(multiplayerRoomType(deployment), joinOptions(deployment));
    peers.push({ room: flooder, results: [] });
    flooder.reconnection.enabled = false;
    let closed: number | undefined;
    flooder.onLeave((code) => {
      closed = code;
    });
    await wait(() => expect(watcher.snapshot?.state.phase).toBe("playing"));
    for (let inputId = 0; inputId < 100; inputId++) flooder.send("input", { inputId, x: 1, y: 0 });
    await wait(() => expect(closed).toBe(4002));
    await wait(() => expect(watcher.snapshot?.state.players).toHaveLength(1));
  });

  it("shows a player's own moves at once when the page passes the rules the service runs", async () => {
    const deployment = await dropIn({}, {}, createBuiltInAdapter("roam"));
    const walker = player(deployment, { rules: createBuiltInAdapter("roam") });
    await walker.quickPlay();
    await wait(() => expect(walker.snapshot?.state.phase).toBe("playing"));
    const start = walker.snapshot!.state.players[0]!.x;
    walker.sendInput({ x: 1, y: 0 });
    // Before any trip to the service: the walker has moved, and the service's room has not.
    expect(walker.snapshot!.state.players[0]!.x).toBeGreaterThan(start);
    expect(walker.confirmed!.state.players[0]!.x).toBe(start);
    const frames = setInterval(() => walker.sendInput({ x: 1, y: 0 }), 1000 / 60);
    await wait(() => expect(walker.confirmed!.state.players[0]!.x).toBeGreaterThan(start + 3));
    clearInterval(frames);
    walker.sendInput({ x: 0, y: 0 });
    // Once the service has read every input, the guess and the service agree.
    await wait(() => expect(walker.snapshot!.state.players[0]!.x).toBeCloseTo(walker.confirmed!.state.players[0]!.x, 5));
  });

  it("lets players roam a shared world that never ends", async () => {
    const deployment = await dropIn({}, {}, createBuiltInAdapter("roam"));
    const events: string[] = [];
    let snapshots = 0;
    const explorer = player(deployment, {}, { onEvent: (event) => events.push(event.type), onSnapshot: () => snapshots++ });
    await explorer.quickPlay();
    // One explorer is enough; there is nobody to wait for.
    await wait(() => expect(explorer.snapshot?.state.phase).toBe("playing"));
    const me = () => explorer.snapshot!.state.players[0]!;
    expect(Math.hypot(me().x - 50, me().y - 50)).toBeLessThanOrEqual(6.01);
    const frames = setInterval(() => explorer.sendInput({ x: -1, y: 0 }), 1000 / 60);
    await wait(() => expect(me().x).toBe(0));
    clearInterval(frames);
    explorer.sendInput({ x: 0, y: 0 });
    // Every tick that moved the explorer sent a snapshot, and no event beside it.
    expect(snapshots).toBeGreaterThan(20);
    expect(events).not.toContain("state.updated");
    // Each tick says which of the explorer's inputs it read, for the page to replay the rest.
    await wait(() => expect(explorer.snapshot!.acks![0]).toBeGreaterThan(20));
    // Walking through the centre or into the edge finishes nothing.
    expect(explorer.snapshot!.state.phase).toBe("playing");
    const friend = player(deployment);
    await friend.quickPlay();
    expect(friend.roomId).toBe(explorer.roomId);
    await wait(() => expect(friend.snapshot?.state.players).toHaveLength(2));
    expect(friend.snapshot!.state.players.find((p) => p.playerId === explorer.playerId)!.x).toBe(0);
    expect(friend.snapshot!.state.phase).toBe("playing");
  });

  it("keeps the seat of a page refreshed before the service saw its old connection close", async () => {
    const storage = memoryStorage();
    const identityStorage = memoryStorage();
    const before = new MultiplayerClient({ manifest: config, storage, identityStorage, transport: new Client(endpoint) });
    wrappers.push(before);
    await before.createRoom({ displayName: "Owner" });
    await wait(() => expect(before.playerId).toBeTruthy());
    const guest = await peer(await transport(), config, before.roomId);
    await wait(() => expect(before.snapshot?.state.players).toHaveLength(2));
    before.sendCommand("start");
    await wait(() => expect(guest.snapshot?.state.phase).toBe("playing"));
    const playerId = before.playerId;
    // The refreshed page has what the old one saved, while the old socket still looks open.
    const copy = memoryStorage();
    for (let index = 0; index < storage.length; index++) copy.setItem(storage.key(index)!, storage.getItem(storage.key(index)!)!);
    const reloaded = new Client(endpoint);
    const joinById = vi.spyOn(reloaded, "joinById");
    const after = new MultiplayerClient({ manifest: config, storage: copy, identityStorage, transport: reloaded });
    wrappers.push(after);
    expect(await after.reconnect()).toBe(true);
    // Back through its reconnection token, to the same seat, not joined again as a member.
    expect(joinById).not.toHaveBeenCalled();
    expect(after.playerId).toBe(playerId);
    await wait(() => expect(guest.snapshot!.state.players[0]).toMatchObject({ playerId, connected: true }));
  });

  it("gives a held seat to the same player joining again from a browser without the saved room", async () => {
    const identityStorage = memoryStorage();
    const owner = new MultiplayerClient({ manifest: config, storage: memoryStorage(), identityStorage, transport: new Client(endpoint) });
    wrappers.push(owner);
    await owner.createRoom({ displayName: "Owner" });
    await wait(() => expect(owner.roomCode).toBeTruthy());
    const playerId = owner.playerId;
    const roomCode = owner.roomCode!;
    const guest = await peer(await transport(), config, owner.roomId);
    await wait(() => expect(owner.snapshot?.state.players).toHaveLength(2));
    owner.sendCommand("start");
    await wait(() => expect(guest.snapshot?.state.phase).toBe("playing"));
    owner.dispose();
    await wait(() => expect(guest.snapshot!.state.players[0]!.connected).toBe(false));
    // Same account, nothing saved for the room: joining by code takes the held seat back.
    const elsewhere = new MultiplayerClient({ manifest: config, storage: memoryStorage(), identityStorage, transport: new Client(endpoint) });
    wrappers.push(elsewhere);
    await elsewhere.joinRoom({ roomCode });
    await wait(() => expect(elsewhere.playerId).toBe(playerId));
    await wait(() => expect(guest.snapshot!.state.players[0]).toMatchObject({ playerId, connected: true }));
    // The dropped connection's window ending later does not take the seat away.
    await new Promise((resolve) => setTimeout(resolve, config.reconnectSeconds * 1000 + 300));
    expect(guest.snapshot!.state.players).toHaveLength(2);
    expect(guest.snapshot!.state.players[0]).toMatchObject({ playerId, connected: true });
    elsewhere.sendCommand("action", { action: "take", count: 1 });
    await wait(() => expect((guest.snapshot?.state.game as { remaining: number } | undefined)?.remaining).toBe(20));
  });

  it("restores a refreshed browser and a persisted match after service restart", async () => {
    const storage = memoryStorage();
    const identityStorage = memoryStorage();
    const results: TurnCommandResult[] = [];
    const wrapper = new MultiplayerClient(
      {
        manifest: config,
        storage,
        identityStorage,
        transport: new Client(endpoint),
      },
      { onCommandResult: (result) => results.push(result) },
    );
    wrappers.push(wrapper);
    await wrapper.createRoom({ displayName: "Owner" });
    await wait(() => expect(wrapper.playerId).toBeTruthy());
    const guest = await peer(await transport(), config, wrapper.roomId);
    await wait(() => expect(wrapper.snapshot?.state.players).toHaveLength(2));
    wrapper.sendCommand("start");
    await wait(() => expect(wrapper.snapshot?.state.phase).toBe("playing"));
    const playerId = wrapper.playerId;
    const roomId = wrapper.roomId;
    wrapper.dispose();
    await wait(() =>
      expect(guest.snapshot!.state.players[0]!.connected).toBe(false),
    );
    const refreshed = new MultiplayerClient({
      manifest: config,
      storage,
      identityStorage,
      transport: new Client(endpoint),
    });
    wrappers.push(refreshed);
    expect(await refreshed.reconnect()).toBe(true);
    await wait(() =>
      expect(refreshed.snapshot?.state.players[0]!.connected).toBe(true),
    );
    expect(refreshed.playerId).toBe(playerId);
    expect(refreshed.roomId).toBe(roomId);
    for (const { room } of peers) room.reconnection.enabled = false;
    await service.stop();
    refreshed.dispose();
    await start();
    const restored = new MultiplayerClient({
      manifest: config,
      storage,
      identityStorage,
      transport: new Client(endpoint),
    });
    wrappers.push(restored);
    expect(await restored.reconnect()).toBe(true);
    await wait(() => expect(restored.snapshot?.state.phase).toBe("playing"));
    expect(restored.roomId).toBe(roomId);
    expect(restored.playerId).toBe(playerId);
    restored.sendCommand("action", { action: "take", count: 2 });
    await wait(() => expect((restored.snapshot?.state.game as { remaining: number } | undefined)?.remaining).toBe(19));
  });

  it("runs realtime rules at their own tick with the input shape they declare", async () => {
    const arena = createBuiltInAdapter("arena");
    const dts: number[] = [];
    // A jump counter that also counts ticks, to show the room steps a round nobody steers.
    const jumper: GameAdapter = {
      ...arena,
      tickMs: 100,
      validateInput(input) {
        if (Object.keys(input).length !== 1 || typeof input.jump !== "boolean") throw new Error("Send { jump }.");
      },
      step(state, inputs, _now, dt) {
        dts.push(dt);
        const game = (state.game ?? { ticks: 0, jumps: 0 }) as { ticks: number; jumps: number };
        const jumps = [...inputs.values()].filter(({ input }) => input.jump === true).length;
        return { ...state, game: { ticks: game.ticks + 1, jumps: game.jumps + jumps } };
      },
    };
    const deployment = await customService("jumper", jumper, { mode: "realtime", maxClients: 2 });
    const [first] = await match(deployment);
    expect(first.ready).toMatchObject({ tickMs: 100 });
    const errors: unknown[] = [];
    first.room.onMessage("input.error", (value) => errors.push(value));
    first.room.send("input", { inputId: 0, x: 1, y: 0 });
    await wait(() => expect(errors).toEqual([{ code: "invalid_command", message: "Send { jump }." }]));
    first.room.send("input", { inputId: 1, inputs: { nested: { too: { deep: { here: 1 } } } } });
    await wait(() => expect(errors).toHaveLength(2));
    first.room.send("input", { inputId: 2, jump: true });
    await wait(() => expect((first.snapshot!.state.game as { jumps: number }).jumps).toBeGreaterThan(0));
    // Without fresh input the rules still step, at 100 ms ticks of 0.1 seconds.
    const { ticks } = first.snapshot!.state.game as { ticks: number };
    await wait(() => expect((first.snapshot!.state.game as { ticks: number }).ticks).toBeGreaterThan(ticks + 2));
    expect(new Set(dts)).toEqual(new Set([0.1]));
    expect(() => resolveGameAdapter({ ...deployment, adapterId: "fast" }, { fast: { ...jumper, tickMs: 10 } })).toThrow("tickMs must be a whole number from 20 to 1000.");
  });

  it("uses bounded inputs at a fixed realtime tick and closes realtime rooms on restart", async () => {
    const arena = deployments[3]!;
    const [first] = await match(arena);
    const original = first.snapshot!.state.players[0]!;
    first.room.send("input", {
      inputId: 0,
      x: 100,
      y: 100,
      winnerPlayerId: original.playerId,
    });
    const before = first.snapshot!.sequence;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(first.snapshot!.sequence).toBe(before);
    first.room.send("input", { inputId: 1, x: 1, y: 1 });
    await wait(() =>
      expect(first.snapshot!.state.players[0]!.x).toBeGreaterThan(original.x),
    );
    const current = first.snapshot!.state.players[0]!;
    expect(
      Math.hypot(current.x - original.x, current.y - original.y),
    ).toBeLessThanOrEqual(5.01);
    for (const { room } of peers) room.reconnection.enabled = false;
    const roomId = first.room.roomId;
    await service.stop();
    await start();
    const client = await transport();
    await expect(client.joinById(roomId, joinOptions(arena))).rejects.toThrow();
  });

  it("starts one loopback service for local games and connects two independent SDK guests", async () => {
    await service.stop();
    const runtime = new LocalMultiplayerRuntime();
    const clients: MultiplayerClient[] = [];
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      const [gomoku, stones] = await Promise.all([runtime.configure("local-board", "gomoku"), runtime.configure("local-stones", "stones")]);
      expect(gomoku.serverUrl).toBe(stones.serverUrl);
      expect(await runtime.configure("local-board", "gomoku")).toEqual(gomoku);
      const owner = new MultiplayerClient({ manifest: gomoku, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() });
      const guestStorage = memoryStorage();
      const guestIdentityStorage = memoryStorage();
      const guest = new MultiplayerClient({ manifest: gomoku, allowLocalhost: true, storage: guestStorage, identityStorage: guestIdentityStorage });
      clients.push(owner, guest);
      await owner.createRoom();
      await wait(() => expect(owner.roomCode).toMatch(/^[A-F0-9]{16}$/));
      await guest.joinRoom({ roomCode: owner.roomCode });
      await wait(() => expect(owner.snapshot?.state.players).toHaveLength(2));
      await wait(() => expect(guest.playerId).toBeTruthy());
      expect(guest.playerId).not.toBe(owner.playerId);
      // Guest sessions, invitations and matchmaking all go without cookies, so a browser
      // sends them over one connection instead of opening a second for matchmaking.
      const toService = fetched.mock.calls.filter(([url]) => String(url instanceof Request ? url.url : url).startsWith(gomoku.serverUrl));
      expect(toService.map(([url]) => new URL(String(url instanceof Request ? url.url : url)).pathname)).toEqual(
        expect.arrayContaining(["/v1/guests", "/v1/rooms/resolve", expect.stringMatching(/^\/matchmake\/create\//)]),
      );
      for (const [url, init] of toService) expect([String(url), init?.credentials ?? (url instanceof Request ? url.credentials : undefined)]).toEqual([String(url), "omit"]);
      owner.sendCommand("start");
      await wait(() => expect(guest.snapshot?.state.phase).toBe("playing"));
      owner.sendCommand("action", { action: "move", point: { r: 7, c: 7 } });
      await wait(() => expect(guest.snapshot?.state.game?.history).toEqual([{ r: 7, c: 7 }]));
      guest.dispose();
      const restored = new MultiplayerClient({ manifest: gomoku, allowLocalhost: true, storage: guestStorage, identityStorage: guestIdentityStorage });
      clients.push(restored);
      expect(await restored.reconnect()).toBe(true);
      await wait(() => expect(restored.snapshot?.state.game?.history).toHaveLength(1));
    } finally {
      fetched.mockRestore();
      for (const client of clients) client.dispose();
      await runtime.close();
    }
  });

  it("keeps a fixed local address and restores a game's deployment after a restart", async () => {
    await service.stop();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const busyPort = (holder.address() as AddressInfo).port;
    const clients: MultiplayerClient[] = [];
    try {
      const before = new LocalMultiplayerRuntime(0);
      const written = await before.configure("local-restore", "arena", { dropIn: true });
      await before.close();

      // The preferred port is taken, as by a second OhMyGame, so the service listens elsewhere.
      const runtime = new LocalMultiplayerRuntime(busyPort);
      try {
        const restored = await runtime.restore("local-restore", written);
        expect(restored).toEqual({ ...written, serverUrl: expect.not.stringContaining(`:${busyPort}`) });
        const response = await fetch(new URL(`/v1/games/local-restore/deployments/${written.deploymentId}`, restored!.serverUrl));
        expect(await response.json()).toEqual(restored);
        const player = new MultiplayerClient({ manifest: restored!, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() });
        clients.push(player);
        await player.quickPlay();
        await wait(() => expect(player.snapshot?.state.players).toHaveLength(1));
        // Another game's deployment, an edited one, or one this runtime did not write stays unregistered.
        expect(await runtime.restore("other-game", written)).toBeUndefined();
        expect(await runtime.restore("local-restore", { ...written, reconnectSeconds: 60 })).toBeUndefined();
        expect(await runtime.restore("local-restore", { ...written, deploymentId: "public-v1" })).toBeUndefined();
      } finally {
        for (const client of clients) client.dispose();
        await runtime.close();
      }
    } finally {
      holder.close();
    }
  });

  it("runs a game's own rules on the owner's browser for local playtests", async () => {
    await service.stop();
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-custom-rules-"));
    const rulesFile = path.join(workspace, "server", "rules.ts");
    const rules = (start: number, players = "{ min: 2, max: 3 }") => `import { defineGame } from "../src/ohmygame/define-game.js";
export default defineGame({
  players: ${players},
  setup: (ctx) => ({ count: ${start}, seats: ctx.players.length }),
  moves: { add(G: { count: number }, _ctx, { by }: { by: number }) { G.count += by; } },
});
`;
    await mkdir(path.dirname(rulesFile));
    const runtime = new LocalMultiplayerRuntime(0);
    const clients: MultiplayerClient[] = [];
    const play = async (manifest: MultiplayerManifestConfig) => {
      // The page imports the rules file; every player passes it, and the hosting one runs it.
      const rules = await loadRulesDefinition(rulesFile);
      const [owner, guest] = [0, 1].map(() => {
        const client = new MultiplayerClient({ manifest, rules, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() });
        clients.push(client);
        return client;
      }) as [MultiplayerClient, MultiplayerClient];
      await owner.createRoom();
      await wait(() => expect(owner.roomCode).toMatch(/^[A-F0-9]{16}$/));
      await guest.joinRoom({ roomCode: owner.roomCode });
      await wait(() => expect(owner.snapshot?.state.players).toHaveLength(2));
      owner.sendCommand("start");
      await wait(() => expect(guest.snapshot?.state.phase).toBe("playing"));
      return [owner, guest] as const;
    };
    try {
      await expect(runtime.configure("cards", "custom")).rejects.toThrow("Write server/rules.ts first");
      // The rules may be written before setup copies the SDK into the game.
      await writeFile(rulesFile, rules(1));
      const config = await runtime.configure("cards", "custom", {}, rulesFile);
      expect(config).toMatchObject({ mode: "turn-based", adapterId: "host", maxClients: 3, deploymentId: "local-host-turn-based-3p-v1" });
      expect(() => new MultiplayerClient({ manifest: config, allowLocalhost: true })).toThrow(expect.objectContaining({ code: "not_configured" }));
      await expect(runtime.configure("cards", "custom", { maxClients: 4 }, rulesFile)).rejects.toThrow("2 to 3 players");
      const [owner, guest] = await play(config);
      expect(guest.snapshot!.state.game).toEqual({ count: 1, seats: 2 });
      expect(owner.hosting).toBe(true);
      expect(guest.hosting).toBe(false);
      expect(guest.snapshot!.state.hostPlayerId).toBe(owner.playerId);
      owner.moves.add({ by: 4 });
      await wait(() => expect(guest.snapshot!.state.game).toEqual({ count: 5, seats: 2 }));

      // The guest's move is applied by the owner's rules.
      guest.moves.add({ by: 2 });
      await wait(() => expect(owner.snapshot!.state.game).toEqual({ count: 7, seats: 2 }));

      // Edited rules reach the rooms of pages that load them again.
      await writeFile(rulesFile, rules(50));
      expect(await runtime.restore("cards", config, rulesFile)).toEqual(config);
      const [next] = await play(config);
      expect(next.snapshot!.state.game).toEqual({ count: 50, seats: 2 });
      await writeFile(rulesFile, "export default {");
      await expect(runtime.restore("cards", config, rulesFile)).rejects.toThrow();
      await writeFile(rulesFile, rules(1, "{ min: 9, max: 10 }"));
      await expect(runtime.configure("cards", "custom", {}, rulesFile)).rejects.toThrow("need 9 to 10 players; local rooms hold 2 to 8");
    } finally {
      for (const client of clients) client.dispose();
      await runtime.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs a realtime game written with defineRealtimeGame from a game's rules file", async () => {
    await service.stop();
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-realtime-rules-"));
    const rulesFile = path.join(workspace, "server", "rules.ts");
    await mkdir(path.dirname(rulesFile));
    // A one-row snake: it keeps its heading in G, a dash jumps it forward once, reaching the
    // wall wins the round, and wins carry over to the next round.
    await writeFile(rulesFile, `import { defineRealtimeGame } from "@ohmygame/sdk";
type Snake = { x: number; dir: "none" | "left" | "right" };
export default defineRealtimeGame({
  players: { min: 1, max: 4 },
  setup: (ctx, previous?: { snakes: Record<string, Snake>; wins: Record<string, number> }) => ({
    snakes: Object.fromEntries(ctx.players.map((id) => [id, { x: 2, dir: "none" }])) as Record<string, Snake>,
    wins: previous?.wins ?? {} as Record<string, number>,
  }),
  input(value) {
    if (value.dir !== "left" && value.dir !== "right") throw new Error("Send { dir }.");
    return { dir: value.dir as "left" | "right" };
  },
  action(value) {
    if (value.dash !== 1 && value.dash !== 2 && value.dash !== 3) throw new Error("Dash one to three cells.");
    return { dash: value.dash as 1 | 2 | 3 };
  },
  tick(G, _ctx, inputs, _dt, actions) {
    for (const [id, snake] of Object.entries(G.snakes)) {
      if (inputs[id]) snake.dir = inputs[id].dir;
      if (snake.dir !== "none") snake.x += snake.dir === "right" ? 1 : -1;
    }
    for (const { playerId, action } of actions) if (G.snakes[playerId]) G.snakes[playerId].x += action.dash;
    for (const [id, snake] of Object.entries(G.snakes)) if (snake.x >= 19) G.wins[id] = (G.wins[id] ?? 0) + 1;
  },
  join: (G, _ctx, playerId) => { G.snakes[playerId] = { x: 2, dir: "none" }; },
  leave: (G, _ctx, playerId) => { delete G.snakes[playerId]; },
  endIf: (G) => {
    const winners = Object.keys(G.snakes).filter((id) => G.snakes[id]!.x >= 19);
    return winners.length ? { winners } : undefined;
  },
});
`);
    const runtime = new LocalMultiplayerRuntime(0);
    const clients: MultiplayerClient[] = [];
    try {
      const config = await runtime.configure("snake", "custom", { dropIn: true }, rulesFile);
      // Realtime rules that hide nothing run in every player's browser, in lockstep.
      expect(config).toMatchObject({ mode: "realtime", roomPolicy: "drop-in", adapterId: "lockstep", tickMs: 50, deploymentId: "local-lockstep-50ms-4p-dropin-v1" });
      // After OhMyGame restarts, a deployment comes back at the service's address as it ran
      // its rules, so a game set up before lockstep keeps its host until it is set up again.
      const { tickMs: _tickMs, ...hosted } = { ...config, adapterId: "host", deploymentId: "local-host-realtime-4p-dropin-v1", serverUrl: "http://127.0.0.1:1" };
      expect(await runtime.restore("snake", hosted, rulesFile)).toMatchObject({ adapterId: "host", deploymentId: "local-host-realtime-4p-dropin-v1", serverUrl: config.serverUrl });
      expect(await runtime.restore("snake", { ...config, serverUrl: "http://127.0.0.1:1" }, rulesFile)).toEqual(config);
      const rules = await loadRulesDefinition(rulesFile);
      const errors: string[] = [];
      const join = () => {
        const client = new MultiplayerClient(
          { manifest: config, rules, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() },
          { onError: (error) => errors.push(error.message) },
        );
        clients.push(client);
        return client;
      };
      const game = (client: MultiplayerClient) =>
        client.snapshot?.state.game as { snakes: Record<string, { x: number }>; wins: Record<string, number> } | undefined;
      const snakes = (client: MultiplayerClient) => game(client)?.snakes ?? {};
      const [first, second] = [join(), join()];
      await first.quickPlay();
      // One player is enough to start, and a latecomer joins the running round.
      await wait(() => expect(Object.keys(snakes(first))).toEqual([first.playerId]));
      await second.quickPlay();
      expect(second.roomId).toBe(first.roomId);
      await wait(() => expect(Object.keys(snakes(first)).sort()).toEqual([first.playerId, second.playerId].sort()));
      first.sendInput({ dir: "diagonal" });
      await wait(() => expect(errors).toContain("Send { dir }."));
      await second.leave();
      await wait(() => expect(Object.keys(snakes(first))).toEqual([first.playerId]));
      // One input sets the heading; the snake keeps moving long after the input itself expires.
      first.sendInput({ dir: "right" });
      await wait(() => expect(first.snapshot?.state.phase).toBe("finished"));
      expect(first.snapshot!.state.winnerPlayerIds).toEqual([first.playerId]);
      expect(snakes(first)[first.playerId!]!.x).toBe(19);
      // The drop-in room starts the next round from setup, which keeps the wins.
      await wait(() => expect(first.snapshot?.state.phase).toBe("playing"));
      expect(snakes(first)[first.playerId!]).toEqual({ x: 2, dir: "none" });
      expect(game(first)!.wins).toEqual({ [first.playerId!]: 1 });
      // An action is read in exactly one tick: one dash moves the snake once and no more.
      expect(first.sendAction({ dash: 4 })).toBe(true);
      await wait(() => expect(errors).toContain("Dash one to three cells."));
      expect(first.sendAction({ dash: 3 })).toBe(true);
      await wait(() => expect(snakes(first)[first.playerId!]!.x).toBe(5));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(snakes(first)[first.playerId!]!.x).toBe(5);
      await first.leave();
      expect(first.sendAction({ dash: 1 })).toBe(false);

      // In a room with an owner, the owner restarts a finished round, and setup keeps the wins.
      const owned = await runtime.configure("snake", "custom", { dropIn: false }, rulesFile);
      const owner = new MultiplayerClient(
        { manifest: owned, rules, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() },
        { onError: (error) => errors.push(error.message) },
      );
      clients.push(owner);
      await owner.createRoom();
      await wait(() => expect(owner.snapshot?.state.phase).toBe("lobby"));
      owner.sendAction({ dash: 1 });
      await wait(() => expect(errors).toContain("The round is not running."));
      owner.sendCommand("start");
      await wait(() => expect(owner.snapshot?.state.phase).toBe("playing"));
      owner.sendInput({ dir: "right" });
      await wait(() => expect(owner.snapshot?.state.phase).toBe("finished"));
      // The finished round stays finished until the owner asks for another.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(owner.snapshot!.state.phase).toBe("finished");
      owner.sendCommand("restart");
      await wait(() => expect(owner.snapshot?.state.phase).toBe("playing"));
      expect(game(owner)).toEqual({ snakes: { [owner.playerId!]: { x: 2, dir: "none" } }, wins: { [owner.playerId!]: 1 } });
      expect(owner.snapshot!.state.winnerPlayerIds).toBeUndefined();
    } finally {
      for (const client of clients) client.dispose();
      await runtime.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  /** A service whose rooms run their rules on a player's browser. */
  async function hostedService(settings: Partial<MultiplayerManifestConfig>) {
    await service.stop();
    const deployment: MultiplayerManifestConfig = { ...config, gameId: "hosted", adapterId: "host", reconnectSeconds: 1, ...settings };
    service = createMultiplayerServer({
      deployments: [],
      auth: { guestSecret: "a".repeat(32) },
      databasePath: path.join(directory, `hosted-${deployment.deploymentId}.sqlite`),
      host: "127.0.0.1",
      port: 0,
      allowLocalhost: true,
      logger: false,
      roundRestartMs: 50,
    });
    await service.start();
    const manifest = { ...deployment, serverUrl: `http://127.0.0.1:${service.port}` };
    service.registerLocalDeployment(manifest);
    return manifest;
  }

  it("runs turn-based rules on the owner's browser, hides hands from others and moves hosting when the host leaves", async () => {
    const rules = defineGame({
      players: { min: 2, max: 3 },
      setup: (ctx) => ({ hands: Object.fromEntries(ctx.players.map((id) => [id, `secret-${id}`])) as Record<string, string>, turns: 0 }),
      moves: { pass(G) { G.turns++; } },
      playerView: (G, _ctx, playerId) => ({ hands: playerId ? { [playerId]: G.hands[playerId] } : {}, turns: G.turns }),
    });
    const manifest = await hostedService({ deploymentId: "turns" });
    const seen: string[] = [];
    const hosting: boolean[] = [];
    const results: TurnCommandResult[] = [];
    const owner = new MultiplayerClient({ manifest, rules, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() }, {
      onHost: (active) => hosting.push(active),
      onCommandResult: (result) => results.push(result),
    });
    const guest = new MultiplayerClient({ manifest, rules, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() }, {
      onSnapshot: (snapshot) => seen.push(JSON.stringify(snapshot)),
    });
    try {
      await owner.createRoom();
      await wait(() => expect(owner.roomCode).toMatch(/^[A-F0-9]{16}$/));
      await guest.joinRoom({ roomCode: owner.roomCode });
      await wait(() => expect(owner.snapshot?.state.players).toHaveLength(2));
      await wait(() => expect(owner.hosting).toBe(true));
      owner.sendCommand("start");
      await wait(() => expect(guest.snapshot?.state.phase).toBe("playing"));
      // Each player sees only their own hand; the host runs the rules but others never get its view.
      expect(guest.snapshot!.state.game).toEqual({ hands: { [guest.playerId!]: `secret-${guest.playerId}` }, turns: 0 });
      expect(owner.snapshot!.state.game).toEqual({ hands: { [owner.playerId!]: `secret-${owner.playerId}` }, turns: 0 });
      owner.moves.pass();
      await wait(() => expect(guest.snapshot?.state.currentPlayerId).toBe(guest.playerId));
      // Out of turn: the host's rules refuse it, with their reason.
      const refused = await new Promise<TurnCommandResult>((resolve) => {
        const id = owner.moves.pass();
        const check = setInterval(() => {
          const result = results.find((entry) => entry.commandId === id);
          if (result) {
            clearInterval(check);
            resolve(result);
          }
        }, 10);
      });
      expect(refused).toMatchObject({ accepted: false, error: { code: "not_your_turn", message: "It is another player's turn." } });

      // The host leaves mid-match: the guest takes over the rules and play goes on.
      await owner.leave();
      await wait(() => expect(guest.hosting).toBe(true));
      await wait(() => expect(guest.snapshot!.state.hostPlayerId).toBe(guest.playerId));
      guest.moves.pass();
      await wait(() => expect(guest.snapshot!.state.game).toMatchObject({ turns: 2 }));
      expect(seen.join("")).not.toContain(`secret-${owner.playerId}`);
      expect(hosting).toEqual([true, false]);
    } finally {
      owner.dispose();
      guest.dispose();
    }
  });

  it("runs realtime rules on a player's browser and keeps the round going when that player leaves", async () => {
    const rules = defineRealtimeGame({
      players: { min: 1, max: 4 },
      tickMs: 40,
      setup: () => ({ ticks: 0, boosts: 0 }),
      input: (value) => ({ go: value.go === true }),
      action: (value) => {
        if (value.boost !== true) throw new Error("Send { boost: true }.");
        return { boost: true };
      },
      tick(G, _ctx, _inputs, _dt, actions) {
        G.ticks++;
        G.boosts += actions.length;
      },
    });
    const manifest = await hostedService({ deploymentId: "ticks", mode: "realtime", roomPolicy: "drop-in", maxClients: 4 });
    const errors: string[] = [];
    const [first, second] = [0, 1].map(() =>
      new MultiplayerClient({ manifest, rules, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() }, { onError: (error) => errors.push(error.message) }),
    ) as [MultiplayerClient<typeof rules>, MultiplayerClient<typeof rules>];
    const ticks = (client: MultiplayerClient<typeof rules>) => (client.snapshot?.state.game as { ticks: number } | undefined)?.ticks ?? 0;
    try {
      await first.quickPlay();
      await wait(() => expect(ticks(first)).toBeGreaterThan(2));
      expect(first.hosting).toBe(true);
      await second.quickPlay();
      expect(second.roomId).toBe(first.roomId);
      await wait(() => expect(ticks(second)).toBeGreaterThan(ticks(first) - 5));
      // The host's own action goes straight to its rules, and its game shows each tick
      // before the service sends it back; the guest sees it too, once.
      first.sendAction({ boost: true });
      await wait(() => expect((second.snapshot!.state.game as { boosts: number }).boosts).toBe(1));
      expect(ticks(first)).toBeGreaterThanOrEqual(ticks(second));
      // The guest's action reaches the host's rules once, and a bad one comes back as an error.
      second.sendAction({ boost: true });
      await wait(() => expect((first.snapshot!.state.game as { boosts: number }).boosts).toBe(2));
      second.sendAction({ boost: false } as never);
      await wait(() => expect(errors).toContain("Send { boost: true }."));

      await first.leave();
      await wait(() => expect(second.hosting).toBe(true));
      const before = ticks(second);
      await wait(() => expect(ticks(second)).toBeGreaterThan(before + 3));
      expect((second.snapshot!.state.game as { boosts: number }).boosts).toBe(2);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("runs realtime rules in every player's browser in lockstep, alike everywhere, and catches up a latecomer", async () => {
    // Every tick may drop food at a random place, so pages that drew different numbers would differ at once.
    type Game = { ticks: number; rounds: number; startedAt: number; x: Record<string, number>; food: number[]; ended: string };
    const rules = defineRealtimeGame({
      players: { min: 1, max: 4 },
      tickMs: 40,
      setup: (ctx, previous?: Game): Game => ({
        ticks: 0,
        rounds: (previous?.rounds ?? 0) + 1,
        startedAt: ctx.now(),
        x: Object.fromEntries(ctx.players.map((id) => [id, 0])),
        food: [],
        ended: "",
      }),
      input: (value) => ({ dx: value.dx === -1 ? -1 : 1 }),
      action: (value) => {
        if (value.end !== true) throw new Error("Send { end: true }.");
        return { end: true };
      },
      tick(G, ctx, inputs, _dt, actions) {
        G.ticks++;
        for (const id of ctx.players) G.x[id] = (G.x[id] ?? 0) + (inputs[id]?.dx ?? 0);
        if (ctx.random() < 0.5) G.food = [...G.food, Math.floor(ctx.random() * 100)].slice(-10);
        for (const { playerId } of actions) G.ended = playerId;
      },
      join: (G, _ctx, playerId) => { G.x[playerId] = 0; },
      leave: (G, _ctx, playerId) => { delete G.x[playerId]; },
      endIf: (G) => (G.ended ? { winners: [G.ended] } : undefined),
    });
    const manifest = await hostedService({ deploymentId: "lockstep", adapterId: "lockstep", tickMs: 40, mode: "realtime", roomPolicy: "drop-in", maxClients: 4 });
    const seen: Map<string, string>[] = [];
    const join = () => {
      const byTick = new Map<string, string>();
      seen.push(byTick);
      return new MultiplayerClient({ manifest, rules, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() }, {
        onSnapshot: (snapshot) => {
          const game = snapshot.state.game as Game | undefined;
          if (snapshot.state.phase === "playing" && game) byTick.set(`${game.rounds}:${game.ticks}`, JSON.stringify(game));
        },
      }) as MultiplayerClient<typeof rules>;
    };
    const game = (client: MultiplayerClient<typeof rules>) => client.snapshot?.state.game as Game | undefined;
    /**
     * Pages show a guess a little ahead of the frames they have, which a change they could
     * not foresee, such as a player joining, corrects. Once nothing changes, every tick two
     * pages both showed must be the same on both.
     */
    const alike = async (a: number, b: number) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const byTick of seen) byTick.clear();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const shared = [...seen[a]!.keys()].filter((tick) => seen[b]!.has(tick));
      expect(shared.length).toBeGreaterThan(3);
      for (const tick of shared) expect(seen[b]!.get(tick)).toBe(seen[a]!.get(tick));
    };
    const [first, second, late] = [join(), join(), join()];
    try {
      await first.quickPlay();
      await wait(() => expect(game(first)?.ticks).toBeGreaterThan(3));
      await second.quickPlay();
      expect(second.roomId).toBe(first.roomId);
      await wait(() => expect(Object.keys(game(second)?.x ?? {}).sort()).toEqual([first.playerId, second.playerId].sort()));
      first.sendInput({ dx: 1 });
      second.sendInput({ dx: -1 });
      await wait(() => expect(game(second)!.x[first.playerId!]).toBeGreaterThan(0));
      // Nobody hosts, and each page's own run of the rules reaches the same states.
      expect(first.hosting || second.hosting).toBe(false);
      await alike(0, 1);
      // confirmed is the newest frame from the service, which the shown guess runs ahead of.
      const confirmed = first.confirmed!.state.game as Game;
      expect(confirmed.ticks).toBeLessThanOrEqual(game(first)!.ticks);
      expect(Object.keys(confirmed.x).sort()).toEqual([first.playerId, second.playerId].sort());
      // After a checkpoint, a latecomer starts from it and runs on in step.
      await new Promise((resolve) => setTimeout(resolve, 2300));
      await late.quickPlay();
      expect(late.roomId).toBe(first.roomId);
      await wait(() => expect(Object.keys(game(late)?.x ?? {})).toHaveLength(3));
      await wait(() => expect(game(first)!.x).toHaveProperty(late.playerId!));
      await alike(0, 2);
      await alike(1, 2);

      // An action ends the round on every page; the next one's setup gets the last game.
      expect(second.sendAction({ end: false } as never)).toBe(true);
      second.sendAction({ end: true });
      await wait(() => expect(first.snapshot?.state.phase).toBe("finished"));
      for (const client of [first, second, late]) {
        await wait(() => expect(client.snapshot?.state.phase).toBe("finished"));
        expect(client.snapshot!.state.winnerPlayerIds).toEqual([second.playerId]);
      }
      await wait(() => expect(game(first)?.rounds).toBe(2));
      await wait(() => expect(game(late)?.rounds).toBe(2));
      await alike(0, 2);
    } finally {
      for (const client of [first, second, late]) client.dispose();
    }
  });

  it("passes each player's own state on in an owner room, with shared things first come first served", async () => {
    const runtime = new LocalMultiplayerRuntime(0);
    try {
      // Local setup: no rules file; the deployment names how often states go out.
      const local = await runtime.configure("party", "owner", { dropIn: true });
      expect(local).toMatchObject({ mode: "realtime", adapterId: "owner", tickMs: 100, roomPolicy: "drop-in", deploymentId: "local-owner-100ms-4p-dropin-v1" });
      expect(await runtime.restore("party", { ...local, serverUrl: "http://127.0.0.1:1" })).toEqual(local);
    } finally {
      await runtime.close();
    }
    const manifest = await hostedService({ deploymentId: "owner", adapterId: "owner", tickMs: 40, mode: "realtime", roomPolicy: "drop-in", maxClients: 4 });
    type Party = { players: Record<string, Record<string, unknown>>; shared: Record<string, unknown> };
    const messages: { from: string; message: Record<string, unknown> }[] = [];
    const join = () => new MultiplayerClient({ manifest, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() }, {
      onMessage: (from, message) => messages.push({ from, message }),
    });
    const game = (client: MultiplayerClient) => client.snapshot?.state.game as Party | undefined;
    const [a, b] = [join(), join()];
    try {
      await a.quickPlay();
      await b.quickPlay();
      expect(b.roomId).toBe(a.roomId);
      await wait(() => expect(b.snapshot?.state.phase).toBe("playing"));
      await wait(() => expect(a.playerId && b.playerId).toBeTruthy());
      // The page's own state shows at once; the others' arrive within a tick, only what changed.
      a.setState({ x: 1, name: "A" });
      expect(game(a)!.players[a.playerId!]).toEqual({ x: 1, name: "A" });
      await wait(() => expect(game(b)?.players[a.playerId!]).toEqual({ x: 1, name: "A" }));
      a.setState({ x: 2, name: "A" });
      await wait(() => expect(game(b)!.players[a.playerId!]).toEqual({ x: 2, name: "A" }));
      expect(() => a.setState({ big: "x".repeat(5000) })).toThrow("small plain object");

      // The first page to set up the shared area does; the second finds it taken.
      expect(await a.updateShared([{ key: "food:1", value: { x: 3 }, expectAbsent: true }])).toBe(true);
      expect(await b.updateShared([{ key: "food:1", value: { x: 9 }, expectAbsent: true }])).toBe(false);
      await wait(() => expect(game(b)!.shared).toEqual({ "food:1": { x: 3 } }));
      // Both eat the same food at once: exactly one gets it, together with its new food.
      const eaten = await Promise.all([
        a.updateShared([{ key: "food:1", expect: { x: 3 } }, { key: "food:2", value: { x: 5 }, expectAbsent: true }]),
        b.updateShared([{ key: "food:1", expect: { x: 3 } }, { key: "food:3", value: { x: 6 }, expectAbsent: true }]),
      ]);
      expect(eaten.filter(Boolean)).toHaveLength(1);
      await wait(() => expect(Object.keys(game(a)!.shared)).toEqual([eaten[0] ? "food:2" : "food:3"]));
      expect(game(b)!.shared).toEqual(game(a)!.shared);

      // A message reaches the other page, which applies what only the sender saw.
      expect(a.emit({ crash: b.playerId })).toBe(true);
      await wait(() => expect(messages).toEqual([{ from: a.playerId, message: { crash: b.playerId } }]));

      // The first page to end the round decides; the next round starts with nothing kept.
      a.finishRound([b.playerId!, "nobody"]);
      await wait(() => expect(b.snapshot?.state.phase).toBe("finished"));
      expect(b.snapshot!.state.winnerPlayerIds).toEqual([b.playerId]);
      await wait(() => expect(a.snapshot?.state.phase).toBe("playing"));
      await wait(() => expect(game(a)).toEqual({ players: { [a.playerId!]: {} }, shared: {} }));

      // A player who leaves takes their state with them.
      b.setState({ x: 7 });
      await wait(() => expect(game(a)!.players[b.playerId!]).toEqual({ x: 7 }));
      const left = b.playerId!;
      await b.leave();
      await wait(() => expect(game(a)!.players).not.toHaveProperty(left));
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("relays connection setup between two players of an owner room, and numbers each state", async () => {
    const manifest = await hostedService({ deploymentId: "owner-p2p", adapterId: "owner", tickMs: 40, mode: "realtime", roomPolicy: "drop-in", maxClients: 4 });
    const join = () => new MultiplayerClient({ manifest, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() });
    type Raw = { room: Room };
    const [a, b, c] = [join(), join(), join()];
    try {
      for (const client of [a, b, c]) await client.quickPlay();
      expect(new Set([a.roomId, b.roomId, c.roomId]).size).toBe(1);
      await wait(() => expect([a, b, c].every((client) => client.snapshot?.state.phase === "playing" && client.playerId)).toBe(true));
      const raw = (client: MultiplayerClient) => (client as unknown as Raw).room;
      const signals = new Map<MultiplayerClient, unknown[]>([[a, []], [b, []], [c, []]]);
      const frames: unknown[] = [];
      for (const [client, got] of signals) raw(client).onMessage("p2p.signal", (value: unknown) => got.push(value));
      raw(b).onMessage("owner.frame", (value: unknown) => frames.push(value));

      // Passed on unread, with who sent it, to the one player it names.
      raw(a).send("p2p.signal", { to: b.playerId, data: { description: { type: "offer", sdp: "v=0" } } });
      await wait(() => expect(signals.get(b)).toEqual([{ from: a.playerId, data: { description: { type: "offer", sdp: "v=0" } } }]));
      // Not to anyone else, not to the sender, not when too large or malformed.
      raw(a).send("p2p.signal", { to: a.playerId, data: { x: 1 } });
      raw(a).send("p2p.signal", { to: "nobody", data: { x: 1 } });
      raw(a).send("p2p.signal", { to: c.playerId, data: { sdp: "x".repeat(9000) } });
      raw(a).send("p2p.signal", { to: c.playerId, data: "text" });
      raw(a).send("p2p.signal", { to: c.playerId, data: { ok: true } });
      await wait(() => expect(signals.get(c)).toEqual([{ from: a.playerId, data: { ok: true } }]));
      expect(signals.get(a)).toEqual([]);
      expect(signals.get(b)).toHaveLength(1);

      // Each state carries its version on the sender's page, which frames and later syncs pass on.
      a.setState({ x: 1 });
      a.setState({ x: 2 });
      await wait(() => expect(frames.some((frame) => (frame as { players?: Record<string, { seq?: number }> }).players?.[a.playerId!]?.seq === 2)).toBe(true));
      const late = join();
      const synced: unknown[] = [];
      try {
        await late.quickPlay();
        expect(late.roomId).toBe(a.roomId);
        raw(late).onMessage("owner.sync", (value: unknown) => synced.push(value));
        raw(late).send("sync");
        await wait(() => expect(synced).toContainEqual(expect.objectContaining({ seqs: { [a.playerId!]: 2 } })));
      } finally {
        late.dispose();
      }
    } finally {
      for (const client of [a, b, c]) client.dispose();
    }
  });

  it("sends owner states and messages straight between pages that connect, and through the service to the rest", async () => {
    FakePeerConnection.reset();
    // A slow tick: whatever arrives within a fraction of it came straight from the other page.
    const manifest = await hostedService({ deploymentId: "owner-direct", adapterId: "owner", tickMs: 1000, mode: "realtime", roomPolicy: "drop-in", maxClients: 4 });
    const messages = new Map<MultiplayerClient, { from: string; message: Record<string, unknown> }[]>();
    const join = (p2p: boolean) => {
      const got: { from: string; message: Record<string, unknown> }[] = [];
      const client = new MultiplayerClient({
        manifest, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage(),
        ...(p2p ? { p2p: { peerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection } } : {}),
      }, { onMessage: (from, message) => got.push({ from, message }) });
      messages.set(client, got);
      return client;
    };
    const players = (client: MultiplayerClient) => (client.snapshot?.state.game as { players: Record<string, Record<string, unknown>> } | undefined)?.players;
    const [a, b, c] = [join(true), join(true), join(false)];
    try {
      for (const client of [a, b, c]) await client.quickPlay();
      await wait(() => expect([a, b, c].every((client) => client.snapshot?.state.phase === "playing" && client.playerId)).toBe(true));
      await wait(() => expect(a.peers[b.playerId!]).toBe("open"));
      expect(b.peers[a.playerId!]).toBe("open");
      expect(c.peers).toEqual({});
      const directStates = () => [...FakePeerConnection.all.values()].flatMap((pc) => pc.channels.get(0)?.sent ?? []).length;

      for (const x of [1, 2, 3]) {
        const before = directStates();
        const start = Date.now();
        a.setState({ x });
        await vi.waitFor(() => expect(players(b)?.[a.playerId!]).toEqual({ x }), { timeout: 150, interval: 5 });
        expect(Date.now() - start).toBeLessThan(150);
        expect(directStates()).toBeGreaterThan(before);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      // The player without a direct connection gets it through the service, a tick later.
      await wait(() => expect(players(c)?.[a.playerId!]).toEqual({ x: 3 }));
      // And the service's copy does not take B back to an older state.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(players(b)?.[a.playerId!]).toEqual({ x: 3 });

      // A message arrives once on each page, though B gets it both ways.
      expect(a.emit({ boom: 1 })).toBe(true);
      await wait(() => expect(messages.get(c)).toEqual([{ from: a.playerId, message: { boom: 1 } }]));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(messages.get(b)).toEqual([{ from: a.playerId, message: { boom: 1 } }]);

      // Leaving closes the page's connections; the other page lets the player go.
      const left = b.playerId!;
      await b.leave();
      expect(b.peers).toEqual({});
      await wait(() => expect(a.peers).not.toHaveProperty(left));
    } finally {
      for (const client of [a, b, c]) client.dispose();
      FakePeerConnection.reset();
    }
  });

  it("types a realtime game's input in the page", () => {
    const rules = defineRealtimeGame({
      players: { min: 1, max: 2 },
      setup: () => ({}),
      input: (value) => ({ dir: value.dir as "left" | "right" }),
      tick: () => {},
    });
    const typed = null as unknown as MultiplayerClient<typeof rules>;
    const acting = defineRealtimeGame({
      ...rules,
      action: (value) => ({ fire: value.fire === true }),
      tick: (_G, _ctx, _inputs, _dt, actions) => {
        for (const { action } of actions) if (action.fire) return;
      },
    });
    const firing = null as unknown as MultiplayerClient<typeof acting>;
    const send = () => {
      typed.sendInput({ dir: "left" });
      // @ts-expect-error The rules read a direction, not a speed.
      typed.sendInput({ speed: 3 });
      // @ts-expect-error These rules take no actions.
      typed.sendAction({ fire: true });
      firing.sendAction({ fire: true });
      // @ts-expect-error The rules read fire, not jump.
      firing.sendAction({ jump: true });
    };
    expect(typeof send).toBe("function");
    expect(compileGame(rules)).toMatchObject({ mode: "realtime", tickMs: undefined });
    expect(compileGame(rules).validateAction).toBeUndefined();
    expect(compileGame(acting).validateAction).toBeTypeOf("function");
    expect(() => compileGame({ ...rules, tickMs: 5 })).toThrow("tickMs must be a whole number from 20 to 1000.");
  });

  it("sizes local rooms from two to eight players and keeps gomoku at two", async () => {
    await service.stop();
    const runtime = new LocalMultiplayerRuntime();
    const clients: MultiplayerClient[] = [];
    try {
      const stones = await runtime.configure("local-sized", "stones");
      expect(stones.maxClients).toBe(4);
      const arena = await runtime.configure("local-sized", "arena", { maxClients: 8 });
      expect(arena).toMatchObject({ maxClients: 8, deploymentId: "local-arena-8p-v1" });
      expect(await runtime.configure("local-sized", "stones", { maxClients: 6 })).toMatchObject({ maxClients: 6, deploymentId: "local-stones-6p-v1" });
      await expect(runtime.configure("local-sized", "arena", { maxClients: 9 })).rejects.toThrow("2 to 8 players");
      await expect(runtime.configure("local-sized", "arena", { maxClients: 1 })).rejects.toThrow("2 to 8 players");
      await expect(runtime.configure("local-sized", "gomoku", { maxClients: 4 })).rejects.toThrow("exactly 2 players");
      expect(await runtime.configure("local-sized", "arena", { dropIn: true })).toMatchObject({ roomPolicy: "drop-in", deploymentId: "local-arena-4p-dropin-v1" });
      await expect(runtime.configure("local-sized", "stones", { dropIn: true })).rejects.toThrow("realtime rules");
      expect(await runtime.configure("local-sized", "roam")).toMatchObject({ mode: "realtime", roomPolicy: "drop-in", maxClients: 4, reconnectSeconds: 15, deploymentId: "local-roam-4p-dropin-v1" });
      expect(await runtime.configure("local-sized", "roam", { dropIn: false })).toMatchObject({ roomPolicy: "invite-or-public", deploymentId: "local-roam-4p-v1" });

      const players = Array.from({ length: 9 }, () => new MultiplayerClient({ manifest: arena, allowLocalhost: true, storage: memoryStorage(), identityStorage: memoryStorage() }));
      clients.push(...players);
      const [owner, ...guests] = players;
      await owner!.createRoom();
      await wait(() => expect(owner!.roomCode).toMatch(/^[A-F0-9]{16}$/));
      for (const guest of guests.slice(0, 7)) await guest.joinRoom({ roomCode: owner!.roomCode });
      await wait(() => expect(owner!.snapshot?.state.players).toHaveLength(8));
      await expect(guests[7]!.joinRoom({ roomCode: owner!.roomCode })).rejects.toThrow();
    } finally {
      for (const client of clients) client.dispose();
      await runtime.close();
    }
  });
});
