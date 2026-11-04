// Node compiles these once. Vite supplies static checks to the renderer under its script CSP.
import { Compile } from "typebox/schema";
import {
  ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA,
  ASSET_CANVAS_SCHEMA,
} from "./asset-canvas-schema.js";
import { CANVAS_TABLE_SCHEMA } from "./canvas-table-schema.js";

export const tableValidator = Compile(CANVAS_TABLE_SCHEMA);
export const boardContentValidator = Compile(ASSET_CANVAS_SCHEMA);
export const layoutValidator = Compile(ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA);
export const positionValidator = Compile(
  ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA.properties.nodes.additionalProperties,
);
