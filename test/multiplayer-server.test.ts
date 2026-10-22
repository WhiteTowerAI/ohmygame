import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, type Room } from "@colyseus/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMultiplayerServer } from "../src/multiplayer-server/service.js";
import { MultiplayerClient } from "../src/renderer/multiplayer-client.js";
import {
  multiplayerRoomType,
  type MultiplayerManifestConfig,
  type MultiplayerSnapshot,
  type TurnCommand,
  type TurnCommandResult,
} from "../src/shared/multiplayer-protocol.js";

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

describe.sequential("multiplayer service over HTTP and WebSocket", () => {
  let directory: string;
  let service: ReturnType<typeof createMultiplayerServer>;
  let endpoint: string;
  let peers: Peer[];
  let wrappers: MultiplayerClient[];
  const deployments = [
    config,
    { ...config, deploymentId: "v2" },
    { ...config, gameId: "private", roomPolicy: "invite-only" as const },
    { ...config, gameId: "arena", mode: "realtime" as const },
  ];
  async function start() {
    service = createMultiplayerServer({
      deployments,
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
    room.onMessage("ready", (value) => {
      result.ready = value;
    });
    room.onMessage("event", () => {});
    room.onMessage("command.result", (value) => {
      result.results.push(value);
    });
    room.onMessage("input.error", () => {});
    room.onStateChange((state: { snapshot: string }) => {
      if (state.snapshot) result.snapshot = JSON.parse(state.snapshot);
    });
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

  it("runs an authoritative match and preserves both accepted and rejected results", async () => {
    const [first, second] = await match();
    const wrongTurn = await command(second, "take", { count: 3 });
    expect(wrongTurn.result.error?.code).toBe("not_your_turn");
    const taken = await command(first, "take", { count: 3 });
    expect(taken.result.accepted).toBe(true);
    await wait(() => expect(second.snapshot!.state.remaining).toBe(18));
    const replay = await command(first, "take", { count: 3 }, taken.value);
    expect(replay.result).toEqual(taken.result);
    const rejectedReplay = await command(
      second,
      "take",
      { count: 3 },
      wrongTurn.value,
    );
    expect(rejectedReplay.result).toEqual(wrongTurn.result);
    expect(first.snapshot!.state.remaining).toBe(18);
    const stale = await command(second, "pass", undefined, {
      expectedSequence: 0,
    });
    expect(stale.result.error?.code).toBe("sequence_conflict");
    let next = second;
    while (next.snapshot!.state.phase === "playing") {
      const remaining = next.snapshot!.state.remaining;
      const result = await command(next, "take", {
        count: Math.min(3, remaining),
      });
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
    restored.sendCommand("take", { count: 2 });
    await wait(() => expect(restored.snapshot?.state.remaining).toBe(19));
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
});
