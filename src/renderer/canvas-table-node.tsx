import type { CanvasWorkspaceDetail } from "../shared/canvas-workspace.js";
import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  canvasCell,
  importCanvasCsv,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  parseCanvasCell,
  pasteCanvasCells,
  serializeDelimitedTable,
  type CanvasCell,
  type CanvasTable,
  type CanvasTableColumn,
  type CanvasColumnType,
} from "../shared/canvas-table.js";
import type {
  CanvasTableConflict,
  CanvasTableStorage,
} from "./canvas-table-storage.js";
import {
  CanvasNodeLabel,
  type CanvasNodeDetails,
} from "./canvas-node-label.js";
import {
  CanvasNodeResizer,
  CanvasNodeSizeActions,
  type CanvasNodeResizeRuntime,
} from "./canvas-node-resizer.js";
import {
  CanvasTextInput,
  CanvasTextComposer,
  type CanvasTextModels,
} from "./canvas-text-composer.js";
import { useAgentModels } from "./model-selector.js";
import {
  Columns2,
  Check,
  Copy,
  Download,
  Eye,
  Maximize,
  Pencil,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  Upload,
  X,
} from "./icons.js";

export interface CanvasTables {
  storage: CanvasTableStorage;
  issues?: CanvasWorkspaceDetail["tableIssues"];
  open(id: string, mode?: "edit" | "preview"): void;
  add(): Promise<string | undefined>;
}
export interface TableNodeRuntime extends CanvasTextModels {
  tables: CanvasTables;
  table?: CanvasTable;
  issue?: string;
}
export function CanvasTableNode({
  data,
  selected,
}: {
  data: {
    tableId?: string;
    tableRuntime?: TableNodeRuntime;
    resizeRuntime?: CanvasNodeResizeRuntime;
    nodeDetails?: CanvasNodeDetails;
  };
  selected?: boolean;
}) {
  const runtime = data.tableRuntime;
  const table = runtime?.table;
  return (
    <div
      className={`story-node story-text-node design-document-node canvas-table-node${selected ? " is-selected" : ""}`}
    >
      <CanvasNodeResizer selected={selected} runtime={data.resizeRuntime} />
      <div className="story-text-output">
        <div data-alignment-frame className="design-document-node-content">
          <CanvasNodeLabel
            icon={Columns2}
            label={runtime?.table?.title || "Table"}
            details={data.nodeDetails}
            className="design-document-node-header"
          />
          {runtime?.issue ? (
            <p className="design-document-issue" role="status">
              {runtime.issue}
            </p>
          ) : null}
          {table ? (
            <div className="design-document-node-body is-preview nowheel">
              <CanvasTablePreview table={table} />
            </div>
          ) : (
            <p className="design-document-issue">
              Table unavailable. Restore its file to load it again.
            </p>
          )}
        </div>
        <footer
          className={`design-document-node-footer nodrag nowheel${selected ? "" : " is-hidden"}`}
        >
          <div
            className="design-mode-control"
            role="group"
            aria-label="Table view"
          >
            <button
              type="button"
              aria-label="Edit table"
              title="Edit table"
              disabled={!table}
              onClick={() => table && runtime?.tables.open(table.id, "edit")}
            >
              <Pencil size={14} />
            </button>
          </div>
          <div className="design-document-node-actions">
            <CanvasNodeSizeActions runtime={data.resizeRuntime} />
            <button
              type="button"
              aria-label="Expand table"
              title="Expand table"
              disabled={!table}
              onClick={() => table && runtime?.tables.open(table.id, "preview")}
            >
              <Maximize size={14} />
            </button>
          </div>
        </footer>
      </div>
      {selected && table && runtime ? (
        <div className="canvas-node-auxiliary">
          <CanvasTableAI
            table={table}
            tables={runtime.tables}
            textModels={runtime}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ExpandedCanvasTable({
  table,
  tables,
  initialMode = "edit",
}: {
  table: CanvasTable;
  tables: CanvasTables;
  initialMode?: "edit" | "preview";
}) {
  const [mode, setMode] = useState(initialMode);
  const catalog = useAgentModels();
  const session = tables.storage.sessions.get(table.id);
  return (
    <>
      <header className="design-expanded-toolbar">
        <Columns2 size={16} />
        <CanvasTextInput
          aria-label="Table title"
          maxLength={200}
          value={table.title}
          onChange={(title) => tables.storage.update({ ...table, title })}
        />
        <div
          className="design-mode-control"
          role="group"
          aria-label="Table view"
        >
          <button
            type="button"
            title="Edit table"
            aria-label="Edit table"
            aria-pressed={mode === "edit"}
            onClick={() => setMode("edit")}
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            title="Preview table"
            aria-label="Preview table"
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            <Eye size={15} />
          </button>
        </div>
      </header>
      {session?.conflict ? (
        <CanvasTableConflictNotice
          conflict={session.conflict}
          storage={tables.storage}
        />
      ) : null}
      {!session?.conflict && (session?.issue || tables.storage.error) ? (
        <p className="canvas-table-notice" role="alert">
          {session?.issue ?? tables.storage.error}
        </p>
      ) : null}
      {mode === "edit" ? (
        <CanvasTableEditor table={table} tables={tables} />
      ) : (
        <CanvasTablePreview table={table} />
      )}
      <div className="design-expanded-ai">
        <CanvasTableAI
          table={table}
          tables={tables}
          textModels={{
            models: catalog.models,
            modelStatus: catalog.status,
            defaultModel: catalog.defaultModel ?? catalog.models[0],
            defaultReasoningLevel: catalog.defaultReasoningLevel,
          }}
        />
      </div>
    </>
  );
}

export function CanvasTablePreview({ table }: { table: CanvasTable }) {
  return (
    <div
      className="canvas-table-scroll canvas-table-preview"
      role="region"
      aria-label="Table preview"
    >
      <table
        style={{
          width:
            38 +
            table.columns.reduce(
              (sum, column) => sum + (column.width ?? 180),
              0,
            ),
        }}
      >
        <colgroup>
          <col style={{ width: 38 }} />
          {table.columns.map((column) => (
            <col key={column.id} style={{ width: column.width ?? 180 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th aria-label="Rows" />
            {table.columns.map((column) => (
              <th key={column.id} scope="col">
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={row.id}>
              <th className="canvas-table-row-number" scope="row">
                {r + 1}
              </th>
              {table.columns.map((column) => (
                <td key={column.id}>
                  {String(canvasCell(row, column.id) ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!table.rows.length ? (
        <p className="canvas-table-empty">
          No rows yet. Edit the table or describe what to generate below.
        </p>
      ) : null}
    </div>
  );
}

export function CanvasTableAI({
  table,
  tables,
  textModels,
}: {
  table: CanvasTable;
  tables: CanvasTables;
  textModels: CanvasTextModels;
}) {
  const storage = tables.storage,
    state = storage.generation(table.id),
    busy = state?.generating || state?.applying;
  const [copyNotice, setCopyNotice] = useState<string>();
  return (
    <>
      <CanvasTextComposer
        {...textModels}
        instruction={state?.instruction ?? ""}
        model={state?.model}
        reasoningLevel={state?.reasoningLevel}
        generating={state?.generating}
        busy={busy}
        error={state?.error}
        label="Table generation instruction"
        placeholder="Describe the table to create or change"
        generateLabel={
          state?.error || state?.proposal
            ? "Retry table generation"
            : "Generate table"
        }
        onInstruction={(instruction) =>
          storage.changeGeneration(table.id, { instruction, error: undefined })
        }
        onModel={(model, reasoningLevel) =>
          storage.changeGeneration(table.id, {
            model,
            reasoningLevel,
            error: undefined,
          })
        }
        onReasoningChange={(reasoningLevel) =>
          storage.changeGeneration(table.id, {
            model: state?.model ?? textModels.defaultModel,
            reasoningLevel,
            error: undefined,
          })
        }
        onGenerate={(model, reasoningLevel) => {
          void storage.generate(table.id, model, reasoningLevel);
        }}
      />
      {state?.proposal ? (
        <section
          className="design-ai-result nodrag nowheel nokey"
          aria-label="AI table draft"
        >
          <p className="design-ai-result-status" role="status">
            Candidate draft — review before replacing the table.
          </p>
          <div className="canvas-table-ai-preview">
            <CanvasTablePreview table={state.proposal} />
          </div>
          {copyNotice ? <p role="status">{copyNotice}</p> : null}
          <footer>
            <button
              type="button"
              title="Copy table draft"
              aria-label="Copy table draft"
              onClick={() => {
                void navigator.clipboard
                  .writeText(serializeDelimitedTable(state.proposal!, "\t"))
                  .then(() => setCopyNotice("Draft copied."))
                  .catch(() => setCopyNotice("Could not copy the draft."));
              }}
            >
              <Copy size={14} />
              <span>Copy</span>
            </button>
            <button
              type="button"
              title="Discard table draft"
              aria-label="Discard table draft"
              disabled={busy}
              onClick={() =>
                storage.changeGeneration(table.id, {
                  proposal: undefined,
                  error: undefined,
                })
              }
            >
              <X size={14} />
              <span>Discard</span>
            </button>
            <button
              type="button"
              title="Replace table with draft"
              aria-label="Replace table with draft"
              disabled={busy}
              onClick={() => {
                void storage.applyGeneration(table.id);
              }}
            >
              <Check size={14} />
              <span>{state.applying ? "Saving…" : "Use draft"}</span>
            </button>
          </footer>
        </section>
      ) : null}
    </>
  );
}

export function CanvasTableConflictNotice({
  conflict,
  storage,
}: {
  conflict: CanvasTableConflict;
  storage: CanvasTableStorage;
}) {
  return (
    <div className="design-notice" role="alert">
      <span>
        Table “{conflict.local.title}” changed elsewhere. Your draft is kept;
        choose a version to resume saving.
      </span>
      <button
        type="button"
        onClick={() => storage.resolve(conflict.local.id, "remote")}
      >
        Use disk version
      </button>
      <button
        type="button"
        onClick={() => storage.resolve(conflict.local.id, "local")}
      >
        Keep my version
      </button>
    </div>
  );
}

function CanvasTableEditor({
  table,
  tables,
}: {
  table: CanvasTable;
  tables: CanvasTables;
}) {
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [resizedColumn, setResizedColumn] = useState<{
    id: string;
    width: number;
  }>();
  const upload = useRef<HTMLInputElement>(null);
  const drag = useRef<
    { id: string; x: number; width: number; current: number } | undefined
  >(undefined);
  const session = tables.storage.sessions.get(table.id);
  const columnWidth = (column: CanvasTableColumn) =>
    resizedColumn?.id === column.id
      ? resizedColumn.width
      : (column.width ?? 180);
  const update = (next: CanvasTable) => tables.storage.update(next);
  const run = (action: () => void) => {
    try {
      action();
      setError(undefined);
      setNotice(undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  const paste = (
    event: ClipboardEvent<HTMLTextAreaElement>,
    r: number,
    c: number,
  ) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !/[\r\n]/.test(text)) return undefined;
    event.preventDefault();
    event.stopPropagation();
    if (!run(() => update(pasteCanvasCells(table, text, r, c))))
      return undefined;
    const latest = tables.storage.sessions.get(table.id)?.local;
    return String(
      (latest?.rows[r]
        ? canvasCell(latest.rows[r]!, latest.columns[c]!.id)
        : undefined) ?? "",
    );
  };
  const setType = (id: string, type: CanvasColumnType) =>
    run(() =>
      update({
        ...table,
        columns: table.columns.map((column) =>
          column.id === id ? { ...column, type } : column,
        ),
        rows: table.rows.map((row) => ({
          ...row,
          cells: {
            ...row.cells,
            [id]: parseCanvasCell(String(canvasCell(row, id) ?? ""), type),
          },
        })),
      }),
    );
  return (
    <section
      className="canvas-table-editor nodrag nowheel nokey"
      aria-label="Table editor"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "z" &&
          !(
            event.target instanceof HTMLTextAreaElement ||
            event.target instanceof HTMLInputElement
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          tables.storage.history(table.id, event.shiftKey ? "redo" : "undo");
        }
      }}
    >
      <div className="canvas-table-toolbar">
        <button
          type="button"
          aria-label="Add row"
          disabled={table.rows.length >= MAX_TABLE_ROWS}
          onClick={() =>
            run(() =>
              update({
                ...table,
                rows: [...table.rows, { id: crypto.randomUUID(), cells: {} }],
              }),
            )
          }
        >
          <Plus size={13} />
          Row
        </button>
        <button
          type="button"
          aria-label="Add column"
          disabled={table.columns.length >= MAX_TABLE_COLUMNS}
          onClick={() =>
            run(() =>
              update({
                ...table,
                columns: [
                  ...table.columns,
                  {
                    id: crypto.randomUUID(),
                    title: `Column ${table.columns.length + 1}`,
                    type: "text",
                  },
                ],
              }),
            )
          }
        >
          <Plus size={13} />
          Column
        </button>
        <button
          type="button"
          title="Undo table edit"
          aria-label="Undo table edit"
          disabled={!session?.undo.length}
          onClick={() => tables.storage.history(table.id, "undo")}
        >
          <Undo2 size={13} />
        </button>
        <button
          type="button"
          title="Redo table edit"
          aria-label="Redo table edit"
          disabled={!session?.redo.length}
          onClick={() => tables.storage.history(table.id, "redo")}
        >
          <Redo2 size={13} />
        </button>
        <button
          type="button"
          title="Copy table as TSV"
          aria-label="Copy table as TSV"
          onClick={() => {
            void navigator.clipboard
              .writeText(serializeDelimitedTable(table, "\t"))
              .then(() => {
                setNotice("Table copied.");
                setError(undefined);
              })
              .catch(() => setError("Could not copy the table."));
          }}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          title="Export CSV"
          aria-label="Export CSV"
          onClick={() => {
            const url = URL.createObjectURL(
                new Blob(["\uFEFF", serializeDelimitedTable(table, ",")], {
                  type: "text/csv;charset=utf-8",
                }),
              ),
              link = document.createElement("a");
            link.href = url;
            link.download = `${table.title || "table"}.csv`;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download size={13} />
        </button>
        <button
          type="button"
          title="Import CSV (replace table)"
          aria-label="Import CSV"
          onClick={() => upload.current?.click()}
        >
          <Upload size={13} />
        </button>
        <input
          ref={upload}
          hidden
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            if (file.size > 4 * 1024 * 1024) {
              setError("The table is too large.");
              return;
            }
            void file
              .text()
              .then((text) =>
                run(() => {
                  // Use the current resource, as reading a file may finish after another edit.
                  const latest =
                    tables.storage.sessions.get(table.id)?.local ?? table;
                  update(importCanvasCsv(latest, text));
                }),
              )
              .catch((cause) => setError(String(cause)));
          }}
        />
      </div>
      {error || notice ? (
        <p className="canvas-table-notice" role={error ? "alert" : "status"}>
          {error ?? notice}
        </p>
      ) : null}
      <div className="canvas-table-scroll">
        <table
          style={{
            width:
              38 +
              table.columns.reduce(
                (sum, column) => sum + columnWidth(column),
                0,
              ),
          }}
        >
          <colgroup>
            <col style={{ width: 38 }} />
            {table.columns.map((column) => (
              <col key={column.id} style={{ width: columnWidth(column) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th aria-label="Rows" />
              {table.columns.map((column, c) => (
                <th key={column.id}>
                  <CanvasTextInput
                    aria-label={`Column ${c + 1} title`}
                    value={column.title}
                    maxLength={200}
                    onChange={(title) =>
                      update({
                        ...table,
                        columns: table.columns.map((item) =>
                          item.id === column.id ? { ...item, title } : item,
                        ),
                      })
                    }
                  />
                  <div className="canvas-table-column-tools">
                    <select
                      aria-label={`Column ${c + 1} type`}
                      value={column.type}
                      onChange={(event) =>
                        setType(
                          column.id,
                          event.target.value as CanvasColumnType,
                        )
                      }
                    >
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="boolean">Boolean</option>
                    </select>
                    <button
                      type="button"
                      aria-label={`Delete column ${c + 1}`}
                      title="Delete column"
                      disabled={table.columns.length === 1}
                      onClick={() =>
                        run(() =>
                          update({
                            ...table,
                            columns: table.columns.filter(
                              (item) => item.id !== column.id,
                            ),
                            rows: table.rows.map((row) => ({
                              ...row,
                              cells: Object.fromEntries(
                                Object.entries(row.cells).filter(
                                  ([id]) => id !== column.id,
                                ),
                              ),
                            })),
                          }),
                        )
                      }
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <span
                    role="separator"
                    aria-label={`Resize column ${c + 1}`}
                    aria-orientation="vertical"
                    className="canvas-table-column-resize"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      const width = column.width ?? 180;
                      drag.current = {
                        id: column.id,
                        x: event.clientX,
                        width,
                        current: width,
                      };
                    }}
                    onPointerMove={(event) => {
                      if (drag.current?.id !== column.id) return;
                      const current = Math.min(
                        1200,
                        Math.max(
                          80,
                          Math.round(
                            drag.current.width + event.clientX - drag.current.x,
                          ),
                        ),
                      );
                      drag.current.current = current;
                      setResizedColumn({ id: column.id, width: current });
                    }}
                    onPointerUp={() => {
                      const current = drag.current;
                      if (!current) return;
                      drag.current = undefined;
                      setResizedColumn(undefined);
                      const latest =
                        tables.storage.sessions.get(table.id)?.local ?? table;
                      update({
                        ...latest,
                        columns: latest.columns.map((item) =>
                          item.id === current.id
                            ? { ...item, width: current.current }
                            : item,
                        ),
                      });
                    }}
                    onPointerCancel={() => {
                      drag.current = undefined;
                      setResizedColumn(undefined);
                    }}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={row.id}>
                <th>
                  <span>{r + 1}</span>
                  <button
                    type="button"
                    aria-label={`Delete row ${r + 1}`}
                    title="Delete row"
                    onClick={() =>
                      run(() =>
                        update({
                          ...table,
                          rows: table.rows.filter((item) => item.id !== row.id),
                        }),
                      )
                    }
                  >
                    <Trash2 size={11} />
                  </button>
                </th>
                {table.columns.map((column, c) => (
                  <td key={column.id}>
                    <TableCell
                      value={String(canvasCell(row, column.id) ?? "")}
                      label={`Row ${r + 1}, ${column.title || `column ${c + 1}`}`}
                      type={column.type}
                      onPaste={(event) => paste(event, r, c)}
                      onCommit={(value, history) => {
                        const latest =
                          tables.storage.sessions.get(table.id)?.local ?? table;
                        return tables.storage.update(
                          {
                            ...latest,
                            rows: latest.rows.map((item) =>
                              item.id === row.id
                                ? {
                                    ...item,
                                    cells: {
                                      ...item.cells,
                                      [column.id]: value,
                                    },
                                  }
                                : item,
                            ),
                          },
                          history,
                        );
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="canvas-table-hint">
        Paste cells from a spreadsheet. CSV import replaces the table; Undo
        restores it.
      </p>
    </section>
  );
}

function TableCell({
  value,
  label,
  type,
  onCommit,
  onPaste,
}: {
  value: string;
  label: string;
  type: CanvasColumnType;
  onCommit(value: CanvasCell, history: boolean): boolean;
  onPaste(event: ClipboardEvent<HTMLTextAreaElement>): string | undefined;
}) {
  const [draft, setDraft] = useState(value),
    [error, setError] = useState<string>();
  const focused = useRef(false);
  const recordHistory = useRef(true),
    composing = useRef(false);
  const pending = useRef(false),
    published = useRef(value);
  const commit = (text: string) => {
    const cell = parseCanvasCell(text, type);
    if (onCommit(cell, recordHistory.current)) recordHistory.current = false;
    published.current = String(cell ?? "");
    pending.current = false;
  };
  useEffect(() => {
    if (
      !focused.current ||
      (!pending.current && !composing.current && value !== published.current)
    ) {
      published.current = value;
      setDraft(value);
      setError(undefined);
      recordHistory.current = true;
    }
  }, [value]);
  return (
    <>
      <textarea
        aria-label={label}
        aria-invalid={Boolean(error)}
        title={error}
        rows={1}
        maxLength={10000}
        inputMode={type === "number" ? "decimal" : undefined}
        value={draft}
        onFocus={() => {
          focused.current = true;
          recordHistory.current = true;
        }}
        onChange={(event) => {
          const text = event.currentTarget.value;
          setDraft(text);
          pending.current = true;
          if (
            !composing.current &&
            !(event.nativeEvent as InputEvent).isComposing
          ) {
            try {
              commit(text);
              setError(undefined);
            } catch {
              /* Validate unfinished typed values on blur. */
            }
          }
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          const text = event.currentTarget.value;
          setDraft(text);
          pending.current = true;
          try {
            commit(text);
            setError(undefined);
          } catch {
            /* Validate unfinished typed values on blur. */
          }
        }}
        onPaste={(event) => {
          const pasted = onPaste(event);
          if (pasted !== undefined) {
            setDraft(pasted);
            published.current = pasted;
            pending.current = false;
            recordHistory.current = true;
          }
        }}
        onBlur={() => {
          focused.current = false;
          composing.current = false;
          try {
            if (pending.current) commit(draft);
            setDraft(published.current);
            setError(undefined);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      />
      {error ? <small role="alert">{error}</small> : null}
    </>
  );
}
