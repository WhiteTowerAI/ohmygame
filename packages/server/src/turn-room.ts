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
  TICK_MS_RANGE,
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
import type { ServerStore } from "./game-data.js";
import {
  HOST_MESSAGE_MAX_BYTES,
  HOST_REPLY_MS,
  mergeHostState,
  type HostReply,
  type HostRequest,
  type HostViews,
} from "@ohmygame/sdk/host";

/** A request for the hosting player, before the room adds its ID, state and clock. */
type HostAsk = HostRequest extends infer Request ? (Request extends HostRequest ? Omit<Request, "requestId" | "state" | "now"> : never) : never;

/** A small plain object, as a hosting player's message must be. */
function hostMessage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return JSON.stringify(value).length <= HOST_MESSAGE_MAX_BYTES ? value : undefined;
  } catch {
    return undefined;
  }
}
/** The parts of a hosting player's state the room reads, checked before it merges them. */
function isHostState(value: unknown): value is MultiplayerGameState {
  return (
    isRecord(value) &&
    typeof value.phase === "string" &&
    typeof value.currentPlayerId === "string" &&
    typeof value.winnerPlayerId === "string" &&
    typeof value.turnDeadline === "number" &&
    Array.isArray(value.players) &&
    value.players.every((player) => isRecord(player) && typeof player.playerId === "string") &&
    (value.winnerPlayerIds === undefined || (Array.isArray(value.winnerPlayerIds) && value.winnerPlayerIds.every((id) => typeof id === "string"))) &&
    (value.game === undefined || isRecord(value.game))
  );
}
function isHostViews(value: unknown): value is HostViews {
  return isRecord(value) && Object.values(value).every(isRecord);
}

export interface RoomServices {
  config: MultiplayerManifestConfig;
  store: RoomStore;
  restoring: Map<string, StoredRoom>;
  adapter: GameAdapter;
  reserve(roomId: string): boolean;
  /** How long a finished drop-in round shows its result before the next one starts. */
  roundRestartMs: number;
  /** Where finished matches go when the rules name a matchBoard and the service keeps game data. */
  results?: { store: ServerStore; allowGame?(gameId: string): boolean | Promise<boolean> };
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
  /** The connection whose browser runs the rules, in a hosted room. */
  private hostSession?: string;
  private readonly hostWaits = new Map<string, (reply: HostReply | undefined) => void>();
  /** Hosted rooms apply one change of the rules at a time, in order. */
  private hostQueue: Promise<void> = Promise.resolve();
  private hostTimeoutPending = false;
  private hostRoundPending = false;
  protected services!: RoomServices;

