import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Room, type Client } from "@colyseus/core";
import {
  isRealtimeInput,
  isRecord,
  isTurnCommand,
  normalizeDisplayName,
  type JoinRoomOptions,
  type MultiplayerErrorCode,
  type MultiplayerEventType,
  type MultiplayerGameState,
  type MultiplayerManifestConfig,
  type MultiplayerSnapshot,
  type RealtimeInput,
  type TurnCommand,
  type TurnCommandResult,
} from "../shared/multiplayer-protocol.js";
import { MultiplayerRoomState } from "../shared/multiplayer-state.js";
import type { MultiplayerIdentity } from "./auth.js";
import { nextTurn, TICK_MS } from "./game.js";
import type { GameAdapter } from "./adapters.js";
import type { RoomStore, StoredRoom } from "./store.js";

export interface RoomServices {
  config: MultiplayerManifestConfig;
  store: RoomStore;
  restoring: Map<string, StoredRoom>;
  adapter: GameAdapter;
  reserve(roomId: string): boolean;
}
export const ROOM_IDLE_MS = 30 * 60 * 1000;

/** Transport, membership and persistence surround pure game rules. */
export class GameRoom extends Room {
  state = new MultiplayerRoomState();
  private record!: StoredRoom;
  private readonly controls = new Map<string, string>();
  private readonly playerInputs = new Map<
    string,
    { input: RealtimeInput; at: number }
  >();
  private shuttingDown = false;
  private lastInputId = new Map<string, number>();
  private inviteCode = "";
  protected services!: RoomServices;

  async onCreate(options: Record<string, unknown>): Promise<void> {
    const { config, store, restoring } = this.services;
    const restored =
      typeof options.restoreToken === "string"
        ? restoring.get(options.restoreToken)
        : undefined;
    if (restored) restoring.delete(String(options.restoreToken));
    const now = Date.now();
    if (restored) {
      this.roomId = restored.snapshot.roomId;
      this.record = structuredClone(restored);
      for (const player of this.record.snapshot.state.players)
        player.connected = false;
    } else {
      if (
        typeof options.creationKey !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(options.creationKey)
      )
        throw new Error("A room creation key is required.");
      this.inviteCode = randomBytes(8).toString("hex").toUpperCase();
      this.record = {
        config,
        snapshot: {
          roomId: this.roomId,
          gameId: config.gameId,
          deploymentId: config.deploymentId,
          mode: config.mode,
          sequence: 0,
          state: this.services.adapter.initialState(),
          serverTime: new Date(now).toISOString(),
        },
        members: [],
        inviteCodeHash: hashInviteCode(this.inviteCode),
        creationKeyHash: hashInviteCode(options.creationKey),
        updatedAt: now,
      };
    }
    if (!this.services.reserve(this.roomId))
      throw new Error("The multiplayer service has reached its room limit.");
    this.maxClients = config.maxClients;
    this.maxMessagesPerSecond = config.mode === "realtime" ? 40 : 10;
    this.patchRate = config.mode === "realtime" ? TICK_MS : 50;
    this.autoDispose = false;
    await this.setPrivate(
      config.roomPolicy === "invite-only" ||
        this.record.snapshot.state.phase !== "lobby",
    );
    await this.setMetadata({
      gameId: config.gameId,
      deploymentId: config.deploymentId,
      mode: config.mode,
    });
    store.save(this.record);
    this.sync();
    this.onMessage("sync", (client) => {
      client.send("ready", {
        playerId: this.controls.get(client.sessionId),
        inviteCode:
          this.controls.get(client.sessionId) ===
          this.record.snapshot.state.ownerId
            ? this.inviteCode || undefined
            : undefined,
      });
      client.send("snapshot", this.snapshot());
    });
    this.onMessage("command", (client, value: unknown) =>
      this.command(client, value),
    );
    this.onMessage("input", (client, value: unknown) =>
      this.input(client, value),
    );
    this.clock.setInterval(() => this.maintenance(), 1000);
    if (config.mode === "realtime")
      this.setTimestep(() => this.tick(), TICK_MS);
  }

