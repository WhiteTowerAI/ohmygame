import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  PluginConfigurationValues,
  PluginConfigurationView,
  PluginDetail,
  PluginConfigurationField,
  McpServerDefinition,
} from "../shared/plugins.js";

interface StoredConfiguration {
  version: 1;
  plugins: Record<
    string,
    {
      values: Record<string, string | boolean>;
      secretRefs: Record<string, string>;
    }
  >;
  credentials: Record<string, string>;
  legacyOwners: Record<string, { pluginId: string; serverId: string }>;
  migrated: boolean;
  serverOverrides?: Record<string, string>;
  extraFields?: Record<string, Record<string, PluginConfigurationField>>;
}

export class PluginConfigurationError extends Error {
  readonly statusCode = 400;
}

/** Credentials stay out of packages, API responses and model context. The local
 * encryption key and ciphertext both belong to the user's private data directory. */
export class PluginConfigurationStore {
  #state: StoredConfiguration = {
    version: 1,
    plugins: {},
    credentials: {},
    legacyOwners: {},
    migrated: false,
  };
  #key!: Buffer;
  #writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const keyPath = path.join(this.directory, "plugin-credentials.key");
    try {
      await writeFile(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    this.#key = await readFile(keyPath);
    if (this.#key.length !== 32)
      throw new Error("Invalid plugin credential key");
    try {
      const state = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as StoredConfiguration;
      if (
        state.version !== 1 ||
        !state.plugins ||
        !state.credentials ||
        !state.legacyOwners
      )
        throw new Error("Invalid plugin configuration store");
      this.#state = state;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  get filePath(): string {
    return path.join(this.directory, "plugin-configuration.json");
  }
  get migrated(): boolean {
    return this.#state.migrated;
  }
  get legacyOwners(): StoredConfiguration["legacyOwners"] {
    return structuredClone(this.#state.legacyOwners);
  }
  legacyName(pluginId: string, serverId: string): string | undefined {
    return Object.entries(this.#state.legacyOwners).find(
      ([, owner]) => owner.pluginId === pluginId && owner.serverId === serverId,
    )?.[0];
  }
  override(pluginId: string, serverId: string): unknown {
    const ref = this.#state.serverOverrides?.[`${pluginId}/${serverId}`];
    return ref
      ? JSON.parse(this.#decrypt(this.#state.credentials[ref]!))
      : undefined;
  }
  async setOverride({
    plugin,
    serverId,
    definition,
    fields,
    values,
    definitions,
  }: {
    plugin: PluginDetail;
    serverId: string;
    definition: McpServerDefinition;
    fields: Record<string, PluginConfigurationField>;
    values: PluginConfigurationValues;
    definitions: Record<string, McpServerDefinition>;
  }): Promise<void> {
    const pluginId = plugin.id;
    await this.#mutate((next) => {
      const extras = ((next.extraFields ??= {})[pluginId] ??= {});
      for (const [key, field] of Object.entries(fields))
        if (!Object.hasOwn(plugin.configuration ?? {}, key))
          extras[key] = field;
      const overrides = (next.serverOverrides ??= {});
      const key = `${pluginId}/${serverId}`;
      if (overrides[key]) delete next.credentials[overrides[key]!];
      const ref = randomUUID();
      overrides[key] = ref;
      next.credentials[ref] = this.#encrypt(JSON.stringify(definition));
      // Prune generated fields against all current definitions inside the write
      // queue, so concurrent edits to another service cannot lose its fields.
      const referenced = new Set<string>();
      for (const [id, packaged] of Object.entries(definitions)) {
        const overrideRef = overrides[`${pluginId}/${id}`];
        const template = overrideRef
          ? JSON.parse(this.#decrypt(next.credentials[overrideRef]!))
          : packaged;
        for (const match of JSON.stringify(template).matchAll(
          /\$\{config\.([a-z0-9_.-]+)\}/g,
        ))
          referenced.add(match[1]!);
      }
      const stored = next.plugins[pluginId];
      for (const key of Object.keys(extras)) {
        if (referenced.has(key)) continue;
        delete extras[key];
        if (stored?.secretRefs[key])
          delete next.credentials[stored.secretRefs[key]!];
        if (stored) {
          delete stored.secretRefs[key];
          delete stored.values[key];
        }
      }
      this.#applyValues(
        next,
        pluginId,
        fields,
        Object.fromEntries(
          Object.entries(values).filter(([key]) => referenced.has(key)),
        ),
      );
    });
  }
  async markMigrated(): Promise<void> {
    await this.#mutate((next) => {
      next.migrated = true;
    });
  }
  async setLegacyOwner(
    id: string,
    pluginId: string,
    serverId: string,
  ): Promise<void> {
    await this.#mutate((next) => {
      next.legacyOwners[id] = { pluginId, serverId };
    });
  }
  fields(plugin: PluginDetail): Record<string, PluginConfigurationField> {
    return { ...plugin.configuration, ...this.#state.extraFields?.[plugin.id] };
  }
  view(plugin: PluginDetail): PluginConfigurationView {
    const fields = this.fields(plugin);
    const stored = this.#state.plugins[plugin.id];
    const values: Record<string, string | boolean> = {};
    const configuredSecrets: string[] = [];
    for (const [key, field] of Object.entries(fields)) {
      if (field.type === "secret") {
        if (stored?.secretRefs[key]) configuredSecrets.push(key);
      } else if (
        stored?.values[key] !== undefined ||
        field.default !== undefined
      )
        values[key] = stored?.values[key] ?? field.default!;
    }
    const missing = Object.entries(fields)
      .filter(
        ([key, field]) =>
          field.required &&
          (field.type === "secret"
            ? !configuredSecrets.includes(key)
            : values[key] === undefined || values[key] === ""),
      )
      .map(([key]) => key);
    return { fields, values, configuredSecrets, missing };
  }
  resolved(plugin: PluginDetail): Record<string, string | boolean> {
    const values = { ...this.view(plugin).values };
    const stored = this.#state.plugins[plugin.id];
    const fields = this.fields(plugin);
    for (const [key, ref] of Object.entries(stored?.secretRefs ?? {})) {
      if (fields[key]?.type === "secret")
        values[key] = this.#decrypt(this.#state.credentials[ref]!);
    }
    return values;
  }
  async update(
    plugin: PluginDetail,
    values: PluginConfigurationValues,
    allowSecrets = true,
  ): Promise<PluginConfigurationView> {
    const fields = this.fields(plugin);
    for (const [key, value] of Object.entries(values)) {
      const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!field)
        throw new PluginConfigurationError(
          `Unknown configuration field: ${key}`,
        );
      if (field.type === "secret" && !allowSecrets)
        throw new PluginConfigurationError(
          "Enter credentials in the plugin configuration form",
        );
      if (
        value !== null &&
        (field.type === "boolean"
          ? typeof value !== "boolean"
          : typeof value !== "string")
      )
        throw new PluginConfigurationError(`Invalid value for ${field.label}`);
      if (
        field.type === "select" &&
        value !== null &&
        !field.options?.includes(value as string)
      )
        throw new PluginConfigurationError(
          `Choose a valid option for ${field.label}`,
        );
    }
    await this.#mutate((next) => {
      this.#applyValues(next, plugin.id, this.fields(plugin), values);
    });
    return this.view(plugin);
  }
  redact(
    plugin: PluginDetail,
    value: string,
    literalSecrets: string[] = [],
  ): string {
    const secrets: string[] = [];
    const fields = this.fields(plugin);
    const configured = Object.entries(this.resolved(plugin)).flatMap(
      ([key, secret]) =>
        fields[key]?.type === "secret" && typeof secret === "string"
          ? [secret]
          : [],
    );
    for (const secret of [...configured, ...literalSecrets]) {
      if (!secret) continue;
      secrets.push(secret);
      const token = /^(?:Bearer|Basic)\s+(.+)$/i.exec(secret)?.[1];
      if (token) secrets.push(token);
      try {
        const url = new URL(secret);
        if (url.password) secrets.push(url.password);
        for (const [name, input] of url.searchParams)
          if (/key|token|secret|password|signature/i.test(name) && input)
            secrets.push(input);
      } catch {
        /* Most secrets are not URLs. */
      }
    }
    for (const secret of secrets.sort((a, b) => b.length - a.length))
      value = value.split(secret).join("[redacted]");
    return value;
  }
  #applyValues(
    next: StoredConfiguration,
    pluginId: string,
    fields: Record<string, PluginConfigurationField>,
    values: PluginConfigurationValues,
  ): void {
    const stored = (next.plugins[pluginId] ??= { values: {}, secretRefs: {} });
    for (const [key, value] of Object.entries(values)) {
      if (fields[key]!.type === "secret") {
        const oldRef = stored.secretRefs[key];
        if (oldRef) delete next.credentials[oldRef];
        delete stored.secretRefs[key];
        if (value !== null && value !== "") {
          const ref = randomUUID();
          stored.secretRefs[key] = ref;
          next.credentials[ref] = this.#encrypt(String(value));
        }
      } else if (value === null) delete stored.values[key];
      else stored.values[key] = value;
    }
  }
  #encrypt(value: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  #decrypt(value: string): string {
    const data = Buffer.from(value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
  #mutate(operation: (next: StoredConfiguration) => void): Promise<void> {
    const result = this.#writes.then(async () => {
      const next = structuredClone(this.#state);
      operation(next);
      const temp = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(next, null, 2), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temp, this.filePath);
        this.#state = next;
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.#writes = result.catch(() => {});
    return result;
  }
}
