// client.d.ts
export * from "./index.js";
export * from "./multiplayer-protocol.js";

// multiplayer.d.ts
export * from "./multiplayer-client.js";

// index.d.ts
import { type GameAuth } from "./account.js";
import { type IdentityProvider } from "./identity.js";
import { type GameLeaderboard, type GameStorage } from "./cloud.js";
import { type CloudConfig } from "./cloud-protocol.js";
import { type MultiplayerManifestConfig } from "./multiplayer-protocol.js";
export { isOhMyGameError, OhMyGameError, type OhMyGameErrorCode } from "./errors.js";
export type { GameAuth } from "./account.js";
export type { GameLeaderboard, GameStorage } from "./cloud.js";
export { isCloudConfig, LEADERBOARD_PAGE_MAX, SAVE_MAX_BYTES, SAVE_MAX_KEYS, SCORE_SUBMITS_PER_MINUTE, type CloudConfig, type LeaderboardEntry, type LeaderboardOrder, type PlayerScore, type ScoreResult, } from "./cloud-protocol.js";
export { gameTokenAudience, isGameAccountConfig, type GameAccountConfig, type OhMyGamePlayer, } from "./account-protocol.js";
export { GuestIdentity, type GuestIdentityOptions, type IdentityProvider } from "./identity.js";
export { defineGame, defineRealtimeGame, type ClientAction, type ClientInput, type ClientMoves, type PlayerAction, type RealtimeGameContext, type RealtimeGameDefinition, type GameContext, type GameDefinition, type GameResult, type MoveContext, type MoveDefinition, type MoveFunction, type MoveOptions, } from "./define-game.js";
export interface InitOptions {
    /**
     * The game's manifest, or where to load it. Defaults to manifest.json beside the
     * page, which OhMyGame writes and publishing checks.
     */
    manifest?: {
        multiplayer?: unknown;
        account?: unknown;
        cloud?: unknown;
    } | string | URL;
    /**
     * Who the player is for game services, in place of the OhMyGame account in game.auth.
     * Without either, deployments that allow guests use a guest.
     */
    identity?: IdentityProvider;
    /** Opt in only for loopback development, never for a published deployment. */
    allowLocalhost?: boolean;
}
/**
 * The game's configuration, which every SDK feature starts from. For rooms, pass it to
 * createMultiplayerClient from @ohmygame/sdk/multiplayer.
 */
export interface OhMyGame {
    /** The game's multiplayer deployment, or undefined for a single-player game. */
    readonly multiplayer?: MultiplayerManifestConfig;
    /** The player's OhMyGame account. Sign-in is available in games published to OhMyGame. */
    readonly auth: GameAuth;
    /** The player's saves: in this browser, and on the game service when the game has one. */
    readonly storage: GameStorage;
    /** Leaderboards on the game service; leaderboard.available is false without one. */
    readonly leaderboard: GameLeaderboard;
    /** The game service for saves and leaderboards, from manifest.json's "cloud". */
    readonly cloud?: CloudConfig;
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
/** The service could not be reached, as when the player is offline. */
 | "offline"
/** The player keeps as much as the service allows, such as their number of saves or a save's size. */
 | "quota_exceeded"
/** The player sent too many requests, such as scores; retry in a minute. */
 | "rate_limited"
/** The data changed since it was read, or a leaderboard ranks in the other order. */
 | "conflict"
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
    private saved;
}

// account.d.ts
import { type OhMyGamePlayer } from "./account-protocol.js";
import type { IdentityProvider } from "./identity.js";
/** The player's OhMyGame account in this game: game.auth from init. */
export interface GameAuth extends IdentityProvider {
    /** Whether players can sign in: true in games published to OhMyGame, false in local builds. */
    readonly available: boolean;
    /** The signed-in player, or undefined while they play as a guest. */
    readonly player: OhMyGamePlayer | undefined;
    /**
     * Signs the player in and resolves with them. Inside an OhMyGame page that already has the
     * player, this needs no window. Otherwise it opens OhMyGame sign-in in a popup; where the
     * popup is blocked, as on many phones, the page goes to sign-in and comes back, and init()
     * finishes signing in. Throws unsupported in a local build and cancelled when the player
     * closes the window.
     */
    signIn(): Promise<OhMyGamePlayer>;
    /** A current game token for game services, renewed when it is about to expire; undefined for a guest. */
    getToken(): Promise<string | undefined>;
}

