import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isPluginManifest,
  pluginComponentKey,
  type CreateMcpPluginRequest,
  type McpServerDefinition,
  type PluginConfigurationField,
  type PluginConfigurationValues,
  type PluginDetail,
} from "../shared/plugins.js";
import type { ProjectType } from "../shared/contracts.js";
import {
  isMcpServerDefinition,
  LocalPluginError,
  readPluginMcpServers,
  type LocalPluginStore,
} from "./local-plugins.js";
import type { PluginSkillSource } from "./plugin-runtime.js";
import type { PluginSettingsStore } from "./plugin-settings.js";
import {
  PluginConfigurationError,
  PluginConfigurationStore,
} from "./plugin-configuration.js";
import { PluginMcpHost, type EffectiveMcpConfig } from "./plugin-mcp-host.js";
import type { LegacyMcpConfiguration } from "./legacy-mcp.js";

interface PluginMcpPackage {
  root: string;
  definitions: Record<string, McpServerDefinition>;
}

export class PluginCapabilities {
  readonly configuration: PluginConfigurationStore;
  readonly host = new PluginMcpHost();
  constructor(
    private readonly dataDirectory: string,
    private readonly agentDirectory: string,
    private readonly sources: readonly PluginSkillSource[],
    private readonly localPlugins: LocalPluginStore,
    private readonly settings: PluginSettingsStore,
  ) {
    this.configuration = new PluginConfigurationStore(dataDirectory);
  }
  async all(): Promise<PluginDetail[]> {
    const listed = await Promise.all(
      this.sources.map((source) => source.list()),
    );
    return listed
      .flatMap((result) => (Array.isArray(result) ? result : result.plugins))
      .map((plugin) => this.settings.decorate(plugin));
  }
  async definition(
    plugin: PluginDetail,
    serverId: string,
  ): Promise<McpServerDefinition> {
    return this.#resolve(plugin, serverId, await this.#package(plugin));
  }
  async #package(plugin: PluginDetail): Promise<PluginMcpPackage> {
    for (const source of this.sources) {
      const root = await source.installedPath(plugin.id);
      if (root && plugin.mcpConfigPath)
        return {
          root,
          definitions: await readPluginMcpServers(root, plugin.mcpConfigPath),
        };
    }
    throw new LocalPluginError("Plugin MCP definition not found", 404);
  }
  #template(
    plugin: PluginDetail,
    serverId: string,
    bundle: PluginMcpPackage,
  ): McpServerDefinition {
    if (!plugin.mcpServers?.some((s) => s.id === serverId))
      throw new LocalPluginError("MCP server not found", 404);
    return (this.configuration.override(plugin.id, serverId) ??
      bundle.definitions[serverId]) as McpServerDefinition;
  }
  #resolve(
    plugin: PluginDetail,
    serverId: string,
    bundle: PluginMcpPackage,
  ): McpServerDefinition {
    const { root } = bundle;
    const template = this.#template(plugin, serverId, bundle);
    const serializedTemplate = JSON.stringify(template);
    const missing = this.configuration
      .view(plugin)
      .missing.filter((key) =>
        serializedTemplate.includes(`\${config.${key}}`),
      );
    if (missing.length)
      throw new PluginConfigurationError(
        `Configure ${missing.map((key) => this.configuration.fields(plugin)[key]!.label).join(", ")}`,
      );
    const values = this.configuration.resolved(plugin);
    const resolved = substitute(template, values) as McpServerDefinition;
    if (!isMcpServerDefinition(resolved))
      throw new PluginConfigurationError("Resolved MCP definition is invalid");
    if (typeof resolved.cwd === "string" && !path.isAbsolute(resolved.cwd))
      resolved.cwd = path.resolve(root, resolved.cwd);
    if (
      resolved.command &&
      resolved.cwd === undefined &&
      !this.configuration.legacyName(plugin.id, serverId)
    )
      resolved.cwd = root;
    return resolved;
  }
  runtimeName(pluginId: string, serverId: string): string {
    return (
      this.configuration.legacyName(pluginId, serverId) ??
      `plugin-${createHash("sha256").update(pluginId).digest("hex").slice(0, 12)}-${serverId}`
    );
  }
  async effective(projectType?: ProjectType): Promise<EffectiveMcpConfig> {
    const mcpServers: Record<string, McpServerDefinition> = {};
    for (const plugin of await this.all()) {
      if (
        !plugin.enabled ||
        (projectType &&
          plugin.projectTypes?.length &&
          !plugin.projectTypes.includes(projectType))
      )
        continue;
      if (!plugin.mcpServers?.some((server) => server.enabled)) continue;
      const bundle = await this.#package(plugin);
      for (const server of plugin.mcpServers) {
        if (!server.enabled) continue;
        try {
          const definition = this.#resolve(plugin, server.id, bundle);
          mcpServers[this.runtimeName(plugin.id, server.id)] = {
            ...definition,
            disabled: false,
          };
        } catch (cause) {
          if (!(cause instanceof PluginConfigurationError)) throw cause;
        }
      }
    }
    return { mcpServers };
  }
  async decorate(plugin: PluginDetail): Promise<PluginDetail> {
    const bundle = plugin.mcpServers?.length
      ? await this.#package(plugin)
      : undefined;
    const mcpServers = (plugin.mcpServers ?? []).map((server) => {
      let status:
        | "enabled"
        | "disabled"
        | "not-configured"
        | "connected"
        | "failed"
        | "needs-auth" =
        !plugin.enabled || !server.enabled ? "disabled" : "enabled";
      if (status !== "disabled") {
        try {
          this.#resolve(plugin, server.id, bundle!);
        } catch (cause) {
          if (cause instanceof PluginConfigurationError)
            status = "not-configured";
          else throw cause;
        }
      }
      const runtime = this.host.status(this.runtimeName(plugin.id, server.id));
      if (
        status === "enabled" &&
        runtime &&
        ["connected", "failed", "needs-auth"].includes(runtime.status)
      )
        status = runtime.status as "connected" | "failed" | "needs-auth";
      const template = this.#template(plugin, server.id, bundle!);
      return {
        ...server,
        transport: template.url ? ("http" as const) : ("stdio" as const),
        status,
        toolCount: runtime?.toolCount,
      };
    });
    const owners = this.configuration.legacyOwners;
    const all = plugin.connections.length ? await this.all() : [];
    const connections = plugin.connections.map((connection) => {
      const owner = owners[connection.id];
      const provider = all.find((p) => p.id === owner?.pluginId);
      const enabled = Boolean(
        provider?.enabled &&
        provider.mcpServers?.find((s) => s.id === owner?.serverId)?.enabled,
      );
      return {
        ...connection,
        ownerPluginId: owner?.pluginId,
        enabled,
        status: !provider
          ? ("not-configured" as const)
          : enabled
            ? ("enabled" as const)
            : ("disabled" as const),
      };
    });
    return {
      ...plugin,
      configuration: this.configuration.fields(plugin),
      mcpServers,
      connections,
    };
  }
  async test(
    plugin: PluginDetail,
    serverId: string,
    action: "test" | "auth-start" | "auth-complete" = "test",
    input?: string,
  ) {
    const definition = await this.definition(plugin, serverId);
    const literals: PluginConfigurationValues = {};
    protectDefinitions({ [serverId]: definition }, {}, literals, true);
    const redact = (text: string) =>
      this.configuration.redact(
        plugin,
        text,
        Object.values(literals).filter(
          (value): value is string => typeof value === "string",
        ),
      );
    try {
      const result = await this.host.probe(
        `${plugin.id}:${serverId}`,
        this.runtimeName(plugin.id, serverId),
        definition,
        this.agentDirectory,
        action,
        input,
      );
      if (result.message) result.message = redact(result.message);
      return result;
    } catch (cause) {
      throw new Error(
        redact(cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }
  async template(
    plugin: PluginDetail,
    serverId: string,
  ): Promise<McpServerDefinition> {
    return this.#template(plugin, serverId, await this.#package(plugin));
  }

  async editableTemplate(
    plugin: PluginDetail,
    serverId: string,
  ): Promise<McpServerDefinition> {
    const template = await this.template(plugin, serverId);
    const fields = this.configuration.fields(plugin),
      values: PluginConfigurationValues = {};
    const safe = protectDefinitions(
      { [serverId]: structuredClone(template) },
      fields,
      values,
      true,
    )[serverId]!;
    return {
      ...safe,
      disabled:
        !this.settings.resolve(plugin).components[
          pluginComponentKey("mcp", serverId)
        ],
    };
  }
  async setDefinition(
    plugin: PluginDetail,
    serverId: string,
    definition: McpServerDefinition,
    allowSecrets = true,
  ): Promise<void> {
    if (
      !plugin.mcpServers?.some((server) => server.id === serverId) ||
      !isMcpServerDefinition(definition)
    )
      throw new LocalPluginError("Invalid MCP server definition");
    const bundle = await this.#package(plugin);
    const fields = this.configuration.fields(plugin),
      values: PluginConfigurationValues = {};
    // Preserve masked placeholders returned by a pure read of a package that
    // contained literal credentials. Only an explicit save persists extraction.
    protectDefinitions(
      { [serverId]: structuredClone(this.#template(plugin, serverId, bundle)) },
      fields,
      values,
      true,
    );
    const protectedDefinition = protectDefinitions(
      { [serverId]: structuredClone(definition) },
      fields,
      values,
      allowSecrets,
    )[serverId]!;
    await this.configuration.setOverride({
      plugin,
      serverId,
      definition: protectedDefinition,
      fields,
      values,
      definitions: bundle.definitions,
    });
    if (typeof definition.disabled === "boolean")
      await this.settings.updateComponent(
        plugin,
        pluginComponentKey("mcp", serverId),
        !definition.disabled,
      );
  }
  async create(
    input: CreateMcpPluginRequest,
    allowSecrets = true,
  ): Promise<PluginDetail> {
    if (
      !input ||
      !input.servers ||
      typeof input.servers !== "object" ||
      Array.isArray(input.servers) ||
      !Object.keys(input.servers).length
    )
      throw new LocalPluginError("Add at least one MCP server");
    for (const [id, definition] of Object.entries(input.servers)) {
      if (
        !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(id) ||
        !isMcpServerDefinition(definition)
      )
        throw new LocalPluginError(`Invalid MCP server: ${id}`);
    }
    const fields: Record<string, PluginConfigurationField> = structuredClone(
      input.configuration ?? {},
    );
    const values: PluginConfigurationValues = {};
    const servers = protectDefinitions(
      structuredClone(input.servers),
      fields,
      values,
      allowSecrets,
    );
    const manifest = {
      name: input.name,
      version: "1.0.0",
      description: input.description || "MCP tools",
      mcpServers: "./mcp.json",
      configuration: fields,
      interface: { displayName: input.displayName || input.name },
    };
    if (!isPluginManifest(manifest))
      throw new LocalPluginError("Invalid plugin name or configuration fields");
    const source = path.join(
      this.dataDirectory,
      "plugin-workspaces",
      input.name,
    );
    if (await this.localPlugins.read(`personal:${input.name}`))
      throw new LocalPluginError("Plugin already exists", 409);
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await writeFile(
      path.join(source, ".ohmygame-plugin", "plugin.json"),
      JSON.stringify(manifest, null, 2),
    );
    await writeFile(
      path.join(source, "mcp.json"),
      JSON.stringify({ mcpServers: servers }, null, 2),
    );
    const plugin = await this.localPlugins.install(source);
    await this.configuration.update(plugin, values);
    return this.settings.decorate(plugin);
  }
  async migrate(legacy: LegacyMcpConfiguration): Promise<void> {
    if (this.configuration.migrated) return;
    const definitions = await legacy.readAndBackup();
    const owners = this.configuration.legacyOwners;
    const godot = (await this.all()).find(
      (plugin) => plugin.id === "ohmygame:godot",
    );
    if (
      godot &&
      !Object.hasOwn(definitions, "ohmygame-godot") &&
      !owners["ohmygame-godot"]
    )
      await this.configuration.setLegacyOwner(
        "ohmygame-godot",
        godot.id,
        "godot",
      );
    for (const [id, definition] of Object.entries(definitions)) {
      if (owners[id]) continue;
      if (!isMcpServerDefinition(definition))
        throw new LocalPluginError(
          `Cannot migrate invalid MCP definition: ${id}`,
        );
      if (id === "ohmygame-godot") {
        const plugin = godot;
        if (!plugin) continue;
        // Preserve advanced/custom preset fields in the user override.
        const bundled = await this.template(plugin, "godot");
        const { disabled: _disabled, ...enabledDefinition } = definition;
        if (JSON.stringify(bundled) !== JSON.stringify(enabledDefinition))
          await this.setDefinition(plugin, "godot", definition);
        if (definition.disabled === true)
          await this.settings.update(plugin, {
            enabled: false,
            components: this.settings.resolve(plugin).components,
          });
        await this.configuration.setLegacyOwner(id, plugin.id, "godot");
        continue;
      }
      const name = `mcp-${id.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${createHash("sha256").update(id).digest("hex").slice(0, 6)}`;
      let plugin = await this.localPlugins.read(`personal:${name}`);
      if (!plugin)
        plugin = await this.create({
          name,
          displayName: id,
          description: "Imported MCP connection",
          servers: { [id]: definition },
        });
      // Installation can succeed before configuration is persisted. Replaying
      // the original definition repairs that window on the next startup.
      await this.setDefinition(plugin, id, definition);
      if (definition.disabled === true)
        await this.settings.update(plugin, {
          enabled: false,
          components: this.settings.resolve(plugin).components,
        });
      await this.configuration.setLegacyOwner(id, plugin.id, id);
    }
    await this.configuration.markMigrated();
  }
}
function substitute(
  value: unknown,
  values: Record<string, string | boolean>,
): unknown {
  if (typeof value === "string") {
    const whole = /^\$\{config\.([a-z0-9_.-]+)\}$/.exec(value);
    if (whole) {
      if (values[whole[1]!] === undefined)
        throw new PluginConfigurationError(
          `Missing configuration: ${whole[1]}`,
        );
      return values[whole[1]!]!;
    }
    return value.replace(/\$\{config\.([a-z0-9_.-]+)\}/g, (_, key: string) => {
      if (values[key] === undefined)
        throw new PluginConfigurationError(`Missing configuration: ${key}`);
      return String(values[key]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, values));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, values)]),
    );
  return value;
}
function protectDefinitions(
  servers: Record<string, McpServerDefinition>,
  fields: Record<string, PluginConfigurationField>,
  values: PluginConfigurationValues,
  allowSecrets: boolean,
): Record<string, McpServerDefinition> {
  function visit(value: unknown, parts: string[], sensitive = false): unknown {
    if (
      typeof value === "string" &&
      (sensitive ||
        (parts.at(-1) === "url" &&
          /[?&](?:api[_-]?key|token|secret|password|signature)=/i.test(
            value,
          ))) &&
      !value.includes("${config.")
    ) {
      if (!allowSecrets)
        throw new PluginConfigurationError(
          "Declare a secret configuration field and ask the user to fill it in the form",
        );
      let key = parts
        .join("-")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      while (
        fields[key] &&
        !(
          fields[key]!.type === "secret" &&
          fields[key]!.label === parts.join(" / ")
        )
      )
        key += "-value";
      fields[key] = {
        type: "secret",
        label: parts.join(" / "),
        required: true,
      };
      values[key] = value;
      return `\${config.${key}}`;
    }
    if (Array.isArray(value))
      return value.map((v, i) => visit(v, [...parts, String(i)], sensitive));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          visit(
            v,
            [...parts, k],
            sensitive ||
              /^(bearerToken|clientSecret)$/i.test(k) ||
              (parts.at(-1) === "env" &&
                !/^(NODE_ENV|PATH|HOME|TMPDIR|TEMP|TMP|LANG|LC_ALL|TZ|PORT|LOG_LEVEL|DEBUG)$/i.test(
                  k,
                )) ||
              (parts.at(-1) === "headers" &&
                !/^(Accept|Accept-Language|Content-Type|User-Agent)$/i.test(k)),
          ),
        ]),
      );
    return value;
  }
  return visit(servers, []) as Record<string, McpServerDefinition>;
}
