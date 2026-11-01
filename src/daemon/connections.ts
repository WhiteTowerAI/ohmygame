// Connections: MCP servers the person added themselves, available to every
// project's agent. They used to be format 1 plugins that held only MCP
// servers ("Add MCP", or imported from the old `mcp.json`); `migrate` moves
// those here and leaves the plugins untouched, so an older app still finds
// them. Definitions, values and secrets live in the plugin configuration store
// (encrypted), owned by `connection:<id>`.

import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectType } from "../shared/contracts.js";
import type { ConnectionSummary, CreateConnectionRequest, UpdateConnectionRequest } from "../shared/connections.js";
import {
  PERSONAL_MARKETPLACE,
  isPluginManifest,
  type McpServerDefinition,
  type PluginConfigurationField,
  type PluginConfigurationValues,
  type PluginConfigurationView,
  type PluginDetail,
  type PluginMcpResult,
} from "../shared/plugins.js";
import { isMcpServerDefinition } from "./local-plugins.js";
import { PluginConfigurationError, type ConfigurationOwner, type PluginConfigurationStore } from "./plugin-configuration.js";
import { protectDefinitions, substitute, type PluginCapabilities } from "./plugin-capabilities.js";
import type { EffectiveMcpConfig, PluginMcpHost } from "./plugin-mcp-host.js";

/** Each connection's template is stored as this server of its owner. */
const SERVER = "server";
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ConnectionError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

interface ConnectionRecord {
  id: string;
  displayName: string;
  /** The adapter's server name; OAuth sign-ins are stored by it, so it never changes. */
  runtimeName: string;
  enabled: boolean;
  projectTypes?: ProjectType[];
  /** Files a command uses, copied from the plugin it came from; its working directory defaults here. */
  files?: boolean;
  /**
   * The plugin's folder a relative working directory resolved against, also
   * for later configured values: one inside it uses the copy in `files`, one
   * outside it resolves against the original folder, as before.
   */
  cwdRoot?: string;
  migratedFrom?: { type: "plugin"; pluginId: string; serverId: string };
}

interface ConnectionsFile {
  version: 1;
  connections: Record<string, ConnectionRecord>;
  /**
   * Plugin servers already moved, by `<pluginId>/<serverId>`, kept after the
   * connection is deleted so a deleted connection never comes back.
   */
  moved: Record<string, { connectionId: string }>;
}

/** The format 1 plugins and their MCP servers, as migration needs them. */
export interface ConnectionMigrationSource {
  plugins(): Promise<PluginDetail[]>;
  capabilities: Pick<PluginCapabilities, "exportMcpServer">;
}

