// client.d.ts
export * from "./index.js";
export * from "./multiplayer-client.js";
export * from "./multiplayer-protocol.js";
export * from "./gomoku.js";

// index.d.ts
import { type IdentityProvider } from "./identity.js";
import { MultiplayerClient, type MultiplayerClientCallbacks, type MultiplayerClientOptions } from "./multiplayer-client.js";
import { type MultiplayerManifestConfig } from "./multiplayer-protocol.js";
export { isOhMyGameError, OhMyGameError, type OhMyGameErrorCode } from "./errors.js";
export { GuestIdentity, type GuestIdentityOptions, type IdentityProvider } from "./identity.js";
export { defineGame, type ClientMoves, type GameContext, type GameDefinition, type GameResult, type MoveContext, type MoveDefinition, type MoveFunction, type MoveOptions, } from "./define-game.js";
export interface InitOptions {
    /**
     * The game's manifest, or where to load it. Defaults to manifest.json beside the
     * page, which OhMyGame writes and publishing checks.
     */
    manifest?: {
        multiplayer?: unknown;
    } | string | URL;
    /** The signed-in player. Without one, deployments that allow guests use a guest. */
    identity?: IdentityProvider;
    /** Opt in only for loopback development, never for a published deployment. */
    allowLocalhost?: boolean;
}
export type MultiplayerOptions = Omit<MultiplayerClientOptions, "manifest" | "identity" | "allowLocalhost">;
export interface OhMyGame {
    /** The game's multiplayer deployment, or undefined for a single-player game. */
    readonly multiplayer?: MultiplayerManifestConfig;
    /** A client for one player's room connection. Throws not_configured without a deployment. */
    createMultiplayerClient<Game = unknown>(callbacks?: MultiplayerClientCallbacks, options?: MultiplayerOptions): MultiplayerClient<Game>;
}
/** Reads the game's configuration once; every SDK feature starts from what it returns. */
export declare function init(options?: InitOptions): Promise<OhMyGame>;

// errors.d.ts
/**
 * Stable reasons a game can branch on. Messages are for people and may change;
 * codes only gain new members.
 */
export type OhMyGameErrorCode = 
/** The game has no deployment for this feature, or its manifest is invalid. */
"not_configured"
/** An option passed to the SDK is outside its allowed range. */
 | "invalid_option"
/** The deployment requires an OhMyGame account and no player is signed in. */
 | "sign_in_required"
/** The call needs a connected room. */
 | "not_connected"
/** A connection is already opening or open on this client. */
 | "busy"
/** The call does not apply to this deployment's room policy. */
 | "unsupported"
/** The service did not answer in time. */
 | "timeout"
/** The service has reached its room limit; retry later. */
 | "room_limit"
/** The service rejected a request, such as an expired invitation. */
 | "request_failed"
/** The service answered with something the SDK does not understand. */
 | "invalid_response"
/** The room closed or the service ended the connection. */
 | "connection_closed"
/** A newer call replaced this one, or the client was disposed. */
 | "cancelled";
