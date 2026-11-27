import { describe, expect, it } from "vitest";
import { activePluginMentions, extractLeadingPluginMention, formatPluginInvocation, formatSkillInvocation, insertMention, matchingMentions, mentionQuery, parseSkillInvocation, skillDisplayName, slashCommandQuery, toPluginMention } from "../src/renderer/composer-mentions.js";
import type { ConversationCapabilities } from "../src/shared/contracts.js";
import { parsePluginMentions, serializePluginMentions } from "../src/shared/plugins.js";
import { skillMentionRanges } from "../src/shared/skill-mentions.js";

const capabilities: ConversationCapabilities = {
  plugins: [{ id: "plugin-1", name: "image-generation", displayName: "Image Generation", description: "Create images", marketplaceId: "ohmygame", marketplaceDisplayName: "OhMyGame" }],
  skills: [{ name: "review", description: "Review a change" }],
};

describe("composer mentions", () => {
  it("finds a mention at the cursor without matching email-like text", () => {
    expect(mentionQuery("Use @image", 10)).toEqual({ start: 4, end: 10, trigger: "@", query: "image" });
    expect(mentionQuery("mail@example", 12)).toBeUndefined();
    // Any number of Skills can be named anywhere; "/" opens the commands only at the start.
    expect(mentionQuery("Use $review", 11)).toEqual({ start: 4, end: 11, trigger: "$", query: "review" });
    expect(mentionQuery("/review", 7)).toEqual({ start: 0, end: 7, trigger: "/", query: "review" });
    expect(mentionQuery("Use /review", 11)).toBeUndefined();
    expect(mentionQuery("@scope/plugin", 13)).toEqual({ start: 0, end: 13, trigger: "@", query: "scope/plugin" });
    expect(slashCommandQuery("/compact Keep API decisions", "/compact Keep API decisions".length)).toEqual({ start: 0, end: 27, trigger: "/", query: "compact keep api decisions" });
    expect(slashCommandQuery("/plan", 5)).toBeUndefined();
  });

  it("filters plugins and skills by their user-facing metadata", () => {
    const pluginQuery = mentionQuery("@generation", 11)!;
    const skillQuery = mentionQuery("$rev", 4)!;
    expect(matchingMentions(capabilities, pluginQuery)).toMatchObject([{ type: "plugin", value: { name: "image-generation" } }]);
    expect(matchingMentions(capabilities, skillQuery)).toMatchObject([{ type: "skill", value: { name: "review" } }]);
  });

  it("also finds skills with @, including their formatted names and plugin labels", () => {
    const available = { ...capabilities, skills: [{ name: "game-design", pluginDisplayName: "Game Studio", description: "Write a brief" }] };
    expect(matchingMentions(available, mentionQuery("@design", 7)!)).toMatchObject([{ type: "skill", value: { name: "game-design" } }]);
    expect(matchingMentions(available, mentionQuery("@studio", 7)!)).toHaveLength(1);
    expect(matchingMentions(available, mentionQuery("$image", 6)!)).toEqual([]);
    expect(matchingMentions(available, mentionQuery("/design", 7)!)).toMatchObject([{ type: "skill", value: { name: "game-design" } }]);
  });

  it("inserts a stable plugin or skill token and preserves surrounding text", () => {
    const query = mentionQuery("Use @im now", 7)!;
    expect(insertMention("Use @im now", query, { type: "plugin", value: capabilities.plugins[0] })).toEqual({
      value: "Use @Image Generation now",
      cursor: 21,
      plugin: { name: "image-generation", marketplaceId: "ohmygame", displayName: "Image Generation" },
    });
    const scoped = { ...capabilities.plugins[0], name: "@scope/plugin", displayName: "Scoped Plugin" };
    expect(insertMention("@s", mentionQuery("@s", 2)!, { type: "plugin", value: scoped }).value).toBe("@Scoped Plugin ");
  });

  it("tells plugins that share a display name apart by publisher, or by ID within one publisher", () => {
    const plugin = (id: string, displayName = "像素画") => {
      const [marketplaceId, name] = id.split("/") as [string, string];
      return { id, name, displayName, description: "", marketplaceId, marketplaceDisplayName: marketplaceId };
    };
    const plugins = [plugin("alice/pixel"), plugin("bob/pixel"), plugin("bob/sprites"), plugin("carol/maps", "地图")];
    const insert = (value: string, picked: (typeof plugins)[number]) =>
      insertMention(value, { start: value.length, end: value.length, trigger: "@", query: "" }, { type: "plugin", value: picked }, plugins);
    const first = insert("", plugins[0]!);
    const second = insert(first.value, plugins[1]!);
    const third = insert(second.value, plugins[2]!);
    expect(third.value).toBe("@像素画 (alice) @像素画 (bob/pixel) @像素画 (bob/sprites) ");
    expect(insert("", plugins[3]!).value).toBe("@地图 ");
    // A label that is another plugin's display name falls back to the ID.
    expect(toPluginMention(plugins[0]!, [...plugins, plugin("dave/pixel", "像素画 (alice)")]).displayName).toBe("像素画 (alice/pixel)");

    const mentions = [first.plugin!, second.plugin!, third.plugin!];
    const wire = serializePluginMentions(third.value.trim(), mentions);
    expect(wire).toBe("[@像素画 (alice)](plugin://pixel@alice) [@像素画 (bob/pixel)](plugin://pixel@bob) [@像素画 (bob/sprites)](plugin://sprites@bob)");
    expect(parsePluginMentions(wire)).toEqual({ text: third.value.trim(), mentions });
    // The picker finds plugins by ID too.
    expect(matchingMentions({ plugins, skills: [] }, mentionQuery("@bob/", 5)!)).toHaveLength(2);
  });

  it("keeps only menu-selected plugins that remain in the prompt", () => {
    const mention = toPluginMention(capabilities.plugins[0]);
    expect(activePluginMentions("Use @Image Generation", [mention])).toEqual([mention]);
    expect(activePluginMentions("用 @Image Generation，画一张图", [mention])).toEqual([mention]);
    expect(activePluginMentions("Use images", [mention])).toEqual([]);
    expect(activePluginMentions("Use @Image Generations", [mention])).toEqual([]);
  });

  it("separates a leading skill from its prompt without changing the wire text", () => {
    expect(parseSkillInvocation("$plugin-creator Create a plugin")).toEqual({
      name: "plugin-creator",
      prompt: "Create a plugin",
    });
    expect(parseSkillInvocation("Use $plugin-creator")).toBeUndefined();
    expect(formatSkillInvocation("plugin-creator", "Create a plugin")).toBe("$plugin-creator Create a plugin");
    expect(formatSkillInvocation(undefined, "Create a plugin")).toBe("Create a plugin");
    expect(skillDisplayName("plugin-creator")).toBe("Plugin Creator");
    expect(skillDisplayName("godot-gdscript")).toBe("Godot GDScript");
    expect(skillDisplayName("godot-2d-movement")).toBe("Godot 2D Movement");
  });

  it("separates a leading plugin from its prompt without changing the wire text", () => {
    const mention = toPluginMention(capabilities.plugins[0]);
    expect(extractLeadingPluginMention("@Image Generation Create an icon", [mention])).toEqual({
      mention,
      prompt: "Create an icon",
    });
    expect(extractLeadingPluginMention("Use @Image Generation", [mention])).toEqual({ prompt: "Use @Image Generation" });
    expect(formatPluginInvocation(mention, "Create an icon")).toBe("@Image Generation Create an icon");
    expect(formatPluginInvocation(undefined, "Create an icon")).toBe("Create an icon");
  });

  it("finds each known Skill named anywhere, ending at a space, punctuation or a full stop", () => {
    expect(skillMentionRanges("$review then $game-design, and $review.", ["review", "game-design"])).toEqual([
      { start: 0, end: 7, name: "review" },
      { start: 13, end: 25, name: "game-design" },
      { start: 31, end: 38, name: "review" },
    ]);
    // Unknown names, prices and text joined to a word stay text.
    expect(skillMentionRanges("costs $5, a$review, $reviews", ["review"])).toEqual([]);
    expect(skillMentionRanges("use $v1.2 now", ["v1.2"])).toEqual([{ start: 4, end: 9, name: "v1.2" }]);
  });
});
