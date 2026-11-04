import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CloseCode, Room, type Client } from "@colyseus/core";
import {
  isRealtimeAction,
  isRealtimeInputMessage,
  isRecord,
  isTurnCommand,
  MULTIPLAYER_ROOM_LIMIT_CODE,
  normalizeDisplayName,
  REALTIME_ACTIONS_PER_TICK,
  type JoinRoomOptions,
  type MultiplayerErrorCode,
  type MultiplayerEventType,
  type MultiplayerGameState,
  type MultiplayerManifestConfig,
  type MultiplayerSnapshot,
  type RealtimeAction,
  type RealtimeInput,
  type TurnCommand,
  type TurnCommandResult,
} from "@ohmygame/sdk/protocol";
import type { MultiplayerIdentity } from "./auth.js";
import { nextTurn, tickMsOf } from "./game.js";
import { describePlayerRange, type GameAdapter } from "./adapters.js";
import type { RoomStore, StoredRoom } from "./store.js";

export interface RoomServices {
  config: MultiplayerManifestConfig;
  store: RoomStore;
  restoring: Map<string, StoredRoom>;
  adapter: GameAdapter;
  reserve(roomId: string): boolean;
  /** How long a finished drop-in round shows its result before the next one starts. */
  roundRestartMs: number;
}
export const ROOM_IDLE_MS = 30 * 60 * 1000;
export const ROUND_RESTART_MS = 3000;
/** Messages a turn-based connection may send in a second before it is closed. */
const TURN_MAX_MESSAGES_PER_SECOND = 10;
/**
 * A realtime connection sends an input at most once a tick, plus a few commands. It may
 * send twice that, and never less than 40 a second, before it is closed.
 */
function realtimeMessageLimit(tickMs: number): number {
  return Math.max(40, Math.ceil((2 * 1000) / tickMs));
}
/** An input counts until the player has missed five ticks, and at least 250 ms. */
function inputLifetimeMs(tickMs: number): number {
  return Math.max(250, 5 * tickMs);
}

/**
 * Transport, membership and persistence surround pure game rules. Snapshots go to each
 * connection as a message, never as shared room state, so a rules adapter can hide
 * one player's data from another.
 */
export class GameRoom extends Room {
  private record!: StoredRoom;
  private readonly controls = new Map<string, string>();
  private readonly playerInputs = new Map<
    string,
    { input: RealtimeInput; at: number }
  >();
  /** Actions for the next tick, in the order they arrived. */
  private actions: { playerId: string; action: RealtimeAction }[] = [];
  private shuttingDown = false;
  private lastInputId = new Map<string, number>();
  private inviteCode = "";
  private finishedAt = 0;
  protected services!: RoomServices;

