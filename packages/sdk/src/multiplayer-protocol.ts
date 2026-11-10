
export type MultiplayerMode = "turn-based" | "realtime";
export type MultiplayerAuthPolicy =
  "anonymous" | "guest-or-account" | "account-required";
/**
 * drop-in is realtime only: players join a room with a free seat, or a new one, without
 * creating or starting it, and can join a round in progress. It has no room owner.
 */
export type MultiplayerRoomPolicy =
  "invite-or-public" | "public" | "invite-only" | "drop-in";

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
export function isPublishedMultiplayerManifest(
  value: unknown,
): value is PublishedMultiplayerManifest {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.version === 1 &&
    value.runtime === "multiplayer-example" &&
    isMultiplayerManifestConfig(value.multiplayer)
  );
}

const identifier = {
  type: "string",
  pattern: "^[A-Za-z0-9_-]{1,100}$",
} as const;
/** The tick of realtime rules that choose none. The service reports each room's own tick when a player joins. */
export const DEFAULT_TICK_MS = 50;
/** The fastest and slowest tick realtime rules may choose, in milliseconds. */
export const TICK_MS_RANGE = { min: 20, max: 1000 } as const;
/** The largest realtime input, in characters of its JSON. */
export const REALTIME_INPUT_MAX_LENGTH = 512;

/**
 * Sent with a matchmaking error when the service cannot open another room; quick play
 * retries it. Colyseus uses the code as the HTTP status, so it stays in that range.
 */
export const MULTIPLAYER_ROOM_LIMIT_CODE = 503;
export const MULTIPLAYER_MIN_CLIENTS = 2;
export const MULTIPLAYER_MAX_CLIENTS = 32;

/**
 * The adapterId of realtime deployments whose rules every player's browser runs alike
 * (lockstep): the service numbers frames of everyone's input and passes them on, and each
 * page steps the same rules with the same random numbers. docs/multiplayer.md describes it.
 */
export const LOCKSTEP_ADAPTER_ID = "lockstep";
/**
 * The adapterId of realtime deployments in which each player's page runs their own part
 * of the game and the service passes it on (owner): every player's state, shared data the
 * service changes one request at a time, and messages. docs/multiplayer.md describes it.
 */
export const OWNER_ADAPTER_ID = "owner";
/** The longest a player's state may be in an owner room, as JSON. */
export const OWNER_STATE_MAX_LENGTH = 4096;
/** The longest one shared value or one message may be in an owner room, as JSON. */
export const OWNER_VALUE_MAX_LENGTH = 1024;
/** The most shared values an owner room keeps. */
export const OWNER_SHARED_MAX_KEYS = 256;
/** The most changes one shared request may make. */
export const OWNER_SHARED_MAX_CHANGES = 8;

export const MULTIPLAYER_MANIFEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "enabled",
    "mode",
    "gameId",
    "deploymentId",
    "protocolVersion",
    "serverUrl",
    "authPolicy",
    "roomPolicy",
    "maxClients",
    "reconnectSeconds",
    "adapterId",
  ],
  properties: {
    enabled: { const: true },
    mode: { enum: ["turn-based", "realtime"] },
    gameId: identifier,
    deploymentId: identifier,
    protocolVersion: { const: 1 },
    serverUrl: { type: "string", pattern: "^https://[^/?#@\\s]+/?$" },
    authPolicy: { enum: ["anonymous", "guest-or-account", "account-required"] },
    roomPolicy: { enum: ["invite-or-public", "public", "invite-only", "drop-in"] },
    maxClients: { type: "integer", minimum: MULTIPLAYER_MIN_CLIENTS, maximum: MULTIPLAYER_MAX_CLIENTS },
    reconnectSeconds: { type: "integer", minimum: 0, maximum: 3600 },
    adapterId: identifier,
    tickMs: { type: "integer", minimum: 20, maximum: 1000 },
  },
} as const;

