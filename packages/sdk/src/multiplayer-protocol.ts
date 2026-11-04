
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
  // A round in progress has no seat to give a turn-based latecomer.
  if ((value as MultiplayerManifestConfig).roomPolicy === "drop-in" && (value as MultiplayerManifestConfig).mode !== "realtime") return false;
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
    !isRecord(value.state)
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
