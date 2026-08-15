import { describe, expect, it } from "vitest";
import { conversationHash, parseAppRoute, projectHash } from "../src/renderer/routes.js";

describe("renderer routes", () => {
  it("uses Home as the default route", () => {
    expect(parseAppRoute("")).toEqual({ page: "home" });
    expect(parseAppRoute("#/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/unknown")).toEqual({ page: "home" });
    expect(parseAppRoute("#/community")).toEqual({ page: "community" });
    expect(parseAppRoute("#/images")).toEqual({ page: "images" });
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

  it("rejects malformed project routes", () => {
    expect(parseAppRoute("#/projects/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/one/more")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/one/conversations/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/%")).toEqual({ page: "home" });
  });
});
