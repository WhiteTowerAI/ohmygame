import { describe, expect, it } from "vitest";
import { parseAppRoute, projectHash } from "../src/renderer/routes.js";

describe("renderer routes", () => {
  it("uses Home as the default route", () => {
    expect(parseAppRoute("")).toEqual({ page: "home" });
    expect(parseAppRoute("#/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/unknown")).toEqual({ page: "home" });
    expect(parseAppRoute("#/community")).toEqual({ page: "community" });
  });

  it("parses and formats project routes", () => {
    expect(parseAppRoute("#/projects/project%201")).toEqual({ page: "project", projectId: "project 1" });
    expect(projectHash("project 1")).toBe("#/projects/project%201");
  });

  it("rejects malformed project routes", () => {
    expect(parseAppRoute("#/projects/")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/one/more")).toEqual({ page: "home" });
    expect(parseAppRoute("#/projects/%")).toEqual({ page: "home" });
  });
});
