import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_HOST_PROTOCOL_VERSION,
  isHostMessage,
  type ExtensionHostPlugin,
  type HostMessage,
  type HostRequest,
  type HostStats,
  type PluginConfigurationValues,
} from "../shared/extension-host-protocol.js";
import {
  registerProjectProcess,
  terminateProjectProcess,
} from "./process-lifecycle.js";
import { projectProcessEnvironment } from "./project-process.js";

// Plugin native code runs here: in extension host processes the daemon
// starts on first need, one for app-level plugins and one per project, never
// in the daemon itself. A host that crashes or hangs takes only its own calls
// with it; the next call starts a fresh one. A plugin that keeps crashing its
// host is quarantined until it is released.
//
// Native code has the person's full trust, so these limits keep mistakes
// (a hang, a leak, a huge result) from spreading; they don't contain a
// plugin that means harm.

export type ExtensionHostFailure =
  | "cancelled"
  | "timeout"
  | "crashed"
  | "quarantined"
  | "failed"
  /** The plugin isn't on where it was called, or doesn't declare what was called. */
  | "unavailable";

export class ExtensionHostError extends Error {
  constructor(
    readonly code: ExtensionHostFailure,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionHostError";
  }
}

export interface ExtensionHostOptions {
  /** Stops a host with no calls in flight after this long. */
  idleMs?: number;
  callTimeoutMs?: number;
  activationTimeoutMs?: number;
  /**
   * How long a cancelled call may take to settle, or a stopping host to
   * clean up, before its process is stopped.
   */
  cancelGraceMs?: number;
  /** Crashes or hangs within `crashWindowMs` that quarantine a plugin. */
  crashLimit?: number;
  crashWindowMs?: number;
  /** A host's JavaScript heap limit; running out crashes the host, which counts as a crash. */
  maxHeapMb?: number;
  /** The host process entry; tests may point at their own. */
  hostEntry?: string;
}

export type InvokeOptions = {
  /** "app", or the key of the project the call is for. */
  scope: string;
  /** The folder a project scope serves; plugins see it as `context.project`. */
  project?: string;
  plugin: ExtensionHostPlugin;
  input?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (message: string, url?: string) => void;
  /** The agent turn the call belongs to. */
  turn?: string;
  /** The plugin's configuration values, sent with the call so a change applies to the next one. */
  configuration?: PluginConfigurationValues;
  /**
   * Runs once the plugin is active, right before the call is sent; throwing
   * refuses the call. Lets the caller check that the plugin is still allowed
   * after waiting for its activation.
   */
  check?: () => void | Promise<void>;
} & (
  | { tool: string; command?: never; projectType?: never }
  | { command: string; tool?: never; projectType?: never }
  /** A project type hook, `<type>:<hook>`. */
  | { projectType: string; tool?: never; command?: never }
);

export interface ActivePlugin {
  version: string;
  tools: string[];
  commands: string[];
  activationMs: number;
}

/** A plugin a scope's host has loaded or is loading. */
export interface ScopePlugin {
  version: string;
  /** The package folder the version comes from. */
  root: string;
  loaded: boolean;
}

