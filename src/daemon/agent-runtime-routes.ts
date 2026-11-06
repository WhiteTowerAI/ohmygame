import { realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { AGENT_PERMISSION_MODES, isAccountRuntimeId, isAgentRuntimeId, type UpdateAgentAccountProfileRequest, type UpdateAgentRuntimeRequest } from "../shared/agent-runtimes.js";
import type { AgentManager } from "./agent.js";
import type { AgentRuntimeService } from "./agent-runtimes/service.js";
import type { ProjectManager } from "./projects.js";

const updateAgentRuntimeSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      enabled: { type: "boolean" },
      // Each agent's own modes; the service checks the mode belongs to the agent.
      autoContinue: { type: "boolean" },
      identifyAsOhMyGame: { type: "boolean" },
      permissionMode: { enum: [...new Set(Object.values(AGENT_PERMISSION_MODES).flat())] },
      binaryPath: { type: "string", maxLength: 4_096 },
      defaultProfileId: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
} as const;

/** Settings → Agents: coding agent CLI status, settings, profiles, and sign-in. */
export function registerAgentRuntimeRoutes(app: FastifyInstance, { agentRuntimes, projects, agents }: {
  agentRuntimes: AgentRuntimeService;
  projects: ProjectManager;
  agents: AgentManager;
}): void {
  /** A directory named for an account, resolved; project workspaces are not account configurations. */
  async function connectedDirectory(configDirectory: string): Promise<string> {
    if (!path.isAbsolute(configDirectory)) throw new Error("The configuration directory must be absolute");
    const directory = await realpath(configDirectory);
    if (projects.list().some((project) => directory === project.workspacePath || directory.startsWith(`${project.workspacePath}${path.sep}`))) throw new Error("Keep account configurations outside project workspaces");
    return directory;
  }

  app.get<{ Params: { runtimeId: string }; Querystring: { recheck?: string } }>("/agent-runtimes/:runtimeId/profiles", async (request, reply) => {
    if (!isAccountRuntimeId(request.params.runtimeId)) return reply.code(404).send({ error: "Account configurations are not supported for this coding agent" });
    return agentRuntimes.accountProfiles(request.params.runtimeId, request.query.recheck === "1");
  });
  app.post<{ Params: { runtimeId: string }; Body: { name: string; configDirectory?: string } }>("/agent-runtimes/:runtimeId/profiles", {
    schema: { body: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 80 }, configDirectory: { type: "string", minLength: 1, maxLength: 4096 } } } },
  }, async (request, reply) => {
    if (!isAccountRuntimeId(request.params.runtimeId)) return reply.code(404).send({ error: "Account configurations are not supported for this coding agent" });
    try {
      const configDirectory = request.body.configDirectory ? await connectedDirectory(request.body.configDirectory) : undefined;
      const profile = await agentRuntimes.addAccountProfile(request.params.runtimeId, request.body.name, configDirectory);
      // All native agents must protect every connected credential directory in their next session.
      for (const runtime of ["claude-code-cli", "codex-cli", "opencode-cli"] as const) agents.releaseRuntimeSessions(runtime);
      return reply.code(201).send(profile);
    } catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.patch<{ Params: { runtimeId: string; profileId: string }; Body: UpdateAgentAccountProfileRequest }>("/agent-runtimes/:runtimeId/profiles/:profileId", {
    schema: { body: { type: "object", additionalProperties: false, minProperties: 1, properties: { name: { type: "string", minLength: 1, maxLength: 80 }, configDirectory: { type: "string", minLength: 1, maxLength: 4096 } } } },
  }, async (request, reply) => {
    const { runtimeId, profileId } = request.params;
    if (!isAccountRuntimeId(runtimeId)) return reply.code(404).send({ error: "Account configurations are not supported for this coding agent" });
    if (!agentRuntimes.settings.profiles(runtimeId).some((profile) => profile.id === profileId)) return reply.code(404).send({ error: "Account configuration not found" });
    try {
      const configDirectory = request.body.configDirectory ? await connectedDirectory(request.body.configDirectory) : undefined;
      return await agentRuntimes.updateAccountProfile(runtimeId, profileId, { name: request.body.name, configDirectory }, () => agents.releaseAccountProfileSessions(runtimeId, profileId));
    } catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.post<{ Params: { runtimeId: string; profileId: string }; Body: { direction: -1 | 1 } }>("/agent-runtimes/:runtimeId/profiles/:profileId/move", {
    schema: { body: { type: "object", additionalProperties: false, required: ["direction"], properties: { direction: { enum: [-1, 1] } } } },
  }, async (request, reply) => {
    const { runtimeId, profileId } = request.params;
    if (!isAccountRuntimeId(runtimeId)) return reply.code(404).send({ error: "Account configurations are not supported for this coding agent" });
    if (profileId === "system") return reply.code(400).send({ error: "System default stays first" });
    if (!agentRuntimes.settings.profiles(runtimeId).some((profile) => profile.id === profileId)) return reply.code(404).send({ error: "Account configuration not found" });
    await agentRuntimes.settings.moveProfile(runtimeId, profileId, request.body.direction);
    return reply.code(204).send();
  });

  app.get<{ Params: { runtimeId: string; profileId: string } }>("/agent-runtimes/:runtimeId/profiles/:profileId/directory", async (request, reply) => {
    const { runtimeId, profileId } = request.params;
    if (!isAccountRuntimeId(runtimeId)) return reply.code(404).send({ error: "Account configurations are not supported for this coding agent" });
    if (!agentRuntimes.settings.profiles(runtimeId).some((profile) => profile.id === profileId)) return reply.code(404).send({ error: "Account configuration not found" });
    return { path: agentRuntimes.accountDirectory(runtimeId, profileId) };
  });

  app.delete<{ Params: { runtimeId: string; profileId: string } }>("/agent-runtimes/:runtimeId/profiles/:profileId", async (request, reply) => {
    const { runtimeId, profileId } = request.params;
    if (!isAccountRuntimeId(runtimeId)) return reply.code(404).send({ error: "Account configurations are not supported for this coding agent" });
    if (profileId === "system") return reply.code(400).send({ error: "System default cannot be deleted" });
    if (!agentRuntimes.settings.profiles(runtimeId).some((profile) => profile.id === profileId)) return reply.code(404).send({ error: "Account configuration not found" });
    try {
      await agentRuntimes.removeAccountProfile(runtimeId, profileId, () => agents.releaseAccountProfileSessions(runtimeId, profileId));
      return reply.code(204).send();
    } catch (cause) {
      return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.get<{ Querystring: { recheck?: string } }>("/agent-runtimes", async (request) => agentRuntimes.statuses(request.query.recheck === "1"));

  app.patch<{ Params: { runtimeId: string }; Body: UpdateAgentRuntimeRequest }>("/agent-runtimes/:runtimeId", { schema: updateAgentRuntimeSchema }, async (request, reply) => {
    if (!isAgentRuntimeId(request.params.runtimeId) || !(await agentRuntimes.known(request.params.runtimeId))) return reply.code(404).send({ error: "Coding agent not found" });
    try {
      const status = await agentRuntimes.update(request.params.runtimeId, request.body);
      // Open conversations pick up how the agent runs with their next message.
      if (request.body.permissionMode !== undefined || request.body.binaryPath !== undefined || request.body.identifyAsOhMyGame !== undefined) agents.releaseRuntimeSessions(request.params.runtimeId);
      return status;
    } catch (cause) {
      return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Params: { runtimeId: string } }>("/agent-runtimes/:runtimeId/recheck", async (request, reply) => {
    if (!isAgentRuntimeId(request.params.runtimeId) || !(await agentRuntimes.known(request.params.runtimeId))) return reply.code(404).send({ error: "Coding agent not found" });
    return agentRuntimes.status(request.params.runtimeId, true);
  });

  app.post<{ Params: { runtimeId: string }; Querystring: { profileId?: string } }>("/agent-runtimes/:runtimeId/login", async (request, reply) => {
    if (!isAgentRuntimeId(request.params.runtimeId) || !(await agentRuntimes.known(request.params.runtimeId))) return reply.code(404).send({ error: "Coding agent not found" });
    try {
      return await agentRuntimes.login(request.params.runtimeId, request.query.profileId);
    } catch (cause) {
      return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });
}
