import { createHash } from "node:crypto";
import type { PluginSessionRequest } from "../shared/plugin-sessions.js";
import { mkdir } from "node:fs/promises";
import type { PluginGameBridge } from "./plugin-game-bridge.js";
import type {
  ExtensionHostPlugin,
  PluginBuild,
  PluginConfigurationValues,
  ProjectTypeHook,
} from "../shared/extension-host-protocol.js";
import type { CanvasNodeDefinition } from "../shared/canvas-plugin-nodes.js";
import { projectTypePlugin } from "../shared/project-file.js";
import { manifestHooks } from "../shared/plugin-hooks.js";
import {
  ExtensionHostError,
  type ExtensionHosts,
  type ExtensionHostStatus,
} from "./extension-hosts.js";
import type { PluginIndex, PluginIndexEntry } from "./plugin-index.js";
import {
  projectFolderKey,
  type ProjectPlugins,
  type ProjectPluginStatus,
} from "./project-plugins.js";

const seconds = (value: number | undefined) =>
  value === undefined ? undefined : value * 1000;

// Runs plugins' native code for projects. Every call is checked against what
// the project asks for and what the person allowed in its folder, and only
// tools and commands the manifest declares can run. A plugin's code is loaded
// only after its package on disk still matches the index, so a package
// changed after install is checked again, and asks again if it wants more.

export interface PluginCallOptions {
  /** The project folder the call is for. */
  folder: string;
  input?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (message: string, url?: string) => void;
  /** The agent turn the call belongs to. */
  turn?: string;
  /** The version the caller expects; the call is refused if the project moved on. */
  version?: string;
  /** The web build a command asked for. */
  build?: PluginBuild;
}

export interface NativePluginStatus {
  id: string;
  version: string;
  status: ProjectPluginStatus;
  quarantined: boolean;
  /** Whether its native code is loaded in the project's host. */
  loaded: boolean;
}

const unavailable = (message: string) =>
  new ExtensionHostError("unavailable", message);

