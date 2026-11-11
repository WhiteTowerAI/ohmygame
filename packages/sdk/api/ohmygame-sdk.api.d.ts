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
/**
 * The game and the multiplayer service share no protocol version: the message says
 * which side to update.
 */
 | "protocol_unsupported"
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
    private issuing?;
    constructor(options: GuestIdentityOptions);
    getToken(): Promise<string>;
    private issue;
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
    /**
     * Signs the player out of this game in this browser, in every tab, and they play as a
     * guest again. An embedding OhMyGame page no longer hands the game its player until the
     * player signs in again. It does not sign them out of OhMyGame.
     */
    signOut(): Promise<void>;
    /**
     * Calls listener with the player whenever they change: signed in, signed out, signed in
     * or out in another tab, renamed, or signed out because their session ended. Returns a
     * function that stops it.
     */
    onAuthChange(listener: (player: OhMyGamePlayer | undefined) => void): () => void;
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
    /**
     * A random number in [0, 1). Use it instead of Math.random: in a lockstep room every
     * player's browser runs the rules and must draw the same numbers.
     */
    random(): number;
    shuffle<T>(items: readonly T[]): T[];
    /** The tick's time in milliseconds. Use it instead of Date.now, for the same reason. */
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

// host.d.ts
/**
 * Rules a player's browser runs for the room: the game's own rules from defineGame or
 * defineRealtimeGame, which the game service never runs. The service keeps the room —
 * seats, phase, sequence, reconnection and the saved state — and asks the hosting player
 * to apply the rules; it accepts only the game's part of the answer. docs/multiplayer.md
 * describes the exchange.
 */
import { type MultiplayerGameState, type RealtimeAction, type RealtimeInput, type TurnCommand } from "./multiplayer-protocol.js";
import { type GameAdapter } from "./rules.js";
/** The adapterId of deployments whose rules run on a player's browser. */
export declare const HOST_ADAPTER_ID = "host";
/** The largest message a hosting player may send, in bytes of its JSON. */
export declare const HOST_MESSAGE_MAX_BYTES: number;
/** How long the service waits for the hosting player before another player hosts. */
export declare const HOST_REPLY_MS = 5000;
/** What the service asks the hosting player to apply to state. */
export type HostRequest = {
    requestId: string;
    /** The room's state, unfiltered. */
    state: MultiplayerGameState;
    now: number;
} & ({
    kind: "command";
    playerId: string;
    command: TurnCommand;
} | {
    kind: "join" | "leave";
    playerId: string;
}
/** A round starts; finished is the round before, when there is one. */
 | {
    kind: "round";
    finished?: MultiplayerGameState;
} | {
    kind: "timeout";
});
/** Views per seat for rules with playerView, keyed by player ID; "" is a spectator's. */
export type HostViews = Record<string, Record<string, unknown>>;
export interface HostReply {
    requestId: string;
    state?: MultiplayerGameState;
    views?: HostViews;
    /** Why the rules refused a command. */
    error?: string;
}
/** Whether rules from defineGame or defineRealtimeGame show players different things. */
export declare function hasPlayerView(rules: unknown): boolean;
/** What each seat, and a spectator, may see of state. */
export declare function hostViews(adapter: GameAdapter, state: MultiplayerGameState): HostViews;
/** Applies one request with the rules, as the service would if it ran them. */
export declare function runHostRequest(adapter: GameAdapter, request: HostRequest, playerView: boolean): HostReply;
/**
 * The room state after a hosting player's answer. The service keeps what it owns: seats and
 * their connections, the owner, and any phase it set itself while the player worked, such as
 * closing the room. From the player it takes the game, positions, whose turn it is, the
 * deadline and winners among the seats. base is the state the request carried; a realtime
 * tick has none, and changes the phase only while a round is playing.
 */
export declare function mergeHostState(host: MultiplayerGameState, room: MultiplayerGameState, base?: MultiplayerGameState): MultiplayerGameState;
/**
 * Calls tick every ms. In a browser the timer runs in a worker: browsers slow a hidden
 * page's own timers to about once a second, which would slow the whole room while the
 * hosting player looks at another tab or window. Falls back to the page's timer.
 */
