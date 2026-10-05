import { describe, expect, it } from "vitest";
import { communityHash, conversationHash, DEFAULT_SETTINGS_SECTION, gameHash, parseAppRoute, playtestHash, projectHash, settingsHash, sidebarHash } from "../src/renderer/routes.js";

describe("renderer routes", () => {
  it("uses Home as the default route", () => {
    expect(parseAppRoute("")).toEqual({ page: "home" });
    expect(parseAppRoute("#/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/unknown")).toEqual({ page: "home" });
    for (const page of ["projects", "library", "plugins", "interactive-story", "asset-canvas"] as const) {
      expect(parseAppRoute(`#/${page}`)).toEqual({ page });
      expect(sidebarHash(page)).toBe(`#/${page}`);
    }
    expect(sidebarHash("home")).toBe("#/");
    expect(sidebarHash("community")).toBe("#/community/games");
    expect(parseAppRoute("#/community")).toEqual({ page: "community" });
    expect(parseAppRoute("#/community/games")).toEqual({ page: "community" });
    expect(parseAppRoute("#/community/images")).toEqual({ page: "home" });
    expect(communityHash()).toBe("#/community/games");
    expect(parseAppRoute("#/tools")).toEqual({ page: "home" });
  });

  it("parses and formats project routes", () => {
    expect(parseAppRoute("#/projects/project%201")).toEqual({ page: "project", projectId: "project 1" });
    expect(parseAppRoute("#/projects/project%201/conversations/chat%201")).toEqual({
      page: "project",
      projectId: "project 1",
      conversationId: "chat 1",
    });
    expect(projectHash("project 1")).toBe("#/projects/project%201");
    expect(conversationHash("project 1", "chat 1")).toBe("#/projects/project%201/conversations/chat%201");
  });

  it("keeps the design view when opening a project or its conversation directly", () => {
    expect(parseAppRoute(projectHash("project 1", "design"))).toEqual({ page: "project", projectId: "project 1", view: "design" });
    expect(parseAppRoute(conversationHash("project 1", "chat 1", "design"))).toEqual({ page: "project", projectId: "project 1", conversationId: "chat 1", view: "design" });
  });

  it("parses and formats Settings routes", () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe("providers");
    expect(parseAppRoute("#/settings")).toEqual({ page: "settings", section: "providers" });
    for (const section of ["account", "billing", "appearance", "providers", "web-search", "connections", "about"] as const) {
      expect(parseAppRoute(`#/settings/${section}`)).toEqual({ page: "settings", section });
      expect(settingsHash(section)).toBe(`#/settings/${section}`);
    }
    expect(parseAppRoute("#/settings/usage")).toEqual({ page: "home" });
    expect(parseAppRoute("#/settings/plans")).toEqual({ page: "home" });
    expect(parseAppRoute("#/settings/unknown")).toEqual({ page: "home" });
  });

  it("parses and formats game routes", () => {
    expect(parseAppRoute("#/community/games/game%201")).toEqual({ page: "game", gameId: "game 1" });
    expect(gameHash("game 1")).toBe("#/community/games/game%201");
  });

  it("parses and formats playtest routes", () => {
    expect(parseAppRoute("#/playtest/project%201")).toEqual({ page: "playtest", projectId: "project 1" });
    expect(playtestHash("project 1")).toBe("#/playtest/project%201");
  });

  it("parses the Node thumbnail route", () => {
    expect(parseAppRoute("#/thumbnail/project%201/night.carriage")).toEqual({
      page: "thumbnail",
      projectId: "project 1",
      nodeId: "night.carriage",
    });
    expect(parseAppRoute("#/thumbnail/project/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/thumbnail/%/node")).toEqual({ page: "home" });
  });

  it("rejects malformed project routes", () => {
    expect(parseAppRoute("#/projects/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/one/more")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/one/conversations/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/%")).toEqual({ page: "home" });
    expect(parseAppRoute("#/games/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/games/%")).toEqual({ page: "home" });
    expect(parseAppRoute("#/community/games/%")).toEqual({ page: "home" });
    expect(parseAppRoute("#/games")).toEqual({ page: "home" });
    expect(parseAppRoute("#/assets")).toEqual({ page: "home" });
    expect(parseAppRoute("#/community/assets")).toEqual({ page: "home" });
    expect(parseAppRoute("#/playtest/project/extra")).toEqual({ page: "home" });
    expect(parseAppRoute("#/playtest/%")).toEqual({ page: "home" });
  });
});
