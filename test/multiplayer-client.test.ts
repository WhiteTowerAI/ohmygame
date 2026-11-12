import { Client, type Room } from "@colyseus/sdk";
import { describe, expect, it, vi } from "vitest";
import { init, isOhMyGameError, OhMyGameError } from "@ohmygame/sdk";
import { createMultiplayerClient, MultiplayerClient, Smoother } from "@ohmygame/sdk/multiplayer";
import type { MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";
import { TickClock, TickPacer } from "../packages/sdk/src/pacing.js";
import { OWNER_DIRECT_INTERVAL_MS, OwnerSession } from "../packages/sdk/src/owner.js";
import { DEFAULT_ICE_SERVERS, P2P_CONNECT_TIMEOUT_MS, P2P_MAX_PLAYERS, P2P_RETRY_MS, PeerMesh } from "../packages/sdk/src/peers.js";
import { FakePeerConnection } from "./fake-peer-connection.js";

const manifest: MultiplayerManifestConfig = {
  enabled: true,
  gameId: "gomoku",
  deploymentId: "v1",
  adapterId: "gomoku",
  mode: "turn-based",
  serverUrl: "https://games.example.test",
  protocolVersion: 1,
  authPolicy: "guest-or-account",
  roomPolicy: "invite-or-public",
  maxClients: 2,
  reconnectSeconds: 2,
};

describe("SDK entries", () => {
  it("keeps the room client out of a game that imports only @ohmygame/sdk", async () => {
    const { build } = await import("esbuild");
    const bundle = async (contents: string) => {
      const result = await build({
        stdin: { contents, resolveDir: process.cwd(), loader: "ts" },
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
        conditions: ["ohmygame-source"],
      });
      return result.outputFiles[0]!.text;
    };
    const solo = await bundle(`import { init } from "@ohmygame/sdk"; init().then(console.log);`);
    const rooms = await bundle(
      `import { init } from "@ohmygame/sdk"; import { createMultiplayerClient } from "@ohmygame/sdk/multiplayer";
      init().then((game) => createMultiplayerClient(game));`,
    );
    expect(solo).not.toContain("@colyseus");
    expect(solo).not.toContain("joinOrCreate");
    expect(rooms).toContain("joinOrCreate");
  });
});

describe("multiplayer connection failures", () => {
  it("times out stalled joins and closes a room that arrives after cancellation", async () => {
    const transport = new Client(manifest.serverUrl);
    let resolve!: (room: Room) => void;
    vi.spyOn(transport, "create").mockImplementation(
      () =>
        new Promise<Room>((done) => {
          resolve = done;
        }),
    );
    const statuses: string[] = [];
    const errors: Error[] = [];
    const client = new MultiplayerClient(
      {
        manifest,
        transport,
        identity: { getToken: async () => "account-token" },
        connectionTimeoutMs: 30,
      },
      {
        onStatus: (status) => statuses.push(status),
        onError: (error) => errors.push(error),
      },
    );
    await expect(client.createRoom()).rejects.toMatchObject({ code: "timeout", message: expect.stringMatching(/timed out/) });
    const leave = vi.fn(async () => {});
    resolve({ reconnection: { enabled: true }, leave } as unknown as Room);
    await vi.waitFor(() => expect(leave).toHaveBeenCalledWith(true));
    expect(client.status).toBe("error");
    expect(statuses).toEqual(["connecting", "error"]);
    expect(errors).toHaveLength(1);
    expect(isOhMyGameError(errors[0], "timeout")).toBe(true);
    client.dispose();
  });

  it("reports once when the service sends a room update the SDK cannot read", async () => {
    const transport = new Client(manifest.serverUrl);
    const handlers = new Map<string, (value: unknown) => void>();
    const room = {
      roomId: "room-1",
      reconnectionToken: "token",
      reconnection: { enabled: true },
      onMessage: (type: string, handler: (value: unknown) => void) => handlers.set(type, handler),
      onDrop: () => {},
      onReconnect: () => {},
      onError: () => {},
      onLeave: () => {},
      send: vi.fn(),
      removeAllListeners: () => {},
      leave: vi.fn(async () => {}),
    } as unknown as Room;
    vi.spyOn(transport, "create").mockResolvedValue(room);
    const errors: OhMyGameError[] = [];
    const snapshots: unknown[] = [];
    const client = new MultiplayerClient(
      { manifest, transport, identity: { getToken: async () => "account-token" } },
      { onError: (error) => errors.push(error), onSnapshot: (snapshot) => snapshots.push(snapshot) },
    );
    await client.createRoom();
    const snapshot = {
      roomId: "room-1",
      gameId: manifest.gameId,
      deploymentId: manifest.deploymentId,
      mode: manifest.mode,
      sequence: 1,
      serverTime: new Date().toISOString(),
      state: { phase: "lobby", ownerId: "", currentPlayerId: "", winnerPlayerId: "", turnDeadline: 0, players: [] },
    };
    // An older or newer room protocol, and a snapshot for another deployment.
    handlers.get("snapshot")!({ ...snapshot, state: { ...snapshot.state, phase: "voting" } });
    handlers.get("snapshot")!({ ...snapshot, deploymentId: "v2" });
    expect(errors).toHaveLength(1);
    expect(isOhMyGameError(errors[0], "invalid_response")).toBe(true);
    expect(client.snapshot).toBeUndefined();
    handlers.get("snapshot")!(snapshot);
    // An out-of-date snapshot is normal and stays quiet.
    handlers.get("snapshot")!({ ...snapshot, sequence: 0 });
    expect(snapshots).toEqual([snapshot]);
    expect(errors).toHaveLength(1);
    client.dispose();
  });

  it("applies a tick's changes to the snapshot they follow, and asks once for a whole one when they do not", async () => {
    const transport = new Client(manifest.serverUrl);
    const handlers = new Map<string, (value: unknown) => void>();
    const send = vi.fn();
    const room = {
      roomId: "room-1",
      reconnectionToken: "token",
      reconnection: { enabled: true },
      onMessage: (type: string, handler: (value: unknown) => void) => handlers.set(type, handler),
      onDrop: () => {},
      onReconnect: () => {},
      onError: () => {},
      onLeave: () => {},
      send,
      removeAllListeners: () => {},
      leave: vi.fn(async () => {}),
    } as unknown as Room;
    vi.spyOn(transport, "create").mockResolvedValue(room);
    const realtime = { ...manifest, mode: "realtime" as const, adapterId: "arena" };
    const snapshots: unknown[] = [];
    const client = new MultiplayerClient(
      { manifest: realtime, transport, identity: { getToken: async () => "account-token" } },
      { onSnapshot: (snapshot) => snapshots.push(snapshot) },
    );
    await client.createRoom();
    const serverTime = new Date().toISOString();
    const delta = (base: number, x: number) => ({ roomId: "room-1", sequence: base + 1, base, serverTime, changes: [[["players", 0, "x"], x]] });
    // Changes that arrive before the first snapshot wait for the one the join asked for.
    handlers.get("snapshot.delta")!(delta(4, 9));
    expect(send).not.toHaveBeenCalledWith("snapshot.request");
    handlers.get("snapshot")!({
      roomId: "room-1",
      gameId: realtime.gameId,
      deploymentId: realtime.deploymentId,
      mode: "realtime",
      sequence: 5,
      serverTime,
      state: {
        phase: "playing", ownerId: "", currentPlayerId: "", winnerPlayerId: "", turnDeadline: 0,
        players: [{ playerId: "a", displayName: "A", connected: true, x: 1, y: 2 }],
      },
    });
    handlers.get("snapshot.delta")!(delta(5, 3));
    expect(client.snapshot?.sequence).toBe(6);
    expect(client.snapshot?.state.players[0]).toMatchObject({ x: 3, y: 2 });
    expect(snapshots).toHaveLength(2);
    // A tick went missing: ask for the whole room once, and drop changes until it comes.
    handlers.get("snapshot.delta")!(delta(7, 5));
    handlers.get("snapshot.delta")!(delta(8, 6));
    expect(send.mock.calls.filter(([type]) => type === "snapshot.request")).toHaveLength(1);
    expect(client.snapshot?.sequence).toBe(6);
    // Changes older than the snapshot held are simply stale.
    handlers.get("snapshot.delta")!(delta(2, 0));
    expect(send.mock.calls.filter(([type]) => type === "snapshot.request")).toHaveLength(1);
    client.dispose();
  });

  it("accepts a realtime input only as a small plain object without inputId", () => {
    const client = new MultiplayerClient({ manifest: { ...manifest, mode: "realtime", adapterId: "arena" } });
    // Before a room is joined, a valid input is ignored rather than queued.
    expect(() => client.sendInput({ x: 1, y: 0, boost: true, aim: [0.5, -1] })).not.toThrow();
    for (const input of [
      { inputId: 3, x: 1 },
      { at: new Date() },
      { x: Number.NaN },
      { fire: () => {} },
      { text: "x".repeat(600) },
    ])
      expect(() => client.sendInput(input)).toThrow(expect.objectContaining({ code: "invalid_option" }));
    client.dispose();
  });

  it("sends a changed input at once, within an allowance that keeps an input changing every frame near one send a tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    try {
      const transport = new Client(manifest.serverUrl);
      const send = vi.fn();
      const room = {
        roomId: "room-1",
        reconnectionToken: "token",
        reconnection: { enabled: true },
        onMessage: () => {},
        onDrop: () => {},
        onReconnect: () => {},
        onError: () => {},
        onLeave: () => {},
        send,
        removeAllListeners: () => {},
        leave: vi.fn(async () => {}),
      } as unknown as Room;
      vi.spyOn(transport, "create").mockResolvedValue(room);
      const client = new MultiplayerClient({
        manifest: { ...manifest, mode: "realtime", adapterId: "arena" },
        transport,
        identity: { getToken: async () => "account-token" },
      });
      await client.createRoom();
      const inputs = () => send.mock.calls.filter(([type]) => type === "input").map(([, value]) => ({ at: performance.now(), value }));
      const sentAt: number[] = [];
      send.mockImplementation((type: string) => type === "input" && sentAt.push(performance.now()));
      const frames = (ms: number, input: (frame: number) => Record<string, number>) => {
        for (let frame = 0; frame * 16 < ms; frame++) {
          client.sendInput(input(frame));
          vi.advanceTimersByTime(16);
        }
      };
      const start = performance.now();
      frames(330, () => ({ x: 1, y: 0 }));
      // Held: at once, then once a tick.
      expect(sentAt.map((at) => at - start)).toEqual([0, 50, 100, 150, 200, 250, 300]);
      sentAt.length = 0;
      const pressed = performance.now();
      frames(16, () => ({ x: 0, y: 1 }));
      // A new direction 36 ms after the last send does not wait for the one due at 350.
      expect(pressed - start).toBe(336);
      expect(sentAt[0]).toBe(pressed);
      expect(inputs().at(-1)!.value).toMatchObject({ x: 0, y: 1 });

      sentAt.length = 0;
      // An analog input that changes every frame for two seconds.
      frames(2000, (frame) => ({ x: Math.sin(frame / 10), y: 0 }));
      expect(sentAt.length).toBeGreaterThanOrEqual(39);
      expect(sentAt.length).toBeLessThanOrEqual(40 + 2 * 4 + 2);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires explicit local configuration and rejects unsupported endpoints", () => {
    expect(
      () =>
        new MultiplayerClient({
          manifest: { ...manifest, serverUrl: "http://127.0.0.1:43130" },
        }),
    ).toThrow(/not configured/);
    expect(
      () =>
        new MultiplayerClient({
          manifest: { ...manifest, serverUrl: "http://example.test" },
          allowLocalhost: true,
        }),
    ).toThrow(/not configured/);
  });

  it("starts from the game's manifest and reports why a client cannot be made", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ title: "Board", multiplayer: manifest }));
    try {
      const game = await init({ manifest: "https://games.example.test/play/manifest.json" });
      expect(fetch.mock.calls[0]![0]).toEqual(new URL("https://games.example.test/play/manifest.json"));
      expect(game.multiplayer).toEqual(manifest);
      expect(createMultiplayerClient(game)).toBeInstanceOf(MultiplayerClient);
    } finally {
      fetch.mockRestore();
    }
    const single = await init({ manifest: { title: "Solo" } as { multiplayer?: unknown } });
    expect(single.multiplayer).toBeUndefined();
    expect(() => createMultiplayerClient(single)).toThrow(expect.objectContaining({ code: "not_configured" }));
    const local = { multiplayer: { ...manifest, serverUrl: "http://127.0.0.1:43139" } };
    await expect(init({ manifest: local })).rejects.toMatchObject({ code: "not_configured", message: expect.stringMatching(/allowLocalhost/) });
    expect((await init({ manifest: local, allowLocalhost: true })).multiplayer?.serverUrl).toBe("http://127.0.0.1:43139");
    await expect(init({ manifest: { multiplayer: { enabled: true } } })).rejects.toBeInstanceOf(OhMyGameError);

    const accounts = await init({ manifest: { multiplayer: { ...manifest, authPolicy: "account-required" } } });
    const transport = new Client(manifest.serverUrl);
    const create = vi.spyOn(transport, "create");
    const client = createMultiplayerClient(accounts, {}, { transport });
    await expect(client.createRoom()).rejects.toMatchObject({ code: "sign_in_required" });
    expect(create).not.toHaveBeenCalled();
    client.dispose();

    // A service that speaks none of the SDK's protocol versions says which side to update.
    const outdated = new Client(manifest.serverUrl);
    const refused = vi.spyOn(outdated, "create").mockRejectedValue(Object.assign(new Error("Update the service."), { code: 426 }));
    const newer = new MultiplayerClient({ manifest, transport: outdated, identity: { getToken: async () => "account-token" } });
    await expect(newer.createRoom()).rejects.toMatchObject({ code: "protocol_unsupported", message: "Update the service." });
    expect(refused.mock.calls[0]![1]).toMatchObject({ protocolVersion: 1 });
    newer.dispose();
  });
});

