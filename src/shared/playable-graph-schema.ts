const identifier = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
} as const;

const workspacePath = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  pattern:
    "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)(?:\\.|\\.\\.)(?:/|$))(?!.*\\\\)(?!.*//).+$",
} as const;

const source = {
  type: "object",
  additionalProperties: false,
  required: ["html", "css", "javascript"],
  properties: {
    html: workspacePath,
    css: workspacePath,
    javascript: workspacePath,
  },
} as const;

const assetIds = {
  type: "array",
  maxItems: 500,
  uniqueItems: true,
  items: identifier,
} as const;

/** JSON Schema for the persisted graph.json file. Cross-reference rules are validated separately. */
export const PLAYABLE_GRAPH_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: {
    identifier,
    workspacePath,
    jsonValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string", maxLength: 1_000_000 },
        { type: "array", maxItems: 10_000, items: { $ref: "#/$defs/jsonValue" } },
        { type: "object", maxProperties: 1_000, additionalProperties: { $ref: "#/$defs/jsonValue" } },
      ],
    },
    source,
  },
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "title",
    "viewport",
    "entryNodeId",
    "initialState",
    "assets",
    "destinations",
    "nodes",
    "edges",
  ],
  properties: {
    version: { const: 1 },
    title: { type: "string", minLength: 1, maxLength: 120 },
    viewport: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: {
        width: { type: "integer", minimum: 240, maximum: 8192 },
        height: { type: "integer", minimum: 240, maximum: 8192 },
      },
    },
    entryNodeId: identifier,
    initialState: {
      type: "object",
      maxProperties: 1_000,
      additionalProperties: { $ref: "#/$defs/jsonValue" },
    },
    assets: {
      type: "object",
      maxProperties: 1_000,
      propertyNames: identifier,
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["type", "source"],
        properties: {
          type: { enum: ["image", "video", "audio"] },
          source: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "assetId"],
                properties: { kind: { const: "library" }, assetId: identifier },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "path"],
                properties: {
                  kind: { const: "workspace" },
                  path: workspacePath,
                },
              },
            ],
          },
        },
      },
    },
    shell: {
      type: "object",
      additionalProperties: false,
      required: ["source", "assets"],
      properties: { source, assets: assetIds },
    },
    destinations: {
      type: "object",
      maxProperties: 500,
      propertyNames: identifier,
      additionalProperties: identifier,
    },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "source", "assets", "signals"],
        properties: {
          id: identifier,
          title: { type: "string", minLength: 1, maxLength: 120 },
          source,
          assets: assetIds,
          signals: {
            type: "array",
            maxItems: 100,
            uniqueItems: true,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label"],
              properties: {
                id: identifier,
                label: { type: "string", minLength: 1, maxLength: 120 },
              },
            },
          },
        },
      },
    },
    edges: {
      type: "array",
      maxItems: 2_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "source", "targetNodeId", "mode"],
        properties: {
          id: identifier,
          source: {
            type: "object",
            additionalProperties: false,
            required: ["nodeId", "signal"],
            properties: { nodeId: identifier, signal: identifier },
          },
          targetNodeId: identifier,
          mode: { enum: ["replace", "push"] },
        },
      },
    },
  },
} as const;
