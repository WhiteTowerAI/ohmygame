import { Check } from "typebox/value";

export type MultiplayerMode = "turn-based" | "realtime";
export type MultiplayerAuthPolicy =
  "anonymous" | "guest-or-account" | "account-required";
export type MultiplayerRoomPolicy =
  "invite-or-public" | "public" | "invite-only";

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
  ],
  properties: {
    enabled: { const: true },
    mode: { enum: ["turn-based", "realtime"] },
    gameId: identifier,
    deploymentId: identifier,
    protocolVersion: { const: 1 },
    serverUrl: { type: "string", pattern: "^https://[^/?#@\\s]+/?$" },
    authPolicy: { enum: ["anonymous", "guest-or-account", "account-required"] },
    roomPolicy: { enum: ["invite-or-public", "public", "invite-only"] },
    maxClients: { type: "integer", minimum: 2, maximum: 32 },
    reconnectSeconds: { type: "integer", minimum: 0, maximum: 3600 },
    adapterId: identifier,
  },
} as const;

export function isMultiplayerManifestConfig(
  value: unknown,
  options: { allowLocalhost?: boolean } = {},
): value is MultiplayerManifestConfig {
  const schema = options.allowLocalhost ? {
    ...MULTIPLAYER_MANIFEST_SCHEMA,
    properties: { ...MULTIPLAYER_MANIFEST_SCHEMA.properties, serverUrl: { type: "string" } },
  } : MULTIPLAYER_MANIFEST_SCHEMA;
  if (!Check(schema, value)) return false;
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
  type: "start" | "take" | "pass" | "close" | "kick" | "action";
  payload?: { count?: number; playerId?: string; [key: string]: unknown };
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
  remaining: number;
  turnDeadline: number;
  players: MultiplayerPlayer[];
  /** Serializable data owned and validated by the deployment's rules adapter. */
  game?: Record<string, unknown>;
}
/** Adapters run only on the service; clients submit intent, never final state. */
export interface MultiplayerGameAdapter<State, Command> {
  initialState(): State;
  validateCommand(state: State, playerId: string, command: Command): void;
  applyCommand(state: State, playerId: string, command: Command): State;
  onDisconnect?(state: State, playerId: string): void;
  onTurnTimeout?(state: State, now: number): State;
  step?(state: State, inputs: ReadonlyMap<string, { input: RealtimeInput; at: number }>, now: number): State;
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
  if (!["start", "take", "pass", "close", "kick", "action"].includes(String(value.type)))
    return false;
  if (value.type === "action") return isRecord(value.payload);
  if (value.type === "take")
    return (
      isRecord(value.payload) &&
      Object.keys(value.payload).length === 1 &&
      Number.isInteger(value.payload.count) &&
      Number(value.payload.count) >= 1 &&
      Number(value.payload.count) <= 3
    );
  if (value.type === "kick")
    return (
      isRecord(value.payload) &&
      Object.keys(value.payload).length === 1 &&
      typeof value.payload.playerId === "string" &&
      value.payload.playerId.length <= 100
    );
  return value.payload === undefined;
}
export function isRealtimeInput(value: unknown): value is RealtimeInput {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isSequence(value.inputId) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    Math.abs(value.x) <= 1 &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    Math.abs(value.y) <= 1
  );
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
    isSequence(state.remaining) &&
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