describe("smoothing other players between updates", () => {
  const walk = (smoother: Smoother) => {
    // Updates every 50 ms, moving 5 units each.
    for (const at of [0, 50, 100]) smoother.push("p", { x: at / 10, y: 1 }, at);
  };

  it("interpolates one update behind, and carries on briefly when an update is late", () => {
    const smoother = new Smoother({ intervalMs: 50 });
    walk(smoother);
    expect(smoother.get("p", 125)).toEqual({ x: 7.5, y: 1 });
    expect(smoother.get("p", 0)).toEqual({ x: 0, y: 1 });
    // The update due at 150 is late: carry on along the last movement, at most one interval.
    expect(smoother.get("p", 175)).toEqual({ x: 12.5, y: 1 });
    expect(smoother.get("p", 400)).toEqual({ x: 15, y: 1 });
    expect(smoother.get("other", 100)).toBeUndefined();
  });

  it("extrapolates ahead of the newest update, and eases toward the newest in damped mode", () => {
    const ahead = new Smoother({ mode: "extrapolate", intervalMs: 50, smoothMs: 0 });
    walk(ahead);
    expect(ahead.get("p", 125)).toEqual({ x: 12.5, y: 1 });
    expect(ahead.get("p", 500)).toEqual({ x: 15, y: 1 });

    const damped = new Smoother({ mode: "damped", smoothMs: 50 });
    damped.push("p", { x: 0 }, 0);
    expect(damped.get("p", 0)).toEqual({ x: 0 });
    damped.push("p", { x: 10 }, 10);
    expect(damped.get("p", 50)!.x).toBeCloseTo(10 * (1 - Math.exp(-1)));
    expect(damped.get("p", 1000)!.x).toBeCloseTo(10);
  });

  it("draws a teleport at once and turns angles the short way round", () => {
    const smoother = new Smoother({ intervalMs: 50, snapDistance: 20 });
    walk(smoother);
    smoother.push("p", { x: 90, y: 1 }, 150);
    expect(smoother.get("p", 160)).toEqual({ x: 90, y: 1 });

    const turning = new Smoother({ intervalMs: 50, delayMs: 0, angles: ["a"] });
    turning.push("p", { a: 3.1 }, 0);
    turning.push("p", { a: -3.1 }, 50);
    // Halfway from 3.1 to -3.1 the short way is pi, not 0.
    expect(Math.abs(turning.get("p", 25)!.a!)).toBeCloseTo(Math.PI);
  });

  it("forgets players who left", () => {
    const smoother = new Smoother();
    smoother.push("a", { x: 1 }, 0);
    smoother.push("b", { x: 2 }, 0);
    smoother.retain(["b"]);
    expect(smoother.get("a", 0)).toBeUndefined();
    smoother.delete("b");
    expect(smoother.get("b", 0)).toBeUndefined();
  });
});

