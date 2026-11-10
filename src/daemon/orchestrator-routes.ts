import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ORCHESTRATOR_MAX_ROLES,
  ORCHESTRATOR_ROLE_ID_PATTERN,
  ORCHESTRATOR_STORE_VERSION,
  type OrchestratorRoleConfig,
} from "../shared/orchestrator.js";
import { OrchestratorConflictError, type OrchestratorSupervisor } from "./orchestrator.js";
import type { ProjectManager } from "./projects.js";

const roleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "persona", "capability", "model"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 40, pattern: ORCHESTRATOR_ROLE_ID_PATTERN.source },
    name: { type: "string", minLength: 1, maxLength: 80 },
    persona: { type: "string", minLength: 1, maxLength: 4_000 },
    capability: { type: "string", enum: ["writer", "advisor"] },
    model: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "id"],
      properties: { provider: { type: "string", minLength: 1, maxLength: 200 }, id: { type: "string", minLength: 1, maxLength: 200 } },
    },
  },
} as const;

const configSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "roles"],
    properties: {
      goal: { type: "string", minLength: 1, maxLength: 4_000 },
      roles: { type: "array", minItems: 1, maxItems: ORCHESTRATOR_MAX_ROLES, items: roleSchema },
    },
  },
} as const;

type ProjectParams = { Params: { projectId: string } };

/** A project's team: its roster and goal, and starting and stopping its run. */
export function registerOrchestratorRoutes(
  app: FastifyInstance,
  options: { projects: Pick<ProjectManager, "get">; orchestrator: OrchestratorSupervisor },
): void {
  const { projects, orchestrator } = options;
  const refused = (reply: FastifyReply, cause: unknown) =>
    reply.code(cause instanceof OrchestratorConflictError ? 409 : 400).send({ error: cause instanceof Error ? cause.message : String(cause) });

  app.get<ProjectParams>("/projects/:projectId/orchestrator", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const state = await orchestrator.loaded(project);
    return state ?? reply.code(404).send({ error: "This project has no team" });
  });

  app.put<ProjectParams & { Body: { goal: string; roles: OrchestratorRoleConfig[] } }>(
    "/projects/:projectId/orchestrator",
    { schema: configSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try {
        return await orchestrator.configure(project, {
          version: ORCHESTRATOR_STORE_VERSION,
          goal: request.body.goal,
          roles: request.body.roles,
          updatedAt: new Date().toISOString(),
        });
      } catch (cause) {
        return refused(reply, cause);
      }
    },
  );

  app.post<ProjectParams>("/projects/:projectId/orchestrator/start", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    try {
      return await orchestrator.start(project);
    } catch (cause) {
      return refused(reply, cause);
    }
  });

  app.post<ProjectParams>("/projects/:projectId/orchestrator/stop", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    await orchestrator.load(project);
    const state = await orchestrator.stop(project.id);
    return state ?? reply.code(404).send({ error: "This project has no team" });
  });

  app.delete<ProjectParams>("/projects/:projectId/orchestrator", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    try {
      await orchestrator.remove(project);
    } catch (cause) {
      return refused(reply, cause);
    }
    return reply.code(204).send();
  });
}
