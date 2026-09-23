import { IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS, MODEL_3D_MODELS, VIDEO_ASPECT_RATIOS, VIDEO_MODEL, VIDEO_RESOLUTIONS } from "./contracts.js";

const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const id = ref("id");
const sourcePath = ref("sourcePath");
const model = ref("model");
const source = ref("source");
const assetReference = ref("assetReference");
const action = ref("action");
const condition = ref("condition");
const presentation = ref("presentation");
const singleMediaPresentation = ref("singleMediaPresentation");
const openUiPresentation = ref("openUiPresentation");
const storyMapPresentation = ref("storyMapPresentation");

const sceneDurationRequirement = {
  if: {
    properties: {
      presentation: {
        properties: {
          media: {
            properties: {
              items: {
                type: "array",
                minItems: 1,
                items: { properties: { type: { const: "video" } }, required: ["type"] },
              },
            },
            required: ["items"],
          },
        },
        required: ["media"],
      },
    },
    required: ["presentation"],
  },
  then: { not: { required: ["durationMs"] } },
  else: { required: ["durationMs"] },
} as const;

const idSchema = { type: "string", minLength: 1 } as const;
const sourcePathSchema = { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)(?:\\.|\\.\\.)(?:/|$))(?!.*//).+$" } as const;
const modelSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "id"],
  properties: { provider: id, id },
} as const;
const sourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["html", "css", "javascript"],
  properties: { html: sourcePath, css: sourcePath, javascript: sourcePath },
} as const;
const assetReferenceSchema = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["type", "assetId"], properties: { type: { const: "library" }, assetId: id } },
    { type: "object", additionalProperties: false, required: ["type", "nodeId"], properties: { type: { const: "node" }, nodeId: id } },
  ],
} as const;
const actionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "variableId", "operator", "value"],
  properties: {
    type: { const: "update-variable" },
    variableId: id,
    operator: { enum: ["set", "add", "subtract", "multiply", "divide"] },
    value: {},
  },
  allOf: [{
    if: { properties: { operator: { const: "divide" } }, required: ["operator"] },
    then: { properties: { value: { type: "number", not: { const: 0 } } } },
  }],
} as const;
const conditionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["variableId", "operator", "value"],
  properties: {
    variableId: id,
    operator: { enum: ["equals", "not-equals", "greater-than", "greater-than-or-equal", "less-than", "less-than-or-equal"] },
    value: {},
  },
} as const;
function presentationSchema(maxItems?: number, movable = false) {
  const items = {
    type: "array",
    ...(maxItems === undefined ? {} : { maxItems }),
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "source"],
      properties: { id, type: { enum: ["image", "video"] }, source: assetReference },
    },
  } as const;
  return {
  type: "object",
  additionalProperties: false,
  required: ["media", "surface"],
  properties: {
    media: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items },
    },
    surface: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source,
        ...(movable ? { layout: {
          type: "object",
          propertyNames: { minLength: 1, maxLength: 120, pattern: "\\S" },
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["offsetX", "offsetY"],
            properties: { offsetX: { type: "number" }, offsetY: { type: "number" } },
          },
        } } : {}),
      },
    },
  },
  } as const;
}
function node(type: string, data: object) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "type", "data"],
    properties: { id, type: { const: type }, data },
  };
}

