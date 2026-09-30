import { Check } from "typebox/value";
import type { PlayableAssetType } from "./playable-nodes.js";

export interface PublishedNodeFile {
  path: string;
  integrity: string;
}

export interface PublishedNodeAsset extends PublishedNodeFile {
  type: PlayableAssetType;
  contentType: string;
  size: number;
}

/** The scope of an agent playtest draft; only drafts enable the playtest bridge. */
export const PLAYTEST_SCOPE_PREFIX = "playtest:";

export interface PublishedNodeManifest {
  version: 1;
  runtime: "playable-nodes";
  scope: string;
  graphSignature: string;
  definition: PublishedNodeFile;
  assets: Record<string, PublishedNodeAsset>;
}

const integrity = {
  type: "string",
  pattern: "^sha256-[A-Za-z0-9+/]{43}=$",
} as const;

const publishedPath = {
  type: "string",
  pattern: "^\\./(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$",
} as const;

export const PUBLISHED_PLAYABLE_MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version", "runtime", "scope", "graphSignature", "definition", "assets"],
  properties: {
    version: { const: 1 },
    runtime: { const: "playable-nodes" },
    scope: { type: "string", minLength: 1 },
    graphSignature: { type: "string", pattern: "^[a-f0-9]{64}$" },
    definition: {
      type: "object",
      additionalProperties: false,
      required: ["path", "integrity"],
      properties: { path: { const: "./playable.json" }, integrity },
    },
    assets: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["path", "integrity", "type", "contentType", "size"],
        properties: {
          path: publishedPath,
          integrity,
          type: { enum: ["image", "video", "audio"] },
          contentType: { type: "string", minLength: 1 },
          size: { type: "integer", minimum: 0 },
        },
      },
    },
  },
} as const;

export function isPublishedNodeManifest(value: unknown): value is PublishedNodeManifest {
  if (!Check(PUBLISHED_PLAYABLE_MANIFEST_SCHEMA, value)) return false;
  return Object.values((value as PublishedNodeManifest).assets).every((asset) => (
    asset.contentType.toLowerCase().startsWith(`${asset.type}/`)
  ));
}
