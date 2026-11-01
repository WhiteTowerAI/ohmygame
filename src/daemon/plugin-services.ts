import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { agentToolName, configReferences, fillConfigReferences, isAppWidePlugin, isPluginId, mcpServerSyntaxIssue, mcpUrlIssue, PLUGIN_DATA_ENV, pluginApiIssue } from "../shared/plugin-manifest.js";
import type { McpServerDefinition } from "../shared/plugins.js";
import type { PluginUiCapabilities } from "../shared/plugin-ui-protocol.js";
import { PROJECT_FILE_NAME, projectTypePlugin } from "../shared/project-file.js";
import { appWidePluginSuits } from "../shared/project-runtime.js";
import {
  ExtensionHosts,
  type ExtensionHostOptions,
} from "./extension-hosts.js";
import { NativePlugins, type PluginCallOptions } from "./native-plugins.js";
import {
  indexPluginPackage,
  localizePluginString,
  PluginIndex,
  type PluginIndexEntry,
  type PluginLocale,
  type PluginPackageResult,
} from "./plugin-index.js";
import { PluginValues } from "./plugin-values.js";
import {
  capabilityGrants,
  PluginGrants,
  projectFolderKey,
  projectSkills,
  resolveProjectPlugins,
  setProjectPlugin,
} from "./project-plugins.js";
import type { PluginSkillRegistration } from "./plugin-runtime.js";

// The format 2 plugin services the daemon holds: the index of installed
// packages, the person's decisions, and the hosts that run native code. They
// load on first use, so the app starts the same with no plugins installed.
//
// Plugin tools are registered here once, as Pi tool definitions. OhMyGame's
// agent uses them directly; the coding agents get the same definitions
// through `ToolBridge`, and agents outside the app through external MCP. One
// schema, one permission check (`NativePlugins`), one result shape.

/** Model-facing text past this length is cut; `structuredContent` keeps the whole result. */
const TOOL_TEXT_MAX_CHARS = 100_000;

/** A tool's input or result that doesn't match the schema its manifest names. */
export class PluginToolSchemaError extends Error {
  /** Bad input is the caller's to fix; a bad result is the plugin's. */
  readonly statusCode: 400 | 502;
  constructor(id: string, side: "input" | "output", schema: TSchema, value: unknown) {
    const problems = [...Errors(schema, value)]
      .slice(0, 3)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    super(
      side === "input"
        ? `${id} was given input that doesn't match its input schema: ${problems}`
        : `${id} returned a result that doesn't match its output schema: ${problems}`,
    );
    this.statusCode = side === "input" ? 400 : 502;
  }
}

/** A command was asked to run in a way it can't. */
/** How long a project type's `ready` command may take before the prompt goes ahead. */
const READY_TIMEOUT_MS = 20_000;

export class PluginCommandInputError extends Error {
  readonly statusCode = 400;
}

type Contributions = NonNullable<PluginIndexEntry["manifest"]["contributes"]>;
type PluginCommand = NonNullable<Contributions["commands"]>[number];

export interface ProjectCommand {
  /** `publisher/name:command`. */
  id: string;
  plugin: string;
  title: string;
  slash?: string;
  slots: NonNullable<NonNullable<Contributions["commands"]>[number]["slots"]>;
  run: NonNullable<Contributions["commands"]>[number]["run"];
}

export interface ProjectPanel {
  id: string;
  plugin: string;
  version: string;
  title: string;
  area: "left" | "center" | "right" | "bottom";
  when?: string;
  capabilities: PluginUiCapabilities;
  /** The plugin's command ids, the only ones its page may run. */
  commands: string[];
}

/**
 * Bundled plugins that start off: those still in beta for a platform the
 * person may not use.
 */
export const BUNDLED_PLUGINS_OFF: readonly string[] = [
  "ohmygame/taptap-maker",
  "ohmygame/aseprite",
  "ohmygame/cocos-creator",
  "ohmygame/douyin-minigame",
  "ohmygame/tiled",
  "ohmygame/unity",
  "ohmygame/unreal-engine",
  "ohmygame/wechat-minigame",
];

/** What deciding whether an app-wide plugin suits a project needs to know of it. */
export type AppWideProject = { type: string; pluginType?: { id: string } | undefined };