export declare function startTicker(ms: number, tick: () => void): () => void;
/**
 * The realtime loop a hosting player's browser runs: every tick it steps the rules with the
 * players' latest inputs and the actions since the last tick, and sends the new state. The
 * hosting player's own input goes straight to the loop, and show lets their game draw each
 * tick at once instead of after a trip through the service.
 */
export declare class HostLoop {
    private readonly adapter;
    private readonly tickMs;
    private readonly playerView;
    private readonly send;
    private readonly show?;
    private state?;
    private readonly inputs;
    private actions;
    private stopTicker?;
    /** When the next tick is due. */
    private due;
    constructor(adapter: GameAdapter, tickMs: number, playerView: boolean, send: (state: MultiplayerGameState, views?: HostViews) => void, show?: (state: MultiplayerGameState) => void);
    /** The phase of the loop's state, which runs ahead of the service's while a round plays. */
    get phase(): MultiplayerGameState["phase"] | undefined;
    start(state: MultiplayerGameState): void;
    /** The room changed without this player's rules, for example a seat was taken. */
    sync(state: MultiplayerGameState): void;
    input(playerId: string, input: RealtimeInput): void;
    action(playerId: string, action: RealtimeAction): void;
    stop(): void;
    private tick;
}

// multiplayer-client.d.ts
import { type OwnerSharedChange, type MultiplayerEvent, type MultiplayerManifestConfig, type MultiplayerSnapshot, type PublicMultiplayerRoom, type TurnCommand, type TurnCommandResult } from "./multiplayer-protocol.js";
import { OhMyGameError } from "./errors.js";
import { type IdentityProvider } from "./identity.js";
import type { ClientAction, ClientInput, ClientMoves } from "./define-game.js";
import type { OhMyGame } from "./index.js";
import { type PeerOptions, type PeerStatus } from "./peers.js";
export { Smoother, type SmoothingMode, type SmoothingOptions } from "./smoothing.js";
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
    /** The service's latest snapshot, which a hosting player's own ticks build on. */
    private fromService?;
    private lastEventSequence;
    /** Whether a whole snapshot is on its way, so a tick's changes that do not fit wait for it. */
    private awaitingSnapshot;
    /** Whether this connection has already reported a snapshot it could not read. */
    private reportedUnreadable;
    private generation;
    private busy;
    private disposed;
    private inputId;
    private latestInput?;
    /** The room's tick, from the service; input goes out no faster. */
    private roomTickMs;
    /** Where the service's tick falls, so input and owner states reach it just before it. */
    private readonly tickClock;
    private readonly inputPacer;
    private pingTimer?;
    /** The input the page last sent, so a change can go out before the next tick's send. */
    private sentInput?;
    /** Early sends left: a few a second, so an input that changes every frame cannot double the messages. */
    private earlySends;
    private earlySendsAt;
    /** Owner rooms: messages this page has emitted, which number their IDs. */
    private messageCount;
    private displayName?;
    private mergeTimer?;
    private aloneSince?;
    private merging;
    private connectionStatus;
    /** The compiled rules, for a deployment whose rules run on a player's browser. */
    private readonly hostRules?;
    private hostLoop?;
    private hostingRoom;
    /** Runs the rules in step with every other player, for a lockstep deployment. */
    private readonly lockstep?;
    /** This player's part of the round, for an owner deployment. */
    private readonly owner?;
    /** Owner rooms with p2p: connections straight to other players' pages. */
    private readonly mesh?;
    /** Messages already passed to onMessage, by sender and ID, so a copy from the other path is dropped. */
    private readonly delivered;
    /** This player's own moves shown before the service's tick reads them, when the page passes the rules the service runs. */
    private readonly prediction?;
    constructor(options: MultiplayerClientOptions, callbacks?: MultiplayerClientCallbacks);
    /**
     * The room's tick in milliseconds, as the service reports it when the player joins: how
     * often a realtime room's snapshots, and an owner room's player states, arrive at most.
     * Pass it to a Smoother as intervalMs.
     */
    get tickMs(): number;
    /**
     * Owner rooms with p2p: each other player this page has tried to reach directly, by
     * playerId: "connecting", "open" (states and messages go straight there too), or
     * "failed" (only through the service; tried again later). Empty without p2p.
     */
    get peers(): Record<string, PeerStatus>;
    get status(): MultiplayerConnectionStatus;
    get roomId(): string | undefined;
    get playerId(): string | undefined;
    get roomCode(): string | undefined;
    /**
     * The room as onSnapshot last reported it. In a lockstep round this runs ahead of the
     * service, so the player's own input shows at once, and other players' parts of it are a
     * guess that the next frame may correct.
     */
    get snapshot(): MultiplayerSnapshot | undefined;
    /**
     * The room at the newest frame the service sent, with no guess: in a lockstep round it
     * trails snapshot by about a round trip and is never corrected, so drawing other players
     * from it shows them a little late but without jumps. With predicted moves it is the
     * service's newest snapshot. Otherwise it is snapshot.
     */
    get confirmed(): MultiplayerSnapshot | undefined;
    /** Whether this player's browser runs the game's rules for the room now. */
    get hosting(): boolean;
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
     * about once per service tick, timed to reach the service just before its tick, and
     * keeps going out while the game keeps calling, so a held key stays fresh. A changed
     * input, such as a key just pressed, goes out at once, a few times a second at most.
     * Sending faster would only be discarded, and a flood closes the connection. Throws
     * invalid_option for an input that is not plain JSON of at most
     * REALTIME_INPUT_MAX_LENGTH characters, or that uses the reserved key inputId.
     */
    sendInput(input: ClientInput<Game>): void;
    /** Whether an early send is allowed now; refills EARLY_SENDS_PER_SECOND, up to EARLY_SENDS_BURST. */
    private earlySend;
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
    setState(state: Record<string, unknown>): void;
    /**
     * Owner rooms: changes snapshot.state.game.shared, the data every player shares, such as
     * food or a door. All the changes apply or none: each may require its key to hold expect
     * or to be absent (expectAbsent), so when two players take the same thing, only the first
     * gets it. Resolves true when the service applied them, false otherwise.
     */
    updateShared(changes: OwnerSharedChange[]): Promise<boolean>;
    /** Owner rooms: sends every other player a one-off message, which reaches them through onMessage. */
    emit(message: Record<string, unknown>): boolean;
    /** Owner rooms: ends the round with these winners; the first page to say so decides. */
    finishRound(winners: string[]): void;
    /** Passes a message on once, whichever path brought it first. */
    private deliverMessage;
    /** Connects straight to the room's connected players, and drops those who left. */
    private updatePeers;
    /** Shows an owner round: the room's seats and phase, with every player's state and the shared data. */
    private showOwner;
    sendAction(action: ClientAction<Game>): boolean;
    private flushInput;
    /**
     * Predicts this player from the rules the service runs: realtime rules from
     * defineRealtimeGame, or a compiled realtime adapter. Rules with playerView are not
     * predicted, since the page does not see the whole state they step.
     */
    private predictionFor;
    /** Shows this player's predicted moves on the room's latest seats and phase. */
    private showPredicted;
    /** What the lockstep runner does with the round: show it, and report to the service. */
    private lockstepHooks;
    /** Shows a lockstep round's state on the room's latest seats and phase. */
    private showLockstep;
    /**
     * The loop this player runs for the room while they host a round: their own input and
     * actions go straight to it, as the service would only pass them back. Between rounds
     * they go to the service, which explains why it refuses them.
     */
    private localLoop;
    /**
     * Shows a tick of this player's own loop at once, as the service will once the tick has
     * made the trip: the room's part from the service, the game's from the rules, in this
     * player's view.
     */
    private showHosted;
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
    /**
     * Rooms whose service tick reads what the page sends once a tick, a realtime room the
     * service runs and an owner room, time those sends to it: the page measures its round trip.
     * A host's loop and lockstep frames keep their own time.
     */
    private pacesToServiceTick;
    private startPinging;
    publicRooms(): Promise<PublicMultiplayerRoom[]>;
    leave(): Promise<void>;
    /** Leaves without reporting a closed connection, for moving to another room. */
    private leaveRoom;
    dispose(): void;
    private connect;
    /** Takes or gives up running the rules for the room, when the service asks. */
    private setHosting;
    private stopHosting;
    private bindHost;
    private bind;
    private receiveSnapshot;
    /**
     * A realtime tick as the changes since the snapshot before. Applied to the snapshot this
     * page holds when that is the one they follow; otherwise the page asks for a whole one,
     * once, and drops changes until it arrives.
     */
    private receiveDelta;
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
export declare function createMultiplayerClient<Game = unknown>(game: OhMyGame, callbacks?: MultiplayerClientCallbacks, options?: MultiplayerOptions & {
    rules?: Game;
}): MultiplayerClient<Game>;

