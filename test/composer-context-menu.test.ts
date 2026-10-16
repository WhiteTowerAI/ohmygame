import { describe, expect, it } from "vitest";
import i18next from "i18next";
import { composerContextItems } from "../src/renderer/composer-context-menu.js";
import { mentionQuery, slashCommandQuery } from "../src/renderer/composer-mentions.js";

const options = {
  capabilities: {
    plugins: [{ id: "images", name: "images", displayName: "Images", description: "Create images", marketplaceId: "local", marketplaceDisplayName: "Local" }],
    skills: [{ name: "game-design", description: "Write a game brief" }],
  },
  planning: false,
  canTogglePlanning: true,
  supportsDesign: true,
};

describe("unified composer context menu", () => {
  it("offers the same actions and capabilities from + and an empty @ query", () => {
    const fromButton = composerContextItems(options);
    expect(composerContextItems({ ...options, query: mentionQuery("@", 1) })).toEqual(fromButton);
    expect(fromButton.map((item) => item.id)).toEqual(["files", "design", "plan", "plugin:images", "skill:game-design"]);
  });

  it("searches actions and skills alongside plugins", () => {
    expect(composerContextItems({ ...options, query: mentionQuery("@design", 7) }).map((item) => item.id)).toEqual(["design", "skill:game-design"]);
    expect(composerContextItems({ ...options, query: mentionQuery("@unknown", 8) })).toEqual([]);
  });

  it("offers plan commands and skills from a leading slash query", () => {
    const query = mentionQuery("/", 1);
    expect(composerContextItems({ ...options, query, showCompact: true }).map((item) => item.id)).toEqual(["plan", "compact", "skill:game-design"]);
    expect(composerContextItems({ ...options, query: mentionQuery("/design", 7), showCompact: true }).map((item) => item.id)).toEqual(["skill:game-design"]);
  });

  it("matches slash commands by their stable IDs in Chinese", async () => {
    const previousLanguage = i18next.language;
    await i18next.changeLanguage("zh-CN");
    try {
      expect(composerContextItems({ ...options, query: mentionQuery("/plan", 5), showCompact: true }).map((item) => item.id)).toEqual(["plan"]);
      expect(composerContextItems({ ...options, query: mentionQuery("/compact", 8), showCompact: true }).map((item) => item.id)).toEqual(["compact"]);
    } finally {
      await i18next.changeLanguage(previousLanguage);
    }
  });

  it("keeps compact instructions in a slash query", () => {
    expect(composerContextItems({ ...options, query: slashCommandQuery("/compact Keep API decisions", "/compact Keep API decisions".length), showCompact: true }).map((item) => item.id)).toEqual(["compact"]);
  });

  it("restricts $ to skills and keeps planning's skill restriction", () => {
    const query = mentionQuery("$", 1);
    expect(composerContextItems({ ...options, query }).map((item) => item.id)).toEqual(["skill:game-design"]);
    expect(composerContextItems({ ...options, query, planning: true })).toEqual([]);
    expect(composerContextItems({ ...options, planning: true }).map((item) => item.id)).not.toContain("skill:game-design");
  });

  it("only offers design and plan actions when the composer supports them", () => {
    expect(composerContextItems({ ...options, canTogglePlanning: false, supportsDesign: false }).map((item) => item.id)).toEqual(["files", "plugin:images", "skill:game-design"]);
    expect(composerContextItems({ ...options, planning: true }).find((item) => item.id === "plan")?.description).toBe("Turn plan mode off");
  });
});
