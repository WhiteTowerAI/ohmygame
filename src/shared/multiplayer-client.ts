import { Client as ColyseusClient, type Room } from "@colyseus/sdk";
import {
  isMultiplayerEvent,
  isMultiplayerManifestConfig,
  isMultiplayerSnapshot,
  isTurnCommand,
  isRecord,
  isTurnCommandResult,
  MULTIPLAYER_ROOM_LIMIT_CODE,
  multiplayerRoomType,
  REALTIME_TICK_MS,
  type JoinRoomOptions,
  type MultiplayerEvent,
  type MultiplayerManifestConfig,
  type MultiplayerSnapshot,
  type PublicMultiplayerRoom,
  type RealtimeInput,
  type TurnCommand,
  type TurnCommandResult,
} from "./multiplayer-protocol.js";

export type MultiplayerConnectionStatus =
  "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "error";
export interface MultiplayerClientOptions {
  manifest: MultiplayerManifestConfig;
  /** Uses the same Supabase session as the editor, refreshed before each join. */
  accessToken?: () => Promise<string | undefined>;
  /**
   * Both default to localStorage: one browser is one player, in every tab and after it
   * closes, and can come back to its seat. Tests inject separate storage per player.
   */
  storage?: Storage;
  identityStorage?: Storage;
  /** Dependency injection for local integration tests. */
  transport?: ColyseusClient;
  /** Opt in only for loopback development, never for a published deployment. */
  allowLocalhost?: boolean;
  connectionTimeoutMs?: number;
  /** Waits before each quick play retry when the service is at its room limit. */
  roomLimitRetryMs?: number[];
  /**
   * Drop-in only: how long a player must be alone before moving to a room with other
   * players, and roughly how often that is checked. Defaults to 5 seconds.
   */
  mergeCheckMs?: number;
}
export interface MultiplayerClientCallbacks {
  onStatus?: (status: MultiplayerConnectionStatus) => void;
  onEvent?: (event: MultiplayerEvent) => void;
  onReady?: (playerId: string, inviteCode?: string) => void;
  onCommandResult?: (result: TurnCommandResult) => void;
  onSnapshot?: (snapshot: MultiplayerSnapshot) => void;
  onError?: (error: Error) => void;
}
interface SavedRoom {
  roomId: string;
  reconnectionToken: string;
  playerId?: string;
  roomCode?: string;
  pending: TurnCommand[];
}

/** Colyseus owns transient reconnects; this wrapper adds refresh and restart recovery. */
export class MultiplayerClient {
  private readonly client: ColyseusClient;
  private readonly storage?: Storage;
  private readonly identityStorage?: Storage;
  private readonly storageKey: string;
  private room?: Room;
  private saved?: SavedRoom;
  private current?: MultiplayerSnapshot;
  private lastEventSequence = -1;
  private generation = 0;
  private busy = false;
  private disposed = false;
  private inputId = 0;
  private latestInput?: { x: number; y: number };
  private inputTimer?: ReturnType<typeof setInterval>;
  private displayName?: string;
  private mergeTimer?: ReturnType<typeof setTimeout>;
  private aloneSince?: number;
  private merging = false;
  private connectionStatus: MultiplayerConnectionStatus = "idle";

