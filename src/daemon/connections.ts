import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { Connection, ConnectionTransport, SaveConnectionRequest } from "../shared/connections.js";

const GODOT_ID = "ohmygame-godot";
const GODOT_TRANSPORT: ConnectionTransport = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@coding-solo/godot-mcp@0.1.1"],
};

const PRESETS: Record<string, { displayName: string; transport: ConnectionTransport }> = {
  [GODOT_ID]: { displayName: "Godot", transport: GODOT_TRANSPORT },
};

export class ConnectionError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export class ConnectionManager {
  readonly #filePath: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(agentDirectory: string) {
    this.#filePath = path.join(agentDirectory, "mcp.json");
  }

  async ensurePresets(): Promise<void> {
    await this.#enqueue(() => this.#ensurePresets());
  }

  async #ensurePresets(): Promise<void> {
    const { contents, config } = await this.#read();
    const existing = config.mcpServers?.[GODOT_ID];
    const disabled = isRecord(existing) && existing.disabled === true;
    const definition = transportDefinition(GODOT_TRANSPORT, disabled);
    if (JSON.stringify(existing) === JSON.stringify(definition)) return;
    await this.#writeEdit(contents, modify(contents, ["mcpServers", GODOT_ID], definition, formattingOptions()));
  }

  async list(): Promise<Connection[]> {
    return this.#enqueue(async () => {
      await this.#ensurePresets();
      const { config } = await this.#read();
      return Object.entries(config.mcpServers ?? {}).flatMap(([id, definition]) => {
        const transport = parseTransport(definition);
        if (!transport) return [];
        const preset = PRESETS[id];
        return [{
          id,
          displayName: preset?.displayName ?? displayName(id),
          source: preset ? "preset" : "user",
          enabled: !isDisabled(definition),
          editable: !preset,
          removable: !preset,
          transport,
        }];
      });
    });
  }

  async save(input: SaveConnectionRequest, previousId?: string): Promise<Connection> {
    validateInput(input);
    if (previousId && PRESETS[previousId]) throw new ConnectionError("Preset connections cannot be edited");
    if (PRESETS[input.id]) throw new ConnectionError("This connection ID is reserved");
    return this.#enqueue(async () => {
      const { contents, config } = await this.#read();
      const servers = config.mcpServers ?? {};
      if (!previousId && servers[input.id] !== undefined) throw new ConnectionError(`Connection already exists: ${input.id}`, 409);
      if (previousId && previousId !== input.id && servers[input.id] !== undefined) throw new ConnectionError(`Connection already exists: ${input.id}`, 409);
      if (previousId && servers[previousId] === undefined) throw new ConnectionError(`Connection not found: ${previousId}`, 404);

      let updated = contents;
      if (previousId && previousId !== input.id) {
        updated = applyEdits(updated, modify(updated, ["mcpServers", previousId], undefined, formattingOptions()));
      }
      const previous = previousId ? servers[previousId] : undefined;
      const definition = transportDefinition(input.transport, isDisabled(previous));
      updated = applyEdits(updated, modify(updated, ["mcpServers", input.id], definition, formattingOptions()));
      await this.#write(updated);
      return {
        id: input.id,
        displayName: displayName(input.id),
        source: "user",
        enabled: !isDisabled(previous),
        editable: true,
        removable: true,
        transport: input.transport,
      };
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.#enqueue(async () => {
      const { contents, config } = await this.#read();
      if (config.mcpServers?.[id] === undefined) throw new ConnectionError(`Connection not found: ${id}`, 404);
      const edits = modify(contents, ["mcpServers", id, "disabled"], enabled ? undefined : true, formattingOptions());
      await this.#writeEdit(contents, edits);
    });
  }

  async remove(id: string): Promise<void> {
    if (PRESETS[id]) throw new ConnectionError("Preset connections cannot be removed");
    await this.#enqueue(async () => {
      const { contents, config } = await this.#read();
      if (config.mcpServers?.[id] === undefined) throw new ConnectionError(`Connection not found: ${id}`, 404);
      await this.#writeEdit(contents, modify(contents, ["mcpServers", id], undefined, formattingOptions()));
    });
  }

  async #read(): Promise<{ contents: string; config: McpConfig }> {
    let contents = "{}\n";
    try {
      contents = await readFile(this.#filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    return { contents, config: parseConfig(contents, this.#filePath) };
  }

  async #writeEdit(contents: string, edits: ReturnType<typeof modify>): Promise<void> {
    await this.#write(applyEdits(contents, edits));
  }

  async #write(contents: string): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(operation);
    this.#writes = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface McpConfig { mcpServers?: Record<string, unknown> }

function parseConfig(contents: string, filePath: string): McpConfig {
  const errors: ParseError[] = [];
  const value = parse(contents, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length || !isRecord(value)) throw new ConnectionError(`OhMyGame Pi MCP config is invalid: ${filePath}`);
  const servers = value.mcpServers;
  if (servers !== undefined && !isRecord(servers)) throw new ConnectionError(`OhMyGame Pi MCP config has an invalid mcpServers field: ${filePath}`);
  return servers ? { mcpServers: servers } : {};
}

function parseTransport(value: unknown): ConnectionTransport | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.command === "string") {
    const args = Array.isArray(value.args) && value.args.every((item) => typeof item === "string") ? value.args : [];
    const env = stringRecord(value.env);
    return { type: "stdio", command: value.command, args, ...(env ? { env } : {}), ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}) };
  }
  if (typeof value.url === "string") {
    const headers = stringRecord(value.headers);
    return { type: "http", url: value.url, ...(headers ? { headers } : {}) };
  }
  return undefined;
}

function transportDefinition(transport: ConnectionTransport, disabled = false): Record<string, unknown> {
  const definition = transport.type === "stdio"
    ? { command: transport.command, args: transport.args, ...(transport.env ? { env: transport.env } : {}), ...(transport.cwd ? { cwd: transport.cwd } : {}) }
    : { url: transport.url, ...(transport.headers ? { headers: transport.headers } : {}) };
  return disabled ? { ...definition, disabled: true } : definition;
}

function validateInput(input: SaveConnectionRequest): void {
  if (!/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(input.id)) throw new ConnectionError("Connection ID must use lowercase letters, numbers, dots, dashes, or underscores");
  if (input.transport.type === "stdio" && !input.transport.command.trim()) throw new ConnectionError("Command is required");
  if (input.transport.type === "http") {
    try { new URL(input.transport.url); } catch { throw new ConnectionError("A valid HTTP URL is required"); }
    if (!/^https?:$/.test(new URL(input.transport.url).protocol)) throw new ConnectionError("Connection URL must use HTTP or HTTPS");
  }
}

function displayName(id: string): string {
  return id.split(/[-_.]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) return undefined;
  return value as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDisabled(value: unknown): boolean {
  return isRecord(value) && value.disabled === true;
}

function formattingOptions() {
  return { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };
}