  /** Players drop into a running round; the room starts and restarts it, so nobody owns it. */
  private get dropIn(): boolean {
    return this.services.config.roomPolicy === "drop-in";
  }

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
      // Quick play opens a drop-in room on demand, so it brings no creation key.
      if (
        !this.dropIn &&
        (typeof options.creationKey !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(options.creationKey))
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
        creationKeyHash: hashInviteCode(
          typeof options.creationKey === "string" ? options.creationKey : randomUUID(),
        ),
        updatedAt: now,
      };
    }
    if (!this.services.reserve(this.roomId))
      throw Object.assign(
        new Error("The multiplayer service has reached its room limit. Try again shortly."),
        { code: MULTIPLAYER_ROOM_LIMIT_CODE },
      );
    this.maxClients = config.maxClients;
    this.maxMessagesPerSecond =
      config.mode === "realtime" ? realtimeMessageLimit(this.tickMs) : TURN_MAX_MESSAGES_PER_SECOND;
    this.autoDispose = false;
    await this.setPrivate(
      config.roomPolicy === "invite-only" ||
        (!this.dropIn && this.record.snapshot.state.phase !== "lobby"),
    );
    await this.setMetadata({
      gameId: config.gameId,
      deploymentId: config.deploymentId,
      mode: config.mode,
    });
    store.save(this.record);
    this.onMessage("sync", (client) => {
      const playerId = this.controls.get(client.sessionId);
      client.send("ready", {
        playerId,
        ...this.tickInfo(),
        inviteCode:
          playerId && (this.dropIn || playerId === this.record.snapshot.state.ownerId)
            ? this.inviteCode || undefined
            : undefined,
      });
      client.send("snapshot", this.snapshotFor(this.controls.get(client.sessionId)));
    });
    this.onMessage("command", (client, value: unknown) =>
      this.command(client, value),
    );
    this.onMessage("input", (client, value: unknown) =>
      this.input(client, value),
    );
    this.onMessage("action", (client, value: unknown) =>
      this.action(client, value),
    );
    this.clock.setInterval(() => this.maintenance(), 1000);
    if (config.mode === "realtime")
      this.setTimestep(() => this.tick(), this.tickMs);
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
    let state = structuredClone(this.record.snapshot.state);
    if (state.phase === "closed") throw new Error("The room is closed.");
    if (!this.dropIn && !state.ownerId && !ownerCreating)
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
      if (state.phase !== "lobby" && !this.dropIn)
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
      if (!state.ownerId && !this.dropIn) state.ownerId = playerId;
      if (this.services.adapter.onPlayerJoin)
        state = this.services.adapter.onPlayerJoin(state, playerId, Date.now());
    } else player.connected = true;
    const playerId = player.playerId;
    this.controls.set(client.sessionId, playerId);
    this.lastInputId.delete(playerId);
    if (this.dropIn && state.phase === "lobby" && this.enoughPlayers(state))
      state = this.startRound(state);
    this.commit(
      state,
      "member.joined",
      { playerId },
      undefined,
      true,
      true,
      members,
    );
    client.send("ready", {
      playerId,
      ...this.tickInfo(),
      // Anyone in a drop-in room can invite a friend to it.
      inviteCode: ownerCreating || this.dropIn ? this.inviteCode : undefined,
    });
    client.send("snapshot", this.snapshotFor(this.controls.get(client.sessionId)));
  }

  async onDrop(client: Client, code?: number): Promise<void> {
    // The service closed this connection, for example for flooding messages. Holding its
    // seat would keep the socket open while every message is ignored, so the player
    // would see a frozen game; release it now so the client learns it was closed.
    if (code === CloseCode.WITH_ERROR) {
      this.onLeave(client);
      return;
    }
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
    client.send("ready", { playerId: this.controls.get(client.sessionId), ...this.tickInfo() });
    client.send("snapshot", this.snapshotFor(this.controls.get(client.sessionId)));
  }
  onLeave(client: Client): void {
    const id = this.controls.get(client.sessionId);
    this.controls.delete(client.sessionId);
    if (!id || this.shuttingDown) return;
    const state = structuredClone(this.record.snapshot.state);
    const player = state.players.find((p) => p.playerId === id);
    if (!player) return;
    player.connected = false;
    this.forgetInput(id);
    // During a match seats persist for asynchronous turns; timeout skips them.
    // A drop-in seat frees once its reconnection window ends, so a newcomer can take it.
    let next = state;
    if (state.phase === "lobby" || this.dropIn) {
      state.players = state.players.filter((p) => p.playerId !== id);
      if (state.ownerId === id)
        state.ownerId = state.players[0]?.playerId ?? "";
      if (!state.players.length) state.phase = "closed";
      else {
        if (this.services.adapter.onPlayerLeave) next = this.services.adapter.onPlayerLeave(state, id, Date.now());
        if (this.dropIn && next.phase === "playing" && !this.enoughPlayers(next))
          next = { ...next, phase: "lobby" };
      }
    }
    this.commit(next, "member.left", { playerId: id });
    if (next.phase === "closed") void this.disconnect();
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

  /** What one seat may see; without a seat, what a spectator may see. */
  snapshotFor(playerId: string | undefined): MultiplayerSnapshot {
    const snapshot = structuredClone(this.record.snapshot);
    const { viewFor } = this.services.adapter;
    return viewFor ? { ...snapshot, state: viewFor(snapshot.state, playerId) } : snapshot;
  }
  authorizedSnapshot(userId: string): MultiplayerSnapshot {
    const member = this.record.members.find(
      (candidate) => candidate.userId === userId && !candidate.banned,
    );
    if (!member) throw new Error("Room membership is required.");
    return this.snapshotFor(member.playerId);
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
    this.forgetInput(player.playerId);
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
      client.send("snapshot", this.snapshotFor(this.controls.get(client.sessionId)));
      return;
    }
    try {
      const adapter = this.services.adapter;
      if (value.type === "start" || value.type === "restart") {
        const connected = this.record.snapshot.state.players.filter((p) => p.connected).length;
        if (connected < adapter.players.min)
          throw new Error(`This game needs ${describePlayerRange(adapter.players)} connected players to start.`);
      }
      adapter.validateCommand(this.record.snapshot.state, id, value);
      let state = adapter.applyCommand(this.record.snapshot.state, id, value);
      if (value.type === "start" || value.type === "restart")
        state = this.roundStarted(
          state,
          Date.now(),
          value.type === "restart" ? this.record.snapshot.state : undefined,
        );
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
            : value.type === "action"
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
      if (state.phase !== "lobby" && !this.dropIn) void this.setPrivate(true);
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
          value.type === "action"
          ? "not_your_turn"
          : "invalid_command",
        cause instanceof Error ? cause.message : "The command failed.",
      );
    }
  }
  /** The room's tick, from its rules. */
  private get tickMs(): number {
    return tickMsOf(this.services.adapter);
  }
  /** Realtime clients pace their input by the room's tick. */
  private tickInfo(): { tickMs?: number } {
    return this.services.config.mode === "realtime" ? { tickMs: this.tickMs } : {};
  }
  private input(client: Client, value: unknown): void {
    const id = this.controls.get(client.sessionId);
    const reject = (message: string) =>
      client.send("input.error", { code: "invalid_command", message });
    if (
      !id ||
      !isRealtimeInputMessage(value) ||
      this.services.config.mode !== "realtime" ||
      this.record.snapshot.state.phase !== "playing"
    )
      return reject("The input is invalid.");
    const { inputId, ...input } = value;
    if (inputId <= (this.lastInputId.get(id) ?? -1)) return;
    try {
      this.services.adapter.validateInput?.(input, id);
    } catch (cause) {
      return reject(cause instanceof Error ? cause.message : "The input is invalid.");
    }
    this.lastInputId.set(id, inputId);
    this.playerInputs.set(id, { input, at: Date.now() });
  }
  /** A one-off action waits for the next tick, which reads it once. */
  private action(client: Client, value: unknown): void {
    const id = this.controls.get(client.sessionId);
    const reject = (message: string) =>
      client.send("input.error", { code: "invalid_command", message });
    const { validateAction } = this.services.adapter;
    if (!id || !isRealtimeAction(value) || this.services.config.mode !== "realtime")
      return reject("The action is invalid.");
    if (!validateAction) return reject("This game takes no actions.");
    if (this.record.snapshot.state.phase !== "playing")
      return reject("The round is not running.");
    if (this.actions.filter((entry) => entry.playerId === id).length >= REALTIME_ACTIONS_PER_TICK)
      return reject("Too many actions at once. Send fewer actions per tick.");
    try {
      validateAction(value, id);
    } catch (cause) {
      return reject(cause instanceof Error ? cause.message : "The action is invalid.");
    }
    this.actions.push({ playerId: id, action: value });
  }
  /** A player who leaves or drops stops steering, and their waiting actions go. */
  private forgetInput(playerId: string): void {
    this.playerInputs.delete(playerId);
    this.actions = this.actions.filter((entry) => entry.playerId !== playerId);
  }
  /** Runs every tick of a round, so rules can move things nobody is steering. */
  private tick(): void {
    const actions = this.actions;
    this.actions = [];
    if (this.record.snapshot.state.phase !== "playing") return;
    const now = Date.now();
    const lifetime = inputLifetimeMs(this.tickMs);
    for (const [id, entry] of this.playerInputs)
      if (now - entry.at > lifetime) this.playerInputs.delete(id);
    const state = this.services.adapter.step!(
      this.record.snapshot.state,
      this.playerInputs,
      now,
      this.tickMs / 1000,
      actions,
    );
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
  /** Whether enough seats are connected for the rules to play a round. */
  private enoughPlayers(state: MultiplayerGameState): boolean {
    return state.players.filter((p) => p.connected).length >= this.services.adapter.players.min;
  }
  /** A drop-in room starts a round by itself; finished is the round before, when it restarts. */
  private startRound(
    state: MultiplayerGameState,
    now = Date.now(),
    finished?: MultiplayerGameState,
  ): MultiplayerGameState {
    const next: MultiplayerGameState = { ...state, phase: "playing", winnerPlayerId: "", currentPlayerId: "" };
    delete next.winnerPlayerIds;
    return this.roundStarted(next, now, finished);
  }
  /** Every round starts clean: no input or action carries over, and the rules set it up. */
  private roundStarted(
    state: MultiplayerGameState,
    now: number,
    finished?: MultiplayerGameState,
  ): MultiplayerGameState {
    this.playerInputs.clear();
    this.actions = [];
    const { onRoundStart } = this.services.adapter;
    return onRoundStart ? onRoundStart(state, now, finished) : state;
  }
  private maintenance(): void {
    const now = Date.now();
    if (this.shuttingDown) return;
    if (
      this.dropIn &&
      this.record.snapshot.state.phase === "finished" &&
      now - this.finishedAt >= this.services.roundRestartMs
    ) {
      const state = structuredClone(this.record.snapshot.state);
      this.commit(
        this.enoughPlayers(state) ? this.startRound(state, now, this.record.snapshot.state) : { ...state, phase: "lobby" },
        "state.updated",
        { reason: "round_restart" },
      );
    } else if (now - this.record.updatedAt > ROOM_IDLE_MS) {
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
    if (state.phase === "finished" && this.record.snapshot.state.phase !== "finished")
      this.finishedAt = now;
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
    // A closed room must not be offered to quick play or a merging player before it disposes.
    if (state.phase === "closed" && !this.locked) void this.lock();
    for (const client of this.clients)
      client.send("snapshot", this.snapshotFor(this.controls.get(client.sessionId)));
    this.broadcast("event", {
      type,
      roomId: this.roomId,
      deploymentId: this.services.config.deploymentId,
      sequence: record.snapshot.sequence,
      serverTime: record.snapshot.serverTime,
      payload,
    });
  }
}

export function hashInviteCode(value: string): string {
  return createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
}
