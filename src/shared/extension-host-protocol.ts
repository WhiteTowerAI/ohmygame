// Messages between the daemon and an extension host process, and the API a
// plugin's native entry sees. Everything crossing the boundary is plain,
// serializable data: no daemon objects, no Node handles.

export const EXTENSION_HOST_PROTOCOL_VERSION = 1;

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
  /** Tools the manifest declares; the entry can register only these. */
  tools: string[];
  /** Native command handlers the manifest names, likewise. */
  commands: string[];
  /** Project types the manifest contributes, whose hooks the entry may register. */
  projectTypes: string[];
}

export type HostCallKind = "tool" | "command" | "projectType";

/** What a project type's native hooks do. */
export const PROJECT_TYPE_HOOKS = ["createProject", "buildWeb"] as const;
export type ProjectTypeHook = (typeof PROJECT_TYPE_HOOKS)[number];

/** What `buildWeb` returns: the built game, relative to the project folder. */
export interface WebBuild {
  /** The folder the host serves, such as `.ohmygame/build/web`. */
  folder: string;
  /** The page in it to open; `index.html` when omitted. */
  entry?: string;
}

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
    }
  | { type: "cancel"; id: number }
  | { type: "deactivate"; id: number; plugin: string }
  | { type: "stats"; id: number }
  /** Deactivate everything, then exit. */
  | { type: "shutdown"; id: number };

export interface HostStats {
  rss: number;
  heapUsed: number;
  plugins: string[];
}

export type HostMessage =
  | { type: "ready"; protocol: number }
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; message: string; cancelled?: boolean }
  | { type: "progress"; id: number; message: string }
  | {
      type: "activated";
      id: number;
      tools: string[];
      commands: string[];
      ms: number;
    }
  | { type: "stats"; id: number; stats: HostStats };

// What a plugin's native entry exports:
//
//   export function activate(context: PluginContext): void | Promise<void>
//   export function deactivate(): void | Promise<void>   // optional

/** The person's values for a plugin's `configuration` fields; secrets only with `capabilities.secrets`. */
export type PluginConfigurationValues = Record<string, string | boolean>;

export interface ToolCall {
  /** Aborted when the caller cancels or the call times out. */
  signal: AbortSignal;
  progress(message: string): void;
  /** The agent turn the call belongs to, when it comes from one. */
  turn?: string;
  /** The plugin's configuration as it is for this call, defaults filled in. */
  configuration: Readonly<PluginConfigurationValues>;
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
  /** Registers a tool the plugin declared in its manifest. */
  registerTool(name: string, handler: ToolHandler): Disposable;
  /** Registers the handler a manifest command names in `run.native`. */
  registerCommand(name: string, handler: ToolHandler): Disposable;
  /**
   * Registers a contributed project type's hooks: `createProject` makes a
   * new project when the type has no template (input `{ name }`), and
   * `buildWeb` builds a `"web-build"` type's game and returns a `WebBuild`.
   */
  registerProjectType(
    id: string,
    hooks: Partial<Record<ProjectTypeHook, ToolHandler>>,
  ): Disposable;
  /** Run when the plugin is deactivated or its host stops. */
  onDispose(dispose: () => void | Promise<void>): void;
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
      return typeof message.message === "string";
    case "activated":
      return (
        isStrings(message.tools) &&
        isStrings(message.commands) &&
        typeof message.ms === "number"
      );
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