// account-protocol.d.ts
/** Where a published game signs players in, written to manifest.json as "account" by OhMyGame publishing. */
export interface GameAccountConfig {
    /** The OhMyGame account service, such as https://api.ohmygame.ai. */
    issuer: string;
    /**
     * Pages that may embed the game and hand it the signed-in player, such as OhMyGame's game
     * page. Defaults to the issuer's origin.
     */
    hostOrigins?: string[];
}
/** The player a game token names: the OhMyGame account ID and the name to show. */
export interface OhMyGamePlayer {
    id: string;
    name: string;
}
/** The audience of a game token: the one game it signs a player in to. */
export declare function gameTokenAudience(gameId: string): string;
export declare function isGameAccountConfig(value: unknown, options?: {
    allowLocalhost?: boolean;
}): value is GameAccountConfig;
export declare function isOhMyGamePlayer(value: unknown): value is OhMyGamePlayer;

// cloud.d.ts
import { type LeaderboardEntry, type LeaderboardOrder, type PlayerScore, type ScoreResult } from "./cloud-protocol.js";
/**
 * Saves that follow the player. Every write lands in the browser first and then on the
 * game service when the game has one ("cloud" in manifest.json): a save made offline is
 * sent when the service can be reached again. Without a service, or in a local build,
 * saves stay in this browser.
 */
export interface GameStorage {
    /** Whether saves reach the game service; false when they stay in this browser. */
    readonly cloud: boolean;
    /**
     * The save under key, or undefined. Reads the service's copy when it can be reached,
     * else this browser's. A save this browser has not sent yet wins over the service's.
     */
    get<T = unknown>(key: string): Promise<T | undefined>;
    /**
     * Keeps value, plain JSON of at most SAVE_MAX_BYTES, under key. Resolves once it is
     * kept in this browser and, when it can be reached, on the service; offline it is sent
     * later. Rejects with quota_exceeded when the player keeps too many saves or it is too large.
     */
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    /** The keys the player keeps. */
    keys(): Promise<string[]>;
    /** Sends saves made while the service could not be reached. The SDK also does this when the browser comes back online. */
    sync(): Promise<void>;
}
/**
 * Leaderboards on the game service. Only signed-in players appear publicly; a guest's
 * score is kept for them, and me() tells them where it would place.
 */
export interface GameLeaderboard {
    /** Whether the game has a game service; without one every call rejects with not_configured. */
    readonly available: boolean;
    /**
     * Submits a score and resolves with the player's best on the board. A board keeps the
     * order of its first score: "desc" (the default) ranks higher scores first, "asc" lower
     * ones, as for a time. Later scores may leave order out; naming the other order rejects
     * with conflict. Rejects with rate_limited after 10 scores in a minute.
     */
    submit(board: string, score: number, options?: {
        order?: LeaderboardOrder;
    }): Promise<ScoreResult>;
    /** Public entries, best first: 10 by default, at most LEADERBOARD_PAGE_MAX. */
    top(board: string, options?: {
        limit?: number;
        offset?: number;
    }): Promise<LeaderboardEntry[]>;
    /** The player's best and rank, or undefined before their first score. */
    me(board: string): Promise<PlayerScore | undefined>;
}

// cloud-protocol.d.ts
/**
 * Cloud saves and leaderboards: what a game's page and the game service agree on.
 * docs/cloud-saves.md describes the routes; free of dependencies so the service can
 * import it.
 */
