import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import {
  CanvasTableAI,
  CanvasTableNode,
  CanvasTablePreview,
  ExpandedCanvasTable,
  type CanvasTables,
} from "../src/renderer/canvas-table-node.js";
import { CanvasTableStorage } from "../src/renderer/canvas-table-storage.js";
import { createCanvasTable } from "../src/shared/canvas-table.js";

const table = createCanvasTable("Equipment", "items");
table.rows[0]!.cells[table.columns[0]!.id] = "Sword";
const tables: CanvasTables = {
  storage: new CanvasTableStorage("project"),
  open: vi.fn(),
  add: vi.fn(),
};
const models = { models: [], modelStatus: "ready" as const };

describe("table display and editing", () => {
  it("renders typed data as plain text without spreadsheet editing controls", () => {
    const html = renderToStaticMarkup(<CanvasTablePreview table={table} />);
    expect(html).toContain("Sword");
    expect(html).toContain("Name");
    for (const element of ["<input", "<textarea", "<button", "<select"])
      expect(html).not.toContain(element);
  });

  it("keeps a selected canvas node as a document-style preview with edit, expand and AI actions", () => {
    const html = renderToStaticMarkup(
      <ReactFlowProvider>
        <CanvasTableNode
          selected
          data={{
            tableId: table.id,
            tableRuntime: { ...models, tables, table },
          }}
        />
      </ReactFlowProvider>,
    );
    for (const label of [
      "Edit table",
      "Expand table",
      "Table generation instruction",
    ])
      expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain("story-text-output");
    expect(html).toContain("Sword");
    expect(html).not.toContain('aria-label="Add row"');
    expect(html).not.toContain('aria-label="Column 1 type"');
    expect(html).not.toContain('aria-label="Row 1, Name"');
  });

  it("offers spreadsheet controls only in the expanded edit mode", () => {
    const preview = renderToStaticMarkup(
      <ExpandedCanvasTable
        table={table}
        tables={tables}
        initialMode="preview"
      />,
    );
    expect(preview).not.toContain('aria-label="Add row"');
    expect(preview).toContain('aria-label="Table generation instruction"');
    const edit = renderToStaticMarkup(
      <ExpandedCanvasTable table={table} tables={tables} initialMode="edit" />,
    );
    expect(edit).toContain('aria-label="Add row"');
    expect(edit).toContain('aria-label="Row 1, Name"');
  });

  it("renders valid prototype-named column IDs with normal widths", () => {
    const prototypeColumns = {
      ...table,
      columns: table.columns.map((column, index) => ({
        ...column,
        id: ["constructor", "toString", "__proto__"][index]!,
      })),
      rows: [],
    };
    const html = renderToStaticMarkup(
      <ExpandedCanvasTable table={prototypeColumns} tables={tables} />,
    );
    expect(html).toContain('style="width:578px"');
    expect(html.match(/<col style="width:180px"/g)).toHaveLength(3);
  });

  it("keeps AI instructions, failure messages and candidate adoption visible", () => {
    const storage = new CanvasTableStorage("project");
    storage.changeGeneration(table.id, {
      instruction: "Balance weapons",
      proposal: table,
      error: "The table changed",
    });
    const html = renderToStaticMarkup(
      <CanvasTableAI
        table={table}
        tables={{ ...tables, storage }}
        textModels={models}
      />,
    );
    expect(html).toContain("Balance weapons");
    expect(html).toContain("The table changed");
    for (const label of [
      "AI table draft",
      "Retry table generation",
      "Discard table draft",
      "Replace table with draft",
    ])
      expect(html).toContain(`aria-label="${label}"`);
  });
});