const nodes = [
  node("start", { type: "object", additionalProperties: false }),
  node("update-state", {
    type: "object", additionalProperties: false, required: ["title", "actions"],
    properties: { title: { type: "string" }, actions: { type: "array", items: action } },
  }),
  node("condition", {
    type: "object", additionalProperties: false, required: ["title"],
    properties: { title: { type: "string" }, condition },
  }),
  node("open-ui", {
    type: "object", additionalProperties: false, required: ["title", "content", "presentation"],
    properties: {
      title: { type: "string" },
      content: {
        type: "object", additionalProperties: false, required: ["title", "buttons"],
        properties: {
          title: { type: "string", maxLength: 120 },
          exits: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id, label: { type: "string", minLength: 1, maxLength: 80 } } } },
          buttons: {
            type: "array", minItems: 4, maxItems: 5,
            items: { type: "object", additionalProperties: false, required: ["id", "label", "action"], properties: { id, label: { type: "string", maxLength: 80 }, action: { enum: ["start-game", "continue-game", "new-game", "open-story-map", "open-settings"] } } },
            allOf: [
              { contains: { type: "object", required: ["action"], properties: { action: { const: "start-game" } } } },
              { contains: { type: "object", required: ["action"], properties: { action: { const: "continue-game" } } } },
              { contains: { type: "object", required: ["action"], properties: { action: { const: "new-game" } } } },
              { contains: { type: "object", required: ["action"], properties: { action: { const: "open-story-map" } } } },
            ],
          },
        },
      },
      presentation: openUiPresentation,
    },
  }),
  node("story-map", {
    type: "object", additionalProperties: false, required: ["title", "presentation"],
    properties: { title: { type: "string", maxLength: 120 }, presentation: storyMapPresentation },
  }),
  node("settings", {
    type: "object", additionalProperties: false, required: ["title", "presentation"],
    properties: { title: { type: "string", maxLength: 120 }, presentation: storyMapPresentation },
  }),
  node("scene", {
    type: "object", additionalProperties: false, required: ["title", "presentation"],
    properties: { title: { type: "string" }, durationMs: { type: "integer", minimum: 1000, maximum: 300000 }, presentation },
    allOf: [sceneDurationRequirement],
  }),
  node("interaction", {
    type: "object", additionalProperties: false, required: ["title", "outcomes", "presentation"],
    properties: {
      title: { type: "string" },
      outcomes: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 80, pattern: "\\S" } },
      timeout: {
        type: "object", additionalProperties: false, required: ["durationMs", "outcome"],
        properties: { durationMs: { type: "integer", minimum: 1000, maximum: 300000 }, outcome: { type: "string", minLength: 1, maxLength: 80, pattern: "\\S" } },
      },
      presentation: singleMediaPresentation,
    },
  }),
  node("choice", {
    type: "object", additionalProperties: false, required: ["title", "options", "presentation"],
    properties: {
      title: { type: "string" }, presentation: singleMediaPresentation,
      options: {
        type: "array", minItems: 1,
        items: {
          type: "object", additionalProperties: false, required: ["id", "label"],
          properties: { id, label: { type: "string" }, condition, actions: { type: "array", items: action } },
        },
      },
      timeout: {
        type: "object", additionalProperties: false, required: ["durationMs", "defaultOptionId"],
        properties: { durationMs: { type: "integer", minimum: 1000, maximum: 300000 }, defaultOptionId: id },
      },
    },
  }),
  node("ending", { type: "object", additionalProperties: false, required: ["title", "description", "presentation"], properties: { title: { type: "string" }, description: { type: "string" }, presentation: singleMediaPresentation } }),
  node("text", { type: "object", additionalProperties: false, required: ["text", "instruction"], properties: { text: { type: "string" }, instruction: { type: "string" }, model } }),
  node("image", {
    type: "object", additionalProperties: false, required: ["prompt", "resolution", "aspectRatio", "images"],
    properties: {
      prompt: { type: "string" }, promptSource: { type: "object", additionalProperties: false, required: ["type", "nodeId"], properties: { type: { const: "node" }, nodeId: id } }, model,
      resolution: { enum: IMAGE_RESOLUTIONS }, aspectRatio: { enum: IMAGE_ASPECT_RATIOS }, images: { type: "array", maxItems: 14, items: assetReference }, assetId: id,
    },
  }),
  node("video", {
    type: "object", additionalProperties: false, required: ["prompt", "model", "resolution", "aspectRatio", "duration", "references"],
    properties: {
      prompt: { type: "string" }, promptSource: { type: "object", additionalProperties: false, required: ["type", "nodeId"], properties: { type: { const: "node" }, nodeId: id } },
      model: { const: VIDEO_MODEL }, resolution: { enum: VIDEO_RESOLUTIONS }, aspectRatio: { enum: VIDEO_ASPECT_RATIOS }, duration: { type: "integer", minimum: 4, maximum: 15 },
      references: { type: "array", maxItems: 15, items: assetReference }, assetId: id,
    },
  }),
  node("model-3d", {
    type: "object", additionalProperties: false, required: ["prompt", "source", "images"],
    properties: {
      prompt: { type: "string" }, promptSource: { type: "object", additionalProperties: false, required: ["type", "nodeId"], properties: { type: { const: "node" }, nodeId: id } },
      model: { enum: MODEL_3D_MODELS }, source: { enum: ["text", "image"] }, images: { type: "array", maxItems: 4, items: assetReference },
      assetId: id,
    },
  }),
  node("asset", { type: "object", additionalProperties: false, required: ["assetId", "mediaType"], properties: { assetId: id, mediaType: { enum: ["image", "video", "audio", "model"] } } }),
];

