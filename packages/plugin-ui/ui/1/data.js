import {
  OmgElement,
  css,
  define,
  text,
  activeElement,
  containsFocus,
} from "./base.js";

/**
 * `<omg-table label>`: a semantic table with stable keyed rows and cells.
 * Text is always inserted as text; a Node cell is slotted without cloning so
 * its state, listeners and plugin styles survive updates. Callers own sorting,
 * loading and actions. Wide tables scroll inside their labelled region.
 *
 * @attr {string} label - Table and scroll-region accessible name.
 * @attr {boolean} loading - Marks data busy; existing rows remain visible.
 * @attr {string} empty-label - Message with no rows; defaults to No data.
 * @prop {Array<{ key: string; heading: string; align?: "left" | "right"; width?: string }>} columns - Unique column keys, headings, optional width and alignment.
 * @prop {Array<{ key: string; cells: Record<string, string | Node> }>} rows - Unique row keys and cells by column key; Node cells belong to this table while mounted.
 * @part region - Focusable horizontal scroll region.
 * @part table - Native table.
 * @part empty - Empty message.
 */
class OmgTable extends OmgElement {
  static observedAttributes = ["label", "loading", "empty-label"];
  static styles = [
    css(`
    :host { display: block; min-width: 0; }
    .region { overflow: auto; }
    table { width: 100%; border-collapse: collapse; font: inherit; }
    th { height: 34px; color: var(--color-text-tertiary); font-size: var(--text-sm); font-weight: var(--weight-medium); text-align: start; }
    th, td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-border); }
    td { height: 48px; overflow-wrap: anywhere; }
    .empty { padding: var(--space-3); color: var(--color-text-secondary); }
  `),
  ];
  static template = `<div class="region" part="region" role="region" tabindex="0"><table part="table"><thead><tr></tr></thead><tbody></tbody></table><div class="empty" part="empty" role="status"></div></div>`;
  #columns = [];
  #rows = [];
  #mounted = new Map();
  #nextSlot = 0;

  get columns() {
    return this.#columns;
  }
  set columns(value) {
    this.#columns = value;
    this.#draw();
  }
  get rows() {
    return this.#rows;
  }
  set rows(value) {
    this.#rows = value;
    this.#draw();
  }

  #removeCell(cell) {
    cell.node?.remove();
    cell.element.remove();
  }
  #draw() {
    const focused = containsFocus(this)
      ? activeElement(this.ownerDocument)
      : null;
    const head = this.shadowRoot.querySelector("thead tr");
    head.replaceChildren(
      ...this.#columns.map((column) => {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = column.heading;
        th.style.textAlign = column.align || "start";
        th.style.width = column.width || "";
        return th;
      }),
    );
    const keys = new Set(this.#rows.map((row) => row.key));
    for (const [key, row] of this.#mounted) {
      if (keys.has(key)) continue;
      for (const cell of row.cells.values()) this.#removeCell(cell);
      row.element.remove();
      this.#mounted.delete(key);
    }
    const body = this.shadowRoot.querySelector("tbody");
    this.#rows.forEach((row, index) => {
      let mounted = this.#mounted.get(row.key);
      if (!mounted) {
        mounted = { element: document.createElement("tr"), cells: new Map() };
        this.#mounted.set(row.key, mounted);
      }
      for (const [key, cell] of mounted.cells) {
        if (!this.#columns.some((column) => column.key === key)) {
          this.#removeCell(cell);
          mounted.cells.delete(key);
        }
      }
      this.#columns.forEach((column, columnIndex) => {
        let cell = mounted.cells.get(column.key);
        if (!cell) {
          cell = { element: document.createElement("td"), value: undefined };
          mounted.cells.set(column.key, cell);
        }
        cell.element.style.textAlign = column.align || "start";
        const value = row.cells[column.key] ?? "";
        if (cell.value !== value) {
          cell.node?.remove();
          cell.node = undefined;
          cell.value = value;
          if (value instanceof Node) {
            // A wrapper also supports Text nodes and avoids changing the caller's slot attribute.
            const wrapper = document.createElement("span");
            wrapper.slot = `cell-${++this.#nextSlot}`;
            wrapper.append(value);
            this.append(wrapper);
            const slot = document.createElement("slot");
            slot.name = wrapper.slot;
            cell.element.replaceChildren(slot);
            cell.node = wrapper;
          } else cell.element.textContent = String(value);
        }
        if (mounted.element.children[columnIndex] !== cell.element)
          mounted.element.insertBefore(
            cell.element,
            mounted.element.children[columnIndex] || null,
          );
      });
      if (body.children[index] !== mounted.element)
        body.insertBefore(mounted.element, body.children[index] || null);
    });
    this.update();
    if (focused?.isConnected && activeElement(this.ownerDocument) !== focused)
      focused.focus({ preventScroll: true });
  }
  update() {
    const label = this.getAttribute("label") || "";
    this.part("region").setAttribute("aria-label", label);
    this.part("table").setAttribute("aria-label", label);
    this.part("table").setAttribute(
      "aria-busy",
      String(this.hasAttribute("loading")),
    );
    text(
      this.part("empty"),
      this.#rows.length || this.hasAttribute("loading")
        ? ""
        : this.getAttribute("empty-label") || "No data",
    );
  }
}

