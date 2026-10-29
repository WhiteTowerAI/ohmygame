import type {
  ExtensionHostPlugin,
  PluginConfigurationValues,
  ProjectTypeHook,
} from "../shared/extension-host-protocol.js";
import { projectTypePlugin } from "../shared/project-file.js";
import {
  ExtensionHostError,
  type ExtensionHosts,
  type ExtensionHostStatus,
} from "./extension-hosts.js";
import type { PluginIndex, PluginIndexEntry } from "./plugin-index.js";
import {
  projectFolderKey,
  resolveProjectPlugins,
  type PluginGrants,
  type ProjectPluginStatus,
} from "./project-plugins.js";

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
  onProgress?: (message: string) => void;
  /** The agent turn the call belongs to. */
  turn?: string;
  /** The version the caller expects; the call is refused if the project moved on. */
  version?: string;
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

function hostPlugin(entry: PluginIndexEntry): ExtensionHostPlugin {
  const { manifest } = entry;
  return {
    id: entry.id,
    version: entry.version,
    root: entry.root,
    entry: manifest.entrypoints!.native!,
    tools: (manifest.contributes?.tools ?? []).map((tool) => tool.name),
    commands: (manifest.contributes?.commands ?? []).flatMap((command) =>
      "native" in command.run ? [command.run.native] : [],
    ),
    projectTypes: (manifest.contributes?.projectTypes ?? []).map(
      (type) => type.id,
    ),
  };
}

export class NativePlugins {
  readonly #index: PluginIndex;
  readonly #grants: PluginGrants;
  readonly #hosts: ExtensionHosts;

  readonly #configuration:
    | ((entry: PluginIndexEntry) => PluginConfigurationValues)
    | undefined;

  constructor(options: {
    index: PluginIndex;
    grants: PluginGrants;
    hosts: ExtensionHosts;
    /** The values a call carries for the plugin's `configuration`. */
    configuration?: (entry: PluginIndexEntry) => PluginConfigurationValues;
  }) {
    this.#index = options.index;
    this.#grants = options.grants;
    this.#hosts = options.hosts;
    this.#configuration = options.configuration;
  }

  /** Calls a tool, named `publisher/name:tool`, in a project. */
  async callTool(tool: string, options: PluginCallOptions): Promise<unknown> {
    const [id, name] = qualified(tool);
    const { key, entry } = await this.#ready(options.folder, id);
    if (options.version && options.version !== entry.version)
      throw unavailable(
        `${id} is now ${entry.version}; this tool was for ${options.version}. Try again in a new turn.`,
      );
    if (!entry.manifest.contributes?.tools?.some((item) => item.name === name))
      throw unavailable(`${id} does not declare a tool named ${name}`);
    return this.#hosts.invoke({
      ...this.#call(key, entry, options),
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
      ...this.#call(key, entry, options),
      command: run.native,
    });
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
      ...this.#call(key, entry, options),
      projectType: `${typeId}:${hook}`,
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
    const resolved = await resolveProjectPlugins({
      folder: key,
      index: this.#index,
      grants: this.#grants,
    }).catch(() => undefined);
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

  /** `refreshProject` for every project with a running host. */
  async refresh(): Promise<void> {
    await Promise.all(
      this.#hosts
        .scopes()
        .filter((scope) => scope !== "app")
        .map((scope) => this.refreshProject(scope)),
    );
  }

  /** Stops a project's host, as when the project is closed. */
  async closeProject(folder: string): Promise<void> {
    await this.#hosts.stop(await projectFolderKey(folder).catch(() => folder));
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
    const resolved = await resolveProjectPlugins({
      folder: key,
      index: this.#index,
      grants: this.#grants,
    });
    if (!resolved?.ok) return undefined;
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

  dispose(): Promise<void> {
    return this.#hosts.dispose();
  }

  #call(key: string, entry: PluginIndexEntry, options: PluginCallOptions) {
    return {
      scope: key,
      project: key,
      plugin: hostPlugin(entry),
      input: options.input,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onProgress: options.onProgress,
      turn: options.turn,
      configuration: this.#configuration?.(entry) ?? {},
      // Activation can take a while; the person may have revoked the plugin
      // or the project moved on meanwhile.
      check: async () => {
        const now = await this.#active(key, entry.id);
        if (now.version !== entry.version || now.root !== entry.root)
          throw unavailable(`${entry.id} changed while the call waited`);
      },
    };
  }

  /** The plugin's index entry when it may run in the project now. */
  async #ready(
    folder: string,
    id: string,
  ): Promise<{ key: string; entry: PluginIndexEntry }> {
    const key = await projectFolderKey(folder);
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
    const resolved = await resolveProjectPlugins({
      folder: key,
      index: this.#index,
      grants: this.#grants,
    });
    if (!resolved) throw unavailable(`${key} has no ohmygame.json`);
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
