import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
} from "./contracts.js";
import { EDITOR_LAYOUT_SCHEMA } from "./editor-layout-schema.js";
import { MODEL_3D_MAX_POLYCOUNT, MODEL_3D_MAX_REFERENCE_IMAGES } from "./generation-config.js";

export const ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA = {
  ...EDITOR_LAYOUT_SCHEMA,
  properties: {
    ...EDITOR_LAYOUT_SCHEMA.properties,
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
const node = (type: string, data: object) => ({
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "data"],
  properties: { id, type: { const: type }, data },
});
const nodes = [
  node("text", {
    type: "object",
    additionalProperties: false,
    required: ["text", "instruction"],
    properties: { text: { type: "string" }, instruction: { type: "string" }, model },
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
      references: { type: "array", maxItems: 15, items: reference },
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
    nodes: { type: "array", maxItems: 2_000, items: { oneOf: nodes } },
    edges: {
      type: "array",
      maxItems: 8_000,
      items: { type: "object", additionalProperties: false, required: ["id", "source", "target"], properties: { id, source: id, target: id, sourceHandle: { type: "string", minLength: 1 } } },
    },
  },
} as const;
