import { describe, expect, it } from "vitest";
import {
  isPublishedMultiplayerManifest,
  isMultiplayerEvent,
  isMultiplayerManifestConfig,
  isTurnCommand,
  isTurnCommandResult,
  normalizeDisplayName,
  sameJson,
} from "@ohmygame/sdk/protocol";

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
  adapterId: "stones",
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
    expect(isMultiplayerManifestConfig({ ...manifest, mode: "realtime", roomPolicy: "drop-in" })).toBe(true);
    expect(isMultiplayerManifestConfig({ ...manifest, mode: "turn-based", roomPolicy: "drop-in" })).toBe(false);
    expect(
      isMultiplayerManifestConfig({ ...manifest, protocolVersion: 2 }),
    ).toBe(false);
    const { gameId: _gameId, ...missingGameId } = manifest;
    for (const invalid of [
      missingGameId,
      { ...manifest, extra: true },
      { ...manifest, gameId: "has space" },
      { ...manifest, maxClients: 2.5 },
      { ...manifest, maxClients: "4" },
      { ...manifest, reconnectSeconds: 3601 },
      { ...manifest, authPolicy: "everyone" },
      [manifest],
      null,
    ])
      expect(isMultiplayerManifestConfig(invalid)).toBe(false);
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
      type: "start",
    } as const;
    expect(isTurnCommand(command)).toBe(true);
    expect(isTurnCommand({ ...command, expectedSequence: -1 })).toBe(false);
    expect(isTurnCommand({ ...command, type: "action", payload: { action: "take", count: 2 } })).toBe(true);
    // The room commands carry no game: a game's moves travel as actions.
    expect(isTurnCommand({ ...command, type: "take", payload: { count: 2 } })).toBe(false);
    expect(isTurnCommand({ ...command, type: "pass" })).toBe(false);
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

  it("allows loopback HTTP only when local testing is explicitly enabled", () => {
    for (const serverUrl of ["http://127.0.0.1:43130", "http://localhost:43130", "http://[::1]:43130"]) {
      const local = { ...manifest, serverUrl, adapterId: "gomoku", maxClients: 2 };
      expect(isMultiplayerManifestConfig(local)).toBe(false);
      expect(isMultiplayerManifestConfig(local, { allowLocalhost: true })).toBe(true);
    }
    for (const serverUrl of ["http://192.168.1.2:43130", "http://127.0.0.1.evil.test", "http://user@localhost:43130", "http://localhost:43130/other"]) {
      expect(isMultiplayerManifestConfig({ ...manifest, serverUrl }, { allowLocalhost: true })).toBe(false);
    }
  });
  it("compares states as JSON would serialize them", () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    // A rule that leaves a key undefined has not changed the state the room would send.
    expect(sameJson({ a: undefined, b: 1 }, { b: 1 })).toBe(true);
    expect(sameJson({ b: 1 }, { a: undefined, b: 1 })).toBe(true);
    expect(sameJson({ a: null }, {})).toBe(false);
    expect(sameJson([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameJson({ players: [{ x: 1 }] }, { players: [{ x: 1.5 }] })).toBe(false);
    expect(sameJson(JSON.parse('{"__proto__":{}}'), { other: 1 })).toBe(false);
  });
});
