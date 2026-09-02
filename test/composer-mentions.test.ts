import { describe, expect, it } from "vitest";
import { activePluginMentions, extractLeadingPluginMention, formatPluginInvocation, formatSkillInvocation, insertMention, matchingMentions, mentionQuery, parseSkillInvocation, skillDisplayName, toPluginMention } from "../src/renderer/composer-mentions.js";
import type { ConversationCapabilities } from "../src/shared/contracts.js";

const capabilities: ConversationCapabilities = {
  plugins: [{ id: "plugin-1", name: "image-generation", displayName: "Image Generation", description: "Create images", marketplaceId: "opengame" }],
  skills: [{ name: "review", description: "Review a change" }],
};

describe("composer mentions", () => {
  it("finds a mention at the cursor without matching email-like text", () => {
    expect(mentionQuery("Use @image", 10)).toEqual({ start: 4, end: 10, trigger: "@", query: "image" });
    expect(mentionQuery("mail@example", 12)).toBeUndefined();
    expect(mentionQuery("Use $review", 11)).toBeUndefined();
  });

  it("filters plugins and skills by their user-facing metadata", () => {
    const pluginQuery = mentionQuery("@generation", 11)!;
    const skillQuery = mentionQuery("$rev", 4)!;
    expect(matchingMentions(capabilities, pluginQuery)).toMatchObject([{ type: "plugin", value: { name: "image-generation" } }]);
    expect(matchingMentions(capabilities, skillQuery)).toMatchObject([{ type: "skill", value: { name: "review" } }]);
  });

  it("inserts a stable plugin or skill token and preserves surrounding text", () => {
    const query = mentionQuery("Use @im now", 7)!;
    expect(insertMention("Use @im now", query, { type: "plugin", value: capabilities.plugins[0] })).toEqual({
      value: "Use @Image Generation now",
      cursor: 21,
    });
    const scoped = { ...capabilities.plugins[0], name: "@scope/plugin", displayName: "Scoped Plugin" };
    expect(insertMention("@s", mentionQuery("@s", 2)!, { type: "plugin", value: scoped }).value).toBe("@Scoped Plugin ");
  });

  it("keeps only menu-selected plugins that remain in the prompt", () => {
    const mention = toPluginMention(capabilities.plugins[0]);
    expect(activePluginMentions("Use @Image Generation", [mention])).toEqual([mention]);
    expect(activePluginMentions("Use images", [mention])).toEqual([]);
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
});