  /** A player's browser runs the rules; the room keeps seats, phase, order and the saved state. */
  private get hosted(): boolean {
    return this.services.adapter.hosted === true;
  }

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
    // A hosted room does not know its rules' tick, so it allows the fastest one.
    this.maxMessagesPerSecond =
      config.mode === "realtime"
        ? realtimeMessageLimit(this.hosted ? TICK_MS_RANGE.min : this.tickMs)
        : TURN_MAX_MESSAGES_PER_SECOND;
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
      if (!this.hosted) return;
      // A host that reconnected stopped running the rules when it dropped; it resumes here.
      if (client.sessionId === this.hostSession)
        client.send("host", { active: true, state: this.record.snapshot.state, tickMs: this.services.adapter.tickMs });
      this.assignHost();
    });
    this.onMessage("host.reply", (client, value: unknown) => this.hostReply(client, value));
    this.onMessage("host.state", (client, value: unknown) => this.hostState(client, value));
    this.onMessage("host.inputError", (client, value: unknown) => {
      const message = hostMessage(value);
      if (client.sessionId !== this.hostSession || typeof message?.playerId !== "string" || typeof message.message !== "string") return;
      for (const connection of this.clients)
        if (this.controls.get(connection.sessionId) === message.playerId)
          connection.send("input.error", { code: "invalid_command", message: message.message.slice(0, 300) });
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
    // A hosted realtime room runs no tick: the hosting player's browser does.
    if (config.mode === "realtime" && !this.hosted)
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
      if (this.hosted) {
        if (state.phase === "playing") this.hostTask({ kind: "join", playerId });
      } else if (this.services.adapter.onPlayerJoin)
        state = this.services.adapter.onPlayerJoin(state, playerId, Date.now());
    } else player.connected = true;
    const playerId = player.playerId;
    this.controls.set(client.sessionId, playerId);
    this.lastInputId.delete(playerId);
    if (this.dropIn && state.phase === "lobby" && this.enoughPlayers(state)) {
      if (this.hosted) this.hostStartRound();
      else state = this.startRound(state);
    }
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
    // The new connection is not among the room's clients until onJoin returns.
    if (this.hosted) this.clock.setTimeout(() => this.assignHost(), 0);
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
        if (this.hosted) {
          if (state.phase === "playing") this.hostTask({ kind: "leave", playerId: id });
        } else if (this.services.adapter.onPlayerLeave) next = this.services.adapter.onPlayerLeave(state, id, Date.now());
        if (this.dropIn && next.phase === "playing" && !this.enoughPlayers(next))
          next = { ...next, phase: "lobby" };
      }
    }
    this.commit(next, "member.left", { playerId: id });
    if (next.phase === "closed") void this.disconnect();
    else if (this.hosted) this.assignHost();
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
    const views = this.record.views;
    if (this.hosted && views && snapshot.state.game !== undefined) {
      const game = views[playerId ?? ""] ?? views[""];
      return { ...snapshot, state: { ...snapshot.state, game: structuredClone(game) ?? {} } };
    }
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
    if (this.hosted) this.assignHost();
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
    // Only closing the room needs no rules; the hosting player applies every other command.
    if (this.hosted && value.type !== "close") {
      const base = this.record.snapshot.state;
      this.hostQueue = this.hostQueue.then(async () => {
        try {
          if (this.record.snapshot.sequence !== value.expectedSequence) {
            reject("sequence_conflict", "The room state changed. Try again.");
            return;
          }
          const reply = await this.askHost({ kind: "command", playerId: id, command: value });
          if (reply.error !== undefined || !reply.state) throw new Error(reply.error ?? "The rules refused the command.");
          this.accepted(client, id, value, commandId, mergeHostState(reply.state, this.record.snapshot.state, base), reply.views);
        } catch (cause) {
          reject(
            this.record.snapshot.state.currentPlayerId !== id && value.type === "action" ? "not_your_turn" : "invalid_command",
            cause instanceof Error ? cause.message : "The command failed.",
          );
        }
      });
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
      this.accepted(client, id, value, commandId, state);
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
  /** Commits an accepted command's state and carries out what the room owes it, such as removing a kicked player. */
  private accepted(
    client: Client,
    id: string,
    value: TurnCommand,
    commandId: string,
    state: MultiplayerGameState,
    views?: HostViews,
  ): void {
    if (value.type === "start" || value.type === "restart") {
      this.playerInputs.clear();
      this.actions = [];
    }
    {
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
        views ? { views } : {},
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
    if (this.hosted) {
      // The hosting player's rules read and check it.
      this.lastInputId.set(id, inputId);
      this.hostConnection()?.send("host.input", { playerId: id, input });
      return;
    }
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
    if (this.hosted) {
      if (this.record.snapshot.state.phase !== "playing") return reject("The round is not running.");
      this.hostConnection()?.send("host.action", { playerId: id, action: value });
      return;
    }
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
      if (this.hosted && this.enoughPlayers(state)) {
        this.hostStartRound(this.record.snapshot.state);
        return;
      }
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
      if (this.hosted) {
        if (this.hostTimeoutPending) return;
        this.hostTimeoutPending = true;
        this.hostTask({ kind: "timeout" }, "turn.changed", () => {
          this.hostTimeoutPending = false;
        });
        return;
      }
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
  /**
   * Counts a finished match for its winners on the rules' match board. A failure costs
   * the leaderboard one result and never the match, so it is only logged.
   */
  private async recordResult(state: MultiplayerGameState, now: number): Promise<void> {
    const board = this.services.adapter.matchBoard;
    const results = this.services.results;
    const winners = state.winnerPlayerIds ?? (state.winnerPlayerId ? [state.winnerPlayerId] : []);
    if (!board || !results || !winners.length) return;
    const { gameId } = this.services.config;
    try {
      if (results.allowGame && !(await results.allowGame(gameId))) return;
      for (const playerId of winners) {
        const userId = this.record.members.find((member) => member.playerId === playerId)?.userId;
        if (!userId) continue;
        await results.store.addScore(gameId, board, {
          playerId: userId,
          name: state.players.find((player) => player.playerId === playerId)?.displayName ?? "Player",
          delta: 1,
          // As with submitted scores, only signed-in players appear publicly.
          public: userId.startsWith("account:"),
          now,
        });
      }
    } catch (cause) {
      console.error("Recording a match result failed", cause);
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
    host: { views?: HostViews; fromHost?: boolean } = {},
  ): void {
    const now = Date.now();
    if (state.phase === "finished" && this.record.snapshot.state.phase !== "finished") {
      this.finishedAt = now;
      void this.recordResult(state, now);
    }
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
      ...(host.views ? { views: host.views } : {}),
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
    // A hosting player's realtime loop learns of changes it did not make, such as a seat taken.
    if (this.hosted && this.services.config.mode === "realtime" && !host.fromHost)
      this.hostConnection()?.send("host.sync", { state: record.snapshot.state });
  }

  /** The hosting player's connection, if they are still connected. */
  private hostConnection(): Client | undefined {
    return this.hostSession ? this.clients.find((client) => client.sessionId === this.hostSession) : undefined;
  }
  /**
   * Chooses who runs the rules: the owner while connected, else the first connected seat.
   * A new host gets the room's full state; the old one is told to stop.
   */
  private assignHost(unresponsive?: string): void {
    if (this.shuttingDown || this.record.snapshot.state.phase === "closed") return;
    const state = this.record.snapshot.state;
    const connection = (playerId: string) =>
      this.clients.find((client) => this.controls.get(client.sessionId) === playerId && client.sessionId !== unresponsive);
    // A dropped connection stays among the clients while its seat waits for it, so ask the seat.
    const current = this.hostConnection();
    const currentPlayer = current && state.players.find((player) => player.playerId === this.controls.get(current.sessionId));
    const next =
      current && currentPlayer?.connected && current.sessionId !== unresponsive
        ? current
        : (state.ownerId ? connection(state.ownerId) : undefined) ??
          state.players.filter((player) => player.connected).map((player) => connection(player.playerId)).find((client) => client);
    if (next?.sessionId === this.hostSession) return;
    current?.send("host", { active: false });
    this.hostSession = next?.sessionId;
    // A request the old host never answered goes to the new one.
    for (const [, resolve] of this.hostWaits) resolve(undefined);
    next?.send("host", { active: true, state: this.record.snapshot.state, tickMs: this.services.adapter.tickMs });
    const hostPlayerId = next ? this.controls.get(next.sessionId) : undefined;
    if (hostPlayerId !== state.hostPlayerId) {
      const updated = { ...structuredClone(state) };
      if (hostPlayerId) updated.hostPlayerId = hostPlayerId;
      else delete updated.hostPlayerId;
      this.commit(updated, "state.updated", { hostPlayerId: hostPlayerId ?? "" }, undefined, true, false);
    }
  }
  /**
   * Asks the hosting player to apply a request. One who does not answer in time loses the
   * role to the next connected player, who is asked instead.
   */
  private async askHost(ask: HostAsk, state?: MultiplayerGameState): Promise<HostReply> {
    for (let attempt = 0; attempt <= this.services.config.maxClients; attempt++) {
      const host = this.hostConnection() ?? (this.assignHost(), this.hostConnection());
      if (!host) throw new Error("No connected player can run the game's rules right now.");
      const requestId = randomUUID();
      const reply = await new Promise<HostReply | undefined>((resolve) => {
        const timer = this.clock.setTimeout(() => resolve(undefined), HOST_REPLY_MS);
        this.hostWaits.set(requestId, (value) => {
          timer.clear();
          this.hostWaits.delete(requestId);
          resolve(value);
        });
        host.send("host.request", { ...ask, requestId, state: state ?? this.record.snapshot.state, now: Date.now() } as HostRequest);
      });
      this.hostWaits.delete(requestId);
      if (reply) return reply;
      if (this.hostSession === host.sessionId) this.assignHost(host.sessionId);
    }
    throw new Error("No connected player could run the game's rules.");
  }
  private hostReply(client: Client, value: unknown): void {
    const reply = hostMessage(value);
    if (client.sessionId !== this.hostSession || typeof reply?.requestId !== "string") return;
    const valid =
      (reply.error === undefined || typeof reply.error === "string") &&
      (reply.state === undefined || isHostState(reply.state)) &&
      (reply.views === undefined || isHostViews(reply.views));
    this.hostWaits.get(reply.requestId)?.(valid ? (reply as unknown as HostReply) : { requestId: reply.requestId, error: "The host sent an invalid answer." });
  }
  /** Runs a request that changes the game through the hosting player's rules, after any before it. */
  private hostTask(ask: HostAsk, type: MultiplayerEventType = "state.updated", done?: () => void): void {
    this.hostQueue = this.hostQueue.then(async () => {
      try {
        const base = this.record.snapshot.state;
        const reply = await this.askHost(ask);
        if (!reply.state || this.record.snapshot.state.phase === "closed") return;
        const state = mergeHostState(reply.state, this.record.snapshot.state, base);
        this.commit(state, state.phase === "finished" ? "room.finished" : type, { reason: ask.kind }, undefined, true, ask.kind !== "timeout", this.record.members, reply.views ? { views: reply.views } : {});
      } catch (cause) {
        console.error(`The hosting player could not apply ${ask.kind}`, cause);
      } finally {
        done?.();
      }
    });
  }
  /** A drop-in room starts a round once; the hosting player's rules set it up. */
  private hostStartRound(finished?: MultiplayerGameState): void {
    if (this.hostRoundPending) return;
    this.hostRoundPending = true;
    this.hostQueue = this.hostQueue.then(async () => {
      try {
        const state = this.record.snapshot.state;
        if (state.phase === "playing" || state.phase === "closed" || !this.enoughPlayers(state)) return;
        this.playerInputs.clear();
        this.actions = [];
        const base: MultiplayerGameState = { ...structuredClone(state), phase: "playing", winnerPlayerId: "", currentPlayerId: "" };
        delete base.winnerPlayerIds;
        const reply = await this.askHost({ kind: "round", ...(finished ? { finished } : {}) }, base);
        if (!reply.state) return;
        const current = this.record.snapshot.state;
        if (current.phase !== state.phase) return;
        // The room decided the round starts; the rules set up its game.
        const next = mergeHostState({ ...reply.state, phase: "playing" }, { ...current, phase: "playing" }, { ...current, phase: "playing" });
        this.commit(next, "state.updated", { reason: "round_start" }, undefined, true, true, this.record.members, reply.views ? { views: reply.views } : {});
      } catch (cause) {
        console.error("The hosting player could not start a round", cause);
      } finally {
        this.hostRoundPending = false;
      }
    });
  }
  /** A realtime tick from the hosting player's loop. */
  private hostState(client: Client, value: unknown): void {
    const message = hostMessage(value);
    if (
      client.sessionId !== this.hostSession ||
      this.services.config.mode !== "realtime" ||
      this.record.snapshot.state.phase !== "playing" ||
      !isHostState(message?.state) ||
      (message.views !== undefined && !isHostViews(message.views))
    )
      return;
    const state = mergeHostState(message.state, this.record.snapshot.state);
    if (JSON.stringify(state) === JSON.stringify(this.record.snapshot.state)) return;
    // Like the service's own tick, only the end of a round needs a disk write.
    this.commit(state, state.phase === "finished" ? "room.finished" : "state.updated", {}, undefined, state.phase === "finished", true, this.record.members, {
      ...(message.views ? { views: message.views as HostViews } : {}),
      fromHost: true,
    });
  }
}

export function hashInviteCode(value: string): string {
  return createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
}
