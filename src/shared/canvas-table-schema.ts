import { Type } from "typebox";

export const MAX_TABLE_ROWS = 1000;
export const MAX_TABLE_COLUMNS = 100;

const id = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,100}$" });
export const CANVAS_TABLE_SCHEMA = Type.Object(
  {
    version: Type.Literal(1),
    id,
    title: Type.String({ maxLength: 200 }),
    columns: Type.Array(
      Type.Object(
        {
          id,
          title: Type.String({ maxLength: 200 }),
          type: Type.Union([
            Type.Literal("text"),
            Type.Literal("number"),
            Type.Literal("boolean"),
          ]),
          width: Type.Optional(Type.Number({ minimum: 80, maximum: 1200 })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_TABLE_COLUMNS },
    ),
    rows: Type.Array(
      Type.Object(
        {
          id,
          cells: Type.Record(
            id,
            Type.Union([
              Type.String({ maxLength: 10000 }),
              Type.Number(),
              Type.Boolean(),
              Type.Null(),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: MAX_TABLE_ROWS },
    ),
  },
  { additionalProperties: false },
);