/** The keywords the manifest schema uses; the browser SDK carries no schema library. */
interface ManifestFieldRule {
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly type?: "string" | "integer";
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

function matchesManifestSchema(
  schema: { readonly required: readonly string[]; readonly properties: Readonly<Record<string, ManifestFieldRule>> },
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  if (!schema.required.every((key) => Object.hasOwn(value, key))) return false;
  return Object.entries(value).every(([key, field]) => {
    if (!Object.hasOwn(schema.properties, key)) return false;
    const rule = schema.properties[key]!;
    if ("const" in rule) return field === rule.const;
    if (rule.enum) return rule.enum.includes(field);
    if (rule.type === "string")
      return typeof field === "string" && (!rule.pattern || new RegExp(rule.pattern).test(field));
    return Number.isInteger(field) && (field as number) >= (rule.minimum ?? -Infinity) && (field as number) <= (rule.maximum ?? Infinity);
  });
}

export function isMultiplayerManifestConfig(
  value: unknown,
  options: { allowLocalhost?: boolean } = {},
): value is MultiplayerManifestConfig {
  const schema = options.allowLocalhost ? {
    ...MULTIPLAYER_MANIFEST_SCHEMA,
    properties: { ...MULTIPLAYER_MANIFEST_SCHEMA.properties, serverUrl: { type: "string" as const } },
  } : MULTIPLAYER_MANIFEST_SCHEMA;
  if (!matchesManifestSchema(schema, value)) return false;
  const config = value as MultiplayerManifestConfig;
  // A round in progress has no seat to give a turn-based latecomer.
  if (config.roomPolicy === "drop-in" && config.mode !== "realtime") return false;
  // Only lockstep and owner deployments name their tick, and they must: the service runs no rules.
  const ticks = config.adapterId === LOCKSTEP_ADAPTER_ID || config.adapterId === OWNER_ADAPTER_ID;
  if (ticks !== (config.tickMs !== undefined)) return false;
  if (ticks && config.mode !== "realtime") return false;
  try {
    const url = new URL((value as MultiplayerManifestConfig).serverUrl);
    return (
      (url.protocol === "https:" || (options.allowLocalhost === true && url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function multiplayerRoomType(
  config: Pick<MultiplayerManifestConfig, "gameId" | "deploymentId">,
): string {
  return `ohmygame_${config.gameId.length}_${config.gameId}_${config.deploymentId}`;
}

export function sameMultiplayerConfig(
  left: MultiplayerManifestConfig,
  right: MultiplayerManifestConfig,
): boolean {
  return (
    Object.keys(
      MULTIPLAYER_MANIFEST_SCHEMA.properties,
    ) as (keyof MultiplayerManifestConfig)[]
  ).every((key) => left[key] === right[key]);
}

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
  payload?: { playerId?: string; [key: string]: unknown };
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
export const REALTIME_ACTIONS_PER_TICK = 8;
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
  players: { min: number; max: number };
  initialState(): State;
  validateCommand(state: State, playerId: string, command: Command): void;
  applyCommand(state: State, playerId: string, command: Command): State;
  onDisconnect?(state: State, playerId: string): void;
  onTurnTimeout?(state: State, now: number): State;
  /**
   * Realtime only: advances the world by one tick of dt seconds. inputs holds each seat's
   * latest input that is still fresh; a player who stops sending drops out of it.
   */
  step?(
    state: State,
    inputs: ReadonlyMap<string, { input: RealtimeInput; at: number }>,
    now: number,
    dt: number,
    actions: readonly { playerId: string; action: RealtimeAction }[],
  ): State;
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
export type MultiplayerEventType =
  | "room.ready"
  | "member.joined"
  | "member.left"
  | "state.updated"
  | "turn.changed"
  | "room.finished"
  | "room.closed"
  | "protocol.error";
export type MultiplayerErrorCode =
  | "invalid_command"
  | "not_your_turn"
  | "sequence_conflict"
  | "room_full"
  | "deployment_mismatch"
  | "protocol_mismatch"
  | "not_authorized"
  | "room_closed"
  | "rate_limited";
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
  error?: { code: MultiplayerErrorCode; message: string };
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

export function isTurnCommand(value: unknown): value is TurnCommand {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some(
      (key) =>
        !["commandId", "expectedSequence", "type", "payload"].includes(key),
    )
  )
    return false;
  if (
    typeof value.commandId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value.commandId) ||
    !isSequence(value.expectedSequence)
  )
    return false;
  if (!["start", "restart", "close", "kick", "action"].includes(String(value.type)))
    return false;
  if (value.type === "action") return isRecord(value.payload);
  if (value.type === "kick")
    return (
      isRecord(value.payload) &&
      Object.keys(value.payload).length === 1 &&
      typeof value.payload.playerId === "string" &&
      value.payload.playerId.length <= 100
    );
  return value.payload === undefined;
}
/** Plain JSON data: no functions, binary data, non-finite numbers or deep nesting. */
function isPlainJson(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 4) return false;
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((item) => isPlainJson(item, depth + 1));
}
/** An input as the game passes it to sendInput, before the SDK numbers it. */
export function isRealtimeInput(value: unknown): value is RealtimeInput {
  return (
    isRecord(value) &&
    !Object.hasOwn(value, "inputId") &&
    isPlainJson(value) &&
    JSON.stringify(value).length <= REALTIME_INPUT_MAX_LENGTH
  );
}
/** An input message as it travels to the service: the game's input with the SDK's increasing inputId. */
/** An action as the game passes it to sendAction and as it travels to the service. */
export function isRealtimeAction(value: unknown): value is RealtimeAction {
  return isRecord(value) && isPlainJson(value) && JSON.stringify(value).length <= REALTIME_INPUT_MAX_LENGTH;
}
export function isRealtimeInputMessage(value: unknown): value is RealtimeInput & { inputId: number } {
  if (!isRecord(value) || !isSequence(value.inputId)) return false;
  const { inputId: _inputId, ...input } = value;
  return isRealtimeInput(input);
}
export function isMultiplayerEvent(value: unknown): value is MultiplayerEvent {
  return (
    isRecord(value) &&
    [
      "room.ready",
      "member.joined",
      "member.left",
      "state.updated",
      "turn.changed",
      "room.finished",
      "room.closed",
      "protocol.error",
    ].includes(String(value.type)) &&
    typeof value.roomId === "string" &&
    typeof value.deploymentId === "string" &&
    isSequence(value.sequence) &&
    isServerTime(value.serverTime) &&
    "payload" in value
  );
}
export function isTurnCommandResult(
  value: unknown,
): value is TurnCommandResult {
  return (
    isRecord(value) &&
    typeof value.commandId === "string" &&
    typeof value.accepted === "boolean" &&
    isSequence(value.sequence) &&
    (value.accepted
      ? value.error === undefined
      : isRecord(value.error) &&
        [
          "invalid_command",
          "not_your_turn",
          "sequence_conflict",
          "room_full",
          "deployment_mismatch",
          "protocol_mismatch",
          "not_authorized",
          "room_closed",
          "rate_limited",
        ].includes(String(value.error.code)) &&
        typeof value.error.message === "string")
  );
}
export function isMultiplayerSnapshot(
  value: unknown,
): value is MultiplayerSnapshot {
  if (
    !isRecord(value) ||
    typeof value.roomId !== "string" ||
    typeof value.gameId !== "string" ||
    typeof value.deploymentId !== "string" ||
    !["turn-based", "realtime"].includes(String(value.mode)) ||
    !isSequence(value.sequence) ||
    !isServerTime(value.serverTime) ||
    !isRecord(value.state) ||
    (value.acks !== undefined && !isAcks(value.acks))
  )
    return false;
  const state = value.state;
  return (
    ["lobby", "playing", "finished", "closed"].includes(String(state.phase)) &&
    typeof state.ownerId === "string" &&
    typeof state.currentPlayerId === "string" &&
    typeof state.winnerPlayerId === "string" &&
    typeof state.turnDeadline === "number" &&
    Number.isFinite(state.turnDeadline) &&
    (state.game === undefined || isRecord(state.game)) &&
    Array.isArray(state.players) &&
    state.players.length <= 32 &&
    state.players.every(
      (player) =>
        isRecord(player) &&
        typeof player.playerId === "string" &&
        typeof player.displayName === "string" &&
        typeof player.connected === "boolean" &&
        typeof player.x === "number" &&
        Number.isFinite(player.x) &&
        typeof player.y === "number" &&
        Number.isFinite(player.y),
    )
  );
}
export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") return "Guest";
  return (
    value
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40) || "Guest"
  );
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isServerTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** A seat change that every page applies at the same frame of a lockstep round. */
export type LockstepEvent =
  | { type: "join"; player: MultiplayerPlayer }
  | { type: "leave"; playerId: string }
  | { type: "connected"; playerId: string; connected: boolean };
/** One tick of a lockstep round: what every page applies, in order, to step the rules. */
export interface LockstepFrame {
  round: number;
  /** 1 for a round's first tick, then one more each tick. */
  frame: number;
  /** Each player's input the rules read this tick. */
  inputs: Record<string, RealtimeInput>;
  /** Actions in the order the service received them. */
  actions?: { playerId: string; action: RealtimeAction }[];
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
export function isLockstepEarlyInput(value: unknown): value is LockstepEarlyInput {
  return isRecord(value) && isSequence(value.round) && typeof value.playerId === "string" && isSequence(value.inputId) &&
    isSequence(value.frame) && isRealtimeInput(value.input);
}
export function isLockstepInput(value: unknown): value is LockstepInput {
  return isRecord(value) && Object.keys(value).length === 3 && isSequence(value.inputId) && isSequence(value.frame) && isRealtimeInput(value.input);
}
/**
 * What a page needs to run a lockstep round from where it is now: sent to everyone when a
 * round starts and to a player who arrives or reconnects during one.
 */
export interface LockstepSync {
  round: number;
  tickMs: number;
  /** The round as it began: the room's state with the seed, the clock, and the last round's game. */
  start: { state: MultiplayerGameState; startedAt: number; previous?: Record<string, unknown> };
  /** A later state of the round that a page reported, to run on from instead of the start. */
  checkpoint?: { frame: number; state: MultiplayerGameState };
  /** Every frame after the checkpoint, or after the start. */
  frames: LockstepFrame[];
}
/** A page's state of a lockstep round after a frame: a checkpoint, or the end of the round. */
export interface LockstepReport {
  round: number;
  frame: number;
  state: MultiplayerGameState;
}
export function isLockstepFrame(value: unknown): value is LockstepFrame {
  return isRecord(value) && isSequence(value.round) && isSequence(value.frame) && isRecord(value.inputs) &&
    (value.actions === undefined || Array.isArray(value.actions)) && (value.events === undefined || Array.isArray(value.events)) &&
    (value.acks === undefined || isRecord(value.acks));
}
export function isLockstepSync(value: unknown): value is LockstepSync {
  return isRecord(value) && isSequence(value.round) && isSequence(value.tickMs) && isRecord(value.start) &&
    isRecord(value.start.state) && typeof value.start.startedAt === "number" && Array.isArray(value.frames) &&
    value.frames.every(isLockstepFrame) && (value.checkpoint === undefined || (isRecord(value.checkpoint) && isSequence(value.checkpoint.frame) && isRecord(value.checkpoint.state)));
}
export function isLockstepReport(value: unknown): value is LockstepReport {
  return isRecord(value) && isSequence(value.round) && isSequence(value.frame) && isRecord(value.state);
}

/** Changes to one player's state in an owner room: top-level keys set and keys removed. */
export interface OwnerPatch {
  set?: Record<string, unknown>;
  delete?: string[];
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
  changes: { key: string; value?: unknown }[];
}

const isValue = (value: unknown, max = OWNER_VALUE_MAX_LENGTH) => isPlainJson(value) && JSON.stringify(value).length <= max;
export function isOwnerState(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isValue(value, OWNER_STATE_MAX_LENGTH);
}
export function isOwnerPatch(value: unknown): value is OwnerPatch {
  return isRecord(value) && Object.keys(value).every((key) => key === "set" || key === "delete") &&
    (value.set === undefined || isOwnerState(value.set)) &&
    (value.delete === undefined || (Array.isArray(value.delete) && value.delete.length <= 64 && value.delete.every((key) => typeof key === "string")));
}
export function isOwnerSharedChange(value: unknown): value is OwnerSharedChange {
  return isRecord(value) && typeof value.key === "string" && value.key.length >= 1 && value.key.length <= 100 &&
    Object.keys(value).every((key) => ["key", "value", "expect", "expectAbsent"].includes(key)) &&
    (value.value === undefined || isValue(value.value)) && (value.expect === undefined || isValue(value.expect)) &&
    (value.expectAbsent === undefined || value.expectAbsent === true);
}
export function isOwnerMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isValue(value);
}
export function isOwnerFrame(value: unknown): value is OwnerFrame {
  return isRecord(value) && isSequence(value.round) && (value.players === undefined || isRecord(value.players)) &&
    (value.left === undefined || Array.isArray(value.left));
}
export function isOwnerSync(value: unknown): value is OwnerSync {
  return isRecord(value) && isSequence(value.round) && isRecord(value.players) && isRecord(value.shared);
}
export function isOwnerSharedUpdate(value: unknown): value is OwnerSharedUpdate {
  return isRecord(value) && isSequence(value.round) && typeof value.by === "string" && Array.isArray(value.changes);
}
/**
 * Plain JSON equality, as JSON.stringify would see it (keys holding undefined count as
 * absent), without building either string: the service compares a shared value with what a
 * change expects, and a realtime room's whole state with the last one every tick.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (!sameJson(left[index], right[index])) return false;
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  let keys = 0;
  for (const key in left) {
    if (left[key] === undefined) continue;
    keys++;
    if (!Object.hasOwn(right, key) || !sameJson(left[key], right[key])) return false;
  }
  for (const key in right) if (right[key] !== undefined) keys--;
  return keys === 0;
}

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

function isAcks(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((ack) => Number.isInteger(ack) && ack >= -1);
}

export function isSnapshotDelta(value: unknown): value is SnapshotDelta {
  return (
    isRecord(value) &&
    typeof value.roomId === "string" &&
    isSequence(value.sequence) &&
    isSequence(value.base) &&
    isServerTime(value.serverTime) &&
    (value.acks === undefined || isAcks(value.acks)) &&
    Array.isArray(value.changes) &&
    value.changes.every(
      (change) =>
        Array.isArray(change) &&
        (change.length === 1 || change.length === 2) &&
        Array.isArray(change[0]) &&
        change[0].every((key: unknown) => typeof key === "string" || (typeof key === "number" && Number.isInteger(key) && key >= 0)),
    )
  );
}

/**
 * The changes that turn one JSON state into another, as JSON sees them. Records are compared
 * key by key and same-length arrays index by index, such as a room's seats. An array whose
 * length changed is sent whole, and so is one whose item changes would be longer than it,
 * such as a snake's body moving one cell.
 */
export function stateChanges(before: unknown, after: unknown): StateChange[] {
  const changes: StateChange[] = [];
  collectChanges(before, after, [], changes);
  return changes;
}

/** `path` is a stack the walk pushes keys onto and pops; a change copies it. */
function collectChanges(before: unknown, after: unknown, path: StatePath, changes: StateChange[]): void {
  if (before === after) return;
  if (isRecord(before) && isRecord(after)) {
    for (const key in after) {
      const value = after[key];
      if (value === undefined) continue;
      path.push(key);
      if (before[key] === undefined || !Object.hasOwn(before, key)) changes.push([[...path], value]);
      else collectChanges(before[key], value, path, changes);
      path.pop();
    }
    for (const key in before)
      if (before[key] !== undefined && (after[key] === undefined || !Object.hasOwn(after, key))) changes.push([[...path, key]]);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    const items: StateChange[] = [];
    for (let index = 0; index < after.length; index++) {
      path.push(index);
      collectChanges(before[index], after[index], path, items);
      path.pop();
    }
    // Whichever is smaller: the items' changes, or the array whole.
    if (items.length > 1 && JSON.stringify(after).length < JSON.stringify(items).length) changes.push([[...path], after]);
    else for (const item of items) changes.push(item);
    return;
  }
  if (!sameJson(before, after)) changes.push([[...path], after]);
}

/**
 * The state with the changes applied. Only the objects along a changed path are copied; the
 * rest is shared with `state`, which is left as it was.
 */
export function applyStateChanges<T>(state: T, changes: readonly StateChange[]): T {
  const copied = new WeakSet<object>();
  let root: unknown = state;
  for (const change of changes) {
    const [path] = change;
    if (path.length === 0) {
      root = change.length === 2 ? change[1] : undefined;
      continue;
    }
    root = changeAt(root, path, 0, change, copied);
  }
  return root as T;
}

function changeAt(node: unknown, path: StatePath, depth: number, change: StateChange, copied: WeakSet<object>): unknown {
  const key = path[depth]!;
  const container: Record<string | number, unknown> | unknown[] =
    Array.isArray(node) ? (copied.has(node) ? node : [...node])
    : isRecord(node) ? (copied.has(node) ? node : { ...node })
    : typeof key === "number" ? [] : {};
  copied.add(container);
  const last = depth === path.length - 1;
  const value = last ? change[1] : changeAt((container as Record<string, unknown>)[key], path, depth + 1, change, copied);
  if (last && change.length === 1) {
    if (Array.isArray(container) && typeof key === "number") container.splice(key, 1);
    else delete (container as Record<string, unknown>)[key];
  } else if (key === "__proto__") Object.defineProperty(container, key, { value, writable: true, enumerable: true, configurable: true });
  else (container as Record<string | number, unknown>)[key] = value;
  return container;
}