export interface ExtensionHostStatus {
  scope: string;
  pid: number | undefined;
  startMs: number | undefined;
  pending: number;
  plugins: Record<string, ActivePlugin>;
  stats?: HostStats;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** The reply each request expects, besides `error`. */
const REPLIES: Record<HostRequest["type"], HostMessage["type"] | undefined> = {
  activate: "activated",
  invoke: "result",
  deactivate: "result",
  stats: "stats",
  cancel: undefined,
  shutdown: undefined,
};

interface Pending {
  type: HostRequest["type"];
  plugin?: string;
  /** Diagnostics requests don't count as use, so they don't keep a host alive. */
  activity: boolean;
  settle(message: HostMessage | ExtensionHostError): void;
  /** Gives up on the call: cancels it, and stops the host if it doesn't settle. */
  giveUp(error: ExtensionHostError): void;
  onProgress?: (message: string, url?: string) => void;
}

interface Activation {
  version: string;
  root: string;
  done: Promise<void>;
}

const DEFAULTS = {
  idleMs: 5 * 60_000,
  callTimeoutMs: 60_000,
  activationTimeoutMs: 15_000,
  cancelGraceMs: 2_000,
  crashLimit: 3,
  crashWindowMs: 5 * 60_000,
  maxHeapMb: 1024,
} satisfies Omit<Required<ExtensionHostOptions>, "hostEntry">;

/** The built host is a sibling `.js`; from source (tsx, Bun, tests) it is the `.ts`. */
function defaultHostEntry(): string {
  const built = fileURLToPath(
    new URL("./extension-host-process.js", import.meta.url),
  );
  return existsSync(built) ? built : built.replace(/\.js$/, ".ts");
}

/** Loader flags such as `--import tsx` carry over; watch, inspector and heap flags don't. */
function hostExecArgv(maxHeapMb: number): string[] {
  return [
    ...process.execArgv.filter(
      (arg) => !/^--(watch|inspect|debug|max-old-space-size)/.test(arg),
    ),
    `--max-old-space-size=${maxHeapMb}`,
  ];
}

const unavailable = (message: string) =>
  new ExtensionHostError("unavailable", message);

class ExtensionHost {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, Pending>();
  /** Per plugin, the version calls should use: activated or activating. */
  readonly #activations = new Map<string, Activation>();
  /** Per plugin, what the host process has loaded. */
  readonly #loaded = new Map<string, ActivePlugin & { root: string }>();
  /** Per plugin, its activations and deactivations, one at a time. */
  readonly #queues = new Map<string, Promise<unknown>>();
  /** Calls in flight per plugin, so a new version waits for the old one's. */
  readonly #inflight = new Map<string, Set<Promise<unknown>>>();
  readonly #ready: Promise<void>;
  #settleReady: ((error?: ExtensionHostError) => void) | undefined;
  readonly #started = performance.now();
  #startMs: number | undefined;
  #nextId = 1;
  #exited = false;
  /** Stopped on purpose: idle, disposed, or its scope closed. */
  #stopping = false;
  /** Killed because a call never settled; that counts against its plugin. */
  #killing = false;
  /** The plugin whose call got its host killed, when one did. */
  #culprit: string | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  /** Last lines of stdout and stderr, for diagnostics. */
  readonly log: string[] = [];

