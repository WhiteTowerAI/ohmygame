// Messages between the daemon and an extension host process, and the API a
// plugin's native entry sees. Everything crossing the boundary is plain,
// serializable data: no daemon objects, no Node handles.

import type { GameRecordingSaved } from "./game-recording.js";
import type {
  GameUseCapabilities,
  GameUseSnapshot,
  PlaytestAction,
  PlaytestCapture,
  PlaytestSnapshot,
  PlaytestViewport,
} from "./playtest.js";

/** 2: hosts ask the daemon for `context.game`. */
export const EXTENSION_HOST_PROTOCOL_VERSION = 2;

/** Results larger than this, serialized, fail instead of being sent. */
export const HOST_RESULT_MAX_BYTES = 8 * 1024 * 1024;
/** Longer progress and error messages are cut to this many characters. */
export const HOST_MESSAGE_MAX_CHARS = 2_000;
/** A call sends at most one progress message per this many milliseconds. */
export const HOST_PROGRESS_INTERVAL_MS = 100;

/** A plugin as the host needs it: its id, version, package folder and native entry. */
export interface ExtensionHostPlugin {
  id: string;
  version: string;
  root: string;
  entry: string;
  /** The plugin's own data folder, shared by its versions and projects. */
  dataFolder: string;
  /** Tools the manifest declares; the entry can register only these. */
  tools: string[];
  /** Native command handlers the manifest names, likewise. */
  commands: string[];
  /** Project types the manifest contributes, whose hooks the entry may register. */
  projectTypes: string[];
  /** Whether the manifest asks for `game`; only then has a project's context `game`. */
  game: boolean;
}

export type HostCallKind = "tool" | "command" | "projectType";

/** What a project type's native hooks do. */
export const PROJECT_TYPE_HOOKS = ["createProject", "buildWeb", "gameUse"] as const;
export type ProjectTypeHook = (typeof PROJECT_TYPE_HOOKS)[number];

/** What `buildWeb` returns: the built game, relative to the project folder. */
export interface WebBuild {
  /** The folder the host serves, such as `.ohmygame/build/web`. */
  folder: string;
  /** The page in it to open; `index.html` when omitted. */
  entry?: string;
}

/**
 * What a type's `gameUse` hook receives: one `game_use` request for the
 * game the plugin runs. `session` is the plugin's own id for a session its
 * `open` returned. A capture writes a PNG or JPEG image to `output`, a file
 * the app chose in a folder it made for this call, and returns its size.
 */
export type GameUseHookInput =
  /** Left out, the game runs at its own size; report it in the result when known. */
  | { operation: "open"; viewport?: { width: number; height: number } }
  | { operation: "inspect" | "close"; session: string }
  | { operation: "act"; session: string; actions: unknown[] }
  | { operation: "capture"; session: string; output: string }
  | { operation: "captureFrame"; session: string; output: string; frame: number };

/** What a `gameUse` hook returns, by operation. */
export interface GameUseHookResults {
  /** `session` is the plugin's id for the session; the app gives the agent its own. */
  open: { session: string; viewport?: { width: number; height: number }; gameState?: unknown };
  inspect: { viewport?: { width: number; height: number }; gameState?: unknown };
  act: { viewport?: { width: number; height: number }; gameState?: unknown };
  /** `frame` is the frame captured, which may be later than asked when the game wasn't ready. */
  capture: { frame?: number; notes?: string };
  captureFrame: { frame?: number; notes?: string };
  close: unknown;
}

/**
 * What `context.game` asks the daemon, for the game of the project the host
 * serves. `session` is one its `open` returned.
 */
export type PluginGameRequest =
  | { operation: "open"; viewport?: PlaytestViewport }
  | { operation: "inspect" | "capture" | "recordStart" | "recordStop" | "close"; session: string }
  | { operation: "act"; session: string; actions: PlaytestAction[] }
  | { operation: "captureFrame"; session: string; frame: number };

export type HostRequest =
  | { type: "activate"; id: number; plugin: ExtensionHostPlugin }
  | {
      type: "invoke";
      id: number;
      plugin: string;
      kind: HostCallKind;
      name: string;
      input: unknown;
      turn?: string;
      configuration?: PluginConfigurationValues;
      build?: PluginBuild;
    }
  | { type: "cancel"; id: number }
  | { type: "deactivate"; id: number; plugin: string }
  | { type: "stats"; id: number }
  /** Deactivate everything, then exit. */
  | { type: "shutdown"; id: number }
  /** The answer to the host's `game` message with this `id`. */
  | { type: "game-reply"; id: number; value?: unknown; error?: string };

export interface HostStats {
  rss: number;
  heapUsed: number;
  plugins: string[];
}

export type HostMessage =
  | { type: "ready"; protocol: number }
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; message: string; cancelled?: boolean }
  /** `url` is an https link the person may open, such as a device sign-in page. */
  | { type: "progress"; id: number; message: string; url?: string }
  | {
      type: "activated";
      id: number;
      tools: string[];
      commands: string[];
      ms: number;
    }
  | { type: "stats"; id: number; stats: HostStats }
  /**
   * A plugin's `context.game` asking the daemon; `id` is the host's own,
   * which the daemon's `game-reply` answers.
   */
  | { type: "game"; id: number; plugin: string; request: PluginGameRequest }
  /** The plugin gave up on its `game` request with this `id`. */
  | { type: "game-cancel"; id: number };

// What a plugin's native entry exports:
//
//   export function activate(context: PluginContext): void | Promise<void>
//   export function deactivate(): void | Promise<void>   // optional