describe("timing sends to the service's tick", () => {
  /** A clock whose service ticks reach the page at `phase` within each 50 ms, with a 30 ms round trip. */
  const learned = (phase: number) => {
    const clock = new TickClock(() => 50);
    for (let tick = 0; tick < 10; tick++) clock.arrived(1000 + tick * 50 + phase + (tick % 3));
    clock.pong(1500, 1530);
    return clock;
  };

  it("sends a whole round trip and a margin before a tick's message arrives", () => {
    // Tick messages arrive about 21 ms into each 50; send 30 + 8 ms earlier, at 33 into the cycle.
    const at = learned(20).nextSend(2000)!;
    expect(at).toBeGreaterThanOrEqual(2000);
    expect(at - 2000).toBeCloseTo(33, -0.5);
    // Arrivals either side of the cycle's wrap still average to its edge, not its middle.
    const edge = new TickClock(() => 50);
    for (const at of [1049, 1100, 1151, 1199, 1250, 1301]) edge.arrived(at);
    edge.pong(0, 10);
    expect(((edge.nextSend(2000)! - 2000) % 50 + 50) % 50).toBeCloseTo(32, -0.5);
  });

  it("waits until it knows both the tick and the round trip", () => {
    const clock = new TickClock(() => 50);
    clock.arrived(1000);
    clock.arrived(1050);
    clock.arrived(1100);
    expect(clock.nextSend(2000)).toBeUndefined();
    clock.pong(1200, 1100); // an answer from before it was sent is not a trip
    expect(clock.nextSend(2000)).toBeUndefined();
    clock.pong(1200, 1230);
    expect(clock.nextSend(2000)).toBeDefined();
  });

  it("sends at once, then once a tick at the clock's moments, and never more than twice a tick", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      vi.setSystemTime(0);
      const sent: number[] = [];
      let waiting = 3;
      const unknown = new TickPacer(new TickClock(() => 50), () => 50, () => {
        if (!waiting) return false;
        waiting--;
        sent.push(performance.now());
        return true;
      });
      vi.advanceTimersByTime(1000);
      unknown.wake();
      vi.advanceTimersByTime(500);
      // Without a tick to time to, once a tick from the first send; it stops with nothing left.
      expect(sent).toEqual([1000, 1050, 1100]);
      expect(unknown.running).toBe(false);

      sent.length = 0;
      const clock = learned(20);
      const paced = new TickPacer(clock, () => 50, () => {
        sent.push(performance.now());
        return true;
      });
      vi.advanceTimersByTime(500); // now 2000
      paced.wake();
      for (let i = 0; i < 20; i++) paced.wake(); // waking while running sends nothing extra
      vi.advanceTimersByTime(200);
      paced.stop();
      expect(sent[0]).toBe(2000);
      // Then at 33 ms into each 50 ms cycle.
      const cycle = (at: number) => ((at - 2033) % 50 + 50) % 50;
      for (const at of sent.slice(1)) expect(Math.min(cycle(at), 50 - cycle(at))).toBeLessThan(3);
      for (let i = 1; i < sent.length; i++) expect(sent[i]! - sent[i - 1]!).toBeGreaterThanOrEqual(25);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("owner rooms connected straight between pages", () => {
  const hooks = (sent: unknown[] = [], direct: unknown[] = []) => ({
    send: (type: string, value: unknown) => sent.push({ type, value }),
    sendDirect: (packet: unknown) => direct.push(packet),
    show: () => {},
    playerId: () => "me",
    tickMs: () => 100,
    clock: new TickClock(() => 100),
  });

  it("keeps whichever of a player's states is newer, straight from their page or from the service", () => {
    const owner = new OwnerSession(hooks());
    const other = () => owner.game().players.b;
    owner.sync({ round: 1, players: { b: { x: 0 } }, shared: {}, seqs: { b: 3 } });
    // Straight from the page: newer than the service's version 3.
    owner.direct("b", { round: 1, seq: 5, state: { x: 5, y: 1 } });
    expect(other()).toEqual({ x: 5, y: 1 });
    // The service's frame for version 4 is older: skipped.
    owner.frame({ round: 1, players: { b: { set: { x: 4 }, seq: 4 } } });
    expect(other()).toEqual({ x: 5, y: 1 });
    // Version 7 builds on the service's previous frame, which version 5 is newer than: applied on top.
    owner.frame({ round: 1, players: { b: { set: { x: 7 }, delete: ["y"], seq: 7 } } });
    expect(other()).toEqual({ x: 7 });
    // A late or out-of-order direct state is older: dropped.
    owner.direct("b", { round: 1, seq: 6, state: { x: 6 } });
    expect(other()).toEqual({ x: 7 });
    // Wrong round, malformed, too large, or from this page: dropped.
    owner.direct("b", { round: 2, seq: 9, state: { x: 9 } });
    owner.direct("b", { round: 1, seq: "9", state: { x: 9 } });
    owner.direct("b", { round: 1, seq: 9, state: { big: "x".repeat(5000) } });
    owner.direct("me", { round: 1, seq: 9, state: { x: 9 } });
    expect(owner.game().players).toEqual({ me: {}, b: { x: 7 } });
    // A player who left stays gone, even if a direct state of theirs arrives late.
    owner.frame({ round: 1, left: ["b"] });
    owner.direct("b", { round: 1, seq: 20, state: { x: 20 } });
    expect(owner.game().players).toEqual({ me: {} });
  });

  it("sends its whole state straight to other pages at once, then at most every 33 ms with the newest", () => {
    vi.useFakeTimers();
    try {
      const sent: { type: string; value: unknown }[] = [];
      const direct: unknown[] = [];
      const owner = new OwnerSession(hooks(sent as unknown[], direct));
      owner.sync({ round: 2, players: {}, shared: {} });
      owner.setState({ x: 1 });
      owner.setState({ x: 2 });
      owner.setState({ x: 3 });
      expect(direct).toEqual([{ round: 2, seq: 1, state: { x: 1 } }]);
      vi.advanceTimersByTime(OWNER_DIRECT_INTERVAL_MS);
      expect(direct).toEqual([{ round: 2, seq: 1, state: { x: 1 } }, { round: 2, seq: 3, state: { x: 3 } }]);
      // The service's copy carries the same version, so a page that has both keeps the newer.
      vi.advanceTimersByTime(200);
      expect(sent.find((entry) => entry.type === "owner.state")?.value).toMatchObject({ seq: expect.any(Number) });
      // Back in the same round after a reload, versions continue past what the service had.
      const again: unknown[] = [];
      const reloaded = new OwnerSession(hooks([], again));
      reloaded.sync({ round: 2, players: { me: { x: 3 } }, shared: {}, seqs: { me: 3 } });
      reloaded.setState({ x: 4 });
      expect((again[0] as { seq: number }).seq).toBeGreaterThan(3 + 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects two pages, the lower ID offering, and passes packets both ways", async () => {
    FakePeerConnection.reset();
    const got: { to: string; channel: string; from: string; packet: unknown }[] = [];
    const meshes = new Map<string, PeerMesh>();
    const mesh = (me: string) => {
      const created = new PeerMesh({
        signal: (to, data) => setTimeout(() => void meshes.get(to)?.receive(me, structuredClone(data)), 1),
        playerId: () => me,
        state: (from, packet) => got.push({ to: me, channel: "states", from, packet }),
        message: (from, packet) => got.push({ to: me, channel: "messages", from, packet }),
      }, { peerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection });
      meshes.set(me, created);
      return created;
    };
    const [a, b] = [mesh("a"), mesh("b")];
    b.update(["a", "b"]);
    expect(b.status()).toEqual({});
    a.update(["a", "b"]);
    expect(a.status()).toEqual({ b: "connecting" });
    await vi.waitFor(() => expect([a.status(), b.status()]).toEqual([{ b: "open" }, { a: "open" }]));
    const [offer] = [...FakePeerConnection.all.values()];
    expect(offer!.configuration.iceServers).toEqual(DEFAULT_ICE_SERVERS);
    a.sendState({ round: 1, seq: 1, state: { x: 1 } });
    b.sendMessage({ id: "m1", message: { hit: true } });
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got).toContainEqual({ to: "b", channel: "states", from: "a", packet: { round: 1, seq: 1, state: { x: 1 } } });
    expect(got).toContainEqual({ to: "a", channel: "messages", from: "b", packet: { id: "m1", message: { hit: true } } });
    // A player who left is dropped. The other side sees its connection end at once, and
    // forgets the player once its own room shows them gone.
    a.update(["a"]);
    expect(a.status()).toEqual({});
    await vi.waitFor(() => expect(b.status()).toEqual({ a: "failed" }));
    b.update(["b"]);
    expect(b.status()).toEqual({});
    // Rooms larger than P2P_MAX_PLAYERS connect none.
    a.update(Array.from({ length: P2P_MAX_PLAYERS }, (_, index) => `p${index}`).concat("a"));
    expect(a.status()).toEqual({});
  });

  it("gives up a connection that does not open, and offers again later", async () => {
    vi.useFakeTimers();
    FakePeerConnection.reset();
    FakePeerConnection.reachable = false;
    try {
      const meshes = new Map<string, PeerMesh>();
      const mesh = (me: string) => {
        const created = new PeerMesh({
          signal: (to, data) => setTimeout(() => void meshes.get(to)?.receive(me, data), 1),
          playerId: () => me,
          state: () => {},
          message: () => {},
        }, { peerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection });
        meshes.set(me, created);
        return created;
      };
      const [a, b] = [mesh("a"), mesh("b")];
      a.update(["a", "b"]);
      b.update(["a", "b"]);
      await vi.advanceTimersByTimeAsync(P2P_CONNECT_TIMEOUT_MS + 10);
      expect([a.status(), b.status()]).toEqual([{ b: "failed" }, { a: "failed" }]);
      // Not before the retry time; then the offering page tries again.
      a.update(["a", "b"]);
      expect(a.status()).toEqual({ b: "failed" });
      FakePeerConnection.reachable = true;
      await vi.advanceTimersByTimeAsync(P2P_RETRY_MS);
      a.update(["a", "b"]);
      await vi.advanceTimersByTimeAsync(500);
      expect([a.status(), b.status()]).toEqual([{ b: "open" }, { a: "open" }]);
    } finally {
      vi.useRealTimers();
      FakePeerConnection.reset();
    }
  });

  it("is only for owner deployments, and does nothing where the browser has no WebRTC", () => {
    // Elsewhere the option is ignored with a warning, and the game still connects through the service.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new MultiplayerClient({ manifest, p2p: true });
    expect(warn).toHaveBeenCalledWith("p2p is for owner deployments; this game connects through the service only.");
    expect(client.peers).toEqual({});
    client.dispose();
    warn.mockRestore();
    const without = new PeerMesh({ signal: () => {}, playerId: () => "a", state: () => {}, message: () => {} });
    expect(without.available).toBe(typeof RTCPeerConnection === "function");
    without.update(["a", "b"]);
    if (!without.available) expect(without.status()).toEqual({});
  });
});