/** Where a game keeps cloud saves and leaderboards: manifest.json's "cloud". */
export interface CloudConfig {
    /** The game service's HTTPS base URL. */
    serverUrl: string;
    /** The game's ID on that service; for a game published to OhMyGame, its OhMyGame game ID. */
    gameId: string;
}
/** A save key or leaderboard name: letters, digits, dot, dash and underscore. */
export declare const CLOUD_NAME_PATTERN: RegExp;
/** The most save keys one player may keep in one game. */
export declare const SAVE_MAX_KEYS = 32;
/** The largest save, in bytes of its JSON. */
export declare const SAVE_MAX_BYTES: number;
/** Scores one player may submit to one game in a minute. */
export declare const SCORE_SUBMITS_PER_MINUTE = 10;
/** The most leaderboard entries one request returns. */
export declare const LEADERBOARD_PAGE_MAX = 100;
/**
 * Leaderboards the game service writes itself from match results, such as match.wins for
 * built-in rules. Players can read them but not submit to them.
 */
export declare const MATCH_BOARD_PREFIX = "match.";
/** "desc": a higher score ranks first, as in points. "asc": lower ranks first, as in a time. */
export type LeaderboardOrder = "desc" | "asc";
export interface SaveRecord {
    key: string;
    value: unknown;
    /** Increases with every write; send it back as ifVersion to refuse a write over a newer one. */
    version: number;
    /** Milliseconds since the epoch, by the service's clock. */
    updatedAt: number;
}
/** A save without its value, as the key list returns it. */
export type SaveSummary = Omit<SaveRecord, "value"> & {
    bytes: number;
};
export interface LeaderboardEntry {
    rank: number;
    /** The player's OhMyGame account ID. Only signed-in players appear on a public board. */
    playerId: string;
    name: string;
    score: number;
    /** When the player set this score, in milliseconds since the epoch. */
    at: number;
}
/**
 * The player's own best on a board. A guest's score is kept for them only: public is
 * false and rank is where the score would place among signed-in players.
 */
export interface PlayerScore {
    score: number;
    at: number;
    rank: number;
    public: boolean;
}
/** The answer to a submitted score. */
export interface ScoreResult extends PlayerScore {
    /** Whether this score replaced the player's previous best. */
    improved: boolean;
}
/** Codes the service sends with an error, beside its message. */
export type CloudErrorCode = "quota_exceeded" | "rate_limited" | "conflict" | "not_found" | "invalid_request" | "not_authorized";
export declare function isCloudConfig(value: unknown, options?: {
    allowLocalhost?: boolean;
}): value is CloudConfig;