export interface PluginServicesOptions {
  /** The folder for the index and decisions, inside the app's data folder. */
  directory: string;
  hosts?: ExtensionHostOptions;
  /** The format 2 plugins that ship with the app, indexed by `ready()` before anything is served. */
  bundled?: string;
  /** Told when the bundled plugins can't be indexed; everything else still loads. */
  onBundledError?: (error: unknown) => void;
  /** Bundled plugins that start off, such as one in beta, until the person turns them on. */
  bundledOff?: readonly string[];
}

/** A plugin's Skill as agent sessions load it. Format 2 plugins have no marketplace; their publisher stands in. */
function skillRegistration(entry: PluginIndexEntry, file: string): PluginSkillRegistration {
  return {
    path: file,
    pluginDisplayName: localizePluginString(entry, entry.manifest.displayName, "en"),
    marketplaceDisplayName: entry.id.split("/")[0]!,
  };
}

export class PluginServices {
  readonly index: PluginIndex;
  readonly grants: PluginGrants;
  readonly hosts: ExtensionHosts;
  readonly native: NativePlugins;
  /** The person's values for plugins' `configuration` fields. */
  readonly values: PluginValues;
  /** Where signed releases are unpacked; uninstalling deletes its folders. */
  readonly packagesDirectory: string;
  readonly #bundledOff: ReadonlySet<string>;
  /** Holds each plugin's data folder, `<publisher>/<name>`. */
  readonly dataDirectory: string;
  readonly #bundled: Pick<PluginServicesOptions, "bundled" | "onBundledError">;
  #files: Promise<void> | undefined;
  #loaded: Promise<void> | undefined;
  readonly #listeners = new Set<(folder?: string) => void>();
  /** Project folders whose `ohmygame.json` is watched, for edits made outside OhMyGame. */
  readonly #watchers = new Map<string, FSWatcher>();

  constructor(options: PluginServicesOptions) {
    this.index = new PluginIndex(path.join(options.directory, "index.json"));
    this.grants = new PluginGrants(path.join(options.directory, "grants.json"));
    this.hosts = new ExtensionHosts(options.hosts);
    this.values = new PluginValues(
      path.join(options.directory, "configuration.json"),
    );
    this.packagesDirectory = path.join(options.directory, "packages");
    this.#bundledOff = new Set(options.bundledOff);
    this.dataDirectory = path.join(options.directory, "data");
    this.#bundled = options;
    this.native = new NativePlugins({
      index: this.index,
      grants: this.grants,
      hosts: this.hosts,
      configuration: (entry) => this.values.forNative(entry),
      dataFolder: (id) => this.dataFolder(id),
    });
  }

