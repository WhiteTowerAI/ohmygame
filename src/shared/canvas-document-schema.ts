import { Type } from "typebox";
import { Check } from "typebox/value";
import type { CanvasMarkdownDocument } from "./canvas-document.js";
export const GAME_DESIGN_SCHEMA = Type.Object({
  id: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,100}$" }),
  title: Type.String({ maxLength: 200 }),
  markdown: Type.String({ maxLength: 1_000_000 }),
}, { additionalProperties: false });
export function isCanvasDocument(value: unknown): value is CanvasMarkdownDocument { return Check(GAME_DESIGN_SCHEMA, value); }
