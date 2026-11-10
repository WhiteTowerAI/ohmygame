import { Client as ColyseusClient, type Room } from "@colyseus/sdk";
import {
  DEFAULT_TICK_MS,
  isMultiplayerEvent,
  isRealtimeAction,
  isRealtimeInput,
  isMultiplayerManifestConfig,
  isMultiplayerSnapshot,
  isTurnCommand,
  isRecord,
  sameJson,
  applyStateChanges,
  isSnapshotDelta,
  isTurnCommandResult,
  LOCKSTEP_ADAPTER_ID,
  MULTIPLAYER_ROOM_LIMIT_CODE,
  OWNER_ADAPTER_ID,
  isOwnerMessage,
  isOwnerMessageEvent,
  isOwnerEmit,
  type OwnerEmit,
  type OwnerSharedChange,
  multiplayerRoomType,
  TICK_MS_RANGE,
  type JoinRoomOptions,
  type MultiplayerEvent,
  type MultiplayerManifestConfig,
  type MultiplayerSnapshot,
  type PublicMultiplayerRoom,
  type RealtimeInput,
  type TurnCommand,
  type TurnCommandResult,
} from "./multiplayer-protocol.js";
import { isOhMyGameError, OhMyGameError, type OhMyGameErrorCode } from "./errors.js";
import { browserStorage, GuestIdentity, serviceRequest, type IdentityProvider } from "./identity.js";
import type { ClientAction, ClientInput, ClientMoves } from "./define-game.js";
import { compileGame, tickMsOf, type GameAdapter } from "./rules.js";
import {
  hasPlayerView,
  HOST_ADAPTER_ID,
  HostLoop,
  mergeHostState,
  runHostRequest,
  startTicker,
  type HostRequest,
} from "./host.js";
import type { OhMyGame } from "./index.js";
import { LockstepRunner } from "./lockstep.js";
import { OwnerSession } from "./owner.js";
import { PeerMesh, type PeerOptions, type PeerStatus } from "./peers.js";
import { PING_INTERVAL_MS, TickClock, TickPacer } from "./pacing.js";
import { OwnPrediction } from "./prediction.js";

export { Smoother, type SmoothingMode, type SmoothingOptions } from "./smoothing.js";

/**
 * Inputs that change send early, before the next tick's send, at most this often on average
 * and this many at once. With one send a tick that stays well inside the service's limit of
 * twice the tick rate in messages a second, even for an input that changes every frame.
 */
const EARLY_SENDS_PER_SECOND = 4;
const EARLY_SENDS_BURST = 2;

export type MultiplayerConnectionStatus =
  "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "error";
export interface MultiplayerClientOptions {
  manifest: MultiplayerManifestConfig;
  /**
   * The signed-in player, asked again before each join. Without a token the client joins
   * as a guest when the deployment allows guests.
   */
  identity?: IdentityProvider;
  /**
   * Both default to localStorage: one browser is one player, in every tab and after it
   * closes, and can come back to its seat. Tests inject separate storage per player.
   */
  storage?: Storage;
  identityStorage?: Storage;
  /** @internal Dependency injection for local integration tests; not in the published types. */
  transport?: RoomTransport;
  /** Opt in only for loopback development, never for a published deployment. */
  allowLocalhost?: boolean;
  /**
   * The game's rules from defineGame or defineRealtimeGame, usually the default export of
   * server/rules.ts. Required when the deployment runs its rules on a player's browser
   * (adapterId "host" or "lockstep"). For a realtime room whose rules the service runs,
   * passing the same rules predicts this player's own moves: snapshot shows them at once
   * and confirmed is the service's newest. Rules with playerView are not predicted.
   */
  rules?: unknown;
  connectionTimeoutMs?: number;
  /** Waits before each quick play retry when the service is at its room limit. */
  roomLimitRetryMs?: number[];
  /**
   * Drop-in only: how long a player must be alone before moving to a room with other
   * players, and roughly how often that is checked. Defaults to 5 seconds.
   */
  mergeCheckMs?: number;
  /**
   * Owner rooms: also send states and messages straight to other players' pages over
   * WebRTC where a direct connection opens, without the trip to the service. Everything
   * still goes through the service too, which reaches the players a connection cannot.
   * Players see each other's network addresses, so leave it off unless the game wants
   * the speed. iceServers replaces the default public STUN servers.
   */
  p2p?: boolean | PeerOptions;
}
export interface MultiplayerClientCallbacks {
  onStatus?: (status: MultiplayerConnectionStatus) => void;
  /**
   * Room events, such as a player joining or a match finishing. A realtime room's ticks
   * raise none: watch onSnapshot for their changes.
   */
  onEvent?: (event: MultiplayerEvent) => void;
  onReady?: (playerId: string, inviteCode?: string) => void;
  onCommandResult?: (result: TurnCommandResult) => void;
  onSnapshot?: (snapshot: MultiplayerSnapshot) => void;
  onError?: (error: OhMyGameError) => void;
  /** This player's browser starts or stops running the game's rules for the room. */
  onHost?: (hosting: boolean) => void;
  /** Owner rooms: another player's message from emit, such as a collision only their page saw. */
  onMessage?: (from: string, message: Record<string, unknown>) => void;
}
/**
 * @internal What the client needs from a room service connection. Colyseus provides it
 * today; another transport only has to offer the same calls.
 */