export declare class OhMyGameError extends Error {
    readonly code: OhMyGameErrorCode;
    readonly name = "OhMyGameError";
    constructor(code: OhMyGameErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
export declare function isOhMyGameError(value: unknown, code?: OhMyGameErrorCode): value is OhMyGameError;

// identity.d.ts
/**
 * Who the player is, as a bearer token for the game service. A provider returns
 * undefined when it has no player, for example before sign-in.
 */
export interface IdentityProvider {
    getToken(): Promise<string | undefined>;
}
export interface GuestIdentityOptions {
    serverUrl: string;
    /** Defaults to localStorage, so one browser stays one guest across tabs and visits. */
    storage?: Storage;
}
/**
 * A guest issued by the game service: no account, kept in browser storage until it
 * expires. The SDK falls back to it when the deployment allows guests.
 */
export declare class GuestIdentity implements IdentityProvider {
    private readonly options;
    private readonly storage?;
    private readonly key;
    constructor(options: GuestIdentityOptions);
    getToken(): Promise<string>;
}

// define-game.d.ts
/**
 * Turn-based rules as plain functions. The service runs them; clients only send a move's
 * name and arguments. Everything here is free of dependencies so a game's rules file can
 * import it on the service and its page can import the types.
 */
export interface GameContext {
    /** Seated players in join order. */
    readonly players: readonly string[];
    readonly ownerId: string;
    /** The player whose turn it is. */
    readonly currentPlayer: string;
    /** A random number in [0, 1) from the service. Use it instead of Math.random. */
    random(): number;
    /** A shuffled copy, using random(). */
    shuffle<T>(items: readonly T[]): T[];
    /** The service's clock in milliseconds. Use it instead of Date.now. */
    now(): number;
}
export interface MoveContext extends GameContext {
    /** The player making this move. */
    readonly playerId: string;
    /** Who acts next. Without a call, a turn move passes the turn to the next seat. */
    setCurrentPlayer(playerId: string): void;
}
/**
 * Change G in place or return a new one. Throw an Error to reject the move; its message
 * reaches the player.
 */
export type MoveFunction<G, Args> = (G: G, ctx: MoveContext, args: Args) => G | void;
export interface MoveOptions<G, Args> {
    run: MoveFunction<G, Args>;
    /**
     * "current" (default): only the player whose turn it is, and the turn then passes on.
     * "owner": only the room owner, at any time. "any": any seated player, at any time.
     */
    by?: "current" | "owner" | "any";
    /** Also accepted after the game ended; when it is accepted, play continues. */
    afterEnd?: boolean;
}
export type MoveDefinition<G> = MoveFunction<G, any> | MoveOptions<G, any>;
/** winners is empty for a draw. */
export interface GameResult {
    winners: string[];
    draw?: boolean;
}
export interface GameDefinition<G extends object, Moves extends Record<string, MoveDefinition<G>>> {
    /** Seats the rules support. A match starts once at least min players are connected. */
    players: {
        min: number;
        max: number;
    };
    /** The game when the owner starts the match. */
    setup(ctx: GameContext): G;
    moves: Moves;
    /** Checked after every accepted move. A result ends the match. */
    endIf?(G: G, ctx: GameContext): GameResult | undefined;
    /** What one player may see, such as their own hand. playerId is undefined for a spectator. */
    playerView?(G: G, ctx: GameContext, playerId: string | undefined): object;
    /** Seconds before a turn is skipped. Defaults to 60. */
    turnSeconds?: number;
    /** Reserved for bots and automated testing; the service does not call it yet. */
    legalMoves?(G: G, ctx: GameContext, playerId: string): {
        move: keyof Moves & string;
        args?: object;
    }[];
}
/** Checks the shape of the rules and returns them unchanged, with their types inferred. */
export declare function defineGame<G extends object, Moves extends Record<string, MoveDefinition<G>>>(definition: GameDefinition<G, Moves>): GameDefinition<G, Moves>;
type MoveArgs<M> = M extends {
    run: (G: never, ctx: never, args: infer A) => unknown;
} ? A : M extends (G: never, ctx: never, args: infer A) => unknown ? A : never;
/** client.moves for a game: one function per move, taking that move's arguments. */
export type ClientMoves<Game> = Game extends {
    moves: infer Moves extends object;
} ? {
    [K in keyof Moves & string]: unknown extends MoveArgs<Moves[K]> ? (args?: Record<string, unknown>) => string : {} extends MoveArgs<Moves[K]> ? (args?: MoveArgs<Moves[K]>) => string : (args: MoveArgs<Moves[K]>) => string;
} : Record<string, (args?: Record<string, unknown>) => string>;
export {};

// multiplayer-client.d.ts
import { type MultiplayerEvent, type MultiplayerManifestConfig, type MultiplayerSnapshot, type PublicMultiplayerRoom, type TurnCommand, type TurnCommandResult } from "./multiplayer-protocol.js";
import { OhMyGameError } from "./errors.js";
import { type IdentityProvider } from "./identity.js";
import type { ClientMoves } from "./define-game.js";
export type MultiplayerConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "error";
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
    onError?: (error: OhMyGameError) => void;
}
/**
 * Colyseus owns transient reconnects; this wrapper adds refresh and restart recovery.
 * Game is the type of the rules from defineGame, which types client.moves.
 */
export declare class MultiplayerClient<Game = unknown> {
    private readonly options;
    private readonly callbacks;
    /**
     * Sends one move of the game's rules, for example client.moves.play({ cards }).
     * Returns the command ID that onCommandResult reports. The key "action" is reserved.
     */
    readonly moves: ClientMoves<Game>;
    private readonly client;
    private readonly storage?;
    private readonly guest;
    private readonly storageKey;
    private room?;
    private saved?;
    private current?;
    private lastEventSequence;
    private generation;
    private busy;
    private disposed;
    private inputId;
    private latestInput?;
    private inputTimer?;
    private displayName?;
    private mergeTimer?;
    private aloneSince?;
    private merging;
    private connectionStatus;
    constructor(options: MultiplayerClientOptions, callbacks?: MultiplayerClientCallbacks);
    get status(): MultiplayerConnectionStatus;
    get roomId(): string | undefined;
    get playerId(): string | undefined;
    get roomCode(): string | undefined;
    get snapshot(): MultiplayerSnapshot | undefined;
    createRoom(options?: {
        displayName?: string;
    }): Promise<void>;
    /**
     * Drop-in deployments only: join the fullest room with a free seat, or open a new one
     * when every room is full. A service at its room limit is retried a few times before
     * the error reaches the game.
     */
    quickPlay(options?: {
        displayName?: string;
    }): Promise<void>;
    joinRoom(options?: {
        displayName?: string;
        roomCode?: string;
        roomId?: string;
    }): Promise<void>;
    reconnect(): Promise<boolean>;
    sendCommand(type: TurnCommand["type"], payload?: TurnCommand["payload"]): string;
    /**
     * Safe to call every frame. The latest direction goes out at most once per service
     * tick, and keeps going out while the game keeps calling, so a held key stays fresh;
     * sending faster would only be discarded, and a flood closes the connection.
     */
    sendInput(x: number, y: number): void;
    private flushInput;
    /**
     * Quick play only places a player when they arrive, so two players can end up alone
     * in separate rooms, for example after one returns to a held seat. A drop-in player
     * who stays alone moves to the busiest room that has others and a free seat.
     * Checks are jittered so two lonely players rarely move at the same moment; when they
     * do, quick play's room creation lock still brings them together.
     */
    private scheduleMerge;
    private stopMerge;
    private alone;
    private checkMerge;
    private stopInput;
    publicRooms(): Promise<PublicMultiplayerRoom[]>;
    leave(): Promise<void>;
    /** Leaves without reporting a closed connection, for moving to another room. */
    private leaveRoom;
    dispose(): void;
    private connect;
    private bind;
    private receiveSnapshot;
    private joinOptions;
    private token;
    private resolveRoom;
    private request;
    private endpoint;
    private persist;
    private setStatus;
    private error;
}

// multiplayer-protocol.d.ts
export type MultiplayerMode = "turn-based" | "realtime";
export type MultiplayerAuthPolicy = "anonymous" | "guest-or-account" | "account-required";
/**
 * drop-in is realtime only: players join a room with a free seat, or a new one, without
 * creating or starting it, and can join a round in progress. It has no room owner.
 */
export type MultiplayerRoomPolicy = "invite-or-public" | "public" | "invite-only" | "drop-in";
export interface MultiplayerManifestConfig {
    enabled: true;
    mode: MultiplayerMode;
    gameId: string;
    deploymentId: string;
    protocolVersion: 1;
    serverUrl: string;
    authPolicy: MultiplayerAuthPolicy;
    roomPolicy: MultiplayerRoomPolicy;
    maxClients: number;
    reconnectSeconds: number;
    /** Immutable server-side rules registered for this deployment. */
    adapterId?: string;
}
/** Explicit reference runtime; authored Web Games render their own adapter. */
export interface PublishedMultiplayerManifest {
    version: 1;
    runtime: "multiplayer-example";
    multiplayer: MultiplayerManifestConfig;
}
export declare function isPublishedMultiplayerManifest(value: unknown): value is PublishedMultiplayerManifest;
/** The service simulates realtime rooms at this interval; the SDK sends input no faster. */
export declare const REALTIME_TICK_MS = 50;
/** A realtime connection that sends more messages than this in a second is closed. */
export declare const REALTIME_MAX_MESSAGES_PER_SECOND = 40;
/**
 * Sent with a matchmaking error when the service cannot open another room; quick play
 * retries it. Colyseus uses the code as the HTTP status, so it stays in that range.
 */
export declare const MULTIPLAYER_ROOM_LIMIT_CODE = 503;
export declare const MULTIPLAYER_MIN_CLIENTS = 2;
export declare const MULTIPLAYER_MAX_CLIENTS = 32;
export declare const MULTIPLAYER_MANIFEST_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["enabled", "mode", "gameId", "deploymentId", "protocolVersion", "serverUrl", "authPolicy", "roomPolicy", "maxClients", "reconnectSeconds"];
    readonly properties: {
        readonly enabled: {
            readonly const: true;
        };
        readonly mode: {
            readonly enum: readonly ["turn-based", "realtime"];
        };
        readonly gameId: {
            readonly type: "string";
            readonly pattern: "^[A-Za-z0-9_-]{1,100}$";
        };
        readonly deploymentId: {
            readonly type: "string";
            readonly pattern: "^[A-Za-z0-9_-]{1,100}$";
        };
        readonly protocolVersion: {
            readonly const: 1;
        };
        readonly serverUrl: {
            readonly type: "string";
            readonly pattern: "^https://[^/?#@\\s]+/?$";
        };
        readonly authPolicy: {
            readonly enum: readonly ["anonymous", "guest-or-account", "account-required"];
        };
        readonly roomPolicy: {
            readonly enum: readonly ["invite-or-public", "public", "invite-only", "drop-in"];
        };
        readonly maxClients: {
            readonly type: "integer";
            readonly minimum: 2;
            readonly maximum: 32;
        };
        readonly reconnectSeconds: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly maximum: 3600;
        };
        readonly adapterId: {
            readonly type: "string";
            readonly pattern: "^[A-Za-z0-9_-]{1,100}$";
        };
    };
};
export declare function isMultiplayerManifestConfig(value: unknown, options?: {
    allowLocalhost?: boolean;
}): value is MultiplayerManifestConfig;
export declare function multiplayerRoomType(config: Pick<MultiplayerManifestConfig, "gameId" | "deploymentId">): string;
export declare function sameMultiplayerConfig(left: MultiplayerManifestConfig, right: MultiplayerManifestConfig): boolean;
export interface JoinRoomOptions {
    gameId: string;
    deploymentId: string;
    protocolVersion: 1;
    displayName?: string;
    roomCode?: string;
    creationKey?: string;
}
export type CreateRoomOptions = JoinRoomOptions;
export interface TurnCommand {
    commandId: string;
    expectedSequence: number;
    type: "start" | "take" | "pass" | "close" | "kick" | "action";
    payload?: {
        count?: number;
        playerId?: string;
        [key: string]: unknown;
    };
}
export interface RealtimeInput {
    inputId: number;
    x: number;
    y: number;
}
export interface MultiplayerPlayer {
    playerId: string;
    displayName: string;
    connected: boolean;
    x: number;
    y: number;
}
export interface MultiplayerGameState {
    phase: "lobby" | "playing" | "finished" | "closed";
    ownerId: string;
    currentPlayerId: string;
    winnerPlayerId: string;
    /** Every winner, when a team or several players win together; empty for a draw. */
    winnerPlayerIds?: string[];
    remaining: number;
    turnDeadline: number;
    players: MultiplayerPlayer[];
    /** Serializable data owned and validated by the deployment's rules adapter. */
    game?: Record<string, unknown>;
}
/** Adapters run only on the service; clients submit intent, never final state. */
export interface MultiplayerGameAdapter<State, Command> {
    /** Seats the rules support. A deployment's maxClients must fit, and a match starts with at least min connected players. */
    players: {
        min: number;
        max: number;
    };
    initialState(): State;
    validateCommand(state: State, playerId: string, command: Command): void;
    applyCommand(state: State, playerId: string, command: Command): State;
    onDisconnect?(state: State, playerId: string): void;
    onTurnTimeout?(state: State, now: number): State;
    step?(state: State, inputs: ReadonlyMap<string, {
        input: RealtimeInput;
        at: number;
    }>, now: number): State;
    /**
     * The state one player may see, such as their own hand but not others'. playerId is
     * undefined for a connection that holds no seat. Without it every player sees the whole state.
     */
    viewFor?(state: State, playerId: string | undefined): State;
    /** Places a new seat, including one joining a drop-in round in progress. Without it the room lines seats up. */
    onPlayerJoin?(state: State, playerId: string, now: number): State;
    /** Resets the round when a drop-in room starts or restarts it, for example respawning every seat. */
    onRoundStart?(state: State, now: number): State;
}
export type MultiplayerEventType = "room.ready" | "member.joined" | "member.left" | "state.updated" | "turn.changed" | "room.finished" | "room.closed" | "protocol.error";
export type MultiplayerErrorCode = "invalid_command" | "not_your_turn" | "sequence_conflict" | "room_full" | "deployment_mismatch" | "protocol_mismatch" | "not_authorized" | "room_closed" | "rate_limited";
export interface MultiplayerEvent<T = unknown> {
    type: MultiplayerEventType;
    roomId: string;
    deploymentId: string;
    sequence: number;
    serverTime: string;
    payload: T;
}
export interface TurnCommandResult {
    commandId: string;
    accepted: boolean;
    sequence: number;
    error?: {
        code: MultiplayerErrorCode;
        message: string;
    };
}
export interface MultiplayerSnapshot {
    roomId: string;
    gameId: string;
    deploymentId: string;
    mode: MultiplayerMode;
    sequence: number;
    state: MultiplayerGameState;
    serverTime: string;
}
export interface PublicMultiplayerRoom {
    roomId: string;
    clients: number;
    maxClients: number;
}
export declare function isTurnCommand(value: unknown): value is TurnCommand;
export declare function isRealtimeInput(value: unknown): value is RealtimeInput;
export declare function isMultiplayerEvent(value: unknown): value is MultiplayerEvent;
export declare function isTurnCommandResult(value: unknown): value is TurnCommandResult;
export declare function isMultiplayerSnapshot(value: unknown): value is MultiplayerSnapshot;
export declare function normalizeDisplayName(value: unknown): string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;

// gomoku.d.ts
export declare const GOMOKU_SIZE = 15;
export type GomokuCell = 0 | 1 | 2;
export interface GomokuPoint {
    r: number;
    c: number;
}
export interface GomokuState {
    board: GomokuCell[];
    history: GomokuPoint[];
    winningLine: GomokuPoint[];
    blackWins: number;
    whiteWins: number;
    [key: string]: unknown;
}
export declare function initialGomokuState(): GomokuState;
export declare function isGomokuPoint(value: unknown): value is GomokuPoint;
export declare function isGomokuState(value: unknown): value is GomokuState;
export declare function gomokuWinningLine(board: GomokuCell[], point: GomokuPoint): GomokuPoint[];