/** JSON Schema for the persisted story.json file. Cross-file graph rules remain runtime validations. */
export const STORY_CODEBASE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: {
    id: idSchema,
    sourcePath: sourcePathSchema,
    model: modelSchema,
    source: sourceSchema,
    assetReference: assetReferenceSchema,
    action: actionSchema,
    condition: conditionSchema,
    presentation: presentationSchema(),
    singleMediaPresentation: presentationSchema(1),
    openUiPresentation: presentationSchema(1, true),
    storyMapPresentation: presentationSchema(0),
  },
  type: "object",
  additionalProperties: false,
  required: ["version", "player", "variables", "chapter"],
  properties: {
    version: { const: 1 },
    player: {
      type: "object", additionalProperties: false, required: ["title", "viewport", "theme", "videoFit", "choicePosition"],
      properties: {
        title: { type: "string", maxLength: 120 },
        viewport: { type: "object", additionalProperties: false, required: ["width", "height"], properties: { width: { type: "integer", minimum: 240, maximum: 8192 }, height: { type: "integer", minimum: 240, maximum: 8192 } } },
        theme: { type: "object", additionalProperties: false, required: ["accentColor", "textColor", "font"], properties: { accentColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, textColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, font: { enum: ["sans", "serif"] } } },
        videoFit: { enum: ["contain", "cover"] }, choicePosition: { enum: ["center", "bottom"] },
      },
    },
    variables: {
      type: "array",
      items: {
        oneOf: [
          { type: "object", additionalProperties: false, required: ["id", "name", "type", "initialValue"], properties: { id, name: { type: "string", minLength: 1, maxLength: 80 }, type: { const: "boolean" }, initialValue: { type: "boolean" } } },
          { type: "object", additionalProperties: false, required: ["id", "name", "type", "initialValue"], properties: { id, name: { type: "string", minLength: 1, maxLength: 80 }, type: { const: "number" }, initialValue: { type: "number" } } },
          { type: "object", additionalProperties: false, required: ["id", "name", "type", "initialValue"], properties: { id, name: { type: "string", minLength: 1, maxLength: 80 }, type: { const: "text" }, initialValue: { type: "string" } } },
        ],
      },
    },
    chapter: {
      type: "object", additionalProperties: false, required: ["id", "title", "nodes", "edges"],
      properties: {
        id, title: { type: "string" },
        nodes: {
          type: "array",
          items: { oneOf: nodes },
          allOf: [
            { contains: { type: "object", required: ["type"], properties: { type: { const: "start" } } }, minContains: 0, maxContains: 1 },
            { contains: { type: "object", required: ["type"], properties: { type: { const: "open-ui" } } }, minContains: 0, maxContains: 1 },
            { contains: { type: "object", required: ["type"], properties: { type: { const: "story-map" } } }, minContains: 0, maxContains: 1 },
            { contains: { type: "object", required: ["type"], properties: { type: { const: "settings" } } }, minContains: 0, maxContains: 1 },
          ],
        },
        edges: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["id", "source", "target"], properties: { id, source: id, target: id, sourceHandle: { type: "string" } } },
        },
      },
    },
  },
} as const;