// define-game.d.ts
/**
 * Game rules as plain functions: turn-based rules with defineGame, realtime rules with
 * defineRealtimeGame. The service runs them; clients only send a move or their input.
 * Everything here is free of dependencies so a game's rules file can import it on the
 * service and its page can import the types.
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
    /**
     * The game when the owner starts a match. previous is the finished match's game when the
     * owner starts another one, so a score can carry over; it is undefined for the first.
     */
    setup(ctx: GameContext, previous?: G): G;
    moves: Moves;
    /** Checked after every accepted move. A result ends the match. */
    endIf?(G: G, ctx: GameContext): GameResult | undefined;
    /** What one player may see, such as their own hand. playerId is undefined for a spectator. */
    playerView?(G: G, ctx: GameContext, playerId: string | undefined): object;
    /** Seconds a player has for their turn. Defaults to 60. */
    turnSeconds?: number;
    /**
     * Runs when the current player's time runs out, with ctx.playerId the player who ran out
     * of time; endIf then runs as after a move, for example to make them lose. Change G in
     * place or return a new one. Without it, or when it chooses no one with
     * ctx.setCurrentPlayer, the turn passes to the next seat.
     */
    timeout?(G: G, ctx: MoveContext): G | void;
    /** Reserved for bots and automated testing; the service does not call it yet. */
    legalMoves?(G: G, ctx: GameContext, playerId: string): {
        move: keyof Moves & string;
        args?: object;
    }[];
}
/** Checks the shape of the rules and returns them unchanged, with their types inferred. */
export declare function defineGame<G extends object, Moves extends Record<string, MoveDefinition<G>>>(definition: GameDefinition<G, Moves>): GameDefinition<G, Moves>;
/** What realtime rules see each tick: the players, and the service's randomness and clock. */
export interface RealtimeGameContext {
    /** Seated players in join order, connected or not. */
    readonly players: readonly string[];
    /** Seated players with an open connection. */
    readonly connected: readonly string[];
    /** The room owner; empty in a drop-in room. */
    readonly ownerId: string;
    random(): number;
    shuffle<T>(items: readonly T[]): T[];
    now(): number;
}
/** One player's action, as tick reads it. */
export interface PlayerAction<Action> {
    playerId: string;
    action: Action;
}
/**
 * Realtime rules: the service calls tick at a fixed rate with each player's latest input,
 * whether or not anyone is pressing anything. A player who stops sending drops out of
 * inputs after five ticks, so keep anything that should persist, such as a snake's
 * heading, in G. Something that happens once, such as firing or jumping, is an action:
 * tick reads each action exactly once.
 */
export interface RealtimeGameDefinition<G extends object, Input extends object, Action extends object = never> {
    /** Seats the rules support. A round starts once at least min players are connected. */
    players: {
        min: number;
        max: number;
    };
    /** Milliseconds between ticks, 20 to 1000. Defaults to 50. */
    tickMs?: number;
    /**
     * The game when a round starts: the owner starts or restarts the match, or a drop-in
     * room starts or restarts a round. previous is the finished round's game when there is
     * one, so a score can carry over.
     */
    setup(ctx: RealtimeGameContext, previous?: G): G;
    /**
     * Reads one input as the player sent it, such as { dir: "up" }, and returns it in the
     * shape tick reads. Throw an Error to reject it; its message reaches the player.
     */
    input(value: Record<string, unknown>, playerId: string): Input;
    /**
     * Reads one action as the player sent it with sendAction, such as { fire: true }, and
     * returns it in the shape tick reads. Throw an Error to refuse it; its message reaches
     * the player. Without it the game takes no actions.
     */
    action?(value: Record<string, unknown>, playerId: string): Action;
    /**
     * Advances the game by dt seconds. Change G in place or return a new one. actions holds
     * every action since the last tick, in the order they arrived; the next tick will not
     * see them again.
     */
    tick(G: G, ctx: RealtimeGameContext, inputs: Readonly<Record<string, Input>>, dt: number, actions: readonly PlayerAction<Action>[]): G | void;
    /** A player takes a seat while a round is running, as in a drop-in room. */
    join?(G: G, ctx: RealtimeGameContext, playerId: string): G | void;
    /** A player gives up their seat while a round is running: they left a drop-in room or were removed. */
    leave?(G: G, ctx: RealtimeGameContext, playerId: string): G | void;
    /** Checked after every tick. A result ends the round; a drop-in room then starts another. */
    endIf?(G: G, ctx: RealtimeGameContext): GameResult | undefined;
    /** What one player may see. playerId is undefined for a spectator. */
    playerView?(G: G, ctx: RealtimeGameContext, playerId: string | undefined): object;
}
/** Checks the shape of realtime rules and returns them unchanged, with their types inferred. */
export declare function defineRealtimeGame<G extends object, Input extends object, Action extends object = never>(definition: RealtimeGameDefinition<G, Input, Action>): RealtimeGameDefinition<G, Input, Action>;
/** Whether rules are realtime rules from defineRealtimeGame. */
export declare function isRealtimeGameDefinition(value: unknown): value is RealtimeGameDefinition<object, object, object>;
/** The input client.sendInput takes for a game: what its rules' input function returns. */
export type ClientInput<Game> = Game extends {
    input(value: never, playerId: never): infer Input extends object;
} ? Input : Record<string, unknown>;
/** The action client.sendAction takes for a game: what its rules' action function returns. */
export type ClientAction<Game> = Game extends {
    action?(value: never, playerId: never): infer Action extends object;
} ? Action : Record<string, unknown>;
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
import type { ClientAction, ClientInput, ClientMoves } from "./define-game.js";
import type { OhMyGame } from "./index.js";
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
    /** Whether this connection has already reported a snapshot it could not read. */
    private reportedUnreadable;
    private generation;
    private busy;
    private disposed;
    private inputId;
    private latestInput?;
    /** The room's tick, from the service; input goes out no faster. */
    private tickMs;
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
     * Sends what the player is doing now in a realtime game, in the shape the rules read,
     * such as { x, y } for a direction. Safe to call every frame: the latest input goes out
     * at most once per service tick, and keeps going out while the game keeps calling, so
     * a held key stays fresh. Sending faster would only be discarded, and a flood closes the
     * connection. Throws invalid_option for an input that is not plain JSON of at most
     * REALTIME_INPUT_MAX_LENGTH characters, or that uses the reserved key inputId.
     */
    sendInput(input: ClientInput<Game>): void;
    /**
     * Sends something the player does once in a realtime game, such as { fire: true }, in
     * the shape the rules' action function reads. The rules read it in exactly one tick, so
     * send it once per press, not every frame. Returns false when no room is connected, in
     * which case nothing is sent: an action is about this moment, so it is never queued.
     * Throws invalid_option for an action that is not plain JSON of at most
     * REALTIME_INPUT_MAX_LENGTH characters. The service reports a refused action through onError.
     */
    sendAction(action: ClientAction<Game>): boolean;
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
export type MultiplayerOptions = Omit<MultiplayerClientOptions, "manifest" | "identity" | "allowLocalhost">;
/**
 * A client for one player's room connection, from the game that init returned. Game is the
 * type of the rules from defineGame, which types client.moves. Throws not_configured when
 * the game has no multiplayer deployment.
 */