/** The person's values for a plugin's `configuration` fields; secrets only with `capabilities.secrets`. */
export type PluginConfigurationValues = Record<string, string | boolean>;

export interface ToolCall {
  /** Aborted when the caller cancels or the call times out. */
  signal: AbortSignal;
  /**
   * Says how the call is going. With `url`, an https link the person needs,
   * such as a sign-in page, the app offers to open it once they see its
   * host; those updates are never dropped.
   */
  progress(message: string, options?: { url?: string }): void;
  /** The agent turn the call belongs to, when it comes from one. */
  turn?: string;
  /** The plugin's configuration as it is for this call, defaults filled in. */
  configuration: Readonly<PluginConfigurationValues>;
  /** For a command whose `run.build` is `"web"`: the game's web build, removed once the call ends. */
  build?: PluginBuild;
}

/** A web build the app made for a command: the files a static host serves, `index.html` at the top. */
export interface PluginBuild {
  folder: string;
}

export type ToolHandler = (
  input: unknown,
  call: ToolCall,
) => unknown | Promise<unknown>;

export interface Disposable {
  dispose(): void;
}

export interface PluginContext {
  pluginId: string;
  version: string;
  /** The project this host serves; undefined in the app host. */
  project?: { folder: string };
  /**
   * A folder only this plugin uses, for downloads, caches and state it keeps
   * between projects. Every version shares it; it is deleted when the last
   * version is uninstalled.
   */
  dataFolder: string;
  /** Registers a tool the plugin declared in its manifest. */
  registerTool(name: string, handler: ToolHandler): Disposable;
  /** Registers the handler a manifest command names in `run.native`. */
  registerCommand(name: string, handler: ToolHandler): Disposable;
  /**
   * Registers a contributed project type's hooks: `createProject` makes a
   * new project when the type has no template (input `{ name }`),
   * `buildWeb` builds a `"web-build"` type's game and returns a `WebBuild`,
   * and `gameUse` runs a `"native"` type's game for `game_use`
   * (`GameUseHookInput`), as the type's `gameUse` declares.
   */
  registerProjectType(
    id: string,
    hooks: Partial<Record<ProjectTypeHook, ToolHandler>>,
  ): Disposable;
  /** Run when the plugin is deactivated or its host stops. */
  onDispose(dispose: () => void | Promise<void>): void;
  /**
   * The project's game, as the agent's `game_use` plays it, when the
   * manifest asks for the `game` capability; undefined in the app host.
   */
  game?: PluginGame;
}

export interface PluginGameCallOptions {
  /** Aborting gives up on the request; an `open` given up on is closed. */
  signal?: AbortSignal;
}

/**
 * The project's game for a plugin: the web game in a window of its own, or a
 * native type's game through its plugin. Sessions a plugin opens are its
 * own, end when it is deactivated or its host stops, and count towards the
 * same limits as the agent's. A plugin can't play the game it runs itself.
 */
export interface PluginGame {
  open(options?: PluginGameCallOptions & { viewport?: PlaytestViewport }): Promise<PluginGameSession>;
}

/** One game session; its requests run one at a time. */
export interface PluginGameSession {
  readonly id: string;
  /** What the game's runtime can do, as `game_use` describes it. */
  readonly capabilities: GameUseCapabilities;
  /** The state `open` returned. */
  readonly snapshot: GameUseSnapshot | PlaytestSnapshot;
  inspect(options?: PluginGameCallOptions): Promise<GameUseSnapshot | PlaytestSnapshot>;
  act(actions: PlaytestAction[], options?: PluginGameCallOptions): Promise<GameUseSnapshot | PlaytestSnapshot>;
  capture(options?: PluginGameCallOptions): Promise<PlaytestCapture>;
  captureFrame(frame: number, options?: PluginGameCallOptions): Promise<PlaytestCapture>;
  /** Records at most 60 seconds into the Library, named for the plugin. */
  recordStart(options?: PluginGameCallOptions): Promise<{ maxSeconds: number }>;
  recordStop(options?: PluginGameCallOptions): Promise<GameRecordingSaved>;
  close(options?: PluginGameCallOptions): Promise<void>;
}

/** Whether a progress update's link is one the app may offer to open: https, of a bounded length. */
export function isProgressLink(value: unknown): value is string {
  return typeof value === "string" && value.length <= HOST_MESSAGE_MAX_CHARS && URL.canParse(value) && new URL(value).protocol === "https:";
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Checks every field, since a host is a separate process. */
export function isHostMessage(value: unknown): value is HostMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "ready") return typeof message.protocol === "number";
  if (typeof message.id !== "number") return false;
  switch (message.type) {
    case "result":
      return true;
    case "error":
      return (
        typeof message.message === "string" &&
        (message.cancelled === undefined ||
          typeof message.cancelled === "boolean")
      );
    case "progress":
      // Checked here too: native code can send its own messages to the daemon.
      return typeof message.message === "string" && (message.url === undefined || isProgressLink(message.url));
    case "activated":
      return (
        isStrings(message.tools) &&
        isStrings(message.commands) &&
        typeof message.ms === "number"
      );
    case "game": {
      const request = message.request as Record<string, unknown> | null;
      return typeof message.plugin === "string" && typeof request === "object" && request !== null && typeof request.operation === "string";
    }
    case "game-cancel":
      return true;
    case "stats": {
      const stats = message.stats as Record<string, unknown> | null;
      return (
        typeof stats === "object" &&
        stats !== null &&
        typeof stats.rss === "number" &&
        typeof stats.heapUsed === "number" &&
        isStrings(stats.plugins)
      );
    }
    default:
      return false;
  }
}
