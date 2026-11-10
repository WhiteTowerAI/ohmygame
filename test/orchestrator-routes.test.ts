import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestratorSupervisor } from "../src/daemon/orchestrator.js";
import { registerOrchestratorRoutes } from "../src/daemon/orchestrator-routes.js";
import type { ProjectState } from "../src/shared/contracts.js";

let app: FastifyInstance;
let busy = false;

const programmer = { id: "programmer", name: "Programmer", persona: "Write the code.", capability: "writer", model: { provider: "pi", id: "test" } };

beforeEach(async () => {
  busy = false;
  const storagePath = await mkdtemp(path.join(tmpdir(), "orchestrator-routes-"));
  const project: ProjectState = { id: "project-1", name: "Project", type: "general", updatedAt: new Date(0).toISOString(), workspacePath: path.join(storagePath, "workspace"), storagePath, preview: { status: "waiting" } };
  let conversations = 0;
  const orchestrator = new OrchestratorSupervisor({
    events: { publish: (() => ({})) as never },
    createConversation: async () => `conversation-${++conversations}`,
    prompt: async () => {
      if (busy) throw new Error("Wait for the other conversation in this project to finish");
      return { turnId: "turn" };
    },
    cancel: async () => {},
    archiveConversation: async () => {},
    now: () => new Date(0).toISOString(),
  });
  app = Fastify();
  registerOrchestratorRoutes(app, { projects: { get: (id: string) => (id === project.id ? project : undefined) }, orchestrator });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const save = (payload: unknown) => app.inject({ method: "PUT", url: "/projects/project-1/orchestrator", payload: payload as object });

describe("orchestrator routes", () => {
  it("saves a roster and reads it back", async () => {
    const response = await save({ goal: "Make it playable", roles: [programmer] });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("idle");
    const read = await app.inject({ method: "GET", url: "/projects/project-1/orchestrator" });
    expect(read.json().config.goal).toBe("Make it playable");
  });

  it("404s before a team is set up, and for a project that does not exist", async () => {
    expect((await app.inject({ method: "GET", url: "/projects/project-1/orchestrator" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/projects/nope/orchestrator" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/projects/project-1/orchestrator/stop" })).statusCode).toBe(404);
  });

  it("refuses a roster with no writer, and a role id that is not a slug", async () => {
    expect((await save({ goal: "g", roles: [{ ...programmer, capability: "advisor" }] })).statusCode).toBe(400);
    expect((await save({ goal: "g", roles: [{ ...programmer, id: "Not A Slug" }] })).statusCode).toBe(400);
  });

  it("refuses to start a team that was never set up", async () => {
    expect((await app.inject({ method: "POST", url: "/projects/project-1/orchestrator/start" })).statusCode).toBe(400);
  });

  it("409s a start while another conversation is busy", async () => {
    await save({ goal: "g", roles: [programmer] });
    busy = true;
    expect((await app.inject({ method: "POST", url: "/projects/project-1/orchestrator/start" })).statusCode).toBe(409);
  });

  it("refuses to change a team that is running", async () => {
    await save({ goal: "g", roles: [programmer] });
    expect((await app.inject({ method: "POST", url: "/projects/project-1/orchestrator/start" })).json().status).toBe("running");
    expect((await save({ goal: "other", roles: [programmer] })).statusCode).toBe(409);
  });

  it("disbands a stopped team and refuses a running one", async () => {
    await save({ goal: "g", roles: [programmer] });
    await app.inject({ method: "POST", url: "/projects/project-1/orchestrator/start" });
    expect((await app.inject({ method: "DELETE", url: "/projects/project-1/orchestrator" })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/projects/project-1/orchestrator/stop" })).json().status).toBe("stopped");
    expect((await app.inject({ method: "DELETE", url: "/projects/project-1/orchestrator" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/projects/project-1/orchestrator" })).statusCode).toBe(404);
  });
});
