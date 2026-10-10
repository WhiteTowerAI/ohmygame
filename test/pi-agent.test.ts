import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureOhMyGamePiEnvironment,
  withoutOhMyGameManagedPiPackages,
} from "../src/daemon/pi-agent.js";

describe("OhMyGame Pi environment", () => {
  it("removes only the legacy app-managed MCP adapter package", () => {
    const configured = [
      "npm:pi-web-access",
      { source: "npm:pi-mcp-adapter@2.27.0", extensions: ["extensions/index.ts"] },
      "github:example/custom-extension",
    ];
    expect(withoutOhMyGameManagedPiPackages(configured)).toEqual([
      "npm:pi-web-access",
      "github:example/custom-extension",
    ]);
    const userPackages = ["npm:pi-web-access"];
    expect(withoutOhMyGameManagedPiPackages(userPackages)).toBe(userPackages);
  });

  it("migrates the legacy adapter setting while preserving user packages", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
      packages: [
        "npm:pi-web-access",
        "npm:pi-mcp-adapter@2.27.0",
        { source: "github:example/custom-extension", extensions: [] },
      ],
    }));

    await ensureOhMyGamePiEnvironment(agentDir);

    expect(JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")).packages).toEqual([
      "npm:pi-web-access",
      { source: "github:example/custom-extension", extensions: [] },
    ]);
  });

  it("creates the plugin creator skill without writing ambient MCP configuration", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    await ensureOhMyGamePiEnvironment(agentDir);
    expect(await readFile(path.join(agentDir, "skills/plugin-creator/SKILL.md"), "utf8")).toContain("mcpServers");
    await expect(readFile(path.join(agentDir, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