  constructor(
    private readonly options: MultiplayerClientOptions,
    private readonly callbacks: MultiplayerClientCallbacks = {},
  ) {
    if (
      !isMultiplayerManifestConfig(options.manifest, {
        allowLocalhost: options.allowLocalhost,
      })
    )
      throw new Error(
        "The multiplayer service is not configured. Supply a valid Colyseus deployment manifest.",
      );
    if (
      options.connectionTimeoutMs !== undefined &&
      (!Number.isFinite(options.connectionTimeoutMs) ||
        options.connectionTimeoutMs <= 0)
    )
      throw new Error("connectionTimeoutMs must be positive.");
    this.client =
      options.transport ?? new ColyseusClient(options.manifest.serverUrl);
    this.storage = options.storage ?? browserStorage("localStorage");
    this.identityStorage =
      options.identityStorage ?? browserStorage("localStorage");
    this.storageKey = `ohmygame:multiplayer:${options.manifest.serverUrl}:${options.manifest.gameId}:${options.manifest.deploymentId}`;
    try {
      const value: unknown = JSON.parse(
        this.storage?.getItem(this.storageKey) ?? "null",
      );
      if (
        isRecord(value) &&
        typeof value.roomId === "string" &&
        typeof value.reconnectionToken === "string" &&
        Array.isArray(value.pending)
      )
        this.saved = {
          roomId: value.roomId,
          reconnectionToken: value.reconnectionToken,
          playerId:
            typeof value.playerId === "string" ? value.playerId : undefined,
          roomCode:
            typeof value.roomCode === "string" ? value.roomCode : undefined,
          pending: value.pending.filter(isTurnCommand).slice(0, 32),
        };
    } catch {
      /* A broken save never prevents a new room. */
    }
  }
  get status(): MultiplayerConnectionStatus {
    return this.connectionStatus;
  }
  get roomId(): string | undefined {
    return this.room?.roomId;
  }
  get playerId(): string | undefined {
    return this.saved?.playerId;
  }
  get roomCode(): string | undefined {
    return this.saved?.roomCode;
  }
  get snapshot(): MultiplayerSnapshot | undefined {
    return this.current;
  }

