import type { ProjectType } from "./contracts.js";
import type { GameRecordingSaved } from "./game-recording.js";

export interface PlaytestViewport {
  width: number;
  height: number;
}

/** `plugin`: a game a plugin's native code runs, for a project type that declares `gameUse`. */
export type GameRuntime = "web" | "godot" | "unity" | "plugin";
export type GameProjectType = ProjectType;
export type GameUseInputCapability = "pointer" | "keyboard" | "text" | "touch" | "resize";
export type GameUseObservationCapability = "screenshot" | "video" | "dom" | "canvas" | "console" | "network";
export type GameUseDeterminismCapability = "snapshot" | "reset" | "seed" | "step";
/**
 * What `game_use` can ask a runtime to do. `capture` is the current frame of the
 * running session; `captureFrame` runs the game again from the start and
 * captures frame N, so it shows that run, not what the session shows now.
 */
export const GAME_USE_OPERATIONS = ["open", "inspect", "act", "capture", "captureFrame", "recordStart", "recordStop", "close"] as const;
export type GameUseOperation = (typeof GAME_USE_OPERATIONS)[number];
/** Operations a plugin's project type may declare; `open` and `close` it always has. */
export const PLUGIN_GAME_USE_OPERATIONS = ["inspect", "act", "capture", "captureFrame"] as const;
export type PluginGameUseOperation = (typeof PLUGIN_GAME_USE_OPERATIONS)[number];
/** Input a plugin's runtime may take. Text needs page elements, which a plugin's snapshot doesn't have. */
export const PLUGIN_GAME_USE_INPUT = ["pointer", "keyboard", "touch", "resize"] as const;
export type PluginGameUseInput = (typeof PLUGIN_GAME_USE_INPUT)[number];
/** A plugin project type's `gameUse`, as its manifest declares it. */
export interface PluginGameUseSpec {
  operations: readonly PluginGameUseOperation[];
  input?: readonly PluginGameUseInput[];
  maxFrame?: number;
}
/** The highest frame `captureFrame` may ask for. */
export const MAX_CAPTURE_FRAME = 100_000;

export interface GameUseCapabilities {
  runtime: GameRuntime;
  projectTypes: readonly GameProjectType[];
  input: readonly GameUseInputCapability[];
  observation: readonly GameUseObservationCapability[];
  deterministic: readonly GameUseDeterminismCapability[];
  watch: boolean;
  /**
   * The operations the runtime supports. Left out, it supports every
   * operation but `captureFrame`, as the web runtime does; `recordStart` and
   * `recordStop` also need `video`, and `capture` needs `screenshot`.
   */
  operations?: readonly GameUseOperation[];
}

/** Whether a runtime supports an operation, by its declared operations and observation. */
export function supportsGameUseOperation(capabilities: GameUseCapabilities, operation: GameUseOperation): boolean {
  if (capabilities.operations && !capabilities.operations.includes(operation)) return false;
  if (!capabilities.operations && operation === "captureFrame") return false;
  if (operation === "capture" || operation === "captureFrame") return capabilities.observation.includes("screenshot");
  if (operation === "recordStart" || operation === "recordStop") return capabilities.observation.includes("video");
  return true;
}

export const WEB_GAME_USE_CAPABILITIES: GameUseCapabilities = {
  runtime: "web",
  projectTypes: ["web-game", "interactive-story", "general"],
  input: ["pointer", "keyboard", "text", "touch", "resize"],
  observation: ["screenshot", "video", "dom", "canvas", "console", "network"],
  deterministic: [],
  watch: true,
};

export type GameUseOpenTarget =
  | { runtime: "web"; url: string }
  | { runtime: "godot" | "unity"; projectPath: string }
  /** `provider` is the project type, `publisher/name:type`, whose plugin runs the game. */
  | { runtime: "plugin"; provider: string; projectPath: string };

export type PlaytestTarget =
  | { selector: string }
  | { testId: string }
  | { text: string }
  | { role: string; name?: string }
  | { x: number; y: number };