export interface RoomTransport {
  auth: { token: string | undefined };
  /** Where the service is, for its HTTP routes. */
  settings: { secure?: boolean; hostname?: string; port?: number | string };
  create(roomName: string, options: JoinRoomOptions): Promise<Room>;
  join(roomName: string, options: JoinRoomOptions): Promise<Room>;
  joinOrCreate(roomName: string, options: JoinRoomOptions): Promise<Room>;
  joinById(roomId: string, options: JoinRoomOptions): Promise<Room>;
  reconnect(reconnectionToken: string): Promise<Room>;
}
interface SavedRoom {
  roomId: string;
  reconnectionToken: string;
  playerId?: string;
  roomCode?: string;
  pending: TurnCommand[];
}

/**
 * Colyseus owns transient reconnects; this wrapper adds refresh and restart recovery.
 * Game is the type of the rules from defineGame, which types client.moves.
 */
export class MultiplayerClient<Game = unknown> {
  /**
   * Sends one move of the game's rules, for example client.moves.play({ cards }).
   * Returns the command ID that onCommandResult reports. The key "action" is reserved.
   */
  readonly moves: ClientMoves<Game> = new Proxy({} as ClientMoves<Game>, {
    get: (_target, name) =>
      typeof name === "string"
        ? (args?: Record<string, unknown>) => this.sendCommand("action", { ...args, action: name })
        : undefined,
  });
  private readonly client: RoomTransport;
  private readonly storage?: Storage;
  private readonly guest: GuestIdentity;
  private readonly storageKey: string;
  private room?: Room;
  private saved?: SavedRoom;
  private current?: MultiplayerSnapshot;
  /** The service's latest snapshot, which a hosting player's own ticks build on. */
  private fromService?: MultiplayerSnapshot;
  private lastEventSequence = -1;
  /** Whether a whole snapshot is on its way, so a tick's changes that do not fit wait for it. */
  private awaitingSnapshot = false;
  /** Whether this connection has already reported a snapshot it could not read. */
  private reportedUnreadable = false;
  private generation = 0;
  private busy = false;
  private disposed = false;
  private inputId = 0;
  private latestInput?: RealtimeInput;
  /** The room's tick, from the service; input goes out no faster. */
  private roomTickMs = DEFAULT_TICK_MS;
  /** Where the service's tick falls, so input and owner states reach it just before it. */
  private readonly tickClock = new TickClock(() => this.roomTickMs);
  private readonly inputPacer = new TickPacer(this.tickClock, () => this.roomTickMs, () => {
    if (!this.latestInput) return false;
    this.flushInput();
    return true;
  });
  private pingTimer?: ReturnType<typeof setInterval>;
  /** The input the page last sent, so a change can go out before the next tick's send. */
  private sentInput?: RealtimeInput;
  /** Early sends left: a few a second, so an input that changes every frame cannot double the messages. */
  private earlySends = EARLY_SENDS_BURST;
  private earlySendsAt = 0;
  /** Owner rooms: messages this page has emitted, which number their IDs. */
  private messageCount = 0;
  private displayName?: string;
  private mergeTimer?: ReturnType<typeof setTimeout>;
  private aloneSince?: number;
  private merging = false;
  private connectionStatus: MultiplayerConnectionStatus = "idle";
  /** The compiled rules, for a deployment whose rules run on a player's browser. */
  private readonly hostRules?: { adapter: GameAdapter; playerView: boolean };
  private hostLoop?: HostLoop;
  private hostingRoom = false;
  /** Runs the rules in step with every other player, for a lockstep deployment. */
  private readonly lockstep?: { adapter: GameAdapter; runner: LockstepRunner };
  /** This player's part of the round, for an owner deployment. */
  private readonly owner?: OwnerSession;
  /** Owner rooms with p2p: connections straight to other players' pages. */
  private readonly mesh?: PeerMesh;
  /** Messages already passed to onMessage, by sender and ID, so a copy from the other path is dropped. */
  private readonly delivered = new Set<string>();
  /** This player's own moves shown before the service's tick reads them, when the page passes the rules the service runs. */
  private readonly prediction?: OwnPrediction;

