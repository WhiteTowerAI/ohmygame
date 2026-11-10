import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OrchestratorStoreUnreadableError,
  loadOrchestratorConfig,
  orchestratorFile,
  removeOrchestratorConfig,
  saveOrchestratorConfig,
} from "../src/daemon/orchestrator-store.js";
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

async function tempProject() {
  const storagePath = await mkdtemp(path.join(tmpdir(), "orchestrator-"));
  return { workspacePath: path.join(storagePath, "workspace"), storagePath };
}

describe("orchestrator store", () => {
  it("returns undefined when nothing was saved", async () => {
    expect(await loadOrchestratorConfig(await tempProject())).toBeUndefined();
  });

  it("round-trips a config and removes it", async () => {
    const project = await tempProject();
    const config: OrchestratorConfig = {
      version: ORCHESTRATOR_STORE_VERSION,
      goal: "ship it",
      roles: [role("programmer", "writer")],
      conversations: { programmer: "conversation-1" },
      updatedAt: new Date(0).toISOString(),
    };
    await saveOrchestratorConfig(project, config);
    expect(await loadOrchestratorConfig(project)).toEqual(config);
    await removeOrchestratorConfig(project);
    expect(await loadOrchestratorConfig(project)).toBeUndefined();
  });

  it("refuses a newer version and leaves the file alone", async () => {
    const project = await tempProject();
    await mkdir(path.dirname(orchestratorFile(project)), { recursive: true });
    const future = JSON.stringify({ version: 99, goal: "from the future", roles: [], updatedAt: new Date(0).toISOString() });
    await writeFile(orchestratorFile(project), future, "utf8");
    await expect(loadOrchestratorConfig(project)).rejects.toBeInstanceOf(OrchestratorStoreUnreadableError);
    await expect(loadOrchestratorConfig(project)).rejects.toMatchObject({ reason: "newer-version" });
    expect(await readFile(orchestratorFile(project), "utf8")).toBe(future);
  });

  it("refuses damaged json and leaves the file alone", async () => {
    const project = await tempProject();
    await mkdir(path.dirname(orchestratorFile(project)), { recursive: true });
    await writeFile(orchestratorFile(project), "{not json", "utf8");
    await expect(loadOrchestratorConfig(project)).rejects.toMatchObject({ reason: "damaged" });
    expect(await readFile(orchestratorFile(project), "utf8")).toBe("{not json");
  });
});
