import { Client, type Room } from "@colyseus/sdk";
import { describe, expect, it, vi } from "vitest";
import { init, isOhMyGameError, OhMyGameError } from "@ohmygame/sdk";
import { MultiplayerClient } from "@ohmygame/sdk/multiplayer";
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
      expect(game.createMultiplayerClient()).toBeInstanceOf(MultiplayerClient);
    } finally {
      fetch.mockRestore();
    }
    const single = await init({ manifest: { title: "Solo" } as { multiplayer?: unknown } });
    expect(single.multiplayer).toBeUndefined();
    expect(() => single.createMultiplayerClient()).toThrow(expect.objectContaining({ code: "not_configured" }));
    const local = { multiplayer: { ...manifest, serverUrl: "http://127.0.0.1:43139" } };
    await expect(init({ manifest: local })).rejects.toMatchObject({ code: "not_configured", message: expect.stringMatching(/allowLocalhost/) });
    expect((await init({ manifest: local, allowLocalhost: true })).multiplayer?.serverUrl).toBe("http://127.0.0.1:43139");
    await expect(init({ manifest: { multiplayer: { enabled: true } } })).rejects.toBeInstanceOf(OhMyGameError);

    const accounts = await init({ manifest: { multiplayer: { ...manifest, authPolicy: "account-required" } } });
    const transport = new Client(manifest.serverUrl);
    const create = vi.spyOn(transport, "create");
    const client = accounts.createMultiplayerClient({}, { transport });
    await expect(client.createRoom()).rejects.toMatchObject({ code: "sign_in_required" });
    expect(create).not.toHaveBeenCalled();
    client.dispose();
  });
});
