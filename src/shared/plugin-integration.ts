import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const PLUGIN_INTEGRATION_ACTIONS = [
  "status",
  "prepare",
  "connect",
  "projects",
  "create",
  "bind",
  "preview-status",
  "preview-install",
  "preview-start",
  "preview-refresh",
  "preview-stop",
  "preview-logs",
] as const;
export type PluginIntegrationAction =
  (typeof PLUGIN_INTEGRATION_ACTIONS)[number];
export interface PluginIntegrationDefinition {
  entry: string;
  /** The adapter can create and initialize a new service project. */
  createProject?: boolean;
  /** Files relative to a workspace, all of which must exist to recognize it. */
  projectFiles?: string[];
  preview?: "external";
}

const Message = Type.String({ maxLength: 4096 });
const Project = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 512 }),
    name: Type.Optional(Message),
  },
  { additionalProperties: false },
);
export const PluginIntegrationResultSchema = Type.Object(
  {
    connection: Type.Optional(
      Type.Object(
        {
          status: Type.Union([
            Type.Literal("needs-setup"),
            Type.Literal("needs-auth"),
            Type.Literal("ready"),
          ]),
          message: Type.Optional(Message),
        },
        { additionalProperties: false },
      ),
    ),
    project: Type.Optional(Type.Union([Project, Type.Null()])),
    projects: Type.Optional(Type.Array(Project, { maxItems: 2000 })),
    preview: Type.Optional(
      Type.Object(
        {
          status: Type.Union([
            Type.Literal("missing"),
            Type.Literal("stopped"),
            Type.Literal("running"),
            Type.Literal("error"),
          ]),
          message: Type.Optional(Message),
          logs: Type.Optional(Type.String({ maxLength: 16_384 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PluginIntegrationResult = Static<
  typeof PluginIntegrationResultSchema
>;

export const PluginIntegrationMessageSchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(1),
      type: Type.Literal("progress"),
      message: Message,
      authorizationUrl: Type.Optional(Type.String({ maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      type: Type.Literal("result"),
      result: PluginIntegrationResultSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { version: Type.Literal(1), type: Type.Literal("error"), message: Message },
    { additionalProperties: false },
  ),
]);
export type PluginIntegrationMessage = Static<
  typeof PluginIntegrationMessageSchema
>;
export function isPluginIntegrationMessage(
  value: unknown,
): value is PluginIntegrationMessage {
  return Check(PluginIntegrationMessageSchema, value);
}

export interface PluginIntegrationRequest {
  version: 1;
  action: PluginIntegrationAction;
  dataDirectory: string;
  workspacePath?: string;
  configuration: Record<string, string | boolean>;
  projectId?: string;
  projectName?: string;
}

export interface PluginIntegrationState {
  pluginId: string;
  action: PluginIntegrationAction;
  running: boolean;
  message?: string;
  authorizationUrl?: string;
  error?: string;
  result?: PluginIntegrationResult;
  /** Epoch milliseconds of the last finished action that reports the connection. */
  connectionCheckedAt?: number;
}
