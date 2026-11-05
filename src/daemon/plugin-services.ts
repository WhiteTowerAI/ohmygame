import { createHash, randomUUID } from "node:crypto";
import { CANVAS_PRESET_MAX_BYTES, canvasPresetIssue, type CanvasPresetBoard } from "../shared/canvas-plugin-nodes.js";
import { watch, type FSWatcher } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { agentToolName, configReferences, fillConfigReferences, isAppWidePlugin, isPluginId, mcpServerSyntaxIssue, PERSONAL_PUBLISHER, mcpUrlIssue, PLUGIN_DATA_ENV, pluginApiIssue, type PluginManifestV2 } from "../shared/plugin-manifest.js";
import type { McpServerDefinition, ProjectPluginCanvas } from "../shared/plugins.js";
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
  missingGrants,
  onInEveryProject,
  PluginGrants,
  projectFolderKey,
  projectSkills,
  resolveProjectPlugins,
  setProjectPlugin,
  type PluginScope,
  type ProjectKind,
  type ProjectPlugins,
} from "./project-plugins.js";
import type { PluginSkillRegistration } from "./plugin-runtime.js";

// The plugin services the daemon holds: the index of installed
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
  /** The plugin's brand colour, which the app checks before using. */
  accent?: string | { light?: string; dark?: string };
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

export interface PluginServicesOptions {
  /** The folder for the index and decisions, inside the app's data folder. */
  directory: string;
  hosts?: ExtensionHostOptions;
  /** The plugins that ship with the app, indexed by `ready()` before anything is served. */
  bundled?: string;
  /** Told when the bundled plugins can't be indexed; everything else still loads. */
  onBundledError?: (error: unknown) => void;
  /** Bundled plugins that start off in every project, such as one in beta, until the person turns them on. */
  bundledOff?: readonly string[];
  /** What the project in a folder (its real path) is, for matching plugins' `appliesTo`. */
  projectKind?: PluginScope["kind"];
}

/** A plugin's Skill as agent sessions load it. Plugins have no marketplace; their publisher stands in. */
function skillRegistration(entry: PluginIndexEntry, file: string): PluginSkillRegistration {
  return {
    path: file,
    pluginDisplayName: localizePluginString(entry, entry.manifest.displayName, "en"),
    marketplaceDisplayName: entry.id.split("/")[0]!,
  };
}

/** Publishers whose names only the app and the Plugin Builder can give out. */
export const RESERVED_PUBLISHERS: ReadonlySet<string> = new Set(["ohmygame", PERSONAL_PUBLISHER]);