/**
 * `<omg-pagination page pages>`: controlled pagination. It requests a page;
 * the caller updates `page` after success. Pending requests preserve focus.
 *
 * @attr {number} page - Current page, one-based; defaults to 1.
 * @attr {number} pages - Number of pages; at least 1.
 * @attr {boolean} disabled - Ignores requests while retaining focus.
 * @attr {string} label - Navigation accessible name; defaults to Pagination.
 * @attr {string} previous-label - Previous button text; defaults to Previous.
 * @attr {string} next-label - Next button text; defaults to Next.
 * @fires {{ page: number }} omg-page-change - Requested page; no state changes until the caller updates page.
 * @part previous - Previous button.
 * @part next - Next button.
 * @part status - Current page and total.
 */
class OmgPagination extends OmgElement {
  static observedAttributes = [
    "page",
    "pages",
    "disabled",
    "label",
    "previous-label",
    "next-label",
  ];
  static styles = [
    css(`
    :host { display: block; }
    nav { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-2); }
    button { min-height: 30px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-md); background: transparent; color: var(--color-text); font: inherit; cursor: pointer; }
    button:not([aria-disabled="true"]):hover { background: var(--color-hover); }
    button[aria-disabled="true"] { opacity: .4; cursor: default; }
    .status { color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
  `),
  ];
  static template = `<nav><button type="button" part="previous"></button><span class="status" part="status" role="status" aria-live="polite"></span><button type="button" part="next"></button></nav>`;
  constructor() {
    super();
    for (const [part, delta] of [
      ["previous", -1],
      ["next", 1],
    ])
      this.part(part).addEventListener("click", () => {
        if (this.hasAttribute("disabled")) return;
        const [page, pages] = this.#range();
        const next = page + delta;
        if (next >= 1 && next <= pages)
          this.dispatchEvent(
            new CustomEvent("omg-page-change", {
              bubbles: true,
              composed: true,
              detail: { page: next },
            }),
          );
      });
  }
  #range() {
    const number = (name) => {
      const value = Number(this.getAttribute(name));
      return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
    };
    const pages = number("pages");
    return [Math.min(pages, number("page")), pages];
  }
  update() {
    const [page, pages] = this.#range();
    this.shadowRoot
      .querySelector("nav")
      .setAttribute("aria-label", this.getAttribute("label") || "Pagination");
    text(
      this.part("previous"),
      this.getAttribute("previous-label") || "Previous",
    );
    text(this.part("next"), this.getAttribute("next-label") || "Next");
    text(this.part("status"), `${page} / ${pages}`);
    this.part("previous").setAttribute(
      "aria-disabled",
      String(this.hasAttribute("disabled") || page <= 1),
    );
    this.part("next").setAttribute(
      "aria-disabled",
      String(this.hasAttribute("disabled") || page >= pages),
    );
  }
}

define("omg-table", OmgTable);
define("omg-pagination", OmgPagination);
