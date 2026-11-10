import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_STORE_VERSION,
  type OrchestratorConfig,
  type OrchestratorRoleConfig,
} from "../src/shared/orchestrator.js";

function role(id: string, capability: "writer" | "advisor"): OrchestratorRoleConfig {
  return { id, name: id, persona: `You are the ${id}.`, capability, model: { provider: "pi", id: "test" } };
}

describe("orchestrator types", () => {
  it("holds a versioned config with a goal and a roster", () => {
    const config: OrchestratorConfig = {
      version: ORCHESTRATOR_STORE_VERSION,
      goal: "Make the night level playable",
      roles: [role("programmer", "writer"), role("critic", "advisor")],
      updatedAt: new Date(0).toISOString(),
    };
    expect(config.version).toBe(1);
    expect(config.roles.map((item) => item.capability)).toEqual(["writer", "advisor"]);
  });
});
