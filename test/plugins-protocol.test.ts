import { describe, expect, it } from "vitest";
import {
  PLUGIN_MANIFEST_PATH,
  isPluginManifest,
  isNewerPluginVersion,
  isPluginVersion,
  parsePluginMentions,
  serializePluginMentions,
  type PluginSummary,
} from "../src/shared/plugins.js";

describe("plugin protocol", () => {
  it("accepts a minimal plugin manifest", () => {
    expect(PLUGIN_MANIFEST_PATH).toBe(".ohmygame-plugin/plugin.json");
    expect(isPluginManifest({
      name: "character-writer",
      version: "1.0.0",
      description: "Reusable character writing workflow",
      skills: "./skills/",
    })).toBe(true);
  });

  it("accepts skills, connections, and display metadata", () => {
    expect(isPluginManifest({
      name: "godot-tools",
      version: "0.1.0-alpha.1",
      description: "Godot workflows and tools",
      skills: "./skills/",
      connections: ["ohmygame-godot"],
      interface: {
        displayName: "Godot",
        shortDescription: "Godot workflows",
        longDescription: "Build and edit Godot projects through the connected editor.",
        defaultPrompt: ["Build a player controller."],
        projectTypes: ["godot-game"],
      },
    })).toBe(true);
  });

  it("accepts multiple skill paths", () => {
    expect(isPluginManifest({
      name: "game-tools",
      version: "1.0.0",
      description: "Game tools",
      skills: ["./skills/godot/", "./skills/web/"],
    })).toBe(true);
  });

  it("rejects invalid identities, paths, and undeclared fields", () => {
    const base = {
      name: "valid-plugin",
      version: "1.0.0",
      description: "Valid plugin",
    };

    expect(isPluginManifest({ ...base, name: "Invalid Plugin" })).toBe(false);
    expect(isPluginManifest({ ...base, skills: "skills/" })).toBe(false);
    expect(isPluginManifest({ ...base, skills: "./../skills/" })).toBe(false);
    expect(isPluginManifest({ ...base, homepage: "https://ohmygame.ai" })).toBe(false);
    expect(isPluginManifest({ ...base, version: "" })).toBe(false);
    expect(isPluginManifest({ ...base, enabled: true })).toBe(false);
    expect(isPluginManifest({ ...base, mcpServers: "./mcp.json" })).toBe(false);
    expect(isPluginManifest({ ...base, apps: "./apps.json" })).toBe(false);
    expect(isPluginManifest({ ...base, hooks: "./hooks.json" })).toBe(false);
    expect(isPluginManifest({ ...base, tools: ["generate-image"] })).toBe(false);
    expect(isPluginManifest({ ...base, interface: { logo: "./logo.png" } })).toBe(false);
  });

  it("accepts SemVer versions only", () => {
    expect(isPluginVersion("1.0.0-alpha.1+build.7")).toBe(true);
    expect(isPluginVersion("1.0")).toBe(false);
    expect(isPluginVersion("1.0.0-01")).toBe(false);
    expect(isPluginVersion("1/2")).toBe(false);
  });

  it("orders stable and prerelease Plugin versions", () => {
    expect(isNewerPluginVersion("1.1.0", "1.0.9")).toBe(true);
    expect(isNewerPluginVersion("1.0.0", "1.0.0-beta.2")).toBe(true);
    expect(isNewerPluginVersion("1.0.0-beta.10", "1.0.0-beta.2")).toBe(true);
    expect(isNewerPluginVersion("1.0.0-alpha", "1.0.0")).toBe(false);
  });

  it("keeps installation state outside the author manifest", () => {
    const plugin: PluginSummary = {
      id: "ohmygame:godot",
      name: "godot",
      displayName: "Godot",
      description: "Connect the agent to the Godot editor",
      marketplace: { id: "ohmygame", displayName: "OhMyGame" },
      source: { type: "builtIn" },
      installed: true,
      enabled: true,
    };

    expect(plugin.source).toEqual({ type: "builtIn" });
  });

  it("serializes and restores Codex-style Plugin mentions", () => {
    const mention = { name: "godot", displayName: "Godot", marketplaceId: "ohmygame" };
    const serialized = serializePluginMentions("Use @Godot to inspect the scene", [mention]);

    expect(serialized).toBe("Use [@Godot](plugin://godot@ohmygame) to inspect the scene");
    expect(parsePluginMentions(serialized)).toEqual({
      text: "Use @Godot to inspect the scene",
      mentions: [mention],
    });
  });

  it("serializes longer Plugin names before matching prefixes", () => {
    const mentions = [
      { name: "foo", displayName: "Foo", marketplaceId: "personal" },
      { name: "foo-bar", displayName: "Foo Bar", marketplaceId: "personal" },
    ];

    expect(serializePluginMentions("Use @Foo Bar, then @Foo", mentions)).toBe(
      "Use [@Foo Bar](plugin://foo-bar@personal), then [@Foo](plugin://foo@personal)",
    );
  });

  it("leaves malformed Plugin references untouched", () => {
    const malformed = "Use [@Godot](plugin://%E0%A4%A@ohmygame)";
    expect(parsePluginMentions(malformed)).toEqual({ text: malformed, mentions: [] });
  });

});
