import { describe, expect, it } from "vitest";
import {
  isPublishedMultiplayerManifest,
  isMultiplayerEvent,
  isMultiplayerManifestConfig,
  isTurnCommand,
  isTurnCommandResult,
  normalizeDisplayName,
} from "../src/shared/multiplayer-protocol.js";
import { isPublishedNodeManifest } from "../src/shared/playable-publish.js";

const manifest = {
  enabled: true,
  mode: "turn-based",
  gameId: "game_123",
  deploymentId: "deploy_123",
  protocolVersion: 1,
  serverUrl: "https://games.example.test",
  authPolicy: "guest-or-account",
  roomPolicy: "invite-or-public",
  maxClients: 4,
  reconnectSeconds: 120,
} as const;

describe("multiplayer protocol", () => {
  it("accepts a versioned manifest and rejects unsafe server settings", () => {
    expect(isMultiplayerManifestConfig(manifest)).toBe(true);
    expect(
      isMultiplayerManifestConfig({
        ...manifest,
        serverUrl: "http://localhost:43130",
      }),
    ).toBe(false);
    expect(isMultiplayerManifestConfig({ ...manifest, maxClients: 0 })).toBe(
      false,
    );
    expect(
      isMultiplayerManifestConfig({ ...manifest, protocolVersion: 2 }),
    ).toBe(false);
    expect(
      isPublishedNodeManifest({
        version: 1,
        runtime: "playable-nodes",
        scope: "published:game_123",
        graphSignature: "a".repeat(64),
        definition: {
          path: "./playable.json",
          integrity: `sha256-${"A".repeat(43)}=`,
        },
        assets: {},
        multiplayer: manifest,
      }),
    ).toBe(false);
    expect(
      isPublishedMultiplayerManifest({
        version: 1,
        runtime: "multiplayer-example",
        multiplayer: manifest,
      }),
    ).toBe(true);
  });

  it("validates idempotent turn commands and ordered events", () => {
    const command = {
      commandId: "command-1",
      expectedSequence: 3,
      type: "pass",
    } as const;
    expect(isTurnCommand(command)).toBe(true);
    expect(isTurnCommand({ ...command, expectedSequence: -1 })).toBe(false);
    const event = {
      type: "turn.changed",
      roomId: "room-1",
      deploymentId: "deploy-123",
      sequence: 4,
      serverTime: new Date().toISOString(),
      payload: { currentPlayerId: "player-2" },
    } as const;
    expect(isMultiplayerEvent(event)).toBe(true);
    expect(
      isTurnCommandResult({
        commandId: "command-1",
        accepted: true,
        sequence: 4,
        event,
      }),
    ).toBe(true);
  });

  it("normalizes player display names", () => {
    expect(normalizeDisplayName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
    expect(normalizeDisplayName(" ")).toBe("Guest");
    expect(normalizeDisplayName("x".repeat(100))).toHaveLength(40);
  });
});
