import { Client, type Room } from "@colyseus/sdk";
import { describe, expect, it, vi } from "vitest";
import { MultiplayerClient } from "../src/shared/multiplayer-client.js";
import type { MultiplayerManifestConfig } from "../src/shared/multiplayer-protocol.js";

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
        accessToken: async () => "account-token",
        connectionTimeoutMs: 30,
      },
      {
        onStatus: (status) => statuses.push(status),
        onError: (error) => errors.push(error),
      },
    );
    await expect(client.createRoom()).rejects.toThrow(/timed out/);
    const leave = vi.fn(async () => {});
    resolve({ reconnection: { enabled: true }, leave } as unknown as Room);
    await vi.waitFor(() => expect(leave).toHaveBeenCalledWith(true));
    expect(client.status).toBe("error");
    expect(statuses).toEqual(["connecting", "error"]);
    expect(errors).toHaveLength(1);
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
});
