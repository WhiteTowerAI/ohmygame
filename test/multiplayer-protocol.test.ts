import { describe, expect, it } from "vitest";
import {
  isPublishedMultiplayerManifest,
  isMultiplayerEvent,
  isMultiplayerManifestConfig,
  isTurnCommand,
  isTurnCommandResult,
  normalizeDisplayName,
  sameJson,
  applyStateChanges,
  isSnapshotDelta,
  stateChanges,
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
  it("sends a tick as what changed, and rebuilds the state from it", () => {
    const seat = (id: string, x: number) => ({ playerId: id, displayName: id, connected: true, x, y: 50 });
    const before = {
      phase: "playing",
      players: [seat("a", 1), seat("b", 2)],
      game: { snake: [{ x: 3, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }], score: { a: 1 }, gone: true, kept: { deep: [1, 2] } },
    };
    const after = {
      phase: "playing",
      players: [seat("a", 1.5), seat("b", 2)],
      game: { snake: [{ x: 4, y: 1 }, { x: 3, y: 1 }, { x: 2, y: 1 }], score: { a: 1, b: 0 }, kept: before.game.kept, maybe: undefined },
    };
    const changes = stateChanges(before, after);
    expect(changes).toEqual([
      [["players", 0, "x"], 1.5],
      // Every cell of the snake moved: the whole array is smaller than each change.
      [["game", "snake"], after.game.snake],
      [["game", "score", "b"], 0],
      [["game", "gone"]],
    ]);
    const rebuilt = applyStateChanges(before, changes);
    expect(sameJson(rebuilt, after)).toBe(true);
    // Only what changed is copied, and the state it started from is left alone.
    expect(rebuilt.players[1]).toBe(before.players[1]);
    expect(rebuilt.game.kept).toBe(before.game.kept);
    expect(before.players[0]!.x).toBe(1);
    expect(stateChanges(before, structuredClone(before))).toEqual([]);
    // Everyone moving still sends each seat's position, not every seat whole.
    const seats = ["a", "b", "c", "d"].map((id, index) => seat(id, index));
    expect(stateChanges({ players: seats }, { players: seats.map((p) => ({ ...p, x: p.x + 0.6 })) })).toHaveLength(4);
    expect(applyStateChanges(before, [[[], { phase: "lobby" }]])).toEqual({ phase: "lobby" });
  });

  it("applies a key named __proto__ as data, never to the prototype", () => {
    const rebuilt = applyStateChanges({ game: {} } as Record<string, unknown>, [[["game", "__proto__", "polluted"], true]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(rebuilt.game as object, "__proto__")).toBe(true);
    expect(sameJson(stateChanges({}, JSON.parse('{"__proto__":{"x":1}}')), [[["__proto__"], { x: 1 }]])).toBe(true);
  });

  it("reads a tick's changes only in the shape the service sends them", () => {
    const delta = { roomId: "r", sequence: 3, base: 2, serverTime: new Date().toISOString(), changes: [[["players", 0, "x"], 1], [["gone"]]] };
    expect(isSnapshotDelta(delta)).toBe(true);
    for (const changes of [[["x", 1]], [[[-1], 1]], [[["x"], 1, 2]], [[[{ key: 1 }], 1]], "x"])
      expect(isSnapshotDelta({ ...delta, changes })).toBe(false);
    expect(isSnapshotDelta({ ...delta, base: undefined })).toBe(false);
  });
});
