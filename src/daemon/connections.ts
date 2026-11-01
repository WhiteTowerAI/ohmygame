// Connections: MCP servers the person added themselves, available to every
// project's agent. Definitions, values and secrets live in the plugin
// configuration store (encrypted), owned by `connection:<id>`.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectType } from "../shared/contracts.js";
import type { ConnectionSummary, CreateConnectionRequest, UpdateConnectionRequest } from "../shared/connections.js";
import {
  isPluginManifest,
  type McpServerDefinition,
  type PluginConfigurationField,
  type PluginConfigurationValues,
  type PluginConfigurationView,
  type PluginMcpResult,
} from "../shared/plugins.js";
import { isMcpServerDefinition } from "./local-plugins.js";
import { PluginConfigurationError, type ConfigurationOwner, type PluginConfigurationStore } from "./plugin-configuration.js";
import { protectDefinitions, substitute } from "./plugin-capabilities.js";
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
}

interface ConnectionsFile {
  version: 1;
  connections: Record<string, ConnectionRecord>;
}

export class ConnectionService {
  #state: ConnectionsFile = { version: 1, connections: {} };
  #writes: Promise<unknown> = Promise.resolve();
  /** Creating and removing a connection pick ids and write two stores; one at a time. */
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

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#filePath, "utf8")) as ConnectionsFile;
      if (value.version !== 1 || !value.connections || typeof value.connections !== "object")
        throw new Error(`Invalid connections file: ${this.#filePath}`);
      this.#state = value;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
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
    return resolved;
  }

  #taken(id: string): boolean {
    return Object.hasOwn(this.#state.connections, id);
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

function slug(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return ID.test(id) ? id : "connection";
}

/** Fields as a plugin manifest may declare them: known types, and no secret with a default. */
function isConfigurationFields(value: unknown): value is Record<string, PluginConfigurationField> | undefined {
  return value === undefined || isPluginManifest({ name: "connection", version: "1.0.0", description: "Connection", configuration: value });
}