// multiplayer-protocol.d.ts
export type MultiplayerMode = "turn-based" | "realtime";
export type MultiplayerAuthPolicy = "anonymous" | "guest-or-account" | "account-required";
/**
 * invite-or-public: an owner creates the room; it is listed while waiting, and anyone
 * with its ID or invite code joins until the match starts. invite-only: never listed,
 * and joining takes the invite code. drop-in is realtime only: players join a room with
 * a free seat, or a new one, without creating or starting it, and can join a round in
 * progress. It has no room owner. "public" is an older name for invite-or-public, still
 * read in saved deployments; registering it makes an invite-or-public deployment.
 */
export type MultiplayerRoomPolicy = "invite-or-public" | "public" | "invite-only" | "drop-in";
export interface MultiplayerManifestConfig {
    enabled: true;
    mode: MultiplayerMode;
    gameId: string;
    deploymentId: string;
    /**
     * The version of this deployment format. Rooms negotiate their protocol separately,
     * from MULTIPLAYER_PROTOCOL_VERSION.
     */
    protocolVersion: 1;
    serverUrl: string;
    authPolicy: MultiplayerAuthPolicy;
    roomPolicy: MultiplayerRoomPolicy;
    maxClients: number;
    reconnectSeconds: number;
    /** The rules the service registered for this deployment, by name. */
    adapterId: string;
    /**
     * Lockstep and owner deployments only: the tick in milliseconds at which the service
     * sends frames, since it never loads the game's rules.
     */
    tickMs?: number;
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
/**
 * The newest room protocol this SDK speaks, sent as protocolVersion when it joins. Games
 * keep the client.js they were built with, so the service must keep speaking every
 * version a published game may send.
 */
export declare const MULTIPLAYER_PROTOCOL_VERSION = 1;
/**
 * The room protocols this service speaks. A new version raises max and keeps min, so
 * games built with an older SDK keep connecting; min rises only once no published game
 * still sends it.
 */
export declare const MULTIPLAYER_PROTOCOL_VERSIONS: {
    readonly min: 1;
    readonly max: 1;
};
/**
 * Sent with a matchmaking error when the service speaks none of the client's versions.
 * Colyseus uses the code as the HTTP status: 426 Upgrade Required.
 */
export declare const MULTIPLAYER_PROTOCOL_UNSUPPORTED_CODE = 426;
/**
 * The version a room speaks to a client: the newest both sides speak. The client sends
 * its newest as protocolVersion and, when it can still speak older ones, its oldest as
 * minProtocolVersion; clients before negotiation send only protocolVersion. Undefined
 * when they share none. The service reports the result as protocolVersion in "ready";
 * a service before negotiation sends none, and speaks version 1.
 */
export declare function negotiateProtocolVersion(options: {
    protocolVersion?: unknown;
    minProtocolVersion?: unknown;
}, supported?: {
    min: number;
    max: number;
}): number | undefined;
/** Why a client and service share no protocol version, for the error both show. */
export declare function describeProtocolMismatch(options: {
    protocolVersion?: unknown;
}, supported?: {
    min: number;
    max: number;
}): string;
export declare const MULTIPLAYER_MIN_CLIENTS = 2;
export declare const MULTIPLAYER_MAX_CLIENTS = 32;
/**
 * The adapterId of realtime deployments whose rules every player's browser runs alike
 * (lockstep): the service numbers frames of everyone's input and passes them on, and each
 * page steps the same rules with the same random numbers. docs/multiplayer.md describes it.
 */
export declare const LOCKSTEP_ADAPTER_ID = "lockstep";
/**
 * The adapterId of realtime deployments in which each player's page runs their own part
 * of the game and the service passes it on (owner): every player's state, shared data the
 * service changes one request at a time, and messages. docs/multiplayer.md describes it.
 */
export declare const OWNER_ADAPTER_ID = "owner";
/** The longest a player's state may be in an owner room, as JSON. */
export declare const OWNER_STATE_MAX_LENGTH = 4096;
/** The longest one shared value or one message may be in an owner room, as JSON. */
export declare const OWNER_VALUE_MAX_LENGTH = 1024;
/** The most shared values an owner room keeps. */
export declare const OWNER_SHARED_MAX_KEYS = 256;
/** The most changes one shared request may make. */
export declare const OWNER_SHARED_MAX_CHANGES = 8;
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
        readonly tickMs: {
            readonly type: "integer";
            readonly minimum: 20;
            readonly maximum: 1000;
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
    /** The newest room protocol the client speaks. See negotiateProtocolVersion. */
    protocolVersion: number;
    /** The oldest room protocol the client still speaks; protocolVersion when absent. */
    minProtocolVersion?: number;
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
    /** The player whose browser runs the rules, in a deployment whose rules run there (adapterId "host"). */
    hostPlayerId?: string;
    /** Serializable data owned and validated by the deployment's rules adapter. */
    game?: Record<string, unknown>;
    /**
     * Lockstep rounds: where the rules' random numbers are, so every page draws the same
     * ones. Each draw moves it on.
     */
    seed?: number;
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
    /**
     * The room asks a player's browser to run the rules, as for adapterId "host": the
     * adapter keeps only the room's own commands. Set by the service, not by rules.
     */
    hosted?: boolean;
    /**
     * The room numbers frames of input for the players' browsers, which all run the rules
     * (adapterId "lockstep"): the adapter keeps only the room's own commands. Set by the
     * service, not by rules.
     */
    lockstep?: boolean;
    /**
     * Each player's page runs their own part of the game and the room passes it on
     * (adapterId "owner"): the adapter keeps only the room's own commands. Set by the service.
     */
    owner?: boolean;
    /** The rules show each player only part of the state, through playerView. */
    playerView?: boolean;
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
    /**
     * A realtime room the service runs, on its ticks: for each seat in state.players, the
     * inputId of the newest input the tick read, or -1. A page that predicts its own player
     * replays its inputs after this one.
     */
    acks?: number[];
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
export declare function isSequence(value: unknown): value is number;
/** A seat change that every page applies at the same frame of a lockstep round. */
export type LockstepEvent = {
    type: "join";
    player: MultiplayerPlayer;
} | {
    type: "leave";
    playerId: string;
} | {
    type: "connected";
    playerId: string;
    connected: boolean;
};
/** One tick of a lockstep round: what every page applies, in order, to step the rules. */
export interface LockstepFrame {
    round: number;
    /** 1 for a round's first tick, then one more each tick. */
    frame: number;
    /** Each player's input the rules read this tick. */
    inputs: Record<string, RealtimeInput>;
    /** Actions in the order the service received them. */
    actions?: {
        playerId: string;
        action: RealtimeAction;
    }[];
    /** Seats that changed since the last frame, applied before the tick. */
    events?: LockstepEvent[];
    /** The inputId of each player's input that first counts in this frame. */
    acks?: Record<string, number>;
}
/**
 * An input for a lockstep round, for the frame the page shows it in. The service applies
 * it at that frame, or at the next one when it arrives too late, so a page that runs ahead
 * of the service can show its own input at once.
 */
export interface LockstepInput {
    inputId: number;
    frame: number;
    input: RealtimeInput;
}
/**
 * Another player's input, passed on as soon as it reaches the service, before the frame it
 * counts in: frame is where the service will count it. Pages guess ahead with it.
 */
export interface LockstepEarlyInput {
    round: number;
    playerId: string;
    inputId: number;
    frame: number;
    input: RealtimeInput;
}
export declare function isLockstepEarlyInput(value: unknown): value is LockstepEarlyInput;
export declare function isLockstepInput(value: unknown): value is LockstepInput;
/**
 * What a page needs to run a lockstep round from where it is now: sent to everyone when a
 * round starts and to a player who arrives or reconnects during one.
 */
export interface LockstepSync {
    round: number;
    tickMs: number;
    /** The round as it began: the room's state with the seed, the clock, and the last round's game. */
    start: {
        state: MultiplayerGameState;
        startedAt: number;
        previous?: Record<string, unknown>;
    };
    /** A later state of the round that a page reported, to run on from instead of the start. */
    checkpoint?: {
        frame: number;
        state: MultiplayerGameState;
    };
    /** Every frame after the checkpoint, or after the start. */
    frames: LockstepFrame[];
}
/** A page's state of a lockstep round after a frame: a checkpoint, or the end of the round. */
export interface LockstepReport {
    round: number;
    frame: number;
    state: MultiplayerGameState;
}
export declare function isLockstepFrame(value: unknown): value is LockstepFrame;
export declare function isLockstepSync(value: unknown): value is LockstepSync;
export declare function isLockstepReport(value: unknown): value is LockstepReport;
/** Changes to one player's state in an owner room: top-level keys set and keys removed. */
export interface OwnerPatch {
    set?: Record<string, unknown>;
    delete?: string[];
    /**
     * The state's version on its page, which counts each setState. Pages that get a
     * player's state straight from that player's page keep whichever version is newer.
     */
    seq?: number;
}
/** One tick of an owner room: every player's state changes since the last, and who left. */
export interface OwnerFrame {
    round: number;
    players?: Record<string, OwnerPatch>;
    left?: string[];
}
/** An owner round as it is now, for a page that starts it or arrives during it. */
export interface OwnerSync {
    round: number;
    players: Record<string, Record<string, unknown>>;
    shared: Record<string, unknown>;
    /** Each player's newest state version the service has. */
    seqs?: Record<string, number>;
}
/** A page's one-off message (owner.emit), with an ID unique on that page so a copy that also arrives straight from it is dropped. */
export interface OwnerEmit {
    id: string;
    message: Record<string, unknown>;
}
/** The service passing an owner.emit on (owner.message). */
export interface OwnerMessageEvent extends OwnerEmit {
    from: string;
}
/** The most characters of JSON one p2p.signal may carry: a session description with its candidates. */
export declare const P2P_SIGNAL_MAX_LENGTH = 8192;
/**
 * Connection setup between two players' pages in an owner room, which the service passes
 * on unread (p2p.signal): the page sends { to, data } and the other gets { from, data }.
 */
export interface P2PSignal {
    to: string;
    data: Record<string, unknown>;
}
/**
 * One change to an owner room's shared data: value sets key, and no value removes it. It
 * applies only if key holds expect now (deep JSON equality), or is absent with
 * expectAbsent, so two players cannot both take the same thing.
 */
export interface OwnerSharedChange {
    key: string;
    value?: unknown;
    expect?: unknown;
    expectAbsent?: boolean;
}
/** Shared changes the service applied, all at once, and whose request they were. */
export interface OwnerSharedUpdate {
    round: number;
    by: string;
    changes: {
        key: string;
        value?: unknown;
    }[];
}
export declare function isOwnerState(value: unknown): value is Record<string, unknown>;
export declare function isOwnerPatch(value: unknown): value is OwnerPatch;
export declare function isOwnerSharedChange(value: unknown): value is OwnerSharedChange;
export declare function isOwnerMessage(value: unknown): value is Record<string, unknown>;
export declare function isOwnerEmit(value: unknown): value is OwnerEmit;
export declare function isOwnerMessageEvent(value: unknown): value is OwnerMessageEvent;
export declare function isP2PSignal(value: unknown): value is P2PSignal;
export declare function isOwnerFrame(value: unknown): value is OwnerFrame;
export declare function isOwnerSync(value: unknown): value is OwnerSync;
export declare function isOwnerSharedUpdate(value: unknown): value is OwnerSharedUpdate;
/**
 * Plain JSON equality, as JSON.stringify would see it (keys holding undefined count as
 * absent), without building either string: the service compares a shared value with what a
 * change expects, and a realtime room's whole state with the last one every tick.
 */
export declare function sameJson(left: unknown, right: unknown): boolean;
/** Where a change applies: the keys and array indexes from the room state down. */
export type StatePath = (string | number)[];
/** [path, value] sets the value there; [path] alone removes it. An empty path replaces the whole state. */
export type StateChange = [path: StatePath] | [path: StatePath, value: unknown];
/**
 * A realtime tick's snapshot as what changed since the one before (`base`), which every
 * connection that shares the room's view has. The page applies it to the snapshot it holds
 * whose sequence is `base`, and asks for a whole one (`snapshot.request`) when it holds another.
 */
export interface SnapshotDelta {
    roomId: string;
    sequence: number;
    base: number;
    serverTime: string;
    changes: StateChange[];
    /** As MultiplayerSnapshot.acks, for this tick. */
    acks?: number[];
}
export declare function isSnapshotDelta(value: unknown): value is SnapshotDelta;
/**
 * The changes that turn one JSON state into another, as JSON sees them. Records are compared
 * key by key and same-length arrays index by index, such as a room's seats. An array whose
 * length changed is sent whole, and so is one whose item changes would be longer than it,
 * such as a snake's body moving one cell.
 */
export declare function stateChanges(before: unknown, after: unknown): StateChange[];
/**
 * The state with the changes applied. Only the objects along a changed path are copied; the
 * rest is shared with `state`, which is left as it was.
 */
export declare function applyStateChanges<T>(state: T, changes: readonly StateChange[]): T;

// peers.d.ts
export type PeerStatus = "connecting" | "open" | "failed";
/** Public STUN servers, which tell a page its public address; both answer from mainland China. */
export declare const DEFAULT_ICE_SERVERS: RTCIceServer[];
/** Rooms with more players connect none: every page would hold a connection to each other one. */
export declare const P2P_MAX_PLAYERS = 8;
/** How long a connection may take to open before it is given up. */
export declare const P2P_CONNECT_TIMEOUT_MS = 15000;
/** How long after giving up the offering page tries again. */
export declare const P2P_RETRY_MS = 60000;
export interface PeerOptions {
    iceServers?: RTCIceServer[];
}
export interface PeerHooks {
    /** Sends connection setup to another player through the service. */
    signal(to: string, data: Record<string, unknown>): void;
    playerId(): string | undefined;
    /** A state packet straight from a player. */
    state(from: string, packet: unknown): void;
    /** A message packet straight from a player. */
    message(from: string, packet: unknown): void;
}
export declare class PeerMesh {
    private readonly hooks;
    private readonly peers;
    /** Players whose connection was given up, and when the offering page may try again. */
    private readonly failed;
    private wanted;
    private readonly factory?;
    private readonly iceServers;
    constructor(hooks: PeerHooks, options?: PeerOptions);
    /** Whether this browser can connect directly at all. */
    get available(): boolean;
    /** Each other player this page has tried to reach directly, and how that went. */
    status(): Record<string, PeerStatus>;
    /** Whether a state or message would reach anyone directly now. */
    get open(): boolean;
    /** The players in the room now: connects to new ones, drops those gone. */
    update(players: readonly string[]): void;
    /** Connection setup another player sent through the service. */
    receive(from: string, data: unknown): Promise<void>;
    /** Sends a state packet to every player reached directly. */
    sendState(packet: unknown): void;
    /** Sends a message packet to every player reached directly. */
    sendMessage(packet: unknown): void;
    close(): void;
    private send;
    private offer;
    private create;
    private deliver;
    private addIncoming;
    /** Gives up a connection; the offering page tries again after P2P_RETRY_MS. */
    private fail;
    private drop;
}

// rules.d.ts
/**
 * Runs rules from defineGame and defineRealtimeGame: the room's own commands, and the
 * compiler that turns rules into the adapter a room calls. The game service uses it, and so
 * does the browser of a player who hosts a game whose rules run there. Free of Node APIs.
 */
import { type GameDefinition, type MoveDefinition, type RealtimeGameDefinition } from "./define-game.js";
import { type MultiplayerGameAdapter, type MultiplayerGameState, type MultiplayerMode, type TurnCommand } from "./multiplayer-protocol.js";
/** Rules as a room calls them. */
export type GameAdapter = MultiplayerGameAdapter<MultiplayerGameState, TurnCommand>;
export declare const TURN_SECONDS = 60;
/** A realtime adapter's tick in milliseconds: its own, or the default. */
export declare function tickMsOf(adapter: {
    tickMs?: number;
}): number;
/** Throws unless the tick is a whole number of milliseconds the service can run. */
export declare function checkTickMs(tickMs: number): void;
export declare function nextTurn(state: MultiplayerGameState, now?: any): void;
/** Ends the match with these winners: one, several for a team, or none for a draw. */
export declare function finishMatch(state: MultiplayerGameState, winners: readonly string[]): void;
/**
 * The room's own commands: the owner starts, restarts once a match has finished, closes and
 * removes players. The room sets up each round through onRoundStart. Rules build on it
 * and handle their game's commands themselves; any other command is rejected. A match left
 * with fewer than players.min seats after a removal ends without a winner.
 */
export declare function createRoomAdapter(mode: MultiplayerMode, players?: {
    min: number;
    max: number;
}): MultiplayerGameAdapter<MultiplayerGameState, TurnCommand>;
/**
 * Turns rules from defineGame or defineRealtimeGame into the adapter rooms run. The room
 * keeps its own lobby, start, restart, close and kick commands; for turn-based rules every other
 * command is a move named by payload.action, and realtime rules read each player's input.
 */
export declare function compileGame<G extends object, Moves extends Record<string, MoveDefinition<G>>>(definition: GameDefinition<G, Moves>): GameAdapter;
export declare function compileGame<G extends object, Input extends object, Action extends object>(definition: RealtimeGameDefinition<G, Input, Action>): GameAdapter;
export declare function compileGame(definition: GameDefinition<object, Record<string, MoveDefinition<object>>> | RealtimeGameDefinition<object, object, object>): GameAdapter;

// smoothing.d.ts
/**
 * Drawing other players between the updates a room sends. Positions arrive a few times a
 * second (once a tick, or once a tick for an owner room's player states); drawing each one
 * as it arrives makes others jump. A Smoother keeps the recent updates of each thing, keyed
 * by any string such as a playerId, and gives the value to draw at the current time.
 *
 * - "interpolate" (the default) draws `delayMs` in the past, between the two updates around
 *   that time, so motion follows exactly the path the updates describe. It runs dry when an
 *   update is late, and then carries on along the last movement for at most `maxExtrapolateMs`.
 * - "extrapolate" draws ahead of the newest update along its movement, at most
 *   `maxExtrapolateMs`, easing toward that point. Shows others sooner, but overshoots a
 *   player who stops or turns, and eases back.
 * - "damped" eases toward the newest update. Never overshoots; trails moving things by
 *   about `smoothMs`.
 *
 * Only numeric fields are smoothed; give the fields to smooth in each update, such as
 * { x, y }. Smoothing runs on the page only and costs the service nothing.
 */
export type SmoothingMode = "interpolate" | "extrapolate" | "damped";
export interface SmoothingOptions {
    /** How to draw between updates. Default "interpolate". */
    mode?: SmoothingMode;
    /**
     * The time between updates in milliseconds, such as the room's tick: client.tickMs.
     * The defaults below derive from it. Default 50.
     */
    intervalMs?: number;
    /** "interpolate": how far in the past to draw. Default intervalMs: one update behind. */
    delayMs?: number;
    /** "extrapolate" and "damped": the easing time constant in milliseconds. Default 50. */
    smoothMs?: number;
    /** The furthest to carry movement past the newest update. Default intervalMs. */
    maxExtrapolateMs?: number;
    /**
     * A jump larger than this, in the fields' own units, is a teleport, such as a respawn: it
     * is drawn at once instead of glided across. Default Infinity (never).
     */
    snapDistance?: number;
    /** Fields that are angles in radians, eased the short way round. */
    angles?: readonly string[];
}
type Values = Record<string, number>;
export declare class Smoother {
    private readonly tracks;
    private readonly mode;
    private readonly delayMs;
    private readonly smoothMs;
    private readonly maxExtrapolateMs;
    private readonly snapDistance;
    private readonly angles;
    constructor(options?: SmoothingOptions);
    /**
     * Records an update for `key`, such as { x, y } from a snapshot, received at `at`
     * (performance.now() by default). An update equal to the last one is still recorded, so a
     * player who stopped is drawn stopped.
     */
    push(key: string, values: Readonly<Values>, at?: number): void;
    /** The values to draw for `key` at `time` (performance.now() by default), or undefined before its first update. */
    get(key: string, time?: number): Values | undefined;
    /** Forgets `key`, such as a player who left. */
    delete(key: string): void;
    /** Forgets every key not in `keys`, such as the players no longer in the snapshot. */
    retain(keys: Iterable<string>): void;
    private interpolate;
    /** The newest update moved along its last movement to `time`, at most maxExtrapolateMs past it. */
    private ahead;
    private ease;
}
export {};