  constructor(
    readonly scope: string,
    readonly project: string | undefined,
    entry: string,
    private readonly options: typeof DEFAULTS,
    private readonly onExit: (host: ExtensionHost, plugins: string[]) => void,
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#settleReady = (error) => {
        clearTimeout(timer);
        this.#settleReady = undefined;
        if (error) {
          reject(error);
          void this.stop().catch(() => {});
        } else {
          this.#startMs = performance.now() - this.#started;
          resolve();
        }
      };
    });
    this.#ready.catch(() => {});
    // The project folder is passed as an argument, not as the working folder,
    // so loader flags still resolve from the app rather than the project.
    this.#child = fork(entry, project ? ["--project", project] : [], {
      execPath: process.execPath,
      execArgv: hostExecArgv(options.maxHeapMb),
      env: { ...projectProcessEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
    });
    registerProjectProcess(this.#child);
    timer = setTimeout(
      () =>
        this.#settleReady?.(
          new ExtensionHostError("failed", "Extension host did not start"),
        ),
      this.options.activationTimeoutMs,
    );
    for (const stream of [this.#child.stdout, this.#child.stderr])
      stream?.setEncoding("utf8").on("data", (chunk: string) => {
        this.log.push(...chunk.split("\n").filter(Boolean));
        this.log.splice(0, Math.max(0, this.log.length - 50));
      });
    this.#child.on("message", (message) => {
      try {
        this.#receive(message);
      } catch {
        // A bad message fails its own call at most, never the daemon.
      }
    });
    this.#child.on("error", (error) => {
      this.log.push(`Extension host error: ${error.message}`);
      // Without a pid it never started, and no exit will follow.
      if (this.#child.pid === undefined) this.#gone(error.message);
    });
    this.#child.once("exit", (code, signal) =>
      this.#gone(String(signal ?? code)),
    );
  }

  get pid() {
    return this.#child.pid;
  }

  get alive() {
    return !this.#exited && !this.#stopping && !this.#killing;
  }

  status(): Omit<ExtensionHostStatus, "stats"> {
    return {
      scope: this.scope,
      pid: this.pid,
      startMs: this.#startMs,
      pending: this.#pending.size,
      plugins: Object.fromEntries(this.#loaded),
    };
  }

  /** Plugins loaded or loading, at the version calls will use. */
  plugins(): Record<string, ScopePlugin> {
    const plugins: Record<string, ScopePlugin> = {};
    for (const [id, loaded] of this.#loaded)
      plugins[id] = {
        version: loaded.version,
        root: loaded.root,
        loaded: true,
      };
    for (const [id, activation] of this.#activations) {
      const loaded = this.#loaded.get(id);
      plugins[id] = {
        version: activation.version,
        root: activation.root,
        loaded:
          loaded?.version === activation.version &&
          loaded.root === activation.root,
      };
    }
    return plugins;
  }

  /**
   * Activates a plugin once. Asked for another version, it lets the running
   * version's calls finish, deactivates it, then activates the new one.
   */
  activate(plugin: ExtensionHostPlugin): Promise<void> {
    const current = this.#activations.get(plugin.id);
    if (current?.version === plugin.version && current.root === plugin.root)
      return current.done;
    const activation: Activation = {
      version: plugin.version,
      root: plugin.root,
      done: Promise.resolve(),
    };
    activation.done = this.#enqueue(plugin.id, async () => {
      // Replaced before its turn came: the newer one activates instead.
      if (this.#activations.get(plugin.id) !== activation) return;
      if (this.#loaded.has(plugin.id)) {
        await this.#drained(plugin.id);
        await this.#unload(plugin.id);
      }
      await this.#ready;
      // Turned off or replaced while the old version drained.
      if (this.#activations.get(plugin.id) !== activation) return;
      const message = await this.#request(
        { type: "activate", plugin },
        plugin.id,
        this.options.activationTimeoutMs,
      );
      if (message.type === "activated")
        this.#loaded.set(plugin.id, {
          version: plugin.version,
          root: plugin.root,
          tools: message.tools,
          commands: message.commands,
          activationMs: message.ms,
        });
    });
    // A failed activation can be retried by the next call.
    activation.done.catch(() => {
      if (this.#activations.get(plugin.id) === activation)
        this.#activations.delete(plugin.id);
    });
    this.#activations.set(plugin.id, activation);
    return activation.done;
  }

  async invoke(options: InvokeOptions): Promise<unknown> {
    const { plugin } = options;
    await this.activate(plugin);
    const current = () => {
      const activation = this.#activations.get(plugin.id);
      if (
        activation?.version !== plugin.version ||
        activation.root !== plugin.root ||
        this.#loaded.get(plugin.id)?.version !== plugin.version ||
        this.#loaded.get(plugin.id)?.root !== plugin.root
      )
        throw unavailable(
          `${plugin.id} ${plugin.version} was turned off or replaced while the call waited`,
        );
      return activation;
    };
    const activation = current();
    await options.check?.();
    if (current() !== activation)
      throw unavailable(`${plugin.id} was replaced while the call waited`);
    const call = this.#request(
      {
        type: "invoke",
        plugin: plugin.id,
        kind:
          options.command !== undefined
            ? "command"
            : options.projectType !== undefined
              ? "projectType"
              : "tool",
        name: (options.command ?? options.projectType ?? options.tool)!,
        input: options.input,
        ...(options.turn ? { turn: options.turn } : {}),
        ...(options.configuration ? { configuration: options.configuration } : {}),
      },
      plugin.id,
      options.timeoutMs ?? this.options.callTimeoutMs,
      options.signal,
      options.onProgress,
    );
    const inflight = this.#inflight.get(plugin.id) ?? new Set();
    this.#inflight.set(plugin.id, inflight);
    inflight.add(call);
    void call
      .catch(() => {})
      .finally(() => {
        inflight.delete(call);
        if (!inflight.size && this.#inflight.get(plugin.id) === inflight)
          this.#inflight.delete(plugin.id);
      });
    const message = await call;
    return message.type === "result" ? message.value : undefined;
  }

  /**
   * Turns a plugin off: cancels its running calls, then disposes what it
   * registered. Its next call activates it again.
   */
  deactivate(plugin: string): Promise<void> {
    this.#activations.delete(plugin);
    // Cancel at once, not after whatever is queued for the plugin.
    const cancel = () => {
      const error = new ExtensionHostError(
        "cancelled",
        `${plugin} was turned off`,
      );
      for (const pending of this.#pending.values())
        if (pending.plugin === plugin && pending.type === "invoke")
          pending.giveUp(error);
    };
    cancel();
    return this.#enqueue(plugin, async () => {
      cancel();
      await this.#drained(plugin);
      await this.#unload(plugin);
    });
  }

  async stats(): Promise<HostStats | undefined> {
    if (!this.alive) return undefined;
    await this.#ready;
    const message = await this.#request({ type: "stats" }, undefined, 5_000);
    return message.type === "stats" ? message.stats : undefined;
  }

  /**
   * Stops the host: asks it to clean up (`onDispose`, `deactivate`), then
   * stops its process and anything it started.
   */
  async stop(): Promise<void> {
    if (this.#exited) return;
    this.#stopping = true;
    clearTimeout(this.#idle);
    if (this.#child.connected) {
      const exited = new Promise<void>((resolve) =>
        this.#child.once("exit", () => resolve()),
      );
      this.#send({ type: "shutdown", id: this.#nextId++ });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.options.cancelGraceMs);
        }),
      ]);
      clearTimeout(timer);
    }
    await terminateProjectProcess(this.#child);
  }

  #enqueue(plugin: string, task: () => Promise<void>): Promise<void> {
    const run = (this.#queues.get(plugin) ?? Promise.resolve()).then(task);
    const settled = run.catch(() => {});
    this.#queues.set(plugin, settled);
    void settled.then(() => {
      if (this.#queues.get(plugin) === settled) this.#queues.delete(plugin);
    });
    return run;
  }

  async #unload(plugin: string): Promise<void> {
    if (!this.#loaded.delete(plugin) || !this.alive) return;
    await this.#request(
      { type: "deactivate", plugin },
      plugin,
      this.options.activationTimeoutMs,
    );
  }

  async #drained(plugin: string): Promise<void> {
    await Promise.allSettled([...(this.#inflight.get(plugin) ?? [])]);
  }

  /** The process is gone, by exit or a failed start; runs once. */
  #gone(reason: string) {
    if (this.#exited) return;
    this.#exited = true;
    clearTimeout(this.#idle);
    this.#settleReady?.(
      new ExtensionHostError("crashed", `Extension host exited (${reason})`),
    );
    const plugins = new Set<string>();
    for (const pending of this.#pending.values())
      if (pending.plugin) plugins.add(pending.plugin);
    const error = new ExtensionHostError(
      "crashed",
      `Extension host exited (${reason})`,
    );
    for (const pending of [...this.#pending.values()]) pending.settle(error);
    this.#pending.clear();
    this.#loaded.clear();
    this.#activations.clear();
    // Whatever the plugins started outlives the host unless it is stopped too.
    void terminateProjectProcess(this.#child).catch(() => {});
    // A crash can't be traced to one call, so every plugin with a call in
    // flight is counted; a hang is traced to the call that hung.
    const blamed = this.#stopping
      ? []
      : this.#culprit
        ? [this.#culprit]
        : [...plugins];
    this.onExit(this, blamed);
  }

  #request(
    request: WithoutId<HostRequest>,
    plugin: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    onProgress?: (message: string, url?: string) => void,
  ): Promise<HostMessage> {
    if (!this.alive)
      return Promise.reject(
        new ExtensionHostError("crashed", "Extension host is not running"),
      );
    if (signal?.aborted)
      return Promise.reject(
        new ExtensionHostError("cancelled", "Plugin call cancelled"),
      );
    const activity = request.type !== "stats";
    if (activity) clearTimeout(this.#idle);
    const id = this.#nextId++;
    return new Promise<HostMessage>((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      let failure: ExtensionHostError | undefined;
      // Cancel cooperatively first; code that ignores the signal, or never
      // yields, loses its host after the grace period.
      const giveUp = (error: ExtensionHostError) => {
        if (failure || !this.#pending.has(id)) return;
        failure = error;
        this.#send({ type: "cancel", id });
        grace = setTimeout(() => {
          if (!this.#pending.has(id) || this.#exited) return;
          this.#killing = true;
          this.#culprit ??= plugin;
          void terminateProjectProcess(this.#child).catch(() => {});
        }, this.options.cancelGraceMs);
      };
      const abort = () =>
        giveUp(new ExtensionHostError("cancelled", "Plugin call cancelled"));
      const timer = setTimeout(
        () =>
          giveUp(
            new ExtensionHostError(
              "timeout",
              `Plugin call timed out after ${timeoutMs} ms`,
            ),
          ),
        timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      const settle = (message: HostMessage | ExtensionHostError) => {
        if (!this.#pending.has(id)) return;
        clearTimeout(timer);
        clearTimeout(grace);
        signal?.removeEventListener("abort", abort);
        this.#pending.delete(id);
        if (activity) this.#scheduleIdle();
        // A host stopped for a call that never settled reports why it was stopped.
        if (failure && message instanceof ExtensionHostError) reject(failure);
        else if (message instanceof ExtensionHostError) reject(message);
        else if (message.type === "error")
          reject(
            failure ??
              new ExtensionHostError(
                message.cancelled ? "cancelled" : "failed",
                message.message,
              ),
          );
        else if (failure) reject(failure);
        else if (message.type !== REPLIES[request.type])
          reject(
            new ExtensionHostError(
              "failed",
              `Extension host answered ${request.type} with ${message.type}`,
            ),
          );
        else resolve(message);
      };
      this.#pending.set(id, {
        type: request.type,
        plugin,
        activity,
        onProgress,
        settle,
        giveUp,
      });
      // Input IPC can't carry (BigInt, cycles) fails here, not as a hang.
      this.#send({ ...request, id } as HostRequest, (error) =>
        settle(
          new ExtensionHostError(
            "failed",
            `The request could not be sent to the extension host: ${error.message}`,
          ),
        ),
      );
    });
  }

  #send(request: HostRequest, onError?: (error: Error) => void) {
    if (!this.#child.connected) {
      onError?.(new Error("not connected"));
      return;
    }
    try {
      this.#child.send(request, (error) => {
        if (error) onError?.(error);
      });
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #receive(message: unknown) {
    if (!isHostMessage(message)) return;
    if (message.type === "ready") {
      this.#settleReady?.(
        message.protocol === EXTENSION_HOST_PROTOCOL_VERSION
          ? undefined
          : new ExtensionHostError(
              "failed",
              "Extension host protocol mismatch",
            ),
      );
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (message.type === "progress") {
      if (pending.type !== "invoke") return;
      try {
        pending.onProgress?.(message.message, message.url);
      } catch {
        // The caller's progress handler failing doesn't fail the call.
      }
    } else pending.settle(message);
  }

  #scheduleIdle() {
    clearTimeout(this.#idle);
    const busy = [...this.#pending.values()].some(
      (pending) => pending.activity,
    );
    if (busy || !this.alive) return;
    this.#idle = setTimeout(
      () => void this.stop().catch(() => {}),
      this.options.idleMs,
    );
    this.#idle.unref();
  }
}

export class ExtensionHosts {
  readonly #hosts = new Map<string, ExtensionHost>();
  readonly #crashes = new Map<string, number[]>();
  /** Plugins that reached the crash limit; they stay off until released. */
  readonly #quarantined = new Set<string>();
  readonly #options: typeof DEFAULTS;
  readonly #entry: string;
  #disposed = false;

  constructor(options: ExtensionHostOptions = {}) {
    const { hostEntry, ...rest } = options;
    this.#options = { ...DEFAULTS, ...rest };
    this.#entry = hostEntry ?? defaultHostEntry();
  }

  /** Calls one of a plugin's tools or commands in the host for `scope`, starting it if needed. */
  async invoke(options: InvokeOptions): Promise<unknown> {
    if (this.quarantined(options.plugin.id))
      throw new ExtensionHostError(
        "quarantined",
        `${options.plugin.id} stopped its extension host too often and is turned off until it is released`,
      );
    return this.#host(options.scope, options.project).invoke(options);
  }

  quarantined(plugin: string): boolean {
    return this.#quarantined.has(plugin);
  }

  /** Lets a quarantined plugin run again, as when the person turns it back on. */
  release(plugin: string) {
    this.#quarantined.delete(plugin);
    this.#crashes.delete(plugin);
  }

  /** Scopes with a running host. */
  scopes(): string[] {
    return [...this.#hosts.keys()];
  }

  /** Plugins loaded or loading in a scope's host, by id. */
  active(scope: string): Record<string, ScopePlugin> {
    const host = this.#hosts.get(scope);
    return host?.alive ? host.plugins() : {};
  }

  async status(): Promise<ExtensionHostStatus[]> {
    return Promise.all(
      [...this.#hosts.values()].map(async (host) => ({
        ...host.status(),
        stats: await host.stats().catch(() => undefined),
      })),
    );
  }

  /** Turns a plugin off in one scope's host, as when it is disabled there. */
  async deactivate(scope: string, plugin: string): Promise<void> {
    await this.#hosts.get(scope)?.deactivate(plugin);
  }

  /** The last lines a scope's host wrote, for diagnostics. */
  log(scope: string): string[] {
    return [...(this.#hosts.get(scope)?.log ?? [])];
  }

  async stop(scope: string): Promise<void> {
    await this.#hosts.get(scope)?.stop();
  }

  /** Stops every host; no new ones start afterwards. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await Promise.all([...this.#hosts.values()].map((host) => host.stop()));
    this.#hosts.clear();
  }

  #host(scope: string, project: string | undefined): ExtensionHost {
    if (this.#disposed)
      throw new ExtensionHostError("failed", "Extension hosts are shut down");
    const existing = this.#hosts.get(scope);
    if (existing?.alive) {
      if (existing.project !== project)
        throw new ExtensionHostError(
          "failed",
          `The extension host for ${scope} serves another folder`,
        );
      return existing;
    }
    let host: ExtensionHost;
    try {
      host = this.#start(scope, project);
    } catch (error) {
      throw new ExtensionHostError(
        "failed",
        `The extension host could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#hosts.set(scope, host);
    return host;
  }

  #start(scope: string, project: string | undefined): ExtensionHost {
    return new ExtensionHost(
      scope,
      project,
      this.#entry,
      this.#options,
      (exited, plugins) => {
        if (this.#hosts.get(scope) === exited) this.#hosts.delete(scope);
        const now = Date.now();
        for (const plugin of plugins) {
          const recent = [
            ...(this.#crashes.get(plugin) ?? []).filter(
              (time) => now - time < this.#options.crashWindowMs,
            ),
            now,
          ];
          this.#crashes.set(plugin, recent);
          if (recent.length >= this.#options.crashLimit)
            this.#quarantined.add(plugin);
        }
      },
    );
  }
}
