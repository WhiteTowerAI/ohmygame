import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  ensureOpenGamePiEnvironment,
  isOpenGameManagedPiPackage,
  withRequiredPiPackages,
} from "../src/daemon/pi-agent.js";

describe("OpenGame Pi environment", () => {
  it("adds the MCP adapter without replacing existing packages", () => {
    expect(withRequiredPiPackages(["npm:pi-web-access"])).toEqual([
      "npm:pi-web-access",
      "npm:pi-mcp-adapter@2.27.0",
    ]);
    const configured = [{ source: "npm:pi-mcp-adapter", skills: [] }];
    expect(withRequiredPiPackages(configured)).toBe(configured);
    expect(isOpenGameManagedPiPackage("npm:pi-mcp-adapter@2.27.0")).toBe(true);
    expect(isOpenGameManagedPiPackage("npm:pi-web-access")).toBe(false);
  });

  it("merges the Godot server into the app-owned MCP config", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "open-game-pi-agent-"));
    await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({
      settings: { idleTimeout: 5 },
      mcpServers: { existing: { url: "https://example.com/mcp" } },
    }));

    await ensureOpenGamePiEnvironment(agentDir);

    const config = JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8"));
    expect(config).toEqual({
      settings: { idleTimeout: 5 },
      mcpServers: {
        existing: { url: "https://example.com/mcp" },
        "opengame-godot": {
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
    const agentDir = await mkdtemp(path.join(tmpdir(), "open-game-pi-agent-"));
    await writeFile(path.join(agentDir, "mcp.json"), `{
  // Keep user-managed servers intact.
  "mcpServers": {
    "existing": { "url": "https://example.com/mcp" },
  },
}\n`);

    await ensureOpenGamePiEnvironment(agentDir);

    const contents = await readFile(path.join(agentDir, "mcp.json"), "utf8");
    expect(contents).toContain("// Keep user-managed servers intact.");
    expect(contents).toMatch(/"opengame-godot"[\s\S]*?,\s*\n\s*},/);
    expect(parse(contents, [], { allowTrailingComma: true })).toMatchObject({
      mcpServers: {
        existing: { url: "https://example.com/mcp" },
        "opengame-godot": GODOT_SERVER,
      },
    });
  });

  it("reports an invalid MCP config without replacing it", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "open-game-pi-agent-"));
    const invalidConfig = "{ invalid JSONC";
    await writeFile(path.join(agentDir, "mcp.json"), invalidConfig);

    await expect(ensureOpenGamePiEnvironment(agentDir)).rejects.toThrow("OpenGame Pi MCP config is invalid");
    expect(await readFile(path.join(agentDir, "mcp.json"), "utf8")).toBe(invalidConfig);
  });
});

const GODOT_SERVER = {
  command: "npx",
  args: ["-y", "@coding-solo/godot-mcp@0.1.1"],
};
