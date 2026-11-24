import { describe, expect, it } from "vitest";
import {
  isPluginIcon,
  isNewerPluginVersion,
  isPluginVersion,
  parsePluginMentions,
  serializePluginMentions,
  splitPluginMentions,
} from "../src/shared/plugins.js";

describe("plugin protocol", () => {
  it("accepts package images and rejects anything else", () => {
    for (const icon of [{ type: "asset", path: "./assets/icon.png" }, { type: "asset", path: "./assets/icon.webp" }, { type: "asset", path: "./assets/icon.svg" }]) {
      expect(isPluginIcon(icon)).toBe(true);
    }
    for (const icon of [{ type: "preset", id: "image" }, { type: "asset", path: "./../icon.png" }, { type: "asset", path: "https://example.com/icon.png" }, { type: "asset", path: "./icon.gif" }]) {
      expect(isPluginIcon(icon)).toBe(false);
    }
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

  it("splits a prompt at its Plugin mentions, longer names first", () => {
    const foo = { name: "foo", displayName: "Foo", marketplaceId: "personal" };
    const fooBar = { name: "foo-bar", displayName: "Foo Bar", marketplaceId: "personal" };

    expect(splitPluginMentions("@Foo Bar hi, then @Foo. @Food stays", [foo, fooBar])).toEqual([
      fooBar, " hi, then ", foo, ". @Food stays",
    ]);
    expect(splitPluginMentions("No mentions", [])).toEqual(["No mentions"]);
  });

  it("leaves malformed Plugin references untouched", () => {
    const malformed = "Use [@Godot](plugin://%E0%A4%A@ohmygame)";
    expect(parsePluginMentions(malformed)).toEqual({ text: malformed, mentions: [] });
  });

});