export class ConnectionService {
  #state: ConnectionsFile = { version: 1, connections: {}, moved: {} };
  #writes: Promise<unknown> = Promise.resolve();
  /** Creating, moving and removing a connection pick ids and write two stores; one at a time. */
  #changes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDirectory: string,
    private readonly agentDirectory: string,
    private readonly configuration: PluginConfigurationStore,
    private readonly host: PluginMcpHost,
  ) {}

  get #filePath(): string {
    return path.join(this.dataDirectory, "connections.json");
  }

  #filesPath(id: string): string {
    return path.join(this.dataDirectory, "connections", id);
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#filePath, "utf8")) as ConnectionsFile;
      if (value.version !== 1 || !value.connections || typeof value.connections !== "object" || !value.moved || typeof value.moved !== "object")
        throw new Error(`Invalid connections file: ${this.#filePath}`);
      this.#state = value;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  /** Whether a plugin's server runs as a connection now. */
  moved(pluginId: string, serverId: string): boolean {
    return Object.hasOwn(this.#state.moved, `${pluginId}/${serverId}`);
  }

  list(): ConnectionSummary[] {
    return Object.values(this.#state.connections)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((record) => this.#summary(record));
  }

  read(id: string): ConnectionSummary {
    return this.#summary(this.#record(id));
  }

  /** The servers a project of this type starts: each enabled connection that is configured. */
  effective(projectType?: ProjectType): EffectiveMcpConfig {
    const mcpServers: Record<string, McpServerDefinition> = {};
    for (const record of Object.values(this.#state.connections)) {
      if (!record.enabled || (projectType && record.projectTypes?.length && !record.projectTypes.includes(projectType))) continue;
      try {
        mcpServers[record.runtimeName] = { ...this.#resolve(record), disabled: false };
      } catch (cause) {
        if (!(cause instanceof PluginConfigurationError)) throw cause;
      }
    }
    return { mcpServers };
  }

  async create(input: CreateConnectionRequest, allowSecrets = true): Promise<ConnectionSummary> {
    const displayName = typeof input?.displayName === "string" ? input.displayName.trim() : "";
    if (!displayName || displayName.length > 100) throw new ConnectionError("Name the connection");
    if (!isMcpServerDefinition(input.definition)) throw new ConnectionError("Invalid MCP server definition");
    if (!isConfigurationFields(input.configuration)) throw new ConnectionError("Invalid connection configuration");
    return this.#exclusive(() => this.#create(displayName, input, allowSecrets));
  }

  async #create(displayName: string, input: CreateConnectionRequest, allowSecrets: boolean): Promise<ConnectionSummary> {
    const fields = structuredClone(input.configuration ?? {});
    const values: PluginConfigurationValues = {};
    const { disabled: _disabled, ...template } = structuredClone(input.definition);
    const definition = protectDefinitions({ [SERVER]: template }, fields, values, allowSecrets)[SERVER]!;
    const id = this.#freeId(slug(displayName));
    const record: ConnectionRecord = { id, displayName, runtimeName: `connection-${id}`, enabled: input.definition.disabled !== true };
    const owner = ownerOf(record);
    await this.configuration.setOverride({ plugin: owner, serverId: SERVER, definition, fields, values, definitions: { [SERVER]: definition } });
    await this.#mutate((next) => {
      next.connections[id] = record;
    });
    return this.#summary(record);
  }

  async update(id: string, input: UpdateConnectionRequest): Promise<ConnectionSummary> {
    this.#record(id);
    if (input.displayName !== undefined && (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.length > 100))
      throw new ConnectionError("Name the connection");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new ConnectionError("Invalid connection switch");
    await this.#mutate((next) => {
      const record = next.connections[id]!;
      if (input.displayName !== undefined) record.displayName = input.displayName.trim();
      if (input.enabled !== undefined) record.enabled = input.enabled;
    });
    return this.read(id);
  }

  async remove(id: string): Promise<void> {
    await this.#exclusive(() => this.#remove(id));
  }

  async #remove(id: string): Promise<void> {
    const record = this.#record(id);
    await this.#mutate((next) => {
      delete next.connections[id];
    });
    await this.configuration.remove(ownerOf(record).id);
    if (record.files) await rm(this.#filesPath(id), { recursive: true, force: true });
  }

  /** The template with credentials masked as `${config.*}` references, for editing. */
  editableDefinition(id: string): McpServerDefinition {
    const record = this.#record(id);
    const owner = ownerOf(record);
    return {
      ...protectDefinitions({ [SERVER]: this.#template(record) }, this.configuration.fields(owner), {}, true)[SERVER]!,
      disabled: !record.enabled,
    };
  }

  async setDefinition(id: string, definition: McpServerDefinition, allowSecrets = true): Promise<ConnectionSummary> {
    const record = this.#record(id);
    if (!isMcpServerDefinition(definition)) throw new ConnectionError("Invalid MCP server definition");
    const owner = ownerOf(record);
    const fields = this.configuration.fields(owner);
    const values: PluginConfigurationValues = {};
    // Literal credentials still in the current template keep their generated fields.
    protectDefinitions({ [SERVER]: this.#template(record) }, fields, values, true);
    const { disabled, ...template } = structuredClone(definition);
    const protectedDefinition = protectDefinitions({ [SERVER]: template }, fields, values, allowSecrets)[SERVER]!;
    await this.configuration.setOverride({ plugin: owner, serverId: SERVER, definition: protectedDefinition, fields, values, definitions: { [SERVER]: protectedDefinition } });
    if (typeof disabled === "boolean") await this.update(id, { enabled: !disabled });
    return this.read(id);
  }

  /** Text with the connection's configured secrets taken out, for error messages. */
  redact(id: string, text: string): string {
    const record = Object.hasOwn(this.#state.connections, id) ? this.#state.connections[id] : undefined;
    return record ? this.configuration.redact(ownerOf(record), text) : text;
  }

  configurationView(id: string): PluginConfigurationView {
    return this.configuration.view(ownerOf(this.#record(id)));
  }

  async saveConfiguration(id: string, values: PluginConfigurationValues): Promise<PluginConfigurationView> {
    return this.configuration.update(ownerOf(this.#record(id)), values);
  }

  async test(id: string, action: "test" | "auth-start" | "auth-complete" = "test", input?: string): Promise<PluginMcpResult> {
    const record = this.#record(id);
    const owner = ownerOf(record);
    const definition = this.#resolve(record);
    const literals: PluginConfigurationValues = {};
    protectDefinitions({ [SERVER]: this.#template(record) }, {}, literals, true);
    // Taken now: a secret replaced while the probe runs must still be masked in what it returns.
    const values = this.configuration.resolved(owner);
    const secrets = [
      ...Object.values(literals),
      ...Object.entries(this.configuration.fields(owner)).filter(([, field]) => field.type === "secret").map(([key]) => values[key]),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const redact = (text: string) => this.configuration.redact(owner, text, secrets);
    try {
      const result = await this.host.probe(owner.id, record.runtimeName, definition, this.agentDirectory, action, input);
      if (result.message) result.message = redact(result.message);
      return result;
    } catch (cause) {
      throw new Error(redact(cause instanceof Error ? cause.message : String(cause)));
    }
  }

  /**
   * Moves every server of the person's MCP-only format 1 plugins here,
   * keeping its edited template, values, secrets, switch, project types,
   * files and runtime name (so OAuth sign-ins carry over). The plugins stay
   * installed and unchanged. Each server is recorded once moved, so a rerun
   * after an interruption finishes the rest and a deleted connection stays
   * deleted. One that can't move keeps running from its plugin and is tried
   * again next start; the failures are returned.
   */
  async migrate(source: ConnectionMigrationSource): Promise<{ pluginId: string; serverId: string; error: unknown }[]> {
    const failures: { pluginId: string; serverId: string; error: unknown }[] = [];
    for (const plugin of await source.plugins()) {
      // Only plugins the person made here ("Add MCP", the old mcp.json, their own folders);
      // marketplace plugins keep updating through their packages.
      if (plugin.marketplace.id !== PERSONAL_MARKETPLACE.id || plugin.skills.length || !plugin.mcpServers?.length) continue;
      for (const server of plugin.mcpServers) {
        const key = `${plugin.id}/${server.id}`;
        if (Object.hasOwn(this.#state.moved, key)) continue;
        try {
          await this.#exclusive(() => this.#move(plugin, server, key, source));
        } catch (error) {
          failures.push({ pluginId: plugin.id, serverId: server.id, error });
        }
      }
    }
    return failures;
  }

  async #move(plugin: PluginDetail, server: NonNullable<PluginDetail["mcpServers"]>[number], key: string, source: ConnectionMigrationSource): Promise<void> {
    const exported = await source.capabilities.exportMcpServer(plugin, server.id);
    // The same server reached here another way (an older app imported it twice).
    const existing = Object.values(this.#state.connections).find((record) => record.runtimeName === exported.runtimeName);
    if (existing && !existing.migratedFrom) throw new ConnectionError(`${existing.displayName} already uses the server name ${exported.runtimeName}`, 409);
    if (existing) {
      await this.#mutate((next) => {
        next.moved[key] = { connectionId: existing.id };
      });
      return;
    }
    const single = plugin.mcpServers?.length === 1;
    const label = single ? plugin.displayName : `${plugin.displayName}-${server.id}`;
    const base = slug(label) === "connection" ? slug(single ? plugin.name : `${plugin.name}-${server.id}`) : slug(label);
    // Stable across reruns, so an interrupted move is redone in place.
    const id = this.#taken(base) ? this.#freeId(`${base}-${createHash("sha256").update(key).digest("hex").slice(0, 6)}`) : base;
    const record: ConnectionRecord = {
      id,
      displayName: single ? plugin.displayName : `${plugin.displayName} · ${server.name}`,
      runtimeName: exported.runtimeName,
      enabled: exported.enabled,
      ...(plugin.projectTypes?.length ? { projectTypes: [...plugin.projectTypes] } : {}),
      migratedFrom: { type: "plugin", pluginId: plugin.id, serverId: server.id },
    };
    const template = structuredClone(exported.template);
    delete template.disabled;
    // A command runs in the plugin's folder by default, and a relative
    // working directory is inside it; the folder moves with it. One that
    // points outside it, also through a configured value, keeps resolving
    // against the plugin's folder.
    const defaultFolder = exported.defaultCwd && template.cwd === undefined;
    let relativeFolder = typeof template.cwd === "string" && !path.isAbsolute(template.cwd);
    if (relativeFolder) {
      record.cwdRoot = exported.root;
      let current: unknown;
      try {
        current = substitute(template.cwd, this.configuration.resolved(plugin));
      } catch (cause) {
        if (!(cause instanceof PluginConfigurationError)) throw cause;
      }
      // A fixed folder outside needs no copy; a configured one may point inside later.
      if (!(template.cwd as string).includes("${") && typeof current === "string" && !inside(exported.root, path.resolve(exported.root, current)))
        relativeFolder = false;
    }
    if (template.command && (defaultFolder || relativeFolder)) {
      await this.#copyFiles(id, exported.root);
      record.files = true;
      if (defaultFolder) template.cwd = ".";
    }
    await this.configuration.copyOwner({ from: plugin.id, fields: exported.fields, to: ownerOf(record).id, serverId: SERVER, definition: template });
    await this.#mutate((next) => {
      next.connections[id] = record;
      next.moved[key] = { connectionId: id };
    });
  }

  #summary(record: ConnectionRecord): ConnectionSummary {
    const template = this.#template(record);
    let status: ConnectionSummary["status"] = record.enabled ? "enabled" : "disabled";
    const configured = !this.configuration.view(ownerOf(record)).missing.length;
    const runtime = this.host.status(record.runtimeName);
    if (record.enabled) {
      try {
        this.#resolve(record);
      } catch (cause) {
        if (!(cause instanceof PluginConfigurationError)) throw cause;
        status = "not-configured";
      }
      if (status === "enabled" && runtime && (runtime.status === "connected" || runtime.status === "failed" || runtime.status === "needs-auth"))
        status = runtime.status;
    }
    return {
      id: record.id,
      displayName: record.displayName,
      transport: template.url ? "http" : "stdio",
      enabled: record.enabled,
      status,
      ...(runtime?.toolCount !== undefined ? { toolCount: runtime.toolCount } : {}),
      ...(record.projectTypes?.length ? { projectTypes: [...record.projectTypes] } : {}),
      configurationStatus: configured ? "ready" : "needs-configuration",
      ...(record.migratedFrom ? { migratedFrom: { ...record.migratedFrom } } : {}),
    };
  }

  #record(id: string): ConnectionRecord {
    const record = Object.hasOwn(this.#state.connections, id) ? this.#state.connections[id] : undefined;
    if (!record) throw new ConnectionError("Connection not found", 404);
    return record;
  }

  #template(record: ConnectionRecord): McpServerDefinition {
    const template = this.configuration.override(ownerOf(record).id, SERVER);
    if (!isMcpServerDefinition(template)) throw new ConnectionError(`${record.displayName} has no MCP server definition`, 500);
    return structuredClone(template);
  }

  #resolve(record: ConnectionRecord): McpServerDefinition {
    const owner = ownerOf(record);
    const template = this.#template(record);
    const serialized = JSON.stringify(template);
    const view = this.configuration.view(owner);
    const missing = view.missing.filter((key) => serialized.includes(`\${config.${key}}`));
    if (missing.length) throw new PluginConfigurationError(`Configure ${missing.map((key) => view.fields[key]!.label).join(", ")}`);
    const resolved = substitute(template, this.configuration.resolved(owner)) as McpServerDefinition;
    if (!isMcpServerDefinition(resolved)) throw new PluginConfigurationError("Resolved MCP definition is invalid");
    if (typeof resolved.cwd === "string" && !path.isAbsolute(resolved.cwd)) {
      const files = record.files ? this.#filesPath(record.id) : undefined;
      if (record.cwdRoot) {
        const target = path.resolve(record.cwdRoot, resolved.cwd);
        resolved.cwd = files && inside(record.cwdRoot, target) ? path.join(files, path.relative(record.cwdRoot, target)) : target;
      } else if (files) resolved.cwd = path.resolve(files, resolved.cwd);
    }
    return resolved;
  }

  async #copyFiles(id: string, root: string): Promise<void> {
    const target = this.#filesPath(id);
    const staging = `${target}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await cp(root, staging, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  #taken(id: string): boolean {
    return Object.hasOwn(this.#state.connections, id) ||
      Object.values(this.#state.moved).some((item) => item.connectionId === id) ||
      // A moved server keeps its old runtime name, which may look like a new one's,
      // and one from the old mcp.json that hasn't moved yet will.
      Object.values(this.#state.connections).some((record) => record.runtimeName === `connection-${id}`) ||
      Object.hasOwn(this.configuration.legacyOwners, `connection-${id}`);
  }

  #freeId(base: string): string {
    let id = base;
    for (let index = 2; this.#taken(id); index++) id = `${base}-${index}`;
    return id;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#changes.then(operation);
    this.#changes = result.catch(() => {});
    return result;
  }

  #mutate(operation: (next: ConnectionsFile) => void): Promise<void> {
    const result = this.#writes.then(async () => {
      const next = structuredClone(this.#state);
      operation(next);
      await mkdir(this.dataDirectory, { recursive: true });
      const temp = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
        await rename(temp, this.#filePath);
        this.#state = next;
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.#writes = result.catch(() => {});
    return result;
  }
}

function ownerOf(record: Pick<ConnectionRecord, "id">): ConfigurationOwner {
  return { id: `connection:${record.id}`, configuration: {} };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function slug(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return ID.test(id) ? id : "connection";
}

/** Fields as a plugin manifest may declare them: known types, and no secret with a default. */
function isConfigurationFields(value: unknown): value is Record<string, PluginConfigurationField> | undefined {
  return value === undefined || isPluginManifest({ name: "connection", version: "1.0.0", description: "Connection", configuration: value });
}