export declare function createMultiplayerClient<Game = unknown>(game: OhMyGame, callbacks?: MultiplayerClientCallbacks, options?: MultiplayerOptions): MultiplayerClient<Game>;

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
    /** The rules the service registered for this deployment, by name. */
    adapterId: string;
}
/** Explicit reference runtime; authored Web Games render their own adapter. */
export interface PublishedMultiplayerManifest {
    version: 1;
    runtime: "multiplayer-example";
    multiplayer: MultiplayerManifestConfig;
}
export declare function isPublishedMultiplayerManifest(value: unknown): value is PublishedMultiplayerManifest;
/** The tick of realtime rules that choose none. The service reports each room's own tick when a player joins. */
export declare const DEFAULT_TICK_MS = 50;
/** The fastest and slowest tick realtime rules may choose, in milliseconds. */
export declare const TICK_MS_RANGE: {
    readonly min: 20;
    readonly max: 1000;
};
/** The largest realtime input, in characters of its JSON. */
export declare const REALTIME_INPUT_MAX_LENGTH = 512;
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
    readonly required: readonly ["enabled", "mode", "gameId", "deploymentId", "protocolVersion", "serverUrl", "authPolicy", "roomPolicy", "maxClients", "reconnectSeconds", "adapterId"];
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
    /**
     * start, restart, close and kick manage the room; action carries a move of the game's
     * rules. restart is the owner starting another match once one has finished.
     */
    type: "start" | "restart" | "close" | "kick" | "action";
    payload?: {
        playerId?: string;
        [key: string]: unknown;
    };
}
/**
 * What a player sends each tick in a realtime game, such as { x, y } for a direction or
 * { x, y, jump: true }. The rules decide its shape: plain JSON, at most
 * REALTIME_INPUT_MAX_LENGTH characters, without the key inputId, which the SDK adds.
 */
