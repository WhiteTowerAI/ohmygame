import type { FastifyInstance, FastifyReply } from "fastify";
import type { CreateConnectionRequest, UpdateConnectionRequest } from "../shared/connections.js";
import type { McpServerDefinition, PluginConfigurationValues } from "../shared/plugins.js";
import { ConnectionError, type ConnectionService } from "./connections.js";
import { PluginConfigurationError } from "./plugin-configuration.js";

const configurationValues = {
  type: "object",
  additionalProperties: { anyOf: [{ type: "string" }, { type: "boolean" }, { type: "null" }] },
} as const;

/** `/connections`: the person's own MCP servers. Every change restarts the sessions that use them. */
export function registerConnectionRoutes(app: FastifyInstance, { connections, invalidate }: {
  connections: ConnectionService;
  invalidate: () => void;
}) {
  const failed = (reply: FastifyReply, id: string | undefined, cause: unknown) => {
    if (cause instanceof ConnectionError || cause instanceof PluginConfigurationError) {
      const message = id ? connections.redact(id, cause.message) : cause.message;
      return reply.code(cause.statusCode).send({ error: message });
    }
    throw cause;
  };

  app.get("/connections", () => connections.list());

  app.post<{ Body: CreateConnectionRequest }>("/connections", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["displayName", "definition"],
        properties: {
          displayName: { type: "string", minLength: 1, maxLength: 100 },
          definition: { type: "object", additionalProperties: true },
          configuration: { type: "object", additionalProperties: { type: "object" } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const connection = await connections.create(request.body);
      invalidate();
      return reply.code(201).send(connection);
    } catch (cause) {
      return failed(reply, undefined, cause);
    }
  });

  app.get<{ Params: { id: string } }>("/connections/:id", (request, reply) => {
    try {
      return connections.read(request.params.id);
    } catch (cause) {
      return failed(reply, undefined, cause);
    }
  });

  app.patch<{ Params: { id: string }; Body: UpdateConnectionRequest }>("/connections/:id", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          displayName: { type: "string", minLength: 1, maxLength: 100 },
          enabled: { type: "boolean" },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const connection = await connections.update(request.params.id, request.body);
      invalidate();
      return connection;
    } catch (cause) {
      return failed(reply, request.params.id, cause);
    }
  });

  app.delete<{ Params: { id: string } }>("/connections/:id", async (request, reply) => {
    try {
      await connections.remove(request.params.id);
      invalidate();
      return reply.code(204).send();
    } catch (cause) {
      return failed(reply, undefined, cause);
    }
  });

  app.get<{ Params: { id: string } }>("/connections/:id/definition", (request, reply) => {
    try {
      return { definition: connections.editableDefinition(request.params.id) };
    } catch (cause) {
      return failed(reply, request.params.id, cause);
    }
  });

  app.put<{ Params: { id: string }; Body: { definition: McpServerDefinition } }>("/connections/:id/definition", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["definition"],
        properties: { definition: { type: "object", additionalProperties: true } },
      },
    },
  }, async (request, reply) => {
    try {
      const connection = await connections.setDefinition(request.params.id, request.body.definition);
      invalidate();
      return connection;
    } catch (cause) {
      return failed(reply, request.params.id, cause);
    }
  });

  app.get<{ Params: { id: string } }>("/connections/:id/configuration", (request, reply) => {
    try {
      return connections.configurationView(request.params.id);
    } catch (cause) {
      return failed(reply, request.params.id, cause);
    }
  });

  app.put<{ Params: { id: string }; Body: { values: PluginConfigurationValues } }>("/connections/:id/configuration", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["values"],
        properties: { values: configurationValues },
      },
    },
  }, async (request, reply) => {
    try {
      const view = await connections.saveConfiguration(request.params.id, request.body.values);
      invalidate();
      return view;
    } catch (cause) {
      return failed(reply, request.params.id, cause);
    }
  });

  for (const action of ["test", "auth-start", "auth-complete"] as const) {
    app.post<{ Params: { id: string }; Body: { input?: string } }>(`/connections/:id/${action}`, {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { input: { type: "string", maxLength: 16_000 } },
        },
      },
    }, async (request, reply) => {
      try {
        const result = await connections.test(request.params.id, action, request.body?.input);
        if (action === "auth-complete") invalidate();
        return result;
      } catch (cause) {
        if (cause instanceof ConnectionError) return failed(reply, request.params.id, cause);
        return reply.code(400).send({ error: connections.redact(request.params.id, cause instanceof Error ? cause.message : String(cause)) });
      }
    });
  }
}