/** `publisher/name:item` split into the plugin and the item. */
function qualified(value: string): [string, string] {
  const separator = value.lastIndexOf(":");
  if (separator < 1) throw unavailable(`${value} is not publisher/name:id`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function hostPlugin(entry: PluginIndexEntry, dataFolder: string): ExtensionHostPlugin {
  const { manifest } = entry;
  return {
    id: entry.id,
    version: entry.version,
    root: entry.root,
    dataFolder,
    entry: manifest.entrypoints!.native!,
    tools: (manifest.contributes?.tools ?? []).map((tool) => tool.name),
    // A canvas node's code, and an asset source's, are command handlers too.
    commands: [...new Set([
      ...(manifest.contributes?.commands ?? []).flatMap((command) =>
        "native" in command.run ? [command.run.native] : [],
      ),
      ...(manifest.contributes?.canvasNodes ?? []).map((node) => node.run.native),
      ...(manifest.contributes?.assetSources ?? []).flatMap((source) => [source.search, source.fetch]),
    ])],
    projectTypes: (manifest.contributes?.projectTypes ?? []).map(
      (type) => type.id,
    ),
    game: manifest.capabilities?.game === true,
    hooks: [...manifestHooks(manifest)],
  };
}

/** The host scope for calls that belong to no project, such as the Library's sources. */
const APP_SCOPE = "app";

export class NativePlugins {
  readonly #index: PluginIndex;
  readonly #resolve: (folder: string) => Promise<ProjectPlugins>;
  readonly #appPlugin: (id: string) => Promise<PluginIndexEntry | undefined>;
  readonly #hosts: ExtensionHosts;

  readonly #configuration:
    | ((entry: PluginIndexEntry) => PluginConfigurationValues)
    | undefined;

  #persistentList: (() => Promise<PluginIndexEntry[]>) | undefined;
  #persistentTimer: ReturnType<typeof setTimeout> | undefined;
  #reconciling: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly #persistent = new Map<string, { fingerprint: string; generation: number | undefined; release: () => void }>();
  readonly #retries = new Map<string, { count: number; after: number }>();

  readonly #dataFolder: (id: string) => string;

  constructor(options: {
    index: PluginIndex;
    /** Which plugins are on in a project folder, and whether each may run. */
    resolve: (folder: string) => Promise<ProjectPlugins>;
    /** The version of a plugin that may run outside projects, if any: on, and allowed what it asks for. */
    appPlugin?: (id: string) => Promise<PluginIndexEntry | undefined>;
    hosts: ExtensionHosts;
    /** The values a call carries for the plugin's `configuration`. */
    configuration?: (entry: PluginIndexEntry) => PluginConfigurationValues;
    /** The plugin's data folder; made before each call. */
    dataFolder: (id: string) => string;
  }) {
    this.#index = options.index;
    this.#resolve = options.resolve;
    this.#appPlugin = options.appPlugin ?? (async () => undefined);
    this.#hosts = options.hosts;
    this.#configuration = options.configuration;
    this.#dataFolder = options.dataFolder;
  }

  /** Calls a tool, named `publisher/name:tool`, in a project. */
  async callTool(tool: string, options: PluginCallOptions): Promise<unknown> {
    const [id, name] = qualified(tool);
    const { key, entry } = await this.#ready(options.folder, id);
    if (options.version && options.version !== entry.version)
      throw unavailable(
        `${id} is now ${entry.version}; this tool was for ${options.version}. Try again in a new turn.`,
      );
    const declared = entry.manifest.contributes?.tools?.find((item) => item.name === name);
    if (!declared) throw unavailable(`${id} does not declare a tool named ${name}`);
    return this.#hosts.invoke({
      ...(await this.#call(key, entry, { ...options, timeoutMs: options.timeoutMs ?? seconds(declared.timeoutSeconds) })),
      tool: name,
    });
  }

  /** Runs a command, named `publisher/name:command`, whose `run` is native. */
  async runCommand(
    command: string,
    options: PluginCallOptions,
  ): Promise<unknown> {
    const [id, commandId] = qualified(command);
    const { key, entry } = await this.#ready(options.folder, id);
    if (options.version && options.version !== entry.version)
      throw unavailable(
        `${id} is now ${entry.version}; this command was for ${options.version}. Try again.`,
      );
    const run = entry.manifest.contributes?.commands?.find(
      (item) => item.id === commandId,
    )?.run;
    if (!run || !("native" in run))
      throw unavailable(`${id} has no native command named ${commandId}`);
    return this.#hosts.invoke({
      ...(await this.#call(key, entry, { ...options, timeoutMs: options.timeoutMs ?? seconds(run.timeoutSeconds) })),
      command: run.native,
    });
  }

  /**
   * Runs a canvas node, `publisher/name:node`, in the version the project
   * uses: `prepare` checks the call against the node's definition there and
   * returns what its code gets.
   */
  async runCanvasNode<T>(
    node: string,
    options: Omit<PluginCallOptions, "input"> & {
      prepare: (definition: CanvasNodeDefinition, entry: PluginIndexEntry) => Promise<unknown>;
      result: (value: unknown, definition: CanvasNodeDefinition) => Promise<T>;
    },
  ): Promise<T> {
    const [id, nodeId] = qualified(node);
    const { key, entry } = await this.#ready(options.folder, id);
    const definition = entry.manifest.contributes?.canvasNodes?.find(
      (item) => item.id === nodeId,
    );
    if (!definition) throw unavailable(`${id} ${entry.version} has no canvas node ${nodeId}`);
    const input = await options.prepare(definition, entry);
    const value = await this.#hosts.invoke({
      ...(await this.#call(key, entry, { ...options, input, timeoutMs: options.timeoutMs ?? seconds(definition.run.timeoutSeconds) })),
      command: definition.run.native,
    });
    return options.result(value, definition);
  }

  /**
   * Runs an asset source's `search` or `fetch`, `publisher/name:source`,
   * outside any project, in the newest version the person allowed.
   */
  async runAssetSource(
    source: string,
    handler: "search" | "fetch",
    options: Omit<PluginCallOptions, "folder" | "version">,
  ): Promise<unknown> {
    const [id, sourceId] = qualified(source);
    const { key, entry } = await this.#ready(APP_SCOPE, id);
    const definition = entry.manifest.contributes?.assetSources?.find((item) => item.id === sourceId);
    if (!definition) throw unavailable(`${id} ${entry.version} has no asset source ${sourceId}`);
    return this.#hosts.invoke({
      ...(await this.#call(key, entry, { ...options, folder: APP_SCOPE, timeoutMs: options.timeoutMs ?? seconds(definition.timeoutSeconds) })),
      command: definition[handler],
    });
  }

  /**
   * The package a project's canvas node runs from, so one release's output
   * isn't taken for another's, and the inputs that release declares.
   */
  async canvasNodePackage(folder: string, node: string): Promise<{ package: string; inputs: string[] }> {
    const [id, nodeId] = qualified(node);
    const entry = await this.#active(await projectFolderKey(folder), id);
    const definition = entry.manifest.contributes?.canvasNodes?.find((item) => item.id === nodeId);
    return { package: `${entry.version}:${entry.digest}`, inputs: definition?.inputs?.map((input) => input.id) ?? [] };
  }

  /** Runs a hook of a project type, `publisher/name:type`, that the project's plugin contributes. */
  async projectTypeHook(
    type: string,
    hook: ProjectTypeHook,
    options: PluginCallOptions,
  ): Promise<unknown> {
    const id = projectTypePlugin(type);
    if (!id) throw unavailable(`${type} is one of the app's own types`);
    const typeId = type.slice(id.length + 1);
    const { key, entry } = await this.#ready(options.folder, id);
    if (
      !entry.manifest.contributes?.projectTypes?.some(
        (item) => item.id === typeId,
      )
    )
      throw unavailable(`${id} ${entry.version} has no project type ${typeId}`);
    return this.#hosts.invoke({
      ...(await this.#call(key, entry, options)),
      projectType: `${typeId}:${hook}`,
    });
  }

  /** Runs a plugin's handler for an event its manifest's `contributes.hooks` lists. */
  async hook(id: string, event: string, options: PluginCallOptions): Promise<unknown> {
    const { key, entry } = await this.#ready(options.folder, id);
    if (options.version && options.version !== entry.version)
      throw unavailable(`${id} is now ${entry.version}; this hook was for ${options.version}`);
    if (!(manifestHooks(entry.manifest) as readonly string[]).includes(event))
      throw unavailable(`${id} ${entry.version} doesn't hear ${event}`);
    return this.#hosts.invoke({
      ...(await this.#call(key, entry, options)),
      hook: event,
    });
  }

  /**
   * Unloads what a project no longer allows: plugins it stopped asking for,
   * moved to another version, or the person turned off or revoked. Call it
   * after `ohmygame.json` or the person's decisions change.
   */
  async refreshProject(folder: string): Promise<void> {
    const key = await projectFolderKey(folder).catch(() => folder);
    const loaded = this.#hosts.active(key);
    if (!Object.keys(loaded).length) return;
    const resolved = await this.#resolve(key).catch(() => undefined);
    const allowed = new Map(
      resolved?.ok
        ? resolved.plugins
            .filter((plugin) => plugin.status === "active")
            .map((plugin) => [plugin.id, plugin.version])
        : [],
    );
    await Promise.all(
      Object.entries(loaded)
        .filter(([id, plugin]) => allowed.get(id) !== plugin.version)
        .map(([id]) => this.#hosts.deactivate(key, id)),
    );
  }

  /** `refreshProject` for every project with a running host, and the same for the app's own. */
  async refresh(): Promise<void> {
    await Promise.all(
      this.#hosts
        .scopes()
        .map((scope) => scope === APP_SCOPE ? this.#refreshApp() : this.refreshProject(scope)),
    );
    await this.#reconcile();
  }

  /** Unloads app plugins turned off, no longer allowed, or moved to another version. */
  async #refreshApp(): Promise<void> {
    await Promise.all(Object.entries(this.#hosts.active(APP_SCOPE)).map(async ([id, plugin]) => {
      const allowed = await this.#appPlugin(id).catch(() => undefined);
      if (allowed?.version !== plugin.version) await this.#hosts.deactivate(APP_SCOPE, id);
    }));
  }

  /**
   * Restarts the hosts that imported a plugin, as when its package changed
   * under the same version in development: a host keeps the modules it
   * imported, even after turning the plugin off, so only a new one runs the
   * new code. Each starts again on its next call.
   */
  async reload(id: string): Promise<void> {
    await Promise.all(
      this.#hosts.importers(id).map((scope) => this.#hosts.stop(scope)),
    );
  }

  /** Which start of the project's running host this is; undefined when none runs. */
  async hostGeneration(folder: string): Promise<number | undefined> {
    return this.#hosts.generation(await projectFolderKey(folder).catch(() => folder));
  }

  /** Keeps the project's running host from stopping while idle; see `ExtensionHosts.hold`. */
  async holdHost(folder: string): Promise<(() => void) | undefined> {
    return this.#hosts.hold(await projectFolderKey(folder).catch(() => folder));
  }

  /**
   * Answers project plugins' `context.game`: only a plugin on in the project
   * that asks for `game`, checked on every request.
   */
  serveGame(bridge: Pick<PluginGameBridge, "handle" | "release">): void {
    this.#hosts.serveGame({
      handle: async ({ scope, project, generation, plugin }, request, signal) => {
        if (scope === "app" || !project) throw unavailable("Only a project's plugins can play its game");
        const entry = await this.#active(scope, plugin);
        if (entry.manifest.capabilities?.game !== true)
          throw unavailable(`${plugin} doesn't ask to play the game`);
        return bridge.handle({ folder: scope, plugin, generation }, request, signal);
      },
      release: ({ scope, generation, plugin }) => {
        if (scope !== "app") bridge.release({ folder: scope, generation, ...(plugin ? { plugin } : {}) });
      },
    });
  }

  /** Stops a project's host, as when the project is closed. */
  async closeProject(folder: string): Promise<void> {
    await this.#hosts.stop(await projectFolderKey(folder).catch(() => folder));
  }

  quarantined(id: string): boolean {
    return this.#hosts.quarantined(id);
  }

  /** Lets a quarantined plugin run again, as when the person turns it back on. */
  release(id: string) {
    this.#hosts.release(id);
  }

  /** Each plugin a project asks for, with whether it is quarantined or loaded. */
  async projectStatus(
    folder: string,
  ): Promise<NativePluginStatus[] | undefined> {
    const key = await projectFolderKey(folder);
    const resolved = await this.#resolve(key);
    if (!resolved.ok) return undefined;
    const loaded = this.#hosts.active(key);
    return resolved.plugins.map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      status: plugin.status,
      quarantined: this.#hosts.quarantined(plugin.id),
      loaded: loaded[plugin.id]?.version === plugin.version,
    }));
  }

  /** The running hosts, for 诊断. */
  hosts(): Promise<ExtensionHostStatus[]> {
    return this.#hosts.status();
  }

  async stopPersistent(): Promise<void> {
    this.#disposed = true;
    clearTimeout(this.#persistentTimer);
    await this.#reconciling;
    for (const item of this.#persistent.values()) item.release();
    this.#persistent.clear();
    await this.#hosts.stop(APP_SCOPE);
  }

  async dispose(): Promise<void> {
    await this.stopPersistent();
    await this.#hosts.dispose();
  }

  /** Start after application stores and session handlers are ready. */
  async startPersistent(list: () => Promise<PluginIndexEntry[]>): Promise<void> {
    if (this.#disposed || this.#persistentList) return;
    this.#persistentList = list;
    // A damaged plugin store must not prevent the app from opening; retry later.
    await this.#reconcile().catch(() => {});
    const poll = () => {
      if (this.#disposed) return;
      this.#persistentTimer = setTimeout(() => {
        void this.#reconcile().catch(() => {}).finally(poll);
      }, 2_000);
      this.#persistentTimer.unref();
    };
    poll();
  }

  #reconcile(): Promise<void> {
    const run = this.#reconciling.catch(() => {}).then(async () => {
      if (!this.#persistentList || this.#disposed) return;
      const desired = (await this.#persistentList()).filter((entry) => entry.manifest.capabilities?.sessions);
      for (const [id, item] of this.#persistent) {
        const entry = desired.find((entry) => entry.id === id);
        if (entry && item.fingerprint === this.#fingerprint(entry) && item.generation === this.#hosts.generation(APP_SCOPE)) continue;
        item.release();
        this.#persistent.delete(id);
        await this.#hosts.deactivate(APP_SCOPE, id);
      }
      for (const entry of desired) {
        if (this.#disposed || this.#persistent.has(entry.id) || this.#hosts.quarantined(entry.id)) continue;
        const retry = this.#retries.get(entry.id);
        if (retry && retry.after > Date.now()) continue;
        try {
          const { key, entry: ready } = await this.#ready(APP_SCOPE, entry.id);
          const fingerprint = this.#fingerprint(ready);
          const call = await this.#call(key, ready, { folder: APP_SCOPE });
          const release = await this.#hosts.activate(call);
          if (this.#disposed) { release(); break; }
          this.#persistent.set(entry.id, { fingerprint, generation: this.#hosts.generation(APP_SCOPE), release });
          this.#retries.delete(entry.id);
        } catch {
          const count = (retry?.count ?? 0) + 1;
          this.#retries.set(entry.id, { count, after: Date.now() + Math.min(30_000, 2_000 * 2 ** Math.min(count, 4)) });
        }
      }
      for (const id of this.#retries.keys()) if (!desired.some((entry) => entry.id === id)) this.#retries.delete(id);
    });
    this.#reconciling = run;
    return run;
  }

  #fingerprint(entry: PluginIndexEntry): string {
    return createHash("sha256").update(JSON.stringify([entry.version, entry.root, entry.digest, this.#configuration?.(entry) ?? {}])).digest("hex");
  }

  serveSessions(service: { handle(plugin: string, request: PluginSessionRequest, signal: AbortSignal, authorize: () => Promise<void>): Promise<unknown> }): void {
    this.#hosts.serveSessions({ handle: async (caller, request, signal) => {
      const authorize = async () => {
        signal.throwIfAborted();
        if (this.#disposed) throw unavailable("App plugins are stopping");
        if (caller.scope !== APP_SCOPE || caller.project || caller.generation !== this.#hosts.generation(APP_SCOPE)) throw unavailable("Session access requires the app host");
        const entry = await this.#active(APP_SCOPE, caller.plugin);
        signal.throwIfAborted();
        if (!entry.manifest.capabilities?.sessions) throw unavailable("Session access is not granted");
      };
      await authorize();
      const result = await service.handle(caller.plugin, request, signal, authorize);
      await authorize();
      return result;
    } });
  }

  async #call(key: string, entry: PluginIndexEntry, options: PluginCallOptions) {
    const fingerprint = this.#fingerprint(entry);
    const dataFolder = this.#dataFolder(entry.id);
    await mkdir(dataFolder, { recursive: true, mode: 0o700 });
    return {
      scope: key,
      ...(key === APP_SCOPE ? {} : { project: key }),
      plugin: { ...hostPlugin(entry, dataFolder), sessions: key === APP_SCOPE && entry.manifest.capabilities?.sessions === true, configuration: this.#configuration?.(entry) ?? {} },
      input: options.input,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onProgress: options.onProgress,
      turn: options.turn,
      build: options.build,
      configuration: this.#configuration?.(entry) ?? {},
      // Activation can take a while; the person may have revoked the plugin
      // or the project moved on meanwhile.
      check: async () => {
        const now = await this.#active(key, entry.id);
        if (now.version !== entry.version || now.root !== entry.root || (key === APP_SCOPE && this.#fingerprint(now) !== fingerprint))
          throw unavailable(`${entry.id} changed while the call waited`);
      },
    };
  }

  /** The plugin's index entry when it may run in the project now. */
  async #ready(
    folder: string,
    id: string,
  ): Promise<{ key: string; entry: PluginIndexEntry }> {
    const key = folder === APP_SCOPE ? APP_SCOPE : await projectFolderKey(folder);
    // Before its code is loaded, the package must still be what was indexed;
    // a changed package is indexed again and checked again. The project may
    // move to another version while that runs, so the check repeats until
    // the version checked is the version the project uses.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entry = await this.#active(key, id);
      if (!entry.manifest.entrypoints?.native)
        throw unavailable(`${id} has no native code`);
      // Already loaded, or loading, from this very package: it was checked.
      const running = this.#hosts.active(key)[id];
      if (running?.version === entry.version && running.root === entry.root)
        return { key, entry };
      if (!(await this.#index.verify(id, entry.version)))
        throw unavailable(
          `${id} ${entry.version} changed on disk and is no longer a valid package`,
        );
      const checked = await this.#active(key, id);
      if (checked.version === entry.version && checked.root === entry.root) {
        if (!checked.manifest.entrypoints?.native)
          throw unavailable(`${id} has no native code`);
        return { key, entry: checked };
      }
    }
    throw unavailable(`${id} kept changing while it was checked`);
  }

  async #active(key: string, id: string): Promise<PluginIndexEntry> {
    if (key === APP_SCOPE) {
      const entry = await this.#appPlugin(id);
      if (!entry) throw unavailable(`${id} is off, or not allowed what it asks for`);
      return entry;
    }
    const resolved = await this.#resolve(key);
    if (!resolved.ok)
      throw unavailable(
        `ohmygame.json is invalid: ${resolved.issues.join("; ")}`,
      );
    const plugin = resolved.plugins.find((item) => item.id === id);
    if (!plugin) throw unavailable(`The project doesn't use ${id}`);
    if (plugin.status !== "active" || !plugin.entry)
      throw unavailable(`${id} is not on in this project (${plugin.status})`);
    return plugin.entry;
  }
}