  async createRoom(options: { displayName?: string } = {}): Promise<void> {
    this.displayName = options.displayName;
    await this.connect(async () =>
      this.client.create(multiplayerRoomType(this.options.manifest), {
        ...this.joinOptions(options),
        creationKey: crypto.randomUUID(),
      }),
    );
  }
  /**
   * Drop-in deployments only: join the fullest room with a free seat, or open a new one
   * when every room is full. A service at its room limit is retried a few times before
   * the error reaches the game.
   */
  async quickPlay(options: { displayName?: string } = {}): Promise<void> {
    if (this.options.manifest.roomPolicy !== "drop-in")
      throw new Error("Quick play needs a drop-in deployment. Create or join a room instead.");
    this.displayName = options.displayName;
    await this.connect(async () => {
      const join = this.joinOptions(options);
      for (const delay of [...(this.options.roomLimitRetryMs ?? [1000, 2000]), undefined]) {
        try {
          return await this.client.joinOrCreate(multiplayerRoomType(this.options.manifest), join);
        } catch (cause) {
          if (delay === undefined || !isRecord(cause) || cause.code !== MULTIPLAYER_ROOM_LIMIT_CODE) throw cause;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      throw new Error("Quick play could not find a room.");
    });
  }
  async joinRoom(
    options: { displayName?: string; roomCode?: string; roomId?: string } = {},
  ): Promise<void> {
    this.displayName = options.displayName;
    await this.connect(async () => {
      const join = this.joinOptions(options);
      if (options.roomId || options.roomCode)
        return this.client.joinById(
          options.roomId ?? (await this.resolveRoom(options.roomCode!)),
          join,
        );
      // Joining never creates an empty private room or bypasses the owner flow.
      return this.client.join(multiplayerRoomType(this.options.manifest), join);
    });
  }
  async reconnect(): Promise<boolean> {
    if (!this.saved || this.busy || this.disposed || this.room) return false;
    const saved = this.saved;
    try {
      await this.connect(async () => {
        this.setStatus("reconnecting");
        try {
          return await this.client.reconnect(saved.reconnectionToken);
        } catch {
          // A service restart invalidates transport tokens. Verified identity can
          // reclaim a persisted turn seat; it cannot create a replacement match.
          return this.client.joinById(
            saved.roomId,
            this.joinOptions({ roomCode: saved.roomCode }),
          );
        }
      }, true);
      return true;
    } catch {
      return false;
    }
  }
  sendCommand(
    type: TurnCommand["type"],
    payload?: TurnCommand["payload"],
  ): string {
    if (
      !this.room ||
      this.status !== "connected" ||
      !this.current ||
      !this.saved
    )
      throw new Error("The multiplayer room is not connected.");
    if (this.saved.pending.length >= 32)
      throw new Error("Wait for pending commands to finish.");
    const value: TurnCommand = {
      commandId: crypto.randomUUID(),
      expectedSequence: this.current.sequence,
      type,
      ...(payload ? { payload } : {}),
    };
    this.saved.pending.push(value);
    this.persist();
    this.room.send("command", value);
    return value.commandId;
  }
  /**
   * Safe to call every frame. The latest direction goes out at most once per service
   * tick, and keeps going out while the game keeps calling, so a held key stays fresh;
   * sending faster would only be discarded, and a flood closes the connection.
   */
  sendInput(x: number, y: number): void {
    if (!this.room || this.status !== "connected") return;
    this.latestInput = { x, y };
    if (this.inputTimer) return;
    this.flushInput();
    this.inputTimer = setInterval(() => {
      if (this.latestInput) this.flushInput();
      else this.stopInput();
    }, REALTIME_TICK_MS);
  }
  private flushInput(): void {
    const input = this.latestInput;
    this.latestInput = undefined;
    if (!input || !this.room || this.status !== "connected") return;
    this.room.send("input", { inputId: this.inputId++, ...input } satisfies RealtimeInput);
  }
  /**
   * Quick play only places a player when they arrive, so two players can end up alone
   * in separate rooms, for example after one returns to a held seat. A drop-in player
   * who stays alone moves to the busiest room that has others and a free seat.
   * Checks are jittered so two lonely players rarely move at the same moment; when they
   * do, quick play's room creation lock still brings them together.
   */
  private scheduleMerge(): void {
    if (this.options.manifest.roomPolicy !== "drop-in" || this.disposed) return;
    clearTimeout(this.mergeTimer);
    const interval = this.options.mergeCheckMs ?? 5000;
    this.mergeTimer = setTimeout(() => {
      void this.checkMerge().finally(() => {
        if (this.room) this.scheduleMerge();
      });
    }, interval * (0.5 + Math.random()));
  }
  private stopMerge(): void {
    clearTimeout(this.mergeTimer);
    this.mergeTimer = undefined;
    this.aloneSince = undefined;
  }
  private alone(): boolean {
    const connected = this.current?.state.players.filter((player) => player.connected) ?? [];
    return connected.length === 1 && connected[0]!.playerId === this.saved?.playerId;
  }
  private async checkMerge(): Promise<void> {
    if (this.merging || this.busy || this.disposed || !this.room || this.status !== "connected") return;
    if (!this.alone()) {
      this.aloneSince = undefined;
      return;
    }
    this.aloneSince ??= Date.now();
    if (Date.now() - this.aloneSince < (this.options.mergeCheckMs ?? 5000)) return;
    const here = this.room.roomId;
    let target: PublicMultiplayerRoom | undefined;
    try {
      target = (await this.publicRooms())
        .filter((room) => room.roomId !== here && room.clients > 0 && room.clients < room.maxClients)
        .sort((left, right) => right.clients - left.clients)[0];
    } catch {
      return; // An unreachable room list leaves the player where they are.
    }
    if (!target || this.room?.roomId !== here || !this.alone()) return;
    this.merging = true;
    try {
      const displayName = this.displayName;
      await this.leaveRoom();
      try {
        await this.joinRoom({ roomId: target.roomId, displayName });
      } catch {
        // The room filled or closed meanwhile; quick play finds the next best one.
        await this.quickPlay({ displayName });
      }
    } catch {
      /* connect() has already reported the failure through onStatus and onError. */
    } finally {
      this.merging = false;
    }
  }
  private stopInput(): void {
    clearInterval(this.inputTimer);
    this.inputTimer = undefined;
    this.latestInput = undefined;
  }
  async publicRooms(): Promise<PublicMultiplayerRoom[]> {
    const { gameId, deploymentId } = this.options.manifest;
    const response = await this.request(
      `/v1/games/${encodeURIComponent(gameId)}/rooms?deploymentId=${encodeURIComponent(deploymentId)}`,
    );
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new Error("Invalid public room list.");
    return value.filter(
      (room): room is PublicMultiplayerRoom =>
        isRecord(room) &&
        typeof room.roomId === "string" &&
        typeof room.clients === "number" &&
        typeof room.maxClients === "number",
    );
  }
  async leave(): Promise<void> {
    await this.leaveRoom();
    this.setStatus("closed");
  }
  /** Leaves without reporting a closed connection, for moving to another room. */
  private async leaveRoom(): Promise<void> {
    this.stopInput();
    this.stopMerge();
    this.generation++;
    const room = this.room;
    this.room = undefined;
    this.saved = undefined;
    this.current = undefined;
    this.persist();
    room?.removeAllListeners();
    if (room) {
      room.reconnection.enabled = false;
      await room.leave(true);
    }
  }
  dispose(): void {
    this.stopInput();
    this.stopMerge();
    this.disposed = true;
    this.generation++;
    const room = this.room;
    this.room = undefined;
    if (room) {
      room.removeAllListeners();
      room.reconnection.enabled = false;
      void room.leave(false);
    }
  }
  private async connect(
    open: () => Promise<Room>,
    restoring = false,
  ): Promise<void> {
    if (this.busy || this.room || this.disposed)
      throw new Error("A room connection is already active.");
    this.busy = true;
    const generation = ++this.generation;
    this.setStatus(restoring ? "reconnecting" : "connecting");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const opening = (async () => {
        const token = await this.token();
        if (generation !== this.generation)
          throw new Error("Room connection cancelled.");
        this.client.auth.token = token;
        const room = await open();
        if (generation !== this.generation) {
          room.reconnection.enabled = false;
          await room.leave(true);
          throw new Error("Room connection cancelled.");
        }
        return room;
      })();
      const room = await Promise.race([
        opening,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "The multiplayer connection timed out. Check that the Colyseus service is running and try again.",
                ),
              ),
            this.options.connectionTimeoutMs ?? 15_000,
          );
        }),
      ]);
      const old = restoring ? this.saved : undefined;
      this.saved = {
        roomId: room.roomId,
        reconnectionToken: room.reconnectionToken,
        playerId: old?.playerId,
        roomCode: old?.roomCode,
        pending: old?.pending ?? [],
      };
      this.room = room;
      this.current = undefined;
      this.lastEventSequence = -1;
      this.inputId = 0;
      this.bind(room);
      this.persist();
      this.setStatus("connected");
      room.send("sync");
      this.scheduleMerge();
    } catch (cause) {
      if (generation === this.generation) {
        this.generation++;
        this.error(cause);
        this.setStatus("error");
      }
      throw cause;
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }
  private bind(room: Room): void {
    room.reconnection.minUptime = 0;
    // Each player gets their own snapshot, so rules can keep a hand or a role private.
    room.onMessage("snapshot", (value: unknown) => this.receiveSnapshot(value));
    room.onMessage("ready", (value: unknown) => {
      if (!isRecord(value) || typeof value.playerId !== "string" || !this.saved)
        return;
      this.saved.playerId = value.playerId;
      if (typeof value.inviteCode === "string")
        this.saved.roomCode = value.inviteCode;
      this.persist();
      this.callbacks.onReady?.(value.playerId, this.saved.roomCode);
    });
    room.onMessage("event", (value: unknown) => {
      if (
        !isMultiplayerEvent(value) ||
        value.roomId !== room.roomId ||
        value.deploymentId !== this.options.manifest.deploymentId ||
        value.sequence <= this.lastEventSequence
      )
        return;
      this.lastEventSequence = value.sequence;
      this.callbacks.onEvent?.(value);
    });
    room.onMessage("command.result", (value: unknown) => {
      if (!isTurnCommandResult(value) || !this.saved) return;
      this.saved.pending = this.saved.pending.filter(
        (command) => command.commandId !== value.commandId,
      );
      this.persist();
      this.callbacks.onCommandResult?.(value);
    });
    room.onMessage("input.error", (value: unknown) => {
      if (isRecord(value) && typeof value.message === "string")
        this.error(new Error(value.message));
    });
    room.onDrop(() => {
      this.stopInput();
      this.aloneSince = undefined;
      this.current = undefined;
      this.setStatus("reconnecting");
    });
    room.onReconnect(() => {
      if (!this.saved) return;
      // The SDK rotates its token after dispatching onReconnect.
      queueMicrotask(() => {
        if (this.room !== room || !this.saved) return;
        this.saved.reconnectionToken = room.reconnectionToken;
        this.inputId = 0;
        this.persist();
        this.setStatus("connected");
        room.send("sync");
      });
    });
    room.onError((_code, message) =>
      this.error(
        new Error(message ?? "The multiplayer room reported an error."),
      ),
    );
    room.onLeave((code, reason) => {
      if (this.room !== room) return;
      this.stopInput();
      this.stopMerge();
      this.room = undefined;
      this.current = undefined;
      if (code === 1000 || code >= 4000) {
        this.saved = undefined;
        this.persist();
      }
      this.setStatus("closed");
      if (reason) this.error(new Error(reason));
      else if (code === 4002)
        this.error(new Error("The multiplayer service closed the connection. Join again to keep playing."));
    });
  }
  private receiveSnapshot(value: unknown): void {
    const config = this.options.manifest;
    if (
      !isMultiplayerSnapshot(value) ||
      value.roomId !== this.room?.roomId ||
      value.gameId !== config.gameId ||
      value.deploymentId !== config.deploymentId ||
      value.mode !== config.mode ||
      value.sequence < (this.current?.sequence ?? -1)
    )
      return;
    const first = !this.current;
    this.current = value;
    this.callbacks.onSnapshot?.(value);
    if (first)
      for (const command of this.saved?.pending ?? [])
        this.room?.send("command", command);
  }
  private joinOptions(options: {
    displayName?: string;
    roomCode?: string;
  }): JoinRoomOptions {
    const { gameId, deploymentId, protocolVersion } = this.options.manifest;
    return { gameId, deploymentId, protocolVersion, ...options };
  }
  private async token(): Promise<string> {
    const policy = this.options.manifest.authPolicy;
    const account =
      policy === "anonymous" ? undefined : await this.options.accessToken?.();
    if (account) return account;
    if (policy === "account-required")
      throw new Error("Sign in with your OhMyGame account before joining.");
    const key = `ohmygame:multiplayer:guest:${this.options.manifest.serverUrl}`;
    try {
      const value: unknown = JSON.parse(
        this.identityStorage?.getItem(key) ?? "null",
      );
      if (
        isRecord(value) &&
        typeof value.token === "string" &&
        typeof value.expiresAt === "number" &&
        value.expiresAt > Date.now() + 60_000
      )
        return value.token;
    } catch {
      /* Request a fresh guest identity. */
    }
    const response = await this.request("/v1/guests", { method: "POST" });
    const value: unknown = await response.json();
    if (
      !isRecord(value) ||
      typeof value.token !== "string" ||
      typeof value.expiresAt !== "number"
    )
      throw new Error("Invalid guest session.");
    try {
      this.identityStorage?.setItem(key, JSON.stringify(value));
    } catch {
      /* Guests can play without storage. */
    }
    return value.token;
  }
  private async resolveRoom(roomCode: string): Promise<string> {
    const response = await this.request("/v1/rooms/resolve", {
      method: "POST",
      body: JSON.stringify({
        ...this.joinOptions({}),
        roomCode: roomCode.trim(),
      }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.client.auth.token}`,
      },
    });
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.roomId !== "string")
      throw new Error("Invalid room invitation.");
    return value.roomId;
  }
  private async request(
    path: string,
    options?: RequestInit,
  ): Promise<Response> {
    const { secure, hostname, port } = this.client.settings;
    const endpoint = `${secure ? "https" : "http"}://${hostname}${port ? `:${port}` : ""}`;
    const response = await fetch(new URL(path, endpoint), {
      ...options,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => undefined);
      throw new Error(
        isRecord(value) && typeof value.error === "string"
          ? value.error.slice(0, 300)
          : `The multiplayer request failed (${response.status}).`,
      );
    }
    return response;
  }
  private persist(): void {
    try {
      if (this.saved)
        this.storage?.setItem(this.storageKey, JSON.stringify(this.saved));
      else this.storage?.removeItem(this.storageKey);
    } catch {
      /* Private browsing can disable storage. */
    }
  }
  private setStatus(status: MultiplayerConnectionStatus): void {
    if (!this.disposed) {
      this.connectionStatus = status;
      this.callbacks.onStatus?.(status);
    }
  }
  private error(cause: unknown): void {
    if (!this.disposed)
      this.callbacks.onError?.(
        cause instanceof Error ? cause : new Error(String(cause)),
      );
  }
}
function browserStorage(key: "localStorage"): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window[key];
  } catch {
    return undefined;
  }
}
