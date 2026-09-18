import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { ConnectionError, ConnectionManager } from "../src/daemon/connections.js";

describe("ConnectionManager", () => {
  it("projects mcp.json into Connections and preserves unrelated JSONC", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-connections-"));
    await writeFile(path.join(directory, "mcp.json"), `{
  // Keep adapter settings.
  "settings": { "idleTimeout": 5 },
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "cwd": "/tmp/project" },
  },
}\n`);
    const manager = new ConnectionManager(directory);

    expect(await manager.list()).toMatchObject([
      { id: "context7", source: "user", enabled: true, transport: { type: "stdio", cwd: "/tmp/project" } },
      { id: "ohmygame-godot", source: "preset", editable: false, removable: false },
    ]);
    expect(await readFile(path.join(directory, "mcp.json"), "utf8")).toContain("// Keep adapter settings.");
  });

  it("creates, edits, disables, and removes user Connections", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-connections-"));
    const manager = new ConnectionManager(directory);

    await manager.save({ id: "remote", transport: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer token" } } });
    await manager.setEnabled("remote", false);
    await manager.save({ id: "renamed", transport: { type: "stdio", command: "node", args: ["server.js"], cwd: "/tmp" } }, "remote");

    expect(await manager.list()).toContainEqual(expect.objectContaining({
      id: "renamed",
      enabled: false,
      transport: { type: "stdio", command: "node", args: ["server.js"], cwd: "/tmp" },
    }));
    await manager.remove("renamed");
    const config = parse(await readFile(path.join(directory, "mcp.json"), "utf8"), [], { allowTrailingComma: true });
    expect(config.mcpServers).not.toHaveProperty("renamed");
  });

  it("protects presets and validates user definitions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-connections-"));
    const manager = new ConnectionManager(directory);

    await expect(manager.remove("ohmygame-godot")).rejects.toBeInstanceOf(ConnectionError);
    await expect(manager.save({ id: "Bad ID", transport: { type: "stdio", command: "npx", args: [] } })).rejects.toBeInstanceOf(ConnectionError);
    await expect(manager.save({ id: "remote", transport: { type: "http", url: "file:///tmp/mcp" } })).rejects.toBeInstanceOf(ConnectionError);
  });
});
