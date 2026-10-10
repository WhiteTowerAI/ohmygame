import {
  AGENT_REASONING_LEVELS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
} from "./contracts.js";
import { EDITOR_LAYOUT_SCHEMA } from "./editor-layout-schema.js";
import { MAX_ANIMATION_ACTIONS, MODEL_3D_MAX_POLYCOUNT, MODEL_3D_MAX_REFERENCE_IMAGES } from "./generation-config.js";

export const MAX_ASSET_CANVAS_NODES = 2_000;
export const MAX_TEXT_NODE_REFERENCES = 14;

export const ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA = {
  ...EDITOR_LAYOUT_SCHEMA,
  properties: {
    ...EDITOR_LAYOUT_SCHEMA.properties,
    nodes: {
      ...EDITOR_LAYOUT_SCHEMA.properties.nodes,
      additionalProperties: {
        ...EDITOR_LAYOUT_SCHEMA.properties.nodes.additionalProperties,
        properties: {
          ...EDITOR_LAYOUT_SCHEMA.properties.nodes.additionalProperties.properties,
          width: { type: "number", minimum: 100, maximum: 4096 },
          height: { type: "number", minimum: 100, maximum: 4096 },
        },
      },
    },
    fitView: { type: "boolean" },
    view: { const: "canvas" },
  },
} as const;

const id = { type: "string", minLength: 1, maxLength: 120 } as const;
const model = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "id"],
  properties: { provider: id, id },
} as const;
const reference = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["type", "assetId"], properties: { type: { const: "library" }, assetId: id } },
    { type: "object", additionalProperties: false, required: ["type", "nodeId"], properties: { type: { const: "node" }, nodeId: id } },
  ],
} as const;
const nodeReferences = { type: "array", maxItems: MAX_TEXT_NODE_REFERENCES, uniqueItems: true, items: reference.oneOf[1] } as const;
const node = (type: string, data: object) => ({
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "data"],
  properties: { id, type: { const: type }, title: { type: "string", maxLength: 200 }, description: { type: "string", maxLength: 2000 }, data },
});
const nodes = [
  node("table", { type: "object", additionalProperties: false, required: ["tableId"], properties: { tableId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" } } }),
  node("document", { type: "object", additionalProperties: false, required: ["documentId"], properties: { documentId: id, references: nodeReferences } }),
  node("text", {
    type: "object",
    additionalProperties: false,
    required: ["text", "instruction"],
    properties: { text: { type: "string" }, instruction: { type: "string" }, model, reasoningLevel: { enum: AGENT_REASONING_LEVELS }, references: nodeReferences },
  }),
  node("image", {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "resolution", "aspectRatio", "images"],
    properties: {
      prompt: { type: "string" },
      promptSource: { type: "object", additionalProperties: false, required: ["type", "nodeId"], properties: { type: { const: "node" }, nodeId: id } },
      model,
      resolution: { enum: IMAGE_RESOLUTIONS },
      aspectRatio: { enum: IMAGE_ASPECT_RATIOS },
      images: { type: "array", maxItems: 14, items: reference },
      assetId: id,
    },
  }),
  node("video", {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "resolution", "aspectRatio", "duration", "references"],
    properties: {
      prompt: { type: "string" },
      promptSource: { type: "object", additionalProperties: false, required: ["type", "nodeId"], properties: { type: { const: "node" }, nodeId: id } },
      model,
      resolution: { enum: VIDEO_RESOLUTIONS },
      aspectRatio: { enum: VIDEO_ASPECT_RATIOS },
      duration: { type: "integer", minimum: 1, maximum: 30 },
      references: { type: "array", maxItems: 30, items: reference },
      referenceMode: { enum: ["frame", "reference"] },
      referenceMentions: { type: "object", patternProperties: { "^Image[1-9][0-9]*$": reference }, additionalProperties: false },
      assetId: id,
    },
  }),
  node("model-3d", {
    type: "object",
    additionalProperties: false,
    required: ["targetPolycount", "texture", "pbr", "images"],
    properties: {
      model,
      targetPolycount: { type: "integer", minimum: 100, maximum: MODEL_3D_MAX_POLYCOUNT },
      texture: { type: "boolean" },
      pbr: { type: "boolean" },
      images: { type: "array", maxItems: MODEL_3D_MAX_REFERENCE_IMAGES, items: reference },
      assetId: id,
    },
  }),
  node("animate-3d", {
    type: "object",
    additionalProperties: false,
    required: ["heightMeters", "actionIds"],
    properties: {
      source: reference,
      heightMeters: { type: "number", exclusiveMinimum: 0, maximum: 100 },
      actionIds: { type: "array", maxItems: MAX_ANIMATION_ACTIONS, uniqueItems: true, items: { type: "integer", minimum: 0 } },
      assetId: id,
    },
  }),
  node("asset", {
    type: "object",
    additionalProperties: false,
    required: ["assetId", "mediaType"],
    properties: { assetId: id, mediaType: { enum: ["image", "video", "audio", "model"] } },
  }),
];

export const ASSET_CANVAS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version", "viewport", "nodes", "edges"],
  properties: {
    version: { const: 1 },
    viewport: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: { width: { type: "integer", minimum: 240, maximum: 8192 }, height: { type: "integer", minimum: 240, maximum: 8192 } },
    },
    nodes: {
      type: "array", maxItems: MAX_ASSET_CANVAS_NODES,
      items: {
        type: "object", required: ["type"],
        properties: { type: { enum: nodes.map((schema) => schema.properties.type.const) } },
        // Skip unrelated node kinds. TypeBox retains detailed field errors in
        // else branches, whereas then branches report only a generic error.
        allOf: nodes.map((schema) => ({
          if: { properties: { type: { not: schema.properties.type } } },
          else: schema,
        })),
      },
    },
    edges: {
      type: "array",
      maxItems: 8_000,
      items: { type: "object", additionalProperties: false, required: ["id", "source", "target"], properties: { id, source: id, target: id, sourceHandle: { type: "string", minLength: 1 } } },
    },
  },
} as const;
