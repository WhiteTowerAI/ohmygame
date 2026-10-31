import { describe, expect, it } from "vitest";
import i18next from "i18next";
import { composerContextItems } from "../src/renderer/composer-context-menu.js";
import { mentionQuery, slashCommandQuery } from "../src/renderer/composer-mentions.js";
import { pageCommand, slashCommands } from "../src/renderer/project-plugin-contributions.js";
import type { ProjectPluginCommand } from "../src/shared/plugins.js";

const options = {
  capabilities: {
    plugins: [{ id: "images", name: "images", displayName: "Images", description: "Create images", marketplaceId: "local", marketplaceDisplayName: "Local" }],
    skills: [{ name: "game-design", description: "Write a game brief" }],
  },
  planning: false,
  canTogglePlanning: true,
};

describe("unified composer context menu", () => {
  it("offers plugins and skills from @, and the / list when the + menu opens it", () => {
    expect(composerContextItems({ ...options, query: mentionQuery("@", 1) }).map((item) => item.id)).toEqual(["plugin:images", "skill:game-design"]);
    expect(composerContextItems(options)).toEqual(composerContextItems({ ...options, query: mentionQuery("/", 1) }));
  });

  it("searches skills alongside plugins", () => {
    expect(composerContextItems({ ...options, query: mentionQuery("@design", 7) }).map((item) => item.id)).toEqual(["skill:game-design"]);
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
      expect(composerContextItems({ ...options, query: mentionQuery("/pub", 4), canPublish: true }).map((item) => item.id)).toEqual(["publish"]);
    } finally {
      await i18next.changeLanguage(previousLanguage);
    }
  });

  it("offers plugin commands by their slash names, only from /", () => {
    const commands: ProjectPluginCommand[] = [
      { id: "acme/maker:upload", plugin: "acme/maker", title: "Upload build", slash: "upload", slots: [], run: { native: "upload" } },
      { id: "acme/maker:preview", plugin: "acme/maker", title: "Open preview", slots: [{ slot: "composer.slash", when: "project.type == 'acme/maker:game'" }], run: { openPanel: "preview" } },
      { id: "acme/maker:docs", plugin: "acme/maker", title: "Docs", slots: [{ slot: "project.menu" }], run: { url: "https://example.com" } },
    ];
    const at = (type: string) => slashCommands(commands, { values: { "project.type": type } }).map((command) => command.id);
    // A slotted command shows where its `when` holds; a slash name alone shows everywhere.
    expect(at("acme/maker:game")).toEqual(["acme/maker:upload", "acme/maker:preview"]);
    expect(at("web-game")).toEqual(["acme/maker:upload"]);
    const pluginCommands = slashCommands(commands, { values: { "project.type": "acme/maker:game" } });
    expect(composerContextItems({ ...options, query: mentionQuery("/up", 3), pluginCommands }).map((item) => [item.id, item.command])).toEqual([["command:acme/maker:upload", "upload"]]);
    expect(composerContextItems({ ...options, query: mentionQuery("/prev", 5), pluginCommands }).map((item) => item.command)).toEqual(["preview"]);
    expect(composerContextItems({ ...options, query: mentionQuery("@", 1), pluginCommands }).some((item) => item.pluginCommand)).toBe(false);
  });

  it("never lets a plugin page send a message", () => {
    const prompt: ProjectPluginCommand = { id: "acme/maker:ask", plugin: "acme/maker", title: "Ask", slots: [], run: { prompt: "Fix the build", skill: "maker" } };
    const panel = { plugin: "acme/maker", capabilities: {} };
    expect(() => pageCommand(panel, prompt)).toThrow("can't use the composer");
    expect(pageCommand({ ...panel, capabilities: { composer: true } }, prompt)).toEqual({ kind: "fill", text: "Use the maker skill.\n\nFix the build" });
    const open: ProjectPluginCommand = { ...prompt, run: { openPanel: "preview" } };
    expect(pageCommand(panel, open)).toEqual({ kind: "app", command: open });
    expect(pageCommand(panel, { ...prompt, run: { native: "upload" } })).toEqual({ kind: "plugin" });
  });

  it("only offers publish from a slash query when publishing is available", () => {
    const query = mentionQuery("/", 1);
    expect(composerContextItems({ ...options, query, canPublish: true }).map((item) => item.id)).toContain("publish");
    expect(composerContextItems({ ...options, query }).map((item) => item.id)).not.toContain("publish");
    expect(composerContextItems({ ...options, query: mentionQuery("@", 1), canPublish: true }).map((item) => item.id)).not.toContain("publish");
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

  it("only offers plan mode when the composer supports it", () => {
    expect(composerContextItems({ ...options, canTogglePlanning: false }).map((item) => item.id)).toEqual(["skill:game-design"]);
    expect(composerContextItems({ ...options, planning: true }).find((item) => item.id === "plan")?.description).toBe("Turn plan mode off");
  });
});
