import { describe, expect, it } from "vitest";
import { communityGameHash, conversationHash, parseAppRoute, projectHash, sidebarHash } from "../src/renderer/routes.js";

describe("renderer routes", () => {
  it("uses Home as the default route", () => {
    expect(parseAppRoute("")).toEqual({ page: "home" });
    expect(parseAppRoute("#/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/unknown")).toEqual({ page: "home" });
    for (const page of ["projects", "library", "plugins", "interactive-drama", "asset-studio", "community"] as const) {
      expect(parseAppRoute(`#/${page}`)).toEqual({ page });
      expect(sidebarHash(page)).toBe(`#/${page}`);
    }
    expect(sidebarHash("home")).toBe("#/");
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

  it("parses legacy Interactive Drama routes", () => {
    expect(parseAppRoute("#/projects/project%201/interactive-drama")).toEqual({
      page: "project",
      projectId: "project 1",
    });
    expect(parseAppRoute("#/projects/project%201/interactive-drama/conversations/chat%201")).toEqual({
      page: "project",
      projectId: "project 1",
      conversationId: "chat 1",
    });
  });

  it("parses and formats Community game routes", () => {
    expect(parseAppRoute("#/community/games/game%201")).toEqual({ page: "community-game", gameId: "game 1" });
    expect(communityGameHash("game 1")).toBe("#/community/games/game%201");
  });

  it("rejects malformed project routes", () => {
    expect(parseAppRoute("#/projects/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/one/more")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/one/conversations/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/one/interactive-drama/conversations/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/one/interactive-drama/more")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/%")).toEqual({ page: "home" });
    expect(parseAppRoute("#/community/games/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/community/games/%")).toEqual({ page: "home" });
  });
});
