import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  ensureOhMyGamePiEnvironment,
  isOhMyGameManagedPiPackage,
  listMcpServers,
  withRequiredPiPackages,
} from "../src/daemon/pi-agent.js";
import { ConnectionManager } from "../src/daemon/connections.js";

describe("OhMyGame Pi environment", () => {
  it("adds the MCP adapter without replacing existing packages", () => {
    expect(withRequiredPiPackages(["npm:pi-web-access"])).toEqual([
      "npm:pi-web-access",
      "npm:pi-mcp-adapter@2.27.0",
    ]);
    const configured = [{ source: "npm:pi-mcp-adapter", skills: [] }];
    expect(withRequiredPiPackages(configured)).toBe(configured);
    expect(isOhMyGameManagedPiPackage("npm:pi-mcp-adapter@2.27.0")).toBe(true);
    expect(isOhMyGameManagedPiPackage("npm:pi-web-access")).toBe(false);
  });

  it("merges the Godot server into the app-owned MCP config", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({
      settings: { idleTimeout: 5 },
      mcpServers: { existing: { url: "https://example.com/mcp" } },
    }));

    await ensureOhMyGamePiEnvironment(agentDir);

    const config = JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8"));
    expect(config).toEqual({
      settings: { idleTimeout: 5 },
      mcpServers: {
        existing: { url: "https://example.com/mcp" },
        "ohmygame-godot": {
          command: "npx",
          args: ["-y", "@coding-solo/godot-mcp@0.1.1"],
        },
      },
    });
    expect(JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")).packages).toEqual([
      "npm:pi-mcp-adapter@2.27.0",
    ]);
  });

  it("preserves JSONC comments and trailing commas when adding Godot", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    await writeFile(path.join(agentDir, "mcp.json"), `{
  // Keep user-managed servers intact.
  "mcpServers": {
    "existing": { "url": "https://example.com/mcp" },
  },
}\n`);

    await ensureOhMyGamePiEnvironment(agentDir);

    const contents = await readFile(path.join(agentDir, "mcp.json"), "utf8");
    expect(contents).toContain("// Keep user-managed servers intact.");
    expect(contents).toMatch(/"ohmygame-godot"[\s\S]*?,\s*\n\s*},/);
    expect(parse(contents, [], { allowTrailingComma: true })).toMatchObject({
      mcpServers: {
        existing: { url: "https://example.com/mcp" },
        "ohmygame-godot": GODOT_SERVER,
      },
    });
  });

  it("reports an invalid MCP config without replacing it", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    const invalidConfig = "{ invalid JSONC";
    await writeFile(path.join(agentDir, "mcp.json"), invalidConfig);

    await expect(ensureOhMyGamePiEnvironment(agentDir)).rejects.toThrow("OhMyGame Pi MCP config is invalid");
    expect(await readFile(path.join(agentDir, "mcp.json"), "utf8")).toBe(invalidConfig);
  });

  it("disables Godot without removing its MCP definition", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    await ensureOhMyGamePiEnvironment(agentDir);
    await new ConnectionManager(agentDir).setEnabled("ohmygame-godot", false);
    await ensureOhMyGamePiEnvironment(agentDir);

    expect(JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8"))).toMatchObject({
      mcpServers: { "ohmygame-godot": { ...GODOT_SERVER, disabled: true } },
    });

    await new ConnectionManager(agentDir).setEnabled("ohmygame-godot", true);
    expect(JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8"))).toMatchObject({
      mcpServers: { "ohmygame-godot": GODOT_SERVER },
    });
  });

  it("discovers and toggles any configured MCP server without replacing its definition", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    await writeFile(path.join(agentDir, "mcp.json"), `{
  "mcpServers": {
    "figma": {
      // Preserve user-managed fields.
      "url": "https://example.com/mcp",
    },
  },
}\n`);

    expect(await listMcpServers(agentDir)).toEqual([
      { id: "figma", enabled: true },
      { id: "ohmygame-godot", enabled: true },
    ]);

    await new ConnectionManager(agentDir).setEnabled("figma", false);
    const disabled = await readFile(path.join(agentDir, "mcp.json"), "utf8");
    expect(disabled).toContain("// Preserve user-managed fields.");
    expect(parse(disabled, [], { allowTrailingComma: true })).toMatchObject({
      mcpServers: { figma: { url: "https://example.com/mcp", disabled: true } },
    });

    await new ConnectionManager(agentDir).setEnabled("figma", true);
    expect(parse(await readFile(path.join(agentDir, "mcp.json"), "utf8"), [], { allowTrailingComma: true })).toMatchObject({
      mcpServers: { figma: { url: "https://example.com/mcp" } },
    });
  });

});

const GODOT_SERVER = {
  command: "npx",
  args: ["-y", "@coding-solo/godot-mcp@0.1.1"],
};