  onJoin(client: Client, options: JoinRoomOptions): void {
    this.validateVersion(options);
    const identity = client.auth as MultiplayerIdentity | undefined;
    if (!identity?.userId)
      throw new Error("Player authentication is required.");
    const known = this.record.members.find(
      (member) => member.userId === identity.userId,
    );
    if (known?.banned) throw new Error("You have been removed from this room.");
    const ownerCreating =
      !this.record.snapshot.state.ownerId &&
      typeof options.creationKey === "string" &&
      hashInviteCode(options.creationKey) === this.record.creationKeyHash;
    if (
      this.services.config.roomPolicy === "invite-only" &&
      !known &&
      !ownerCreating &&
      !this.matchesInvite(options.roomCode)
    )
      throw new Error("A valid invite code is required.");
    if (options.roomCode && !this.matchesInvite(options.roomCode))
      throw new Error("The invite code is invalid.");
    const state = structuredClone(this.record.snapshot.state);
    if (state.phase === "closed") throw new Error("The room is closed.");
    if (!state.ownerId && !ownerCreating)
      throw new Error("The room owner has not joined yet.");
    let player =
      known && state.players.find((p) => p.playerId === known.playerId);
    if (
      player?.connected ||
      (known && [...this.controls.values()].includes(known.playerId))
    )
      throw new Error("This player already controls the room in another tab.");
    const members = this.record.members.map((member) => ({ ...member }));
    if (!player) {
      if (state.players.length >= this.maxClients)
        throw new Error("The room is full.");
      if (state.phase !== "lobby")
        throw new Error("This game has already started.");
      const playerId = known?.playerId ?? randomUUID();
      player = {
        playerId,
        displayName: normalizeDisplayName(options.displayName),
        connected: true,
        x: 5 + (state.players.length * 80) / this.maxClients,
        y: 5,
      };
      state.players.push(player);
      if (!known) members.push({ playerId, userId: identity.userId });
      if (!state.ownerId) state.ownerId = playerId;
    } else player.connected = true;
    this.controls.set(client.sessionId, player.playerId);
    this.lastInputId.delete(player.playerId);
    this.commit(
      state,
      "member.joined",
      { playerId: player.playerId },
      undefined,
      true,
      true,
      members,
    );
    client.send("ready", {
      playerId: player.playerId,
      inviteCode: ownerCreating ? this.inviteCode : undefined,
    });
    client.send("snapshot", this.snapshot());
  }

  async onDrop(client: Client): Promise<void> {
    this.connected(client, false);
    try {
      await this.allowReconnection(
        client,
        this.services.config.reconnectSeconds,
      );
    } catch {
      /* onLeave handles expiration after Colyseus releases the seat. */
    }
  }
  onReconnect(client: Client): void {
    this.validateIdentity(client);
    this.lastInputId.delete(this.controls.get(client.sessionId)!);
    this.connected(client, true);
    client.send("ready", { playerId: this.controls.get(client.sessionId) });
    client.send("snapshot", this.snapshot());
  }
  onLeave(client: Client): void {
    const id = this.controls.get(client.sessionId);
    this.controls.delete(client.sessionId);
    if (!id || this.shuttingDown) return;
    const state = structuredClone(this.record.snapshot.state);
    const player = state.players.find((p) => p.playerId === id);
    if (!player) return;
    player.connected = false;
    this.playerInputs.delete(id);
    // During a match seats persist for asynchronous turns; timeout skips them.
    if (state.phase === "lobby") {
      state.players = state.players.filter((p) => p.playerId !== id);
      if (state.ownerId === id)
        state.ownerId = state.players[0]?.playerId ?? "";
      if (!state.players.length) state.phase = "closed";
    }
    this.commit(state, "member.left", { playerId: id });
    if (state.phase === "closed") void this.disconnect();
  }
  onBeforeShutdown(): void {
    this.shuttingDown = true;
    const state = structuredClone(this.record.snapshot.state);
    for (const player of state.players) player.connected = false;
    if (this.services.config.mode === "realtime") state.phase = "closed";
    this.commit(
      state,
      state.phase === "closed" ? "room.closed" : "state.updated",
      { reason: "service_restart" },
    );
    void this.disconnect(
      this.services.config.mode === "turn-based" ? 1001 : undefined,
    );
  }

