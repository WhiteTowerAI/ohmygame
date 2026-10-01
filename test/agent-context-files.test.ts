import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectContextFiles } from "../src/daemon/agent.js";

describe("project context files", () => {
  it("keeps only context files from the workspace and the agent directory", () => {
    const workspace = path.resolve("/data/projects/one/workspace");
    const agentDir = path.resolve("/data/pi-agent");
    const files = [
      { path: path.resolve("/repo/AGENTS.md"), content: "repository rules" },
      { path: path.join(agentDir, "AGENTS.md"), content: "global" },
      { path: path.join(workspace, "AGENTS.md"), content: "game notes" },
      { path: path.resolve("/data/projects/one/workspace-copy/AGENTS.md"), content: "sibling" },
    ];

    expect(projectContextFiles(files, workspace, agentDir).map((file) => file.content)).toEqual(["global", "game notes"]);
  });
});