export type PlaytestAction =
  | { type: "click"; target: PlaytestTarget }
  | { type: "type"; target: Exclude<PlaytestTarget, { x: number; y: number }>; text: string }
  | { type: "press"; key: string; duration?: number }
  | { type: "touch"; x: number; y: number }
  | { type: "wait"; milliseconds: number }
  | { type: "resize"; viewport: PlaytestViewport }
  | { type: "bridge"; method: "reset" }
  | { type: "bridge"; method: "setSeed" | "step"; value: number };

export interface PlaytestElement {
  index: number;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  disabled: boolean;
  box: { x: number; y: number; width: number; height: number };
}

export interface PlaytestCanvas {
  index: number;
  width: number;
  height: number;
  box: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface PlaytestLog {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  source?: string;
  line?: number;
  timestamp: string;
}

export interface PlaytestFailedRequest {
  url: string;
  error: string;
  timestamp: string;
}

export interface GameUseSnapshot {
  sessionId: string;
  runtime: GameRuntime;
  capabilities: GameUseCapabilities;
  /** Left out when a plugin's runtime was opened at its own size and hasn't said it. */
  viewport?: PlaytestViewport;
  gameState?: unknown;
  bridgeCapabilities?: string[];
}

export interface PlaytestSnapshot extends GameUseSnapshot {
  url: string;
  title: string;
  readyState: string;
  elements: PlaytestElement[];
  canvases: PlaytestCanvas[];
  /** Visible text of the page and its frames, truncated. */
  text?: string;
  logs: PlaytestLog[];
  failedRequests: PlaytestFailedRequest[];
}

export interface PlaytestCapture {
  sessionId: string;
  mediaType: "image/jpeg";
  data: string;
  width: number;
  height: number;
  /**
   * `fresh-run` when the game was run again from the start for this capture
   * (`captureFrame`), at `frame`. A fresh run is not promised to repeat
   * exactly. Left out, it is the session's current frame.
   */
  source?: "fresh-run";
  frame?: number;
  /** The size the runtime captured, when the image was scaled down from it. */
  sourceWidth?: number;
  sourceHeight?: number;
  /** What the runtime said about the capture, such as that the game was still loading. */
  notes?: string;
  analysis: {
    sampledPixels: number;
    opaqueRatio: number;
    luminanceMean: number;
    luminanceVariance: number;
    likelyBlank: boolean;
  };
}

export interface PlaytestWatchState {
  visible: boolean;
  activeSessions: number;
}

export type PlaytestRequest =
  /** Left out, a plugin's runtime uses the game's own size; the web runtime always gets one. */
  | { operation: "open"; target: GameUseOpenTarget; viewport?: PlaytestViewport }
  | { operation: "inspect"; sessionId: string }
  | { operation: "act"; sessionId: string; actions: PlaytestAction[] }
  | { operation: "capture"; sessionId: string }
  | { operation: "captureFrame"; sessionId: string; frame: number }
  | { operation: "recordStart"; sessionId: string }
  | { operation: "recordStop"; sessionId: string }
  | { operation: "close"; sessionId: string }
  | { operation: "closeAll" };

export type PlaytestResult =
  | { operation: "open"; snapshot: GameUseSnapshot }
  | { operation: "inspect"; snapshot: GameUseSnapshot }
  | { operation: "act"; snapshot: GameUseSnapshot }
  | { operation: "capture"; capture: PlaytestCapture }
  | { operation: "captureFrame"; capture: PlaytestCapture }
  | { operation: "recordStart"; sessionId: string; maxSeconds: number }
  | { operation: "recordStop"; sessionId: string; recording: GameRecordingSaved }
  | { operation: "close" | "closeAll" };

export interface GameRuntimeAdapter {
  readonly available: boolean;
  readonly capabilities: GameUseCapabilities;
  request(request: PlaytestRequest, signal?: AbortSignal): Promise<PlaytestResult>;
  close(): void;
}

export type PlaytestIpcMessage =
  | { channel: "ohmygame:playtest-request"; id: string; request: PlaytestRequest }
  | { channel: "ohmygame:playtest-cancel"; id: string }
  | { channel: "ohmygame:playtest-response"; id: string; result?: PlaytestResult; error?: string };