  snapshot(): MultiplayerSnapshot {
    return structuredClone(this.record.snapshot);
  }
  authorizedSnapshot(userId: string): MultiplayerSnapshot {
    if (
      !this.record.members.some(
        (member) => member.userId === userId && !member.banned,
      )
    )
      throw new Error("Room membership is required.");
    return this.snapshot();
  }
  matchesInvite(code: unknown): boolean {
    return (
      typeof code === "string" &&
      /^[a-f0-9]{16}$/i.test(code.trim()) &&
      hashInviteCode(code) === this.record.inviteCodeHash
    );
  }

  private validateVersion(options: JoinRoomOptions): void {
    if (
      !isRecord(options) ||
      options.gameId !== this.services.config.gameId ||
      options.deploymentId !== this.services.config.deploymentId
    )
      throw new Error("The room belongs to a different game deployment.");
    if (options.protocolVersion !== 1)
      throw new Error("The room protocol version is not supported.");
  }
  private validateIdentity(client: Client): void {
    const id = this.controls.get(client.sessionId);
    if (
      !id ||
      this.record.members.find((member) => member.playerId === id)?.banned
    )
      throw new Error("This player cannot control the room.");
  }
  private connected(client: Client, connected: boolean): void {
    const id = this.controls.get(client.sessionId);
    const state = structuredClone(this.record.snapshot.state);
    const player = state.players.find((p) => p.playerId === id);
    if (!player || this.shuttingDown) return;
    player.connected = connected;
    this.playerInputs.delete(player.playerId);
    this.commit(state, connected ? "member.joined" : "member.left", {
      playerId: id,
      reconnected: connected,
    });
  }
  private command(client: Client, value: unknown): void {
    const id = this.controls.get(client.sessionId);
    if (!id) return;
    const commandId =
      isRecord(value) && typeof value.commandId === "string"
        ? value.commandId.slice(0, 100)
        : "invalid";
    const reject = (code: MultiplayerErrorCode, message: string) => {
      const result: TurnCommandResult = {
        commandId,
        accepted: false,
        sequence: this.record.snapshot.sequence,
        error: { code, message },
      };
      if (isTurnCommand(value))
        this.services.store.save(this.record, { playerId: id, value, result });
      client.send("command.result", result);
    };
    if (!isTurnCommand(value)) {
      reject("invalid_command", "The command is invalid.");
      return;
    }
    const previous = this.services.store.result(
      this.roomId,
      id,
      value.commandId,
    );
    if (previous) {
      client.send("command.result", previous);
      return;
    }
    if (value.expectedSequence !== this.record.snapshot.sequence) {
      reject("sequence_conflict", "The room state changed. Try again.");
      client.send("snapshot", this.snapshot());
      return;
    }
    try {
      const adapter = this.services.adapter;
      adapter.validateCommand(this.record.snapshot.state, id, value);
      const state = adapter.applyCommand(this.record.snapshot.state, id, value);
      const members = this.record.members.map((member) => ({ ...member }));
      if (value.type === "kick") {
        const member = members.find(
          (m) => m.playerId === value.payload?.playerId,
        );
        if (member) member.banned = true;
      }
      const result: TurnCommandResult = {
        commandId,
        accepted: true,
        sequence: this.record.snapshot.sequence + 1,
      };
      const type =
        state.phase === "closed"
          ? "room.closed"
          : state.phase === "finished"
            ? "room.finished"
            : value.type === "take" || value.type === "pass" || value.type === "action"
              ? "turn.changed"
              : "state.updated";
      this.commit(
        state,
        type,
        { actorId: id },
        { playerId: id, value, result },
        true,
        true,
        members,
      );
      if (state.phase !== "lobby") void this.setPrivate(true);
      client.send("command.result", result);
      if (value.type === "kick")
        for (const connection of this.clients)
          if (
            this.controls.get(connection.sessionId) === value.payload?.playerId
          )
            connection.leave(4003, "Removed by the room owner.");
      if (state.phase === "closed") void this.disconnect();
    } catch (cause) {
      reject(
        this.record.snapshot.state.currentPlayerId !== id &&
          (value.type === "take" || value.type === "pass" || value.type === "action")
          ? "not_your_turn"
          : "invalid_command",
        cause instanceof Error ? cause.message : "The command failed.",
      );
    }
  }
  private input(client: Client, value: unknown): void {
    const id = this.controls.get(client.sessionId);
    if (
      !id ||
      !isRealtimeInput(value) ||
      this.services.config.mode !== "realtime" ||
      this.record.snapshot.state.phase !== "playing"
    ) {
      client.send("input.error", {
        code: "invalid_command",
        message: "The movement input is invalid.",
      });
      return;
    }
    if (value.inputId <= (this.lastInputId.get(id) ?? -1)) return;
    this.lastInputId.set(id, value.inputId);
    this.playerInputs.set(id, { input: value, at: Date.now() });
  }
  private tick(): void {
    if (
      this.record.snapshot.state.phase !== "playing" ||
      !this.playerInputs.size
    )
      return;
    const now = Date.now();
    const state = this.services.adapter.step!(this.record.snapshot.state, this.playerInputs, now);
    if (JSON.stringify(state) === JSON.stringify(this.record.snapshot.state))
      return;
    // Realtime games close on service restart, so only the terminal state needs a disk write.
    this.commit(
      state,
      state.phase === "finished" ? "room.finished" : "state.updated",
      {},
      undefined,
      state.phase === "finished",
    );
  }
  private maintenance(): void {
    const now = Date.now();
    if (this.shuttingDown) return;
    if (now - this.record.updatedAt > ROOM_IDLE_MS) {
      this.commit(
        { ...this.record.snapshot.state, phase: "closed" },
        "room.closed",
        { reason: "idle_timeout" },
      );
      void this.disconnect();
    } else if (
      this.services.config.mode === "turn-based" &&
      this.record.snapshot.state.phase === "playing" &&
      now >= this.record.snapshot.state.turnDeadline
    ) {
      let state = structuredClone(this.record.snapshot.state);
      if (this.services.adapter.onTurnTimeout) state = this.services.adapter.onTurnTimeout(state, now);
      else nextTurn(state, now);
      this.commit(
        state,
        "turn.changed",
        { reason: "turn_timeout" },
        undefined,
        true,
        false,
      );
    }
  }
  private commit(
    state: MultiplayerGameState,
    type: MultiplayerEventType,
    payload: unknown,
    command?: {
      playerId: string;
      value: TurnCommand;
      result: TurnCommandResult;
    },
    persist = true,
    active = true,
    members = this.record.members,
  ): void {
    const now = Date.now();
    const record: StoredRoom = {
      ...this.record,
      members,
      snapshot: {
        ...this.record.snapshot,
        sequence: this.record.snapshot.sequence + 1,
        state,
        serverTime: new Date(now).toISOString(),
      },
      updatedAt: active ? now : this.record.updatedAt,
    };
    if (persist) this.services.store.save(record, command);
    this.record = record;
    this.sync();
    this.broadcast("event", {
      type,
      roomId: this.roomId,
      deploymentId: this.services.config.deploymentId,
      sequence: record.snapshot.sequence,
      serverTime: record.snapshot.serverTime,
      payload,
    });
  }
  private sync(): void {
    this.state.snapshot = JSON.stringify(this.record.snapshot);
  }
}

export function hashInviteCode(value: string): string {
  return createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
}