  /**
   * Loads the index and the decisions, then indexes the bundled plugins,
   * once; later calls wait for the same load, so no caller misses a bundled
   * plugin on a fresh start.
   */
  ready(): Promise<void> {
    const { bundled, onBundledError } = this.#bundled;
    this.#loaded ??= this.#load().then(async () => {
      if (bundled) await this.addBundled(bundled).catch((error: unknown) => onBundledError?.(error));
    });
    this.#loaded.catch(() => (this.#loaded = undefined));
    return this.#loaded;
  }

  #load(): Promise<void> {
    this.#files ??= Promise.all([
      this.index.load(),
      this.grants.load(),
      this.values.load(),
    ]).then(() => {});
    this.#files.catch(() => (this.#files = undefined));
    return this.#files;
  }

  /**
   * The tools of a project's active native plugins, as agent tools named
   * `publisher__name__tool`. Empty when the folder has no `ohmygame.json`.
   */
  async agentTools(
    folder: string,
    options: { turn?: () => string | undefined } = {},
  ): Promise<ToolDefinition[]> {
    await this.ready();
    this.#watch(folder);
    const resolved = await resolveProjectPlugins({
      folder,
      index: this.index,
      grants: this.grants,
    }).catch(() => undefined);
    if (!resolved?.ok) return [];
    const tools: ToolDefinition[] = [];
    for (const plugin of resolved.plugins) {
      const entry = plugin.entry;
      if (plugin.status !== "active" || !entry?.manifest.entrypoints?.native)
        continue;
      for (const tool of entry.manifest.contributes?.tools ?? [])
        tools.push(
          await this.#tool(entry, tool, folder, options.turn).catch(
            (error: unknown) => this.#broken(entry, tool.name, error),
          ),
        );
    }
    return tools;
  }

  /**
   * The plugins that apply without a project turning them on, those that only
   * add Skills, so there is nothing to allow: each at its newest version,
   * unless the person turned it off. With a project, only those that suit it.
   */
  async appWide(project?: AppWideProject): Promise<PluginIndexEntry[]> {
    await this.ready();
    return [...new Set(this.index.entries().map((entry) => entry.id))].sort().flatMap((id) => {
      const entry = this.index.get(id);
      if (!entry || !isAppWidePlugin(entry.manifest) || pluginApiIssue(entry.manifest) || this.grants.plugin(id)?.enabled === false) return [];
      return !project || appWidePluginSuits(entry.manifest.appliesTo, project) ? [entry] : [];
    });
  }

  /** The Skills of `appWide`, in a fixed order: when two share a name, agents keep the first. */
  async appWideSkills(project?: AppWideProject): Promise<PluginSkillRegistration[]> {
    return (await this.appWide(project)).flatMap((entry) => entry.skills.map((skill) => skillRegistration(entry, path.join(entry.root, skill.path))));
  }

  /**
   * The Skills of a project's active plugins, for agent sessions to load
   * beside the format 1 plugins' Skills.
   */
  async skills(folder: string): Promise<PluginSkillRegistration[]> {
    await this.ready();
    this.#watch(folder);
    const resolved = await resolveProjectPlugins({
      folder,
      index: this.index,
      grants: this.grants,
    }).catch(() => undefined);
    if (!resolved?.ok) return [];
    return projectSkills(resolved).map((skill) => skillRegistration(this.index.get(skill.plugin)!, path.join(skill.root, skill.path)));
  }

  /** A plugin's data folder; ids are `publisher/name`, so it stays under `dataDirectory`. */
  dataFolder(id: string): string {
    // Ids come from routes too; only a real id names a folder inside the store.
    if (!isPluginId(id)) throw new Error(`Not a plugin id: ${id}`);
    return path.join(this.dataDirectory, ...id.split("/"));
  }

  /**
   * The MCP servers of a project's active plugins, for agent sessions to
   * start beside the format 1 plugins' servers, keyed by a name unique to
   * the plugin and server. A server is left out until the settings it names
   * are filled in, and an HTTP server while its URL is outside
   * `capabilities.network`.
   */
  async mcpServers(folder: string): Promise<Record<string, McpServerDefinition>> {
    await this.ready();
    this.#watch(folder);
    const resolved = await resolveProjectPlugins({
      folder,
      index: this.index,
      grants: this.grants,
    }).catch(() => undefined);
    if (!resolved?.ok) return {};
    const servers: Record<string, McpServerDefinition> = {};
    for (const plugin of resolved.plugins) {
      const entry = plugin.entry;
      if (plugin.status !== "active" || !entry) continue;
      const values = this.values.forNative(entry);
      for (const server of entry.manifest.contributes?.mcpServers ?? []) {
        if (configReferences(server).some((name) => values[name] === undefined)) continue;
        const name = `plugin-${createHash("sha256").update(entry.id).digest("hex").slice(0, 12)}-v2-${server.id}`;
        const filled = fillConfigReferences(server, values);
        const timeout = filled.timeoutSeconds ? { requestTimeoutMs: filled.timeoutSeconds * 1000 } : {};
        if ("url" in filled) {
          // A setting can move the endpoint, but not past what the person allowed.
          if (mcpUrlIssue(filled.url, entry.manifest.capabilities?.network)) continue;
          servers[name] = {
            url: filled.url,
            ...(filled.headers ? { headers: filled.headers } : {}),
            // The adapter keeps every request on this origin, uses the URL and
            // headers as written, and turns off OAuth and redirects.
            allowedOrigins: [new URL(filled.url).origin],
            includeTools: filled.tools,
            ...timeout,
            disabled: false,
          };
          continue;
        }
        const { id: _id, title: _title, tools, cwd, timeoutSeconds: _timeout, ...launch } = filled;
        const definition = { ...launch, cwd: path.resolve(entry.root, cwd ?? ".") };
        // A setting's value is checked as the manifest's own values were.
        if (mcpServerSyntaxIssue(definition)) continue;
        const dataFolder = this.dataFolder(entry.id);
        await mkdir(dataFolder, { recursive: true, mode: 0o700 });
        servers[name] = {
          ...definition,
          env: { ...definition.env, [PLUGIN_DATA_ENV]: dataFolder },
          literalEnv: true,
          includeTools: tools,
          ...timeout,
          disabled: false,
        };
      }
    }
    return servers;
  }

  /**
   * The commands of a project's active plugins, for the host to place in
   * their slots and `/`. Each says how it runs: the app runs prompts, URLs,
   * panels and settings itself; tools and native calls go through the
   * daemon's command route.
   */
  async commands(
    folder: string,
    locale: PluginLocale = "en",
  ): Promise<ProjectCommand[]> {
    await this.ready();
    const resolved = await resolveProjectPlugins({
      folder,
      index: this.index,
      grants: this.grants,
    }).catch(() => undefined);
    if (!resolved?.ok) return [];
    const commands: ProjectCommand[] = [];
    for (const plugin of resolved.plugins) {
      const entry = plugin.entry;
      if (plugin.status !== "active" || !entry) continue;
      for (const command of entry.manifest.contributes?.commands ?? [])
        commands.push({
          id: `${entry.id}:${command.id}`,
          plugin: entry.id,
          title: localizePluginString(entry, command.title, locale),
          ...(command.slash ? { slash: command.slash } : {}),
          slots: command.slots ?? [],
          run: command.run,
        });
    }
    return commands;
  }

  /** The panels of a project's active plugins, with what their pages may ask the host for. */
  async panels(
    folder: string,
    locale: PluginLocale = "en",
  ): Promise<ProjectPanel[]> {
    await this.ready();
    const resolved = await resolveProjectPlugins({
      folder,
      index: this.index,
      grants: this.grants,
    }).catch(() => undefined);
    if (!resolved?.ok) return [];
    const panels: ProjectPanel[] = [];
    for (const plugin of resolved.plugins) {
      const entry = plugin.entry;
      if (plugin.status !== "active" || !entry) continue;
      const capabilities = entry.manifest.capabilities ?? {};
      for (const panel of entry.manifest.contributes?.panels ?? [])
        panels.push({
          id: panel.id,
          plugin: entry.id,
          version: entry.version,
          title: localizePluginString(entry, panel.title, locale),
          area: panel.area,
          ...(panel.when ? { when: panel.when } : {}),
          capabilities: {
            ...(capabilities["project.selection"] ? { "project.selection": true } : {}),
            ...(capabilities.composer ? { composer: true } : {}),
          },
          commands: (entry.manifest.contributes?.commands ?? []).map((command) => command.id),
        });
    }
    return panels;
  }

  /** A command of a project's active plugin, at the version the project uses. */
  async projectCommand(folder: string, id: string) {
    await this.ready();
    const at = id.lastIndexOf(":");
    const pluginId = id.slice(0, at);
    const resolved = await resolveProjectPlugins({
      folder,
      index: this.index,
      grants: this.grants,
    });
    const plugin = resolved?.ok
      ? resolved.plugins.find((item) => item.id === pluginId)
      : undefined;
    if (!plugin?.entry || plugin.status !== "active") return undefined;
    const command = plugin.entry.manifest.contributes?.commands?.find(
      (item) => item.id === id.slice(at + 1),
    );
    return command ? { entry: plugin.entry, command } : undefined;
  }

  /**
   * Whether a project of a plugin type may take a prompt, from the type's
   * `ready` command. Only an answer of `{ ready: false }` holds a prompt back:
   * a plugin that is off, missing or failing never locks the project.
   */
  async projectReady(
    folder: string,
    type: string,
  ): Promise<{ ready: true } | { ready: false; message?: string; panel: string }> {
    const owner = projectTypePlugin(type);
    if (!owner) return { ready: true };
    await this.ready();
    const resolved = await resolveProjectPlugins({ folder, index: this.index, grants: this.grants }).catch(() => undefined);
    const plugin = resolved?.ok ? resolved.plugins.find((item) => item.id === owner) : undefined;
    const entry = plugin?.status === "active" ? plugin.entry : undefined;
    const check = entry?.manifest.contributes?.projectTypes?.find((item) => `${owner}:${item.id}` === type)?.ready;
    if (!entry || !check) return { ready: true };
    let answer: unknown;
    try {
      answer = await this.native.runCommand(`${owner}:${check.command}`, {
        folder,
        version: entry.version,
        timeoutMs: READY_TIMEOUT_MS,
      });
    } catch {
      return { ready: true };
    }
    if (!answer || typeof answer !== "object" || (answer as { ready?: unknown }).ready !== false) return { ready: true };
    const message = (answer as { message?: unknown }).message;
    return {
      ready: false,
      ...(typeof message === "string" && message.trim() ? { message: message.slice(0, 500) } : {}),
      panel: `${owner}:${check.panel}`,
    };
  }

  /** Sets some of a plugin's configuration; the next call to its native code sees them. */
  async configure(
    id: string,
    changes: Record<string, string | boolean | null>,
  ): Promise<void> {
    await this.ready();
    const entry = this.index.get(id);
    if (!entry) throw new Error(`${id} is not installed`);
    await this.values.update(entry, changes);
    await this.changed();
  }

  /**
   * Runs when what a project's plugins offer may have changed: after an
   * install, a decision, or a change to `ohmygame.json`. Sessions listen to
   * rebuild their tools; `folder` is undefined when every project may be
   * affected.
   */
  onChange(listener: (folder?: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Unloads what projects no longer allow and tells listeners. Every change
   * to the index, the decisions or a project file goes through here, or
   * through the methods below that call it.
   */
  async changed(folder?: string): Promise<void> {
    await this.ready();
    await this.#notify(folder);
  }

  async #notify(folder?: string): Promise<void> {
    await (folder ? this.native.refreshProject(folder) : this.native.refresh());
    for (const listener of this.#listeners) {
      try {
        listener(folder);
      } catch {
        // A listener failing doesn't stop the others.
      }
    }
  }

  async install(root: string) {
    await this.ready();
    const result = await this.index.add(root);
    if (result.ok) await this.changed();
    return result;
  }

  /**
   * Indexes the format 2 plugins that ship with the app, in place. They are
   * OhMyGame's own, so what they ask for is allowed at install, unless the
   * person turned one off; each project still allows them in its folder.
   */
  async addBundled(directory: string): Promise<PluginPackageResult[]> {
    // `ready()` runs this, so it waits only for the files.
    await this.#load();
    const folders = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    const results: PluginPackageResult[] = [];
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const root = path.join(directory, folder.name);
      const result = await this.index.add(root);
      results.push(result);
      if (!result.ok || !result.entry.id.startsWith("ohmygame/")) continue;
      // No project pins one that applies by itself, so a version this folder
      // used to hold goes; a version installed apart stays.
      if (isAppWidePlugin(result.entry.manifest))
        for (const stale of this.index.versions(result.entry.id))
          if (stale.version !== result.entry.version && path.resolve(stale.root) === path.resolve(root)) await this.index.remove(stale.id, stale.version);
      const decided = this.grants.plugin(result.entry.id);
      if (decided?.enabled === false) continue;
      // One that starts off asks for consent when the person turns it on.
      if (!decided && this.#bundledOff.has(result.entry.id)) {
        await this.grants.setEnabled(result.entry.id, false);
        continue;
      }
      await this.grants.consent(
        result.entry.id,
        capabilityGrants(result.entry.manifest),
      );
    }
    await this.#notify();
    return results;
  }

  /**
   * Copies a package into the store and allows what it asks for; the caller
   * vouches for it. The same version replaces its older copy, and a choice to
   * turn the plugin off stays.
   */
  async installManaged(source: string): Promise<PluginIndexEntry> {
    await this.ready();
    const checked = await indexPluginPackage(source);
    if (!checked.ok) throw new Error(`Not a valid plugin: ${checked.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    const { id, version } = checked.entry;
    const target = path.join(this.packagesDirectory, ...id.split("/"), version);
    const staging = path.join(this.packagesDirectory, `.staging-${randomUUID()}`);
    await mkdir(this.packagesDirectory, { recursive: true });
    try {
      await cp(source, staging, { recursive: true, verbatimSymlinks: true });
      await rm(target, { recursive: true, force: true });
      await mkdir(path.dirname(target), { recursive: true });
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    const result = await this.index.add(target);
    if (!result.ok) {
      await rm(target, { recursive: true, force: true });
      throw new Error(`Not a valid plugin: ${result.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    }
    await this.grants.consent(id, capabilityGrants(result.entry.manifest));
    await this.changed();
    return result.entry;
  }

  async uninstall(id: string, version?: string): Promise<void> {
    await this.ready();
    const removed = version
      ? [this.index.get(id, version)].filter((entry) => entry !== undefined)
      : this.index.versions(id);
    if (!removed.length) return;
    await this.index.remove(id, version);
    const last = !this.index.versions(id).length;
    if (last) {
      await this.grants.forget(id);
      await this.values.forget(id);
    }
    // Hosts let go of the removed versions before their files go.
    await this.changed();
    for (const entry of removed) {
      const inside = path.relative(this.packagesDirectory, entry.root);
      if (inside && !inside.startsWith("..") && !path.isAbsolute(inside))
        await rm(entry.root, { recursive: true, force: true });
    }
    if (last) await rm(this.dataFolder(id), { recursive: true, force: true });
  }

  /** Records what the person allowed at install; a new plugin starts on. */
  async consent(id: string, allowed: readonly string[]): Promise<void> {
    await this.ready();
    await this.grants.consent(id, allowed);
    await this.changed();
  }

  /** The app switch; turning a plugin back on releases a quarantine. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.ready();
    await this.grants.setEnabled(id, enabled);
    if (enabled) this.native.release(id);
    await this.changed();
  }

  async approve(
    folder: string,
    id: string,
    allowed: readonly string[],
  ): Promise<void> {
    await this.ready();
    await this.grants.approve(await projectFolderKey(folder), id, allowed);
    await this.changed(folder);
  }

  async revoke(folder: string, id: string): Promise<void> {
    await this.ready();
    await this.grants.revoke(await projectFolderKey(folder), id);
    await this.changed(folder);
  }

  /** Turns a plugin on in a project at a version, or off with `null`. */
  async setProjectPlugin(
    folder: string,
    id: string,
    version: string | null,
    initialType?: string,
  ): Promise<void> {
    await this.ready();
    await setProjectPlugin({
      folder,
      id,
      version,
      index: this.index,
      grants: this.grants,
      ...(initialType ? { initialType } : {}),
    });
    await this.changed(folder);
  }

  async close(): Promise<void> {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    await this.native.dispose();
  }

  /** Stops watching a project and its host, as when it is deleted. */
  async closeProject(folder: string): Promise<void> {
    this.#watchers.get(folder)?.close();
    this.#watchers.delete(folder);
    await this.native.closeProject(folder);
  }

  /**
   * Watches the folder, not the file: atomic saves replace the file. A
   * change to `ohmygame.json` by hand, by git or by an agent counts as a
   * change to the project's plugins.
   */
  #watch(folder: string) {
    if (this.#watchers.has(folder)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const watcher = watch(folder, { persistent: false }, (_event, name) => {
        if (name !== null && String(name) !== PROJECT_FILE_NAME) return;
        clearTimeout(timer);
        timer = setTimeout(
          () => void this.changed(folder).catch(() => {}),
          200,
        );
      });
      watcher.on("error", () => {
        watcher.close();
        this.#watchers.delete(folder);
      });
      this.#watchers.set(folder, watcher);
    } catch {
      // A folder that can't be watched still works; edits show next session.
    }
  }

  async #tool(
    entry: PluginIndexEntry,
    tool: NonNullable<
      NonNullable<PluginIndexEntry["manifest"]["contributes"]>["tools"]
    >[number],
    folder: string,
    turn: (() => string | undefined) | undefined,
  ): Promise<ToolDefinition> {
    const parameters = this.#schema(entry, tool.input);
    const output = tool.output ? this.#schema(entry, tool.output) : undefined;
    const name = agentToolName(entry.id, tool.name);
    return {
      name,
      label: `${localizePluginString(entry, entry.manifest.displayName, "en")}: ${tool.name}`,
      description: localizePluginString(entry, tool.description, "en"),
      parameters,
      ...(output ? { outputSchema: output } : {}),
      namespace: { name: entry.id.replace("/", "__") },
      execute: async (
        toolCallId,
        input,
        signal,
        onUpdate,
      ): Promise<AgentToolResult<unknown>> => {
        const value = await this.callTool(entry, tool.name, {
          folder,
          input,
          signal,
          onProgress: (message, url) =>
            onUpdate?.({
              content: [{ type: "text", text: url ? `${message}\n${url}` : message }],
              details: { plugin: entry.id, tool: tool.name, progress: message, ...(url ? { url } : {}) },
            }),
          turn: turn?.() ?? toolCallId,
        });
        const text =
          typeof value === "string"
            ? value
            : (JSON.stringify(value ?? null, null, 2) ?? "null");
        return {
          content: [
            {
              type: "text",
              text:
                text.length > TOOL_TEXT_MAX_CHARS
                  ? `${text.slice(0, TOOL_TEXT_MAX_CHARS)}\n… (cut at ${TOOL_TEXT_MAX_CHARS} characters)`
                  : text,
            },
          ],
          details: { plugin: entry.id, tool: tool.name },
          ...(output ? { structuredContent: value as never } : {}),
        };
      },
    };
  }

  /**
   * Runs a plugin tool with its input and result checked against the schemas
   * its manifest names. Agents and commands both call tools through here.
   */
  async callTool(
    entry: PluginIndexEntry,
    name: string,
    options: Omit<PluginCallOptions, "version">,
  ): Promise<unknown> {
    const tool = entry.manifest.contributes?.tools?.find((item) => item.name === name);
    if (!tool) throw new Error(`${entry.id} does not declare a tool named ${name}`);
    const id = `${entry.id}:${name}`;
    const input = this.#schema(entry, tool.input);
    if (!Check(input, options.input ?? {})) throw new PluginToolSchemaError(id, "input", input, options.input ?? {});
    // A session made before a version change must not run the new code with
    // this version's schemas.
    const value = await this.native.callTool(id, { ...options, input: options.input ?? {}, version: entry.version });
    const output = tool.output ? this.#schema(entry, tool.output) : undefined;
    if (output && !Check(output, value)) throw new PluginToolSchemaError(id, "output", output, value);
    return value;
  }

  /**
   * Runs a command that runs plugin code. A tool command's `input`, from a
   * page or the manifest, is checked by the tool; a native command takes
   * input only when it declares a schema for it.
   */
  async runCommand(
    entry: PluginIndexEntry,
    command: PluginCommand,
    options: Pick<PluginCallOptions, "folder" | "input" | "onProgress">,
  ): Promise<unknown> {
    const { run } = command;
    const id = `${entry.id}:${command.id}`;
    if ("tool" in run) return this.callTool(entry, run.tool, { ...options, input: options.input ?? run.input ?? {} });
    if (!("native" in run)) throw new PluginCommandInputError(`${id} runs in the app`);
    if (!run.input) {
      if (options.input !== undefined) throw new PluginCommandInputError(`${id} takes no input`);
      return this.native.runCommand(id, { ...options, version: entry.version });
    }
    const schema = this.#schema(entry, run.input);
    const input = options.input ?? {};
    if (!Check(schema, input)) throw new PluginToolSchemaError(id, "input", schema, input);
    return this.native.runCommand(id, { ...options, version: entry.version, input });
  }

  /** A tool whose schema can't be read still shows, and says why it can't run. */
  #broken(
    entry: PluginIndexEntry,
    tool: string,
    error: unknown,
  ): ToolDefinition {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: agentToolName(entry.id, tool),
      label: `${entry.id}: ${tool}`,
      description: `Unavailable: ${message}`,
      parameters: { type: "object", properties: {} } as unknown as TSchema,
      execute: () => {
        throw new Error(`${entry.id} can't run ${tool}: ${message}`);
      },
    };
  }

  /** A schema the index checked and kept from the package's bytes. */
  #schema(entry: PluginIndexEntry, file: string): TSchema {
    const schema = entry.toolSchemas?.[file];
    if (!schema) throw new Error(`${file} was not indexed`);
    return structuredClone(schema) as unknown as TSchema;
  }
}
