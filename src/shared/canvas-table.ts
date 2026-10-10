import { Type } from "typebox";
import { Check, Equal as equal } from "typebox/value";
import type { AgentModelRef, AgentReasoningLevel } from "./contracts.js";

export type CanvasCell = string | number | boolean | null;
export type CanvasColumnType = "text" | "number" | "boolean";
export interface CanvasTableColumn {
  id: string;
  title: string;
  type: CanvasColumnType;
  width?: number;
}
export interface CanvasTableRow {
  id: string;
  cells: Record<string, CanvasCell>;
}
export interface CanvasTable {
  version: 1;
  id: string;
  title: string;
  columns: CanvasTableColumn[];
  rows: CanvasTableRow[];
}
export interface CanvasTableDetail {
  table: CanvasTable;
  revision: string;
}
export interface CanvasTableGenerationRequest {
  instruction: string;
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  revision: string;
}
export type CanvasTableGenerationResult =
  | { status: "complete"; table: CanvasTable }
  | { status: "incomplete" | "empty" | "invalid"; error: string };
export type CanvasTableGenerationResponse = CanvasTableGenerationResult & {
  model: AgentModelRef;
  revision: string;
};
export const MAX_TABLE_ROWS = 1000;
export const MAX_TABLE_COLUMNS = 100;
export const canvasTablePath = (id: string) => `canvas/tables/${id}.json`;
export const canvasCell = (
  row: CanvasTableRow,
  columnId: string,
): CanvasCell | undefined =>
  Object.hasOwn(row.cells, columnId) ? row.cells[columnId] : undefined;
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

export function isCanvasTable(value: unknown): value is CanvasTable {
  if (!Check(CANVAS_TABLE_SCHEMA, value)) return false;
  const table = value as CanvasTable;
  const columns = new Map(table.columns.map((column) => [column.id, column]));
  return (
    columns.size === table.columns.length &&
    new Set(table.rows.map((row) => row.id)).size === table.rows.length &&
    table.rows.every((row) =>
      Object.entries(row.cells).every(([key, cell]) => {
        const column = columns.get(key);
        return (
          column &&
          (cell === null ||
            (typeof cell ===
              (column.type === "text" ? "string" : column.type) &&
              (typeof cell !== "number" || Number.isFinite(cell))))
        );
      }),
    )
  );
}

export function createCanvasTable(
  title = "Untitled table",
  tableId: string = crypto.randomUUID(),
): CanvasTable {
  return {
    version: 1,
    id: tableId,
    title,
    columns: ["Name", "Value", "Notes"].map((title) => ({
      id: crypto.randomUUID(),
      title,
      type: "text",
    })),
    rows: Array.from({ length: 3 }, () => ({
      id: crypto.randomUUID(),
      cells: {},
    })),
  };
}

export function parseCanvasCell(
  text: string,
  type: CanvasColumnType,
): CanvasCell {
  if (text.length > 10000)
    throw new Error("Cells support up to 10,000 characters.");
  if (type === "text") return text;
  if (!text.trim()) return null;
  if (type === "boolean") {
    if (/^(true|1)$/i.test(text.trim())) return true;
    if (/^(false|0)$/i.test(text.trim())) return false;
    throw new Error("Enter true or false for a boolean cell.");
  }
  if (
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) &&
    Number.isFinite(Number(text))
  )
    return Number(text);
  throw new Error("Enter a finite number for a number cell.");
}

// Handles CSV and spreadsheet TSV, including quoted newlines and escaped quotes.
export function parseDelimitedTable(
  text: string,
  delimiter: "," | "\t",
): string[][] {
  if (text.length > 4 * 1024 * 1024) throw new Error("The table is too large.");
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [],
    row: string[] = [];
  let field = "",
    quoted = false,
    closed = false;
  const finish = () => {
    row.push(field);
    field = "";
    closed = false;
    if (row.length > MAX_TABLE_COLUMNS)
      throw new Error("Tables support up to 100 columns.");
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === delimiter) finish();
    else if (char === "\n" || char === "\r") {
      finish();
      rows.push(row.splice(0));
      if (char === "\r" && text[i + 1] === "\n") i++;
      if (rows.length > MAX_TABLE_ROWS + 1)
        throw new Error("Tables support up to 1,000 rows.");
    } else if (char === '"' && !field && !closed) quoted = true;
    else {
      if (closed) throw new Error("Unexpected text after a quoted cell.");
      field += char;
    }
    if (field.length > 10000)
      throw new Error("Cells support up to 10,000 characters.");
  }
  if (quoted) throw new Error("A quoted cell is missing its closing quote.");
  if (field || row.length || closed || !rows.length) {
    finish();
    rows.push(row);
  }
  if (rows.length > MAX_TABLE_ROWS + 1)
    throw new Error("Tables support up to 1,000 rows.");
  return rows;
}

