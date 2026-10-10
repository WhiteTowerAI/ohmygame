import { describe, expect, it } from "vitest";
import {
  createCanvasTable,
  importCanvasCsv,
  isCanvasTable,
  mergeCanvasTable,
  parseCanvasCell,
  parseDelimitedTable,
  pasteCanvasCells,
  serializeDelimitedTable,
} from "../src/shared/canvas-table.js";

describe("canvas tables", () => {
  it("round-trips spreadsheet data with quotes, Unicode, empty cells and multiline text", () => {
    const table = importCanvasCsv(
      createCanvasTable(),
      '\uFEFF编号,描述,备注\r\n001,"a,b","line 1\nline 2"\r\n002,"a""b",',
    );
    expect(isCanvasTable(table)).toBe(true);
    expect(
      parseDelimitedTable(serializeDelimitedTable(table, "\t"), "\t"),
    ).toEqual([
      ["编号", "描述", "备注"],
      ["001", "a,b", "line 1\nline 2"],
      ["002", 'a"b', ""],
    ]);
    expect(
      parseDelimitedTable(serializeDelimitedTable(table, ","), ","),
    ).toEqual(parseDelimitedTable(serializeDelimitedTable(table, "\t"), "\t"));
  });
  it("rejects malformed and oversized imports before replacing any data", () => {
    expect(() => parseDelimitedTable('"unterminated', ",")).toThrow(
      "closing quote",
    );
    expect(() => parseDelimitedTable('"a"b', ",")).toThrow("Unexpected text");
    expect(() =>
      parseDelimitedTable(Array(102).fill("x").join(","), ","),
    ).toThrow("100 columns");
    expect(() => pasteCanvasCells(createCanvasTable(), "x\ny", 999, 0)).toThrow(
      "limit",
    );
    expect(() => parseDelimitedTable("x".repeat(10001), ",")).toThrow("10,000");
  });
  it("pastes rectangles at an offset, grows the table, and converts only typed columns", () => {
    const table = createCanvasTable();
    table.columns[1]!.type = "number";
    table.columns[2]!.type = "boolean";
    const result = pasteCanvasCells(
      table,
      "12\ttrue\t001\n3.5\tfalse\t002",
      2,
      1,
    );
    expect(result.rows).toHaveLength(4);
    expect(result.columns).toHaveLength(4);
    expect(result.rows[2]!.cells).toEqual({
      [table.columns[1]!.id]: 12,
      [table.columns[2]!.id]: true,
      [result.columns[3]!.id]: "001",
    });
    expect(table.rows[2]!.cells).toEqual({});
    expect(() => pasteCanvasCells(table, "bad\ttrue", 0, 1)).toThrow("number");
    expect(parseCanvasCell("", "number")).toBeNull();
    expect(parseCanvasCell("FALSE", "boolean")).toBe(false);
    expect(() => parseCanvasCell("Infinity", "number")).toThrow("number");
  });
  it("validates stable IDs, known columns and actual cell types", () => {
    const table = createCanvasTable();
    table.rows[0]!.cells.unknown = "bad";
    expect(isCanvasTable(table)).toBe(false);
    delete table.rows[0]!.cells.unknown;
    table.rows[0]!.cells[table.columns[0]!.id] = 7;
    expect(isCanvasTable(table)).toBe(false);
    table.columns[0]!.type = "number";
    expect(isCanvasTable(table)).toBe(true);
    table.rows[0]!.cells[table.columns[0]!.id] = NaN;
    expect(isCanvasTable(table)).toBe(false);
    delete table.rows[0]!.cells[table.columns[0]!.id];
    table.rows[1]!.id = table.rows[0]!.id;
    expect(isCanvasTable(table)).toBe(false);
  });
  it("merges different cells, metadata and independent new rows without losing either edit", () => {
    const base = createCanvasTable(),
      local = structuredClone(base),
      remote = structuredClone(base);
    local.rows[0]!.cells[base.columns[0]!.id] = "Sword";
    remote.rows[0]!.cells[base.columns[1]!.id] = "10";
    local.columns[0]!.width = 300;
    remote.title = "Items";
    local.rows.push({ id: "local-row", cells: {} });
    remote.rows.push({ id: "remote-row", cells: {} });
    const merged = mergeCanvasTable(base, local, remote)!;
    expect(merged.rows[0]!.cells).toEqual({
      [base.columns[0]!.id]: "Sword",
      [base.columns[1]!.id]: "10",
    });
    expect(merged.title).toBe("Items");
    expect(merged.columns[0]!.width).toBe(300);
    expect(merged.rows).toHaveLength(5);
  });
  it("treats column IDs as data even when they match JavaScript object properties", () => {
    const table = createCanvasTable();
    table.columns[0]!.id = "__proto__";
    table.columns[1]!.id = "constructor";
    expect(
      parseDelimitedTable(serializeDelimitedTable(table, "\t"), "\t")[1],
    ).toEqual(["", "", ""]);
    const pasted = pasteCanvasCells(table, "Sword\t10", 0, 0);
    expect(isCanvasTable(pasted)).toBe(true);
    expect(Object.keys(pasted.rows[0]!.cells)).toEqual([
      "__proto__",
      "constructor",
    ]);
    expect(
      parseDelimitedTable(serializeDelimitedTable(pasted, "\t"), "\t")[1],
    ).toEqual(["Sword", "10", ""]);
  });

  it("preserves inserted row and column positions while merging independent cell edits", () => {
    const base = createCanvasTable(),
      local = structuredClone(base),
      remote = structuredClone(base);
    local.rows[0]!.cells[base.columns[0]!.id] = "Sword";
    remote.rows.splice(1, 0, { id: "inserted-row", cells: {} });
    remote.columns.unshift({
      id: "inserted-column",
      title: "ID",
      type: "text",
    });
    const merged = mergeCanvasTable(base, local, remote)!;
    expect(merged.rows.map((row) => row.id)).toEqual(
      remote.rows.map((row) => row.id),
    );
    expect(merged.columns.map((column) => column.id)).toEqual(
      remote.columns.map((column) => column.id),
    );
    expect(merged.rows[0]!.cells[base.columns[0]!.id]).toBe("Sword");
    expect(mergeCanvasTable(base, remote, local)).toEqual(merged);
  });

  it("keeps both concurrent insertions at their intended positions", () => {
    const base = createCanvasTable(),
      local = structuredClone(base),
      remote = structuredClone(base);
    local.rows.splice(1, 0, { id: "local-row", cells: {} });
    remote.rows.splice(2, 0, { id: "remote-row", cells: {} });
    expect(
      mergeCanvasTable(base, local, remote)?.rows.map((row) => row.id),
    ).toEqual([
      base.rows[0]!.id,
      "local-row",
      base.rows[1]!.id,
      "remote-row",
      base.rows[2]!.id,
    ]);
  });

  it("does not mistake JSON key order for an edit when merging a row deletion", () => {
    const base = createCanvasTable();
    const [first, second] = base.columns;
    base.rows[0]!.cells = { [first!.id]: "Sword", [second!.id]: "10" };
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.rows.shift();
    remote.rows[0]!.cells = { [second!.id]: "10", [first!.id]: "Sword" };
    expect(mergeCanvasTable(base, local, remote)?.rows).toEqual(local.rows);
  });

  it("detects a new row in a concurrently deleted column", () => {
    const base = createCanvasTable(),
      local = structuredClone(base),
      remote = structuredClone(base);
    const deleted = local.columns.shift()!.id;
    remote.rows.push({ id: "added", cells: { [deleted]: "Sword" } });
    expect(mergeCanvasTable(base, local, remote)).toBeUndefined();
  });

  it("detects same-cell and deleted-row conflicts in both directions", () => {
    const base = createCanvasTable(),
      local = structuredClone(base),
      remote = structuredClone(base);
    local.rows[0]!.cells[base.columns[0]!.id] = "Sword";
    remote.rows[0]!.cells[base.columns[0]!.id] = "Shield";
    expect(mergeCanvasTable(base, local, remote)).toBeUndefined();
    remote.rows.shift();
    expect(mergeCanvasTable(base, local, remote)).toBeUndefined();
    expect(mergeCanvasTable(base, remote, local)).toBeUndefined();
  });
  it("allows column removal unless the other side edited its cells", () => {
    const base = createCanvasTable();
    base.rows[0]!.cells[base.columns[0]!.id] = "Sword";
    const local = structuredClone(base),
      remote = structuredClone(base),
      deleted = local.columns.shift()!.id;
    delete local.rows[0]!.cells[deleted];
    expect(mergeCanvasTable(base, local, remote)?.columns).toHaveLength(2);
    remote.rows[0]!.cells[deleted] = "Shield";
    expect(mergeCanvasTable(base, local, remote)).toBeUndefined();
    expect(mergeCanvasTable(base, remote, local)).toBeUndefined();
  });
});
