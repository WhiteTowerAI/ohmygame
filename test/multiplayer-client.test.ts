import { Client, type Room } from "@colyseus/sdk";
import { describe, expect, it, vi } from "vitest";
import { init, isOhMyGameError, OhMyGameError } from "@ohmygame/sdk";
import { createMultiplayerClient, MultiplayerClient } from "@ohmygame/sdk/multiplayer";
import type { MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";

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
  });
});