export function serializeDelimitedTable(
  table: CanvasTable,
  delimiter: "," | "\t",
): string {
  const quote = (value: CanvasCell) => {
    const text = String(value ?? "");
    return text.includes(delimiter) || /["\r\n]/.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  };
  return [
    table.columns.map((column) => column.title),
    ...table.rows.map((row) =>
      table.columns.map((column) => canvasCell(row, column.id) ?? null),
    ),
  ]
    .map((row) => row.map(quote).join(delimiter))
    .join("\r\n");
}

export function importCanvasCsv(table: CanvasTable, text: string): CanvasTable {
  const [header, ...data] = parseDelimitedTable(text, ",");
  const count = Math.max(header!.length, ...data.map((row) => row.length));
  const columns: CanvasTableColumn[] = Array.from(
    { length: count },
    (_, i) => ({
      id: crypto.randomUUID(),
      title: header![i]?.slice(0, 200) || `Column ${i + 1}`,
      type: "text",
    }),
  );
  return {
    ...table,
    columns,
    rows: data.map((row) => ({
      id: crypto.randomUUID(),
      cells: Object.fromEntries(
        columns.map((column, i) => [column.id, row[i] ?? ""]),
      ),
    })),
  };
}

export function pasteCanvasCells(
  table: CanvasTable,
  text: string,
  rowIndex: number,
  columnIndex: number,
): CanvasTable {
  const data = parseDelimitedTable(text, "\t");
  const width = Math.max(...data.map((row) => row.length));
  if (
    rowIndex < 0 ||
    columnIndex < 0 ||
    rowIndex + data.length > MAX_TABLE_ROWS ||
    columnIndex + width > MAX_TABLE_COLUMNS
  )
    throw new Error("Paste exceeds the table limit (1,000 rows, 100 columns).");
  const result = structuredClone(table);
  while (result.columns.length < columnIndex + width)
    result.columns.push({
      id: crypto.randomUUID(),
      title: `Column ${result.columns.length + 1}`,
      type: "text",
    });
  while (result.rows.length < rowIndex + data.length)
    result.rows.push({ id: crypto.randomUUID(), cells: {} });
  data.forEach((row, r) =>
    row.forEach((text, c) => {
      const column = result.columns[columnIndex + c]!;
      const target = result.rows[rowIndex + r]!;
      target.cells = {
        ...target.cells,
        [column.id]: parseCanvasCell(text, column.type),
      };
    }),
  );
  return result;
}

export function mergeCanvasTable(
  base: CanvasTable,
  local: CanvasTable,
  remote: CanvasTable,
): CanvasTable | undefined {
  if (base.id !== local.id || local.id !== remote.id) return;
  let conflict = false;
  const merge = <T>(a: T, b: T, c: T): T => {
    if (equal(b, c) || equal(a, c)) return b;
    if (equal(a, b)) return c;
    conflict = true;
    return b;
  };
  const entities = <T extends { id: string }>(
    before: T[],
    ours: T[],
    theirs: T[],
    fields: (a: T, b: T, c: T) => T,
  ): T[] => {
    const result = new Map<string, T>();
    const byId = (items: T[]) => new Map(items.map((item) => [item.id, item]));
    const beforeById = byId(before),
      oursById = byId(ours),
      theirsById = byId(theirs);
    for (const id of new Set(
      [...before, ...ours, ...theirs].map((item) => item.id),
    )) {
      const a = beforeById.get(id),
        b = oursById.get(id),
        c = theirsById.get(id);
      const value = a && b && c ? fields(a, b, c) : merge(a, b, c);
      if (value) result.set(id, value);
    }
    const retained = new Set(
      before.filter((item) => result.has(item.id)).map((item) => item.id),
    );
    const order = (items: T[]) =>
      items.filter((item) => retained.has(item.id)).map((item) => item.id);
    const ids = merge(order(before), order(ours), order(theirs));
    const placed = new Set(ids);
    // Place new entities before their next surviving neighbor, preserving insertion positions.
    for (const items of [ours, theirs]) {
      let next: string | undefined;
      for (const { id } of items.toReversed()) {
        if (!result.has(id)) continue;
        if (!placed.has(id)) {
          ids.splice(
            next === undefined ? ids.length : ids.indexOf(next),
            0,
            id,
          );
          placed.add(id);
        }
        next = id;
      }
    }
    return ids.map((id) => result.get(id)!);
  };
  const columns = entities(
    base.columns,
    local.columns,
    remote.columns,
    (a, b, c) => {
      const width = merge(a.width, b.width, c.width);
      return {
        id: b.id,
        title: merge(a.title, b.title, c.title),
        type: merge(a.type, b.type, c.type),
        ...(width !== undefined ? { width } : {}),
      };
    },
  );
  const columnIds = new Set(columns.map((column) => column.id));
  for (const column of base.columns.filter(
    (column) => !columnIds.has(column.id),
  )) {
    for (const side of [local, remote])
      if (side.columns.some((item) => item.id === column.id)) {
        for (const row of side.rows) {
          const before = base.rows.find((item) => item.id === row.id);
          if (
            !equal(
              before ? canvasCell(before, column.id) : undefined,
              canvasCell(row, column.id),
            )
          )
            conflict = true;
        }
      }
  }
  const rows = entities(base.rows, local.rows, remote.rows, (a, b, c) => ({
    id: b.id,
    cells: Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(a.cells),
          ...Object.keys(b.cells),
          ...Object.keys(c.cells),
        ]),
      ].flatMap((id) => {
        const value = merge(
          canvasCell(a, id),
          canvasCell(b, id),
          canvasCell(c, id),
        );
        return columnIds.has(id) && value !== undefined ? [[id, value]] : [];
      }),
    ),
  }));
  const result = {
    ...local,
    title: merge(base.title, local.title, remote.title),
    columns,
    rows: rows.map((row) => ({
      ...row,
      cells: Object.fromEntries(
        Object.entries(row.cells).filter(([id]) => columnIds.has(id)),
      ),
    })),
  };
  return !conflict && isCanvasTable(result) ? result : undefined;
}