export type RealtimeInput = Record<string, unknown>;
/**
 * Something a player does once in a realtime game, such as { fire: true }: the rules read
 * each action in exactly one tick. Plain JSON of at most REALTIME_INPUT_MAX_LENGTH characters.
 */
export type RealtimeAction = Record<string, unknown>;
/** The most actions one player may have waiting for the next tick; more are refused. */
export declare const REALTIME_ACTIONS_PER_TICK = 8;
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
    turnDeadline: number;
    players: MultiplayerPlayer[];
    /** Serializable data owned and validated by the deployment's rules adapter. */
    game?: Record<string, unknown>;
}
/**
 * Adapters run only on the service; clients submit intent, never final state.
 *
 * @experimental The low-level form of server rules, for the operator's own service. Turn-based
 * rules should use defineGame; this interface may change before realtime rules have one.
 */
export interface MultiplayerGameAdapter<State, Command> {
    /** The game mode these rules play; a deployment must declare the same mode. */
    mode: MultiplayerMode;
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
    /**
     * Realtime only: advances the world by one tick of dt seconds. inputs holds each seat's
     * latest input that is still fresh; a player who stops sending drops out of it.
     */
    step?(state: State, inputs: ReadonlyMap<string, {
        input: RealtimeInput;
        at: number;
    }>, now: number, dt: number, actions: readonly {
        playerId: string;
        action: RealtimeAction;
    }[]): State;
    /** Realtime only: the tick in milliseconds, 20 to 1000. Defaults to 50. */
    tickMs?: number;
    /**
     * A leaderboard, named with MATCH_BOARD_PREFIX, on which a service that keeps game data
     * records every finished match: each winner's count goes up by one. Only rules the
     * service runs itself may set it, since their results cannot be forged.
     */
    matchBoard?: string;
    /** Realtime only: throws when an input does not have the shape the rules read. Without it any input passes. */
    validateInput?(input: RealtimeInput, playerId: string): void;
    /**
     * Realtime only: throws when an action does not have the shape the rules read. Without
     * it the rules take no actions, and the room refuses them. Each accepted action reaches
     * step once, in the order the room received it.
     */
    validateAction?(action: RealtimeAction, playerId: string): void;
    /**
     * The state one player may see, such as their own hand but not others'. playerId is
     * undefined for a connection that holds no seat. Without it every player sees the whole state.
     */
    viewFor?(state: State, playerId: string | undefined): State;
    /** Places a new seat, including one joining a drop-in round in progress. Without it the room lines seats up. */
    onPlayerJoin?(state: State, playerId: string, now: number): State;
    /**
     * Sets up a round when it starts: the owner starts or restarts the match, or a drop-in
     * room starts or restarts a round. finished is the state of the round that just ended,
     * when there is one, so rules can carry a score over.
     */
    onRoundStart?(state: State, now: number, finished?: State): State;
    /** A seat was given up, after the room removed it from players: a drop-in player left, or a lobby seat emptied. */
    onPlayerLeave?(state: State, playerId: string, now: number): State;
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
/** An input as the game passes it to sendInput, before the SDK numbers it. */
export declare function isRealtimeInput(value: unknown): value is RealtimeInput;
/** An input message as it travels to the service: the game's input with the SDK's increasing inputId. */
/** An action as the game passes it to sendAction and as it travels to the service. */
export declare function isRealtimeAction(value: unknown): value is RealtimeAction;
export declare function isRealtimeInputMessage(value: unknown): value is RealtimeInput & {
    inputId: number;
};
export declare function isMultiplayerEvent(value: unknown): value is MultiplayerEvent;
export declare function isTurnCommandResult(value: unknown): value is TurnCommandResult;
export declare function isMultiplayerSnapshot(value: unknown): value is MultiplayerSnapshot;
export declare function normalizeDisplayName(value: unknown): string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