  constructor(
    private readonly options: MultiplayerClientOptions,
    private readonly callbacks: MultiplayerClientCallbacks = {},
  ) {
    if (
      !isMultiplayerManifestConfig(options.manifest, {
        allowLocalhost: options.allowLocalhost,
      })
    )
      throw new OhMyGameError(
        "not_configured",
        "The multiplayer service is not configured. Supply a valid Colyseus deployment manifest.",
      );
    if (
      options.connectionTimeoutMs !== undefined &&
      (!Number.isFinite(options.connectionTimeoutMs) ||
        options.connectionTimeoutMs <= 0)
    )
      throw new OhMyGameError("invalid_option", "connectionTimeoutMs must be positive.");
    if (options.p2p !== undefined && options.p2p !== false && options.manifest.adapterId !== OWNER_ADAPTER_ID)
      throw new OhMyGameError("invalid_option", "p2p is for owner deployments.");
    if (options.p2p) {
      this.mesh = new PeerMesh(
        {
          signal: (to, data) => this.room?.send("p2p.signal", { to, data }),
          playerId: () => this.saved?.playerId,
          state: (from, packet) => this.owner?.direct(from, packet),
          message: (from, packet) => {
            if (isOwnerEmit(packet)) this.deliverMessage(from, packet.id, packet.message);
          },
        },
        options.p2p === true ? {} : options.p2p,
      );
    }
    if (options.manifest.adapterId === OWNER_ADAPTER_ID)
      this.owner = new OwnerSession({
        send: (type, value) => this.room?.send(type, value),
        ...(this.mesh ? { sendDirect: (packet) => this.mesh!.sendState(packet) } : {}),
        show: () => this.showOwner(),
        playerId: () => this.saved?.playerId,
        tickMs: () => this.tickMs,
        clock: this.tickClock,
      });
    const runsRules = options.manifest.adapterId === HOST_ADAPTER_ID || options.manifest.adapterId === LOCKSTEP_ADAPTER_ID;
    if (!runsRules && options.manifest.mode === "realtime" && options.manifest.adapterId !== OWNER_ADAPTER_ID && options.rules !== undefined)
      this.prediction = this.predictionFor(options.rules);
    if (runsRules) {
      if (options.rules === undefined)
        throw new OhMyGameError(
          "not_configured",
          "This game runs its rules on the players' browsers. Pass { rules } from server/rules.ts to createMultiplayerClient.",
        );
      let adapter: GameAdapter;
      try {
        adapter = compileGame(options.rules as Parameters<typeof compileGame>[0]);
      } catch (cause) {
        throw new OhMyGameError("invalid_option", `The game's rules are invalid: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      if (adapter.mode !== options.manifest.mode)
        throw new OhMyGameError("invalid_option", `The game's rules are ${adapter.mode}, but the deployment is ${options.manifest.mode}. Run multiplayer_setup again.`);
      if (options.manifest.adapterId === LOCKSTEP_ADAPTER_ID) {
        // Every page must step the rules at the tick the service numbers frames at.
        if (tickMsOf(adapter) !== options.manifest.tickMs || adapter.playerView)
          throw new OhMyGameError("invalid_option", "The game's rules changed since its multiplayer deployment was set up. Run multiplayer_setup again.");
        this.lockstep = { adapter, runner: new LockstepRunner(adapter, this.lockstepHooks()) };
      } else this.hostRules = { adapter, playerView: hasPlayerView(options.rules) };
    }
    this.client = options.transport ?? colyseusClient(options.manifest.serverUrl);
    this.storage = options.storage ?? browserStorage();
    this.guest = new GuestIdentity({
      serverUrl: options.manifest.serverUrl,
      storage: options.identityStorage,
      endpoint: this.endpoint(),
    });
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
    // Joining waits for this player's token and a connection to the service. Both start
    // while the player is still on the menu, so a join is left with matchmaking and the
    // room's own WebSocket.
    if (!options.transport) {
      preconnect(this.endpoint());
      void this.token().catch(() => {});
    }
  }
  /**
   * The room's tick in milliseconds, as the service reports it when the player joins: how
   * often a realtime room's snapshots, and an owner room's player states, arrive at most.
   * Pass it to a Smoother as intervalMs.
   */
  get tickMs(): number {
    return this.roomTickMs;
  }
  /**
   * Owner rooms with p2p: each other player this page has tried to reach directly, by
   * playerId: "connecting", "open" (states and messages go straight there too), or
   * "failed" (only through the service; tried again later). Empty without p2p.
   */
  get peers(): Record<string, PeerStatus> {
    return this.mesh?.status() ?? {};
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
  /**
   * The room as onSnapshot last reported it. In a lockstep round this runs ahead of the
   * service, so the player's own input shows at once, and other players' parts of it are a
   * guess that the next frame may correct.
   */
  get snapshot(): MultiplayerSnapshot | undefined {
    return this.current;
  }
  /**
   * The room at the newest frame the service sent, with no guess: in a lockstep round it
   * trails snapshot by about a round trip and is never corrected, so drawing other players
   * from it shows them a little late but without jumps. With predicted moves it is the
   * service's newest snapshot. Otherwise it is snapshot.
   */
  get confirmed(): MultiplayerSnapshot | undefined {
    if (this.prediction) return this.fromService ?? this.current;
    const round = this.lockstep?.runner.current;
    const base = this.fromService;
    if (!round || !base || base.state.phase !== "playing" || this.current?.state.phase !== "playing") return this.current;
    return { ...base, state: mergeHostState(round, base.state) };
  }
  /** Whether this player's browser runs the game's rules for the room now. */
  get hosting(): boolean {
    return this.hostingRoom;
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
      throw new OhMyGameError("unsupported", "Quick play needs a drop-in deployment. Create or join a room instead.");
    this.displayName = options.displayName;
    await this.connect(async () => {
      const join = this.joinOptions(options);
      for (const delay of [...(this.options.roomLimitRetryMs ?? [1000, 2000]), undefined]) {
        try {
          return await this.client.joinOrCreate(multiplayerRoomType(this.options.manifest), join);
        } catch (cause) {
          const full = isRecord(cause) && cause.code === MULTIPLAYER_ROOM_LIMIT_CODE;
          if (full && delay === undefined)
            throw new OhMyGameError("room_limit", cause instanceof Error ? cause.message : "The multiplayer service is full.", { cause });
          if (!full) throw cause;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      throw new OhMyGameError("room_limit", "Quick play could not find a room.");
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
      throw new OhMyGameError("not_connected", "The multiplayer room is not connected.");
    if (this.saved.pending.length >= 32)
      throw new OhMyGameError("busy", "Wait for pending commands to finish.");
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
   * Sends what the player is doing now in a realtime game, in the shape the rules read,
   * such as { x, y } for a direction. Safe to call every frame: the latest input goes out
   * about once per service tick, timed to reach the service just before its tick, and
   * keeps going out while the game keeps calling, so a held key stays fresh. A changed
   * input, such as a key just pressed, goes out at once, a few times a second at most.
   * Sending faster would only be discarded, and a flood closes the connection. Throws
   * invalid_option for an input that is not plain JSON of at most
   * REALTIME_INPUT_MAX_LENGTH characters, or that uses the reserved key inputId.
   */
  sendInput(input: ClientInput<Game>): void {
    if (!isRealtimeInput(input))
      throw new OhMyGameError(
        "invalid_option",
        "An input must be a small plain object of JSON data, without the key inputId.",
      );
    if (!this.room || this.status !== "connected") return;
    this.latestInput = input;
    // A changed input, such as a key just pressed, goes out now rather than at the next
    // tick's send, as long as the early-send allowance lasts.
    if (this.inputPacer.running && !sameJson(input, this.sentInput) && this.earlySend() && this.inputPacer.hurry()) this.earlySends--;
    else this.inputPacer.wake();
  }
  /** Whether an early send is allowed now; refills EARLY_SENDS_PER_SECOND, up to EARLY_SENDS_BURST. */
  private earlySend(): boolean {
    const now = performance.now();
    this.earlySends = Math.min(EARLY_SENDS_BURST, this.earlySends + ((now - this.earlySendsAt) * EARLY_SENDS_PER_SECOND) / 1000);
    this.earlySendsAt = now;
    return this.earlySends >= 1;
  }
  /**
   * Sends something the player does once in a realtime game, such as { fire: true }, in
   * the shape the rules' action function reads. The rules read it in exactly one tick, so
   * send it once per press, not every frame. Returns false when no room is connected, in
   * which case nothing is sent: an action is about this moment, so it is never queued.
   * Throws invalid_option for an action that is not plain JSON of at most
   * REALTIME_INPUT_MAX_LENGTH characters. The service reports a refused action through onError.
   */
  /**
   * Owner rooms: sets this player's state, a small plain object of JSON data that the page
   * keeps up to date as its player moves, such as { x, y, dir }. It shows in
   * snapshot.state.game.players at once and reaches everyone else within a tick; only the
   * top-level keys that changed are sent, so keep large parts that rarely change in their
   * own keys. Throws invalid_option for anything else, or outside an owner deployment.
   */
  setState(state: Record<string, unknown>): void {
    if (!this.owner) throw new OhMyGameError("invalid_option", "setState is for owner deployments.");
    try {
      this.owner.setState(state);
    } catch (cause) {
      throw new OhMyGameError("invalid_option", cause instanceof Error ? cause.message : "The state is invalid.");
    }
  }
  /**
   * Owner rooms: changes snapshot.state.game.shared, the data every player shares, such as
   * food or a door. All the changes apply or none: each may require its key to hold expect
   * or to be absent (expectAbsent), so when two players take the same thing, only the first
   * gets it. Resolves true when the service applied them, false otherwise.
   */
  updateShared(changes: OwnerSharedChange[]): Promise<boolean> {
    if (!this.owner) throw new OhMyGameError("invalid_option", "updateShared is for owner deployments.");
    return this.owner.updateShared(changes);
  }
  /** Owner rooms: sends every other player a one-off message, which reaches them through onMessage. */
  emit(message: Record<string, unknown>): boolean {
    if (!this.owner) throw new OhMyGameError("invalid_option", "emit is for owner deployments.");
    if (!isOwnerMessage(message)) throw new OhMyGameError("invalid_option", "A message must be a small plain object of JSON data.");
    if (!this.room || this.status !== "connected") return false;
    const emitted: OwnerEmit = { id: `${Date.now().toString(36)}.${(this.messageCount++).toString(36)}`, message };
    this.mesh?.sendMessage(emitted);
    this.room.send("owner.emit", emitted);
    return true;
  }
  /** Owner rooms: ends the round with these winners; the first page to say so decides. */
  finishRound(winners: string[]): void {
    if (!this.owner) throw new OhMyGameError("invalid_option", "finishRound is for owner deployments.");
    this.room?.send("owner.finish", { winners });
  }
  /** Passes a message on once, whichever path brought it first. */
  private deliverMessage(from: string, id: string, message: Record<string, unknown>): void {
    const key = `${from} ${id}`;
    if (this.delivered.has(key)) return;
    this.delivered.add(key);
    // Copies arrive within moments of each other; older IDs need not be kept.
    if (this.delivered.size > 512) this.delivered.delete(this.delivered.values().next().value!);
    this.callbacks.onMessage?.(from, message);
  }
  /** Connects straight to the room's connected players, and drops those who left. */
  private updatePeers(): void {
    if (!this.mesh) return;
    const players = this.room ? (this.fromService?.state.players ?? []) : [];
    this.mesh.update(players.filter((player) => player.connected).map((player) => player.playerId));
  }
  /** Shows an owner round: the room's seats and phase, with every player's state and the shared data. */
  private showOwner(): void {
    this.updatePeers();
    const base = this.fromService;
    if (!this.owner?.active || !base || base.state.phase !== "playing") return;
    this.current = { ...base, state: { ...base.state, game: this.owner.game() } };
    this.callbacks.onSnapshot?.(this.current);
  }
  sendAction(action: ClientAction<Game>): boolean {
    if (!isRealtimeAction(action))
      throw new OhMyGameError("invalid_option", "An action must be a small plain object of JSON data.");
    if (!this.room || this.status !== "connected") return false;
    const local = this.localLoop();
    if (local) {
      try {
        if (!this.hostRules!.adapter.validateAction) throw new Error("This game takes no actions.");
        this.hostRules!.adapter.validateAction(action, local.playerId);
        local.loop.action(local.playerId, action);
      } catch (cause) {
        this.error(new OhMyGameError("request_failed", cause instanceof Error ? cause.message : "The action is invalid."));
      }
      return true;
    }
    if (this.lockstep) {
      // Every page's rules read it; they would drop one they refuse, so say why here.
      const { validateAction } = this.lockstep.adapter;
      try {
        if (!validateAction) throw new Error("This game takes no actions.");
        validateAction(action, this.saved?.playerId ?? "");
      } catch (cause) {
        this.error(new OhMyGameError("request_failed", cause instanceof Error ? cause.message : "The action is invalid."));
        return true;
      }
    }
    this.room.send("action", action);
    this.lockstep?.runner.action(action);
    return true;
  }
  private flushInput(): void {
    const input = this.latestInput;
    this.latestInput = undefined;
    if (!input || !this.room || this.status !== "connected") return;
    this.sentInput = input;
    const local = this.localLoop();
    if (local) {
      try {
        this.hostRules!.adapter.validateInput?.(input, local.playerId);
        local.loop.input(local.playerId, input);
      } catch (cause) {
        this.error(new OhMyGameError("request_failed", cause instanceof Error ? cause.message : "The input is invalid."));
      }
      return;
    }
    if (this.lockstep) {
      try {
        this.lockstep.adapter.validateInput?.(input, this.saved?.playerId ?? "");
      } catch (cause) {
        this.error(new OhMyGameError("request_failed", cause instanceof Error ? cause.message : "The input is invalid."));
        return;
      }
      // For the frame this page shows it in, which runs ahead of the service.
      this.room.send("lockstep.input", this.lockstep.runner.input(this.inputId++, input));
      return;
    }
    const inputId = this.inputId++;
    this.room.send("input", { ...input, inputId });
    if (this.prediction) {
      this.prediction.sent(inputId, input);
      this.showPredicted();
    }
  }
  /**
   * Predicts this player from the rules the service runs: realtime rules from
   * defineRealtimeGame, or a compiled realtime adapter. Rules with playerView are not
   * predicted, since the page does not see the whole state they step.
   */
  private predictionFor(rules: unknown): OwnPrediction | undefined {
    let adapter: GameAdapter;
    if (isRecord(rules) && typeof rules.step === "function" && rules.mode === "realtime") adapter = rules as unknown as GameAdapter;
    else {
      try {
        adapter = compileGame(rules as Parameters<typeof compileGame>[0]);
      } catch (cause) {
        throw new OhMyGameError("invalid_option", `The game's rules are invalid: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      if (adapter.mode !== "realtime")
        throw new OhMyGameError("invalid_option", "The game's rules are turn-based, but the deployment is realtime.");
    }
    if (adapter.playerView || adapter.viewFor) return undefined;
    return new OwnPrediction(adapter, { playerId: () => this.saved?.playerId, tickMs: () => this.roomTickMs });
  }
  /** Shows this player's predicted moves on the room's latest seats and phase. */
  private showPredicted(): void {
    const base = this.fromService;
    const state = this.prediction?.state;
    if (!base || !state || base.state.phase !== "playing") return;
    this.current = { ...base, state };
    this.callbacks.onSnapshot?.(this.current);
  }
  /** What the lockstep runner does with the round: show it, and report to the service. */
  private lockstepHooks() {
    return {
      show: (state: MultiplayerSnapshot["state"]) => this.showLockstep(state),
      finish: (report: unknown) => this.room?.send("lockstep.finish", report),
      checkpoint: (report: unknown) => this.room?.send("lockstep.checkpoint", report),
      // The first connected seat reports checkpoints; every page can tell which that is.
      reporter: () => {
        const first = this.fromService?.state.players.find((player) => player.connected);
        return !!first && first.playerId === this.saved?.playerId;
      },
      resync: () => this.room?.send("sync"),
      ping: (sentAt: number) => this.room?.send("ping", sentAt),
      playerId: () => this.saved?.playerId,
      every: startTicker,
    };
  }
  /** Shows a lockstep round's state on the room's latest seats and phase. */
  private showLockstep(state: MultiplayerSnapshot["state"]): void {
    const base = this.fromService;
    // The round shows once the room says it plays; a page that caught up early waits for that.
    if (!base || base.state.phase !== "playing") return;
    this.current = { ...base, state: mergeHostState(state, base.state) };
    this.callbacks.onSnapshot?.(this.current);
  }
  /**
   * The loop this player runs for the room while they host a round: their own input and
   * actions go straight to it, as the service would only pass them back. Between rounds
   * they go to the service, which explains why it refuses them.
   */
  private localLoop(): { loop: HostLoop; playerId: string } | undefined {
    const playerId = this.saved?.playerId;
    return this.hostingRoom && this.hostLoop?.phase === "playing" && playerId ? { loop: this.hostLoop, playerId } : undefined;
  }
  /**
   * Shows a tick of this player's own loop at once, as the service will once the tick has
   * made the trip: the room's part from the service, the game's from the rules, in this
   * player's view.
   */
  private showHosted(room: Room, state: MultiplayerSnapshot["state"]): void {
    const base = this.fromService;
    // A round starts when the service says so; until then the game shows the service's room.
    if (this.room !== room || !base || base.state.phase !== "playing" || !this.hostRules) return;
    let shown = mergeHostState(state, base.state);
    const { viewFor } = this.hostRules.adapter;
    if (this.hostRules.playerView && viewFor) {
      const view = viewFor(shown, this.saved?.playerId);
      shown = { ...shown, game: view.game ?? {} };
    }
    this.current = { ...base, state: shown };
    this.callbacks.onSnapshot?.(this.current);
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
    this.inputPacer.stop();
    this.latestInput = undefined;
    this.sentInput = undefined;
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.tickClock.reset();
  }
  /**
   * Rooms whose service tick reads what the page sends once a tick, a realtime room the
   * service runs and an owner room, time those sends to it: the page measures its round trip.
   * A host's loop and lockstep frames keep their own time.
   */
  private pacesToServiceTick(): boolean {
    return this.options.manifest.mode === "realtime" && !this.lockstep && !this.hostRules;
  }
  private startPinging(): void {
    if (this.pingTimer || !this.pacesToServiceTick()) return;
    const ping = () => this.room?.send("ping", performance.now());
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }
  async publicRooms(): Promise<PublicMultiplayerRoom[]> {
    const { gameId, deploymentId } = this.options.manifest;
    const response = await this.request(
      `/v1/games/${encodeURIComponent(gameId)}/rooms?deploymentId=${encodeURIComponent(deploymentId)}`,
    );
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new OhMyGameError("invalid_response", "Invalid public room list.");
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
    this.stopHosting();
    this.stopInput();
    this.stopMerge();
    this.generation++;
    const room = this.room;
    this.room = undefined;
    this.saved = undefined;
    this.current = undefined;
    this.fromService = undefined;
    this.lockstep?.runner.reset();
    this.owner?.reset();
    this.mesh?.close();
    this.persist();
    room?.removeAllListeners();
    if (room) {
      room.reconnection.enabled = false;
      await room.leave(true);
    }
  }
  dispose(): void {
    this.stopHosting();
    this.stopInput();
    this.stopMerge();
    this.mesh?.close();
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
      throw new OhMyGameError("busy", "A room connection is already active.");
    this.busy = true;
    const generation = ++this.generation;
    this.setStatus(restoring ? "reconnecting" : "connecting");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const opening = (async () => {
        const token = await this.token();
        if (generation !== this.generation)
          throw new OhMyGameError("cancelled", "Room connection cancelled.");
        this.client.auth.token = token;
        const room = await open();
        if (generation !== this.generation) {
          room.reconnection.enabled = false;
          await room.leave(true);
          throw new OhMyGameError("cancelled", "Room connection cancelled.");
        }
        return room;
      })();
      const room = await Promise.race([
        opening,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new OhMyGameError(
                  "timeout",
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
      this.fromService = undefined;
      this.lockstep?.runner.reset();
      this.owner?.reset();
      this.lastEventSequence = -1;
      this.reportedUnreadable = false;
      this.inputId = 0;
      this.prediction?.reset();
      this.bind(room);
      this.persist();
      this.setStatus("connected");
      this.awaitingSnapshot = true;
      room.send("sync");
      this.startPinging();
      this.scheduleMerge();
    } catch (cause) {
      const error = toOhMyGameError(cause, "request_failed");
      if (generation === this.generation) {
        this.generation++;
        this.error(error);
        this.setStatus("error");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }
  /** Takes or gives up running the rules for the room, when the service asks. */
  private setHosting(room: Room, value: unknown): void {
    const rules = this.hostRules;
    if (!rules || !isRecord(value)) return;
    const active = value.active === true;
    this.hostLoop?.stop();
    this.hostLoop = undefined;
    if (active && rules.adapter.mode === "realtime" && isRecord(value.state)) {
      this.hostLoop = new HostLoop(
        rules.adapter,
        tickMsOf(rules.adapter),
        rules.playerView,
        (state, views) => {
          if (this.room === room) room.send("host.state", { state, ...(views ? { views } : {}) });
        },
        (state) => this.showHosted(room, state),
      );
      this.hostLoop.start(value.state as unknown as MultiplayerSnapshot["state"]);
    }
    if (active !== this.hostingRoom) {
      this.hostingRoom = active;
      this.callbacks.onHost?.(active);
    }
  }
  private stopHosting(): void {
    this.hostLoop?.stop();
    this.hostLoop = undefined;
    if (this.hostingRoom) {
      this.hostingRoom = false;
      this.callbacks.onHost?.(false);
    }
  }
  private bindHost(room: Room): void {
    const rules = this.hostRules;
    if (!rules) return;
    room.onMessage("host", (value: unknown) => this.setHosting(room, value));
    room.onMessage("host.request", (value: unknown) => {
      if (!this.hostingRoom || !isRecord(value) || typeof value.requestId !== "string" || !isRecord(value.state)) return;
      const reply = runHostRequest(rules.adapter, value as unknown as HostRequest, rules.playerView);
      // The realtime loop carries on from what the rules just decided.
      if (reply.state) this.hostLoop?.start(reply.state);
      room.send("host.reply", reply);
    });
    room.onMessage("host.sync", (value: unknown) => {
      if (isRecord(value) && isRecord(value.state)) this.hostLoop?.sync(value.state as unknown as MultiplayerSnapshot["state"]);
    });
    room.onMessage("host.input", (value: unknown) => {
      if (!this.hostLoop || !isRecord(value) || typeof value.playerId !== "string" || !isRecord(value.input)) return;
      try {
        rules.adapter.validateInput?.(value.input, value.playerId);
        this.hostLoop.input(value.playerId, value.input);
      } catch (cause) {
        room.send("host.inputError", { playerId: value.playerId, message: cause instanceof Error ? cause.message : "The input is invalid." });
      }
    });
    room.onMessage("host.action", (value: unknown) => {
      if (!this.hostLoop || !isRecord(value) || typeof value.playerId !== "string" || !isRecord(value.action)) return;
      try {
        if (!rules.adapter.validateAction) throw new Error("This game takes no actions.");
        rules.adapter.validateAction(value.action, value.playerId);
        this.hostLoop.action(value.playerId, value.action);
      } catch (cause) {
        room.send("host.inputError", { playerId: value.playerId, message: cause instanceof Error ? cause.message : "The action is invalid." });
      }
    });
  }
  private bind(room: Room): void {
    room.reconnection.minUptime = 0;
    this.bindHost(room);
    // Each player gets their own snapshot, so rules can keep a hand or a role private.
    room.onMessage("snapshot", (value: unknown) => this.receiveSnapshot(value));
    room.onMessage("snapshot.delta", (value: unknown) => this.receiveDelta(value));
    room.onMessage("lockstep.sync", (value: unknown) => this.lockstep?.runner.sync(value));
    room.onMessage("lockstep.frame", (value: unknown) => this.lockstep?.runner.receive(value));
    room.onMessage("pong", (value: unknown) => {
      this.lockstep?.runner.pong(value);
      this.tickClock.pong(value);
    });
    room.onMessage("lockstep.early", (value: unknown) => this.lockstep?.runner.receiveEarly(value));
    room.onMessage("owner.sync", (value: unknown) => this.owner?.sync(value));
    room.onMessage("owner.frame", (value: unknown) => this.owner?.frame(value));
    room.onMessage("owner.shared", (value: unknown) => this.owner?.sharedUpdate(value));
    room.onMessage("owner.shared.result", (value: unknown) => this.owner?.sharedResult(value));
    room.onMessage("owner.message", (value: unknown) => {
      if (isOwnerMessageEvent(value)) this.deliverMessage(value.from, value.id, value.message);
    });
    room.onMessage("p2p.signal", (value: unknown) => {
      if (isRecord(value) && typeof value.from === "string") void this.mesh?.receive(value.from, value.data);
    });
    room.onMessage("ready", (value: unknown) => {
      if (!isRecord(value) || typeof value.playerId !== "string" || !this.saved)
        return;
      this.saved.playerId = value.playerId;
      if (
        typeof value.tickMs === "number" &&
        Number.isInteger(value.tickMs) &&
        value.tickMs >= TICK_MS_RANGE.min &&
        value.tickMs <= TICK_MS_RANGE.max
      )
        this.roomTickMs = value.tickMs;
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
        this.error(new OhMyGameError("request_failed", value.message));
    });
    room.onDrop(() => {
      this.stopHosting();
      this.stopInput();
      this.aloneSince = undefined;
      this.current = undefined;
      this.fromService = undefined;
      this.lockstep?.runner.reset();
      this.owner?.reset();
      this.setStatus("reconnecting");
    });
    room.onReconnect(() => {
      if (!this.saved) return;
      // The SDK rotates its token after dispatching onReconnect.
      queueMicrotask(() => {
        if (this.room !== room || !this.saved) return;
        this.saved.reconnectionToken = room.reconnectionToken;
        this.inputId = 0;
        this.prediction?.reset();
        this.persist();
        this.setStatus("connected");
        this.awaitingSnapshot = true;
        room.send("sync");
        this.startPinging();
      });
    });
    room.onError((_code, message) =>
      this.error(
        new OhMyGameError("request_failed", message ?? "The multiplayer room reported an error."),
      ),
    );
    room.onLeave((code, reason) => {
      if (this.room !== room) return;
      this.stopHosting();
      this.stopInput();
      this.stopMerge();
      this.room = undefined;
      this.current = undefined;
      this.fromService = undefined;
      this.lockstep?.runner.reset();
      this.owner?.reset();
      this.mesh?.close();
      if (code === 1000 || code >= 4000) {
        this.saved = undefined;
        this.persist();
      }
      this.setStatus("closed");
      if (reason) this.error(new OhMyGameError("connection_closed", reason));
      else if (code === 4002)
        this.error(new OhMyGameError("connection_closed", "The multiplayer service closed the connection. Join again to keep playing."));
    });
  }
  private receiveSnapshot(value: unknown): void {
    const config = this.options.manifest;
    if (
      !isMultiplayerSnapshot(value) ||
      value.roomId !== this.room?.roomId ||
      value.gameId !== config.gameId ||
      value.deploymentId !== config.deploymentId ||
      value.mode !== config.mode
    ) {
      // Ignoring it silently would leave the game connected with no room to show, as when
      // a game keeps an older SDK than its service. Report it once per connection.
      if (!this.reportedUnreadable) {
        this.reportedUnreadable = true;
        this.error(
          new OhMyGameError(
            "invalid_response",
            "The multiplayer service sent a room update this game cannot read. The game's OhMyGame SDK may not match its multiplayer service.",
          ),
        );
      }
      return;
    }
    if (value.sequence < (this.fromService?.sequence ?? -1)) return;
    this.awaitingSnapshot = false;
    // A realtime room the service runs sends its snapshots on its tick.
    if (this.pacesToServiceTick() && !this.owner && value.state.phase === "playing") this.tickClock.arrived();
    this.fromService = value;
    this.updatePeers();
    const first = !this.current;
    // While this player runs a round for the room, their own ticks are newer than any the
    // service sends back, about a round trip later, so the game keeps showing those. That
    // includes a round their rules just ended, which a late tick must not seem to reopen.
    const shown = this.current?.state.phase;
    if (!first && value.state.phase === "playing" && this.hostingRoom && this.hostLoop?.phase === shown && (shown === "playing" || shown === "finished")) return;
    if (this.lockstep && value.state.phase === "playing") {
      // The room keeps no game while a lockstep round plays: this page's own run has it.
      const round = this.lockstep.runner.shown;
      if (round) this.showLockstep(round);
    } else if (this.owner && value.state.phase === "playing") {
      // Nor while an owner round plays: the players' states and shared data come on their own.
      this.showOwner();
    } else if (this.prediction && value.state.phase === "playing") {
      this.prediction.confirm(value);
      this.showPredicted();
    } else {
      this.current = value;
      this.callbacks.onSnapshot?.(value);
    }
    if (first)
      for (const command of this.saved?.pending ?? [])
        this.room?.send("command", command);
  }
  /**
   * A realtime tick as the changes since the snapshot before. Applied to the snapshot this
   * page holds when that is the one they follow; otherwise the page asks for a whole one,
   * once, and drops changes until it arrives.
   */
  private receiveDelta(value: unknown): void {
    const base = this.fromService;
    if (!isSnapshotDelta(value) || value.roomId !== this.room?.roomId) return;
    if (base && value.base === base.sequence) {
      let state: MultiplayerSnapshot["state"] | undefined;
      try {
        state = applyStateChanges(base.state, value.changes);
      } catch {
        state = undefined;
      }
      if (state) {
        const { acks: _acks, ...rest } = base;
        this.receiveSnapshot({ ...rest, sequence: value.sequence, serverTime: value.serverTime, state, ...(value.acks ? { acks: value.acks } : {}) });
        return;
      }
    }
    if (value.sequence <= (base?.sequence ?? -1) || this.awaitingSnapshot) return;
    this.awaitingSnapshot = true;
    this.room.send("snapshot.request");
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
      policy === "anonymous" ? undefined : await this.options.identity?.getToken();
    if (account) return account;
    if (policy === "account-required")
      throw new OhMyGameError("sign_in_required", "Sign in with your OhMyGame account before joining.");
    return this.guest.getToken();
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
      throw new OhMyGameError("invalid_response", "Invalid room invitation.");
    return value.roomId;
  }
  private request(path: string, options?: RequestInit): Promise<Response> {
    return serviceRequest(this.endpoint(), path, options);
  }
  // HTTP calls go where the room connection goes, so they reach the same service.
  private endpoint(): string {
    const { secure, hostname, port } = this.client.settings;
    return `${secure ? "https" : "http"}://${hostname}${port ? `:${port}` : ""}`;
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
  private error(error: OhMyGameError): void {
    if (!this.disposed) this.callbacks.onError?.(error);
  }
}

/** Errors from Colyseus or the browser keep their message under a stable code. */
function toOhMyGameError(cause: unknown, code: OhMyGameErrorCode): OhMyGameError {
  if (isOhMyGameError(cause)) return cause;
  return new OhMyGameError(code, cause instanceof Error ? cause.message : String(cause), { cause });
}

/**
 * Colyseus sends matchmaking with credentials by default, and browsers keep requests
 * with and without credentials on separate connections: joining then opened a second
 * TLS connection, most of a second far from the service. The service never reads
 * cookies, so matchmaking goes without them, on the connection the guest and data
 * requests already opened.
 */
/**
 * Asks the browser to open a connection to the service before the first request, for
 * requests without credentials as the SDK sends them. A browser may close it again if
 * nothing uses it soon; then the first request opens its own, as without it.
 */
function preconnect(url: string): void {
  if (typeof document === "undefined" || !document.head) return;
  const origin = new URL(url).origin;
  for (const link of document.head.querySelectorAll<HTMLLinkElement>('link[rel="preconnect"]'))
    if (link.href.replace(/\/$/, "") === origin && link.crossOrigin === "anonymous") return;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  link.crossOrigin = "anonymous";
  document.head.append(link);
}
function colyseusClient(serverUrl: string): ColyseusClient {
  const client = new ColyseusClient(serverUrl);
  client.http.options.credentials = "omit";
  return client;
}
export type MultiplayerOptions = Omit<MultiplayerClientOptions, "manifest" | "identity" | "allowLocalhost">;

/**
 * A client for one player's room connection, from the game that init returned. Game is the
 * type of the rules from defineGame, which types client.moves. Throws not_configured when
 * the game has no multiplayer deployment.
 */
export function createMultiplayerClient<Game = unknown>(
  game: OhMyGame,
  callbacks?: MultiplayerClientCallbacks,
  options: MultiplayerOptions & { rules?: Game } = {},
): MultiplayerClient<Game> {
  if (!game.multiplayer)
    throw new OhMyGameError("not_configured", "This game has no multiplayer deployment in manifest.json.");
  return new MultiplayerClient<Game>(
    { ...options, manifest: game.multiplayer, identity: game.identity, allowLocalhost: game.allowLocalhost },
    callbacks,
  );
}