export function assertAddablePlugin(id: string): void {
  const publisher = id.slice(0, id.indexOf("/"));
  if (RESERVED_PUBLISHERS.has(publisher)) throw new Error(`Plugins added from outside the app can't use the publisher "${publisher}": ${id}`);
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
  #packageChanges: Promise<unknown> = Promise.resolve();
  readonly #bundledOff: ReadonlySet<string>;
  readonly #projectKind: PluginScope["kind"];
  /** Holds each plugin's data folder, `<publisher>/<name>`. */
  readonly dataDirectory: string;
  readonly #bundled: Pick<PluginServicesOptions, "bundled" | "onBundledError">;
  #files: Promise<void> | undefined;
  #loaded: Promise<void> | undefined;
  readonly #listeners = new Set<(folder?: string) => void>();
  /**
   * Project folders whose `ohmygame.json` is watched, for edits made outside
   * OhMyGame, each with the report it is waiting to send and the last one
   * it sent.
   */
  readonly #watchers = new Map<
    string,
    {
      watcher: FSWatcher;
      timer?: ReturnType<typeof setTimeout>;
      report?: Promise<void>;
    }
  >();

  constructor(options: PluginServicesOptions) {
    this.index = new PluginIndex(path.join(options.directory, "index.json"));
    this.grants = new PluginGrants(path.join(options.directory, "grants.json"));
    this.hosts = new ExtensionHosts(options.hosts);
    this.values = new PluginValues(
      path.join(options.directory, "configuration.json"),
    );
    this.packagesDirectory = path.join(options.directory, "packages");
    this.#bundledOff = new Set(options.bundledOff);
    this.#projectKind = options.projectKind;
    this.dataDirectory = path.join(options.directory, "data");
    this.#bundled = options;
    this.native = new NativePlugins({
      index: this.index,
      resolve: (folder) => this.resolve(folder),
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
    const resolved = await this.resolve(folder).catch(() => undefined);
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

  /** What deciding which plugins are on in a project needs. */
  get scope(): PluginScope {
    return { index: this.index, grants: this.grants, startsOff: this.#bundledOff, kind: this.#projectKind };
  }

  /** Every plugin on in the project in a folder, or that its file asks for, and whether each runs. */
  async resolve(folder: string): Promise<ProjectPlugins> {
    await this.ready();
    return resolveProjectPlugins({ folder, ...this.scope });
  }

  /** Whether a plugin is on in every project it suits. */
  onInEveryProject(id: string): boolean {
    return onInEveryProject(this.scope, id);
  }

  /**
   * The plugins on in every project, each at its newest version, that run
   * without anything left to allow; with a kind, only those that suit it. A
   * new project starts with these.
   */
  async everyProject(kind?: ProjectKind): Promise<PluginIndexEntry[]> {
    await this.ready();
    return [...new Set(this.index.entries().map((entry) => entry.id))].sort().flatMap((id) => {
      const entry = this.index.get(id);
      const grant = this.grants.plugin(id);
      if (!entry || pluginApiIssue(entry.manifest) || grant?.enabled === false || !this.onInEveryProject(id)) return [];
      if (missingGrants(capabilityGrants(entry.manifest), grant?.allowed ?? []).length) return [];
      return !kind || appWidePluginSuits(entry.manifest.appliesTo, kind) ? [entry] : [];
    });
  }

  /**
   * The newest version of each installed plugin that this app can run and
   * that isn't disabled everywhere. What a plugin adds to the app itself,
   * such as model providers, comes from these, whatever projects turn on.
   */
  async installed(): Promise<PluginIndexEntry[]> {
    await this.ready();
    return [...new Set(this.index.entries().map((entry) => entry.id))].sort().flatMap((id) => {
      const entry = this.index.get(id);
      return entry && !pluginApiIssue(entry.manifest) && this.grants.plugin(id)?.enabled !== false ? [entry] : [];
    });
  }

  /** The Skills of `everyProject`, as a new project's agent would load them. */
  async everyProjectSkills(kind?: ProjectKind): Promise<PluginSkillRegistration[]> {
    return (await this.everyProject(kind)).flatMap((entry) => entry.skills.map((skill) => skillRegistration(entry, path.join(entry.root, skill.path))));
  }

  /**
   * The Skills of a project's active plugins, for agent sessions to load.
   */
  async skills(folder: string): Promise<PluginSkillRegistration[]> {
    await this.ready();
    this.#watch(folder);
    const resolved = await this.resolve(folder).catch(() => undefined);
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
   * start, keyed by a name unique to the plugin and server. A server is left out until the settings it names
   * are filled in, and an HTTP server while its URL is outside
   * `capabilities.network`.
   */
  async mcpServers(folder: string): Promise<Record<string, McpServerDefinition>> {
    await this.ready();
    this.#watch(folder);
    const resolved = await this.resolve(folder).catch(() => undefined);
    if (!resolved?.ok) return {};
    const servers: Record<string, McpServerDefinition> = {};
    for (const plugin of resolved.plugins) {
      const entry = plugin.entry;
      if (plugin.status !== "active" || !entry) continue;
      for (const server of entry.manifest.contributes?.mcpServers ?? []) {
        const definition = await this.#mcpDefinition(entry, server);
        if (definition) servers[`plugin-${createHash("sha256").update(entry.id).digest("hex").slice(0, 12)}-v2-${server.id}`] = definition;
      }
    }
    return servers;
  }

  /** How to start one of a plugin's MCP servers, unless a setting is missing or a value breaks a rule. */
  async #mcpDefinition(
    entry: PluginIndexEntry,
    server: NonNullable<NonNullable<PluginManifestV2["contributes"]>["mcpServers"]>[number],
    values: ReturnType<PluginValues["forNative"]> = this.values.forNative(entry),
  ): Promise<McpServerDefinition | undefined> {
    if (configReferences(server).some((name) => values[name] === undefined)) return undefined;
    const filled = fillConfigReferences(server, values);
    const timeout = filled.timeoutSeconds ? { requestTimeoutMs: filled.timeoutSeconds * 1000 } : {};
    if ("url" in filled) {
      // A setting can move the endpoint, but not past what the person allowed.
      if (mcpUrlIssue(filled.url, entry.manifest.capabilities?.network)) return undefined;
      return {
        url: filled.url,
        ...(filled.headers ? { headers: filled.headers } : {}),
        // The adapter keeps every request on this origin, uses the URL and
        // headers as written, and turns off OAuth and redirects.
        allowedOrigins: [new URL(filled.url).origin],
        includeTools: filled.tools,
        ...timeout,
        disabled: false,
      };
    }
    const { id: _id, title: _title, tools, cwd, timeoutSeconds: _timeout, ...launch } = filled;
    const definition = { ...launch, cwd: path.resolve(entry.root, cwd ?? ".") };
    // A setting's value is checked as the manifest's own values were.
    if (mcpServerSyntaxIssue(definition)) return undefined;
    const dataFolder = this.dataFolder(entry.id);
    await mkdir(dataFolder, { recursive: true, mode: 0o700 });
    return {
      ...definition,
      env: { ...definition.env, [PLUGIN_DATA_ENV]: dataFolder },
      literalEnv: true,
      includeTools: tools,
      ...timeout,
      disabled: false,
    };
  }

  /**
   * One MCP server of a draft, to try it. Saved settings, secrets included, are
   * only for `withSaved`: a package the person installed, and so reviewed. Any
   * other draft could name an installed plugin to send them somewhere else, so
   * it gets the manifest's defaults.
   */
  async draftMcpServer(root: string, serverId: string, { withSaved }: { withSaved: boolean }): Promise<{ definition?: McpServerDefinition; secrets: string[] }> {
    await this.ready();
    const checked = await indexPluginPackage(root);
    if (!checked.ok) throw new Error("Prepare a valid draft before testing");
    const server = checked.entry.manifest.contributes?.mcpServers?.find((item) => item.id === serverId);
    if (!server) throw new Error("MCP server not found in this draft");
    const fields = Object.entries(checked.entry.manifest.configuration ?? {});
    const values = withSaved
      ? this.values.forNative(checked.entry)
      : Object.fromEntries(fields.flatMap(([name, field]) => field.default === undefined ? [] : [[name, field.default]]));
    const secrets = fields.flatMap(([name, field]) => field.type === "secret" && typeof values[name] === "string" ? [values[name] as string] : []);
    return { definition: await this.#mcpDefinition(checked.entry, server, values), secrets };
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
    const resolved = await this.resolve(folder).catch(() => undefined);
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

  /** What a project's active plugins add to Asset Canvas, in `locale`. */
  async canvas(
    folder: string,
    locale: PluginLocale = "en",
  ): Promise<ProjectPluginCanvas> {
    await this.ready();
    const resolved = await this.resolve(folder).catch(() => undefined);
    const canvas: ProjectPluginCanvas = { nodes: [], presets: [] };
    if (!resolved?.ok) return canvas;
    for (const plugin of resolved.plugins) {
      const entry = plugin.entry;
      if (plugin.status !== "active" || !entry) continue;
      const text = (value: string) => localizePluginString(entry, value, locale);
      const pluginName = text(entry.manifest.displayName);
      for (const node of entry.manifest.contributes?.canvasNodes ?? [])
        canvas.nodes.push({
          id: `${entry.id}:${node.id}`,
          plugin: entry.id,
          pluginName,
          title: text(node.title),
          ...(node.description ? { description: text(node.description) } : {}),
          inputs: (node.inputs ?? []).map((input) => ({ ...input, title: text(input.title) })),
          params: Object.entries(node.params ?? {}).map(([key, param]) => ({
            key,
            ...param,
            title: text(param.title),
            ...(param.description ? { description: text(param.description) } : {}),
          })),
          output: node.output,
        });
      for (const preset of entry.manifest.contributes?.canvasPresets ?? [])
        canvas.presets.push({
          id: `${entry.id}:${preset.id}`,
          plugin: entry.id,
          pluginName,
          title: text(preset.title),
          ...(preset.description ? { description: text(preset.description) } : {}),
        });
    }
    return canvas;
  }

  /** A preset's nodes and edges, from an active plugin's package, checked again as it is read. */
  async canvasPreset(folder: string, plugin: string, id: string): Promise<CanvasPresetBoard | undefined> {
    await this.ready();
    const resolved = await this.resolve(folder).catch(() => undefined);
    const entry = resolved?.ok ? resolved.plugins.find((candidate) => candidate.status === "active" && candidate.entry?.id === plugin)?.entry : undefined;
    const preset = entry?.manifest.contributes?.canvasPresets?.find((candidate) => candidate.id === id);
    if (!entry || !preset) return undefined;
    const file = path.join(entry.root, preset.board);
    const bytes = await readFile(file);
    if (bytes.length > CANVAS_PRESET_MAX_BYTES) throw new Error(`${preset.board} is too large`);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const problem = canvasPresetIssue(value);
    if (problem) throw new Error(`${preset.board} ${problem}`);
    const board = value as Partial<CanvasPresetBoard>;
    return { nodes: board.nodes!, edges: board.edges ?? [] };
  }

  /** The panels of a project's active plugins, with what their pages may ask the host for. */
  async panels(
    folder: string,
    locale: PluginLocale = "en",
  ): Promise<ProjectPanel[]> {
    await this.ready();
    const resolved = await this.resolve(folder).catch(() => undefined);
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
            ...(capabilities["project.files"] ? { "project.files": capabilities["project.files"] } : {}),
            ...(capabilities["project.history"] ? { "project.history": true } : {}),
            ...(capabilities["project.usage"] ? { "project.usage": true } : {}),
          },
          commands: (entry.manifest.contributes?.commands ?? []).map((command) => command.id),
          ...(entry.manifest.ui?.accent ? { accent: entry.manifest.ui.accent } : {}),
        });
    }
    return panels;
  }

  /** A command of a project's active plugin, at the version the project uses. */
  async projectCommand(folder: string, id: string) {
    await this.ready();
    const at = id.lastIndexOf(":");
    const pluginId = id.slice(0, at);
    const resolved = await this.resolve(folder);
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
    locale: PluginLocale = "en",
  ): Promise<{ ready: true } | { ready: false; message?: string; panel: string }> {
    const owner = projectTypePlugin(type);
    if (!owner) return { ready: true };
    await this.ready();
    const resolved = await this.resolve(folder).catch(() => undefined);
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
      // A `%key%` message comes from the plugin's locale files, in the person's language.
      ...(typeof message === "string" && message.trim() ? { message: localizePluginString(entry, message, locale).slice(0, 500) } : {}),
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
   * Indexes the plugins that ship with the app, in place. They are
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
      // A version this folder used to hold, or a folder the app no longer has,
      // goes; a version installed apart stays.
      for (const other of this.index.versions(result.entry.id))
        if (other.version !== result.entry.version) await this.index.verify(other.id, other.version);
      if (this.grants.plugin(result.entry.id)?.enabled === false) continue;
      // One that starts off asks for consent when the person turns it on, and
      // only that consent counts: a record of where it is on allows nothing.
      if (this.#bundledOff.has(result.entry.id)) continue;
      await this.grants.consent(
        result.entry.id,
        capabilityGrants(result.entry.manifest),
      );
    }
    await this.#notify();
    return results;
  }

  /**
   * Copies a package into the store and, unless told not to, allows what it
   * asks for; the caller vouches for it. The same version replaces its older
   * copy, and a choice to turn the plugin off stays.
   */
  installManaged(source: string, { consent = true }: { consent?: boolean } = {}): Promise<PluginIndexEntry> {
    return this.#onePackageChangeAtATime(() => this.#installManaged(source, consent));
  }

  async #installManaged(source: string, consent: boolean): Promise<PluginIndexEntry> {
    await this.ready();
    const checked = await indexPluginPackage(source);
    if (!checked.ok) throw new Error(`Not a valid plugin: ${checked.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    const { id, version } = checked.entry;
    const target = path.join(this.packagesDirectory, ...id.split("/"), version);
    const staging = path.join(this.packagesDirectory, `.staging-${randomUUID()}`);
    const previous = path.join(this.packagesDirectory, `.replaced-${randomUUID()}`);
    await mkdir(this.packagesDirectory, { recursive: true });
    let movedAside = false;
    let placed = false;
    let entry: PluginIndexEntry;
    try {
      await cp(source, staging, { recursive: true, verbatimSymlinks: true });
      await mkdir(path.dirname(target), { recursive: true });
      movedAside = await rename(target, previous).then(() => true, (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return false;
        throw cause;
      });
      await rename(staging, target);
      placed = true;
      const result = await this.index.add(target);
      if (!result.ok) throw new Error(`Not a valid plugin: ${result.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
      entry = result.entry;
    } catch (cause) {
      // The copy it was replacing is still in use, so it goes back.
      if (placed) await rm(target, { recursive: true, force: true });
      if (movedAside) await rename(previous, target);
      throw cause;
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(previous, { recursive: true, force: true });
    }
    if (consent) await this.grants.consent(id, capabilityGrants(entry.manifest));
    await this.changed();
    return entry;
  }

  /**
   * Installs a package the person made. These are all `personal/<name>`, so
   * one can't replace what the app or a publisher ships.
   */
  async installPersonal(source: string, options: { consent: boolean }): Promise<PluginIndexEntry> {
    const checked = await indexPluginPackage(source);
    if (checked.ok && !checked.entry.id.startsWith(`${PERSONAL_PUBLISHER}/`))
      throw new Error(`The plugin's id must be ${PERSONAL_PUBLISHER}/<name>, not ${checked.entry.id}`);
    return this.#replacingAppWide(await this.installManaged(source, options));
  }

  /**
   * Installs a package the person added from npm, GitHub or a file. It allows
   * nothing: what it asks for waits for the person, in a project's Plugins
   * sheet. It can't take a name the app or the Plugin Builder uses.
   */
  async installAdded(source: string): Promise<PluginIndexEntry> {
    const checked = await indexPluginPackage(source);
    if (checked.ok) assertAddablePlugin(checked.entry.id);
    return this.#replacingAppWide(await this.installManaged(source, { consent: false }));
  }

  /** A new version of a plugin that only adds Skills replaces its older versions; any other keeps them for the projects that name them. */
  async #replacingAppWide(entry: PluginIndexEntry): Promise<PluginIndexEntry> {
    if (isAppWidePlugin(entry.manifest))
      for (const older of this.index.versions(entry.id))
        if (older.version !== entry.version && isAppWidePlugin(older.manifest)) await this.uninstall(entry.id, older.version);
    return entry;
  }

  uninstall(id: string, version?: string): Promise<void> {
    return this.#onePackageChangeAtATime(() => this.#uninstall(id, version));
  }

  /** Installing and uninstalling share folders, so one can't delete what the other just placed. */
  #onePackageChangeAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#packageChanges.then(work);
    this.#packageChanges = run.catch(() => undefined);
    return run;
  }

  async #uninstall(id: string, version?: string): Promise<void> {
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

  /** Turns a plugin on or off in every project it suits; projects that set it themselves keep that. */
  async setEveryProject(id: string, on: boolean): Promise<void> {
    await this.ready();
    if (!this.index.get(id)) throw new Error(`${id} is not installed`);
    await this.grants.setEveryProject(id, on);
    await this.changed();
  }

  /** The switch that stops a plugin everywhere; turning it back on releases a quarantine. */
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

  /** Turns a plugin on in a project, at a version or its newest, or off. */
  async setProjectPlugin(
    folder: string,
    id: string,
    on: boolean,
    options: { version?: string; initialType?: string } = {},
  ): Promise<void> {
    await this.ready();
    await setProjectPlugin({ folder, id, on, ...options, ...this.scope });
    await this.changed(folder);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#watchers.keys()].map((folder) => this.#unwatch(folder)),
    );
    await this.native.dispose();
  }

  /**
   * Stops watching a project and its host, as when it is deleted. A report
   * the watcher was still waiting to send is dropped; one already on its way
   * finishes first.
   */
  async closeProject(folder: string): Promise<void> {
    await this.#unwatch(folder);
    await this.native.closeProject(folder);
  }

  /**
   * Watches the folder, not the file: atomic saves replace the file. A
   * change to `ohmygame.json` by hand, by git or by an agent counts as a
   * change to the project's plugins.
   */
  #watch(folder: string) {
    if (this.#watchers.has(folder)) return;
    try {
      const watcher = watch(folder, { persistent: false }, (_event, name) => {
        if (name !== null && String(name) !== PROJECT_FILE_NAME) return;
        const watched = this.#watchers.get(folder);
        if (watched?.watcher !== watcher) return;
        clearTimeout(watched.timer);
        watched.timer = setTimeout(() => {
          watched.timer = undefined;
          watched.report = this.changed(folder).catch(() => {});
        }, 200);
      });
      // A watcher that fails still sends what it saw; the next call to
      // `#watch` starts a new one.
      watcher.on("error", () => {
        watcher.close();
        if (this.#watchers.get(folder)?.watcher === watcher)
          this.#watchers.delete(folder);
      });
      this.#watchers.set(folder, { watcher });
    } catch {
      // A folder that can't be watched still works; edits show next session.
    }
  }

  /**
   * Stops watching the folder: drops the report it still owed and waits for
   * one it already sent.
   */
  async #unwatch(folder: string): Promise<void> {
    const watched = this.#watchers.get(folder);
    if (!watched) return;
    clearTimeout(watched.timer);
    watched.watcher.close();
    this.#watchers.delete(folder);
    await watched.report;
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
    options: Pick<PluginCallOptions, "folder" | "input" | "onProgress" | "build">,
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
