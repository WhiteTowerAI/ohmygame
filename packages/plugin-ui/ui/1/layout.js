// Layout: a page, its sections, and how their contents are arranged.
import { OmgElement, css, define, filled, text } from "./base.js";

const HEADING = css(`
  .header { display: flex; align-items: flex-start; gap: var(--space-3); }
  .titles { flex: 1; min-width: 0; display: grid; gap: var(--space-1); }
  .heading { margin: 0; font-weight: var(--weight-semibold); line-height: 1.3; overflow-wrap: anywhere; }
  .description { margin: 0; color: var(--color-text-secondary); }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
`);

/** Hides a header that has no titles and nothing in its slots. */
function updateHeader(element) {
  const heading = element.getAttribute("heading");
  const description = element.getAttribute("description");
  text(element.part("heading"), heading);
  text(element.part("description"), description);
  const slots = [...element.shadowRoot.querySelectorAll(".header slot")];
  element.part("header").hidden = !heading && !description && !slots.some(filled);
}

/**
 * `<omg-page heading description wide>`: the page's column, centred and at
 * most 720px wide, or the panel's whole width when `wide`. Slots: `brand` (a
 * logo before the heading), `actions`, and the page's sections.
 *
 * @attr {string} heading - The page's title.
 * @attr {string} description - A line under the title.
 * @attr {boolean} wide - Fills the panel's width, for a page with a sidebar or a grid.
 * @slot brand - A logo before the heading.
 * @slot actions - Buttons beside the heading.
 * @slot - The page's sections.
 * @part header - The row of the brand, titles and actions; hidden when empty.
 * @part heading - The title.
 * @part description - The line under the title.
 * @part body - The column of sections.
 */
class OmgPage extends OmgElement {
  static observedAttributes = ["heading", "description"];
  static styles = [
    HEADING,
    css(`
      :host { display: block; max-width: 720px; margin: 0 auto; }
      :host([wide]) { max-width: none; }
      .header { margin-bottom: var(--space-6); }
      .heading { font-size: var(--text-lg); }
      .body { display: flex; flex-direction: column; gap: var(--space-6); }
    `),
  ];
  static template = `
    <header class="header" part="header">
      <slot name="brand"></slot>
      <div class="titles"><h1 class="heading" part="heading"></h1><p class="description" part="description"></p></div>
      <div class="actions"><slot name="actions"></slot></div>
    </header>
    <div class="body" part="body"><slot></slot></div>`;

  constructor() {
    super();
    this.shadowRoot.addEventListener("slotchange", () => this.update());
  }

  update() {
    updateHeader(this);
  }
}

/**
 * `<omg-section heading description>`: a titled group of content. Slots:
 * `actions` beside the heading, and the section's content.
 *
 * @attr {string} heading - The section's title, which names it.
 * @attr {string} description - A line under the title.
 * @slot actions - Buttons beside the heading.
 * @slot - The section's content.
 * @part section - The section.
 * @part header - The titles and actions; hidden when empty.
 * @part heading - The title.
 * @part description - The line under the title.
 * @part body - The column of content.
 */
class OmgSection extends OmgElement {
  static observedAttributes = ["heading", "description"];
  static styles = [
    HEADING,
    css(`
      :host { display: block; }
      section { display: flex; flex-direction: column; gap: var(--space-3); }
      .heading { font-size: var(--text-md); }
      .body { display: flex; flex-direction: column; gap: var(--space-4); }
    `),
  ];
  static template = `
    <section part="section">
      <header class="header" part="header">
        <div class="titles"><h2 class="heading" part="heading"></h2><p class="description" part="description"></p></div>
        <div class="actions"><slot name="actions"></slot></div>
      </header>
      <div class="body" part="body"><slot></slot></div>
    </section>`;

  constructor() {
    super();
    this.shadowRoot.addEventListener("slotchange", () => this.update());
  }

  update() {
    updateHeader(this);
    const heading = this.part("heading");
    const section = this.part("section");
    if (heading.hidden) section.removeAttribute("aria-labelledby");
    else {
      heading.id = "heading";
      section.setAttribute("aria-labelledby", "heading");
    }
  }
}

const SPACES = ["1", "2", "3", "4", "6"];

/**
 * `<omg-stack direction="row|column" gap="1|2|3|4|6" align justify wrap>`:
 * lays its children out in a row or a column, spaced by the app's steps.
 *
 * @attr {"column" | "row"} direction - Column by default.
 * @attr {"0" | "1" | "2" | "3" | "4" | "6"} gap - A space token; 4 for columns, 2 for rows by default.
 * @attr {"start" | "center" | "end" | "stretch" | "baseline"} align - How children line up across it.
 * @attr {"start" | "center" | "end" | "between"} justify - How children are spread along it.
 * @attr {boolean} wrap - Lets a row wrap.
 * @slot - The children.
 */
class OmgStack extends OmgElement {
  static styles = [
    css(`
      :host { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
      :host([direction="row"]) { flex-direction: row; align-items: center; gap: var(--space-2); }
      :host([wrap]) { flex-wrap: wrap; }
      ${SPACES.map((step) => `:host([gap="${step}"]) { gap: var(--space-${step}); }`).join("\n")}
      :host([gap="0"]) { gap: 0; }
      ${["start", "center", "end", "stretch", "baseline"].map((value) => `:host([align="${value}"]) { align-items: ${value === "start" || value === "end" ? `flex-${value}` : value}; }`).join("\n")}
      ${["start", "center", "end"].map((value) => `:host([justify="${value}"]) { justify-content: ${value === "center" ? value : `flex-${value}`}; }`).join("\n")}
      :host([justify="between"]) { justify-content: space-between; }
    `),
  ];
  static template = `<slot></slot>`;
}

/**
 * `<omg-empty heading description>`: what a page shows when it has nothing
 * yet. Slots: `icon`, and actions as its content.
 *
 * @attr {string} heading - What is missing.
 * @attr {string} description - What to do about it.
 * @slot icon - An icon above the heading.
 * @slot - Actions.
 * @part icon - The icon's place; hidden when empty.
 * @part heading - The heading.
 * @part description - The description.
 * @part actions - The actions' row; hidden when empty.
 */
class OmgEmpty extends OmgElement {
  static observedAttributes = ["heading", "description"];
  static styles = [
    css(`
      :host { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-6) var(--space-4); text-align: center; color: var(--color-text-secondary); }
      .icon { color: var(--color-text-tertiary); }
      .heading { margin: 0; font-size: var(--text-md); font-weight: var(--weight-medium); color: var(--color-text); }
      .description { margin: 0; max-width: 48ch; }
      .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-2); margin-top: var(--space-2); }
    `),
  ];
  static template = `
    <div class="icon" part="icon"><slot name="icon"></slot></div>
    <p class="heading" part="heading"></p>
    <p class="description" part="description"></p>
    <div class="actions" part="actions"><slot></slot></div>`;

  constructor() {
    super();
    this.shadowRoot.addEventListener("slotchange", () => this.update());
  }

  update() {
    text(this.part("heading"), this.getAttribute("heading"));
    text(this.part("description"), this.getAttribute("description"));
    const [icon, actions] = this.shadowRoot.querySelectorAll("slot");
    this.part("icon").hidden = !filled(icon);
    this.part("actions").hidden = !filled(actions);
  }
}

/** The number in an attribute, when it is a positive one. */
function positive(element, name) {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * `<omg-grid min columns gap>`: lays its children out in equal columns, as many
 * as fit at `min` pixels wide each, or exactly `columns`.
 *
 * @attr {number} min - The narrowest a column gets, in pixels; 240 by default.
 * @attr {number} columns - A fixed number of columns, in place of as many as fit.
 * @attr {"0" | "1" | "2" | "3" | "4" | "6"} gap - A space token; 3 by default.
 * @slot - The children.
 * @part grid - The grid.
 */
class OmgGrid extends OmgElement {
  static observedAttributes = ["min", "columns"];
  static styles = [
    css(`
      :host { display: block; min-width: 0; }
      .grid { display: grid; gap: var(--space-4); grid-template-columns: var(--_columns); }
      :host([gap="0"]) .grid { gap: 0; }
      ${SPACES.map((step) => `:host([gap="${step}"]) .grid { gap: var(--space-${step}); }`).join("\n")}
    `),
  ];
  static template = `<div class="grid" part="grid"><slot></slot></div>`;

  update() {
    const columns = positive(this, "columns");
    this.part("grid").style.setProperty(
      "--_columns",
      columns ? `repeat(${Math.floor(columns) || 1}, minmax(0, 1fr))` : `repeat(auto-fill, minmax(min(${positive(this, "min") ?? 240}px, 100%), 1fr))`,
    );
  }
}

/**
 * `<omg-split side side-width>`: a sidebar beside the main content, which go
 * one above the other when there isn't room for both.
 *
 * @attr {"start" | "end"} side - Which side the sidebar is on; the start by default.
 * @attr {number} side-width - The sidebar's width in pixels; 240 by default.
 * @slot sidebar - The sidebar.
 * @slot - The main content.
 * @part split - The two places together.
 * @part sidebar - The sidebar's place.
 * @part main - The main content's place.
 */
class OmgSplit extends OmgElement {
  static observedAttributes = ["side-width"];
  static styles = [
    css(`
      :host { display: block; min-width: 0; }
      /* They wrap once the content would have less than half the width, whatever the sidebar's. */
      .split { display: flex; flex-wrap: wrap; gap: var(--space-4); }
      .sidebar { flex: 1 1 var(--_side); min-width: 0; max-width: 100%; }
      .main { flex: 999 1 0; min-width: 50%; }
      :host([side="end"]) .sidebar { order: 1; }
    `),
  ];
  static template = `
    <div class="split" part="split">
      <div class="sidebar" part="sidebar"><slot name="sidebar"></slot></div>
      <div class="main" part="main"><slot></slot></div>
    </div>`;

  update() {
    this.part("split").style.setProperty("--_side", `${positive(this, "side-width") ?? 240}px`);
  }
}

// A slot hears when nodes come and go, but not when a text node's words change.
class OmgTextWatcher extends OmgElement {
  #observer = new MutationObserver(() => this.update());

  connectedCallback() {
    this.#observer.observe(this, { characterData: true, subtree: true });
    super.connectedCallback();
  }

  disconnectedCallback() {
    this.#observer.disconnect();
  }
}

/**
 * `<omg-card heading description>`: a raised surface that groups its content.
 *
 * @attr {string} heading - The card's title.
 * @attr {string} description - A line under the title.
 * @slot actions - Buttons beside the heading.
 * @slot - The content.
 * @part header - The row of the titles and actions; hidden when empty.
 * @part heading - The title.
 * @part description - The line under the title.
 * @part body - The content.
 */
class OmgCard extends OmgTextWatcher {
  static observedAttributes = ["heading", "description"];
  static styles = [
    HEADING,
    css(`
      :host { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; padding: var(--space-4); border-radius: var(--radius-lg); background: var(--color-surface-raised); }
      .heading { font-size: var(--text-md); }
      .body { display: flex; flex-direction: column; gap: var(--space-4); }
    `),
  ];
  static template = `
    <header class="header" part="header">
      <div class="titles"><h3 class="heading" part="heading"></h3><p class="description" part="description"></p></div>
      <div class="actions"><slot name="actions"></slot></div>
    </header>
    <div class="body" part="body"><slot></slot></div>`;

  constructor() {
    super();
    this.shadowRoot.addEventListener("slotchange", () => this.update());
  }

  update() {
    updateHeader(this);
    this.part("body").hidden = !filled(this.shadowRoot.querySelector("slot:not([name])"));
  }
}

/**
 * `<omg-list>`: rows of `omg-list-item`, with a hairline between them.
 *
 * @slot - The `omg-list-item` children.
 */
class OmgList extends OmgElement {
  static styles = [css(`:host { display: flex; flex-direction: column; min-width: 0; }`)];
  static template = `<slot></slot>`;

  update() {
    this.setAttribute("role", "list");
  }
}

/**
 * `<omg-list-item heading description>`: a row: an icon, a title and a line
 * under it, then a value and buttons at its end.
 *
 * @attr {string} heading - The row's title.
 * @attr {string} description - A line under the title.
 * @slot leading - An icon or picture before the title; an `omg-image` is drawn as a 40px thumbnail.
 * @slot - The row's value, at its end.
 * @slot actions - Buttons at its end, after the value.
 * @part leading - The leading place; hidden when empty.
 * @part heading - The title.
 * @part description - The line under the title.
 * @part value - The value's place; hidden when empty.
 * @part actions - The buttons' place; hidden when empty.
 */
class OmgListItem extends OmgTextWatcher {
  static observedAttributes = ["heading", "description"];
  static styles = [
    css(`
      :host { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2) var(--space-3); min-width: 0; padding: var(--space-3) 0; }
      :host(:not(:last-child)) { box-shadow: inset 0 -1px 0 var(--color-border); }
      .leading { flex: none; display: flex; }
      /* An omg-image before the title is a thumbnail, whatever its picture's size; what doesn't fit is cut off. */
      ::slotted(omg-image[slot="leading"]) {
        width: 40px; height: 40px; flex: none; overflow: hidden; border-radius: var(--radius-md); --omg-image-radius: var(--radius-md);
      }
      .titles { flex: 1 1 160px; min-width: 0; display: grid; gap: 2px; overflow-wrap: anywhere; }
      .heading { margin: 0; font-weight: var(--weight-medium); }
      .description { margin: 0; color: var(--color-text-secondary); font-size: var(--text-sm); }
      .value { min-width: 0; color: var(--color-text-secondary); overflow-wrap: anywhere; }
      .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
    `),
  ];
  static template = `
    <div class="leading" part="leading"><slot name="leading"></slot></div>
    <div class="titles"><p class="heading" part="heading"></p><p class="description" part="description"></p></div>
    <div class="value" part="value"><slot></slot></div>
    <div class="actions" part="actions"><slot name="actions"></slot></div>`;

  constructor() {
    super();
    this.shadowRoot.addEventListener("slotchange", () => this.update());
  }

  update() {
    this.setAttribute("role", "listitem");
    text(this.part("heading"), this.getAttribute("heading"));
    text(this.part("description"), this.getAttribute("description"));
    this.part("leading").hidden = !filled(this.shadowRoot.querySelector('slot[name="leading"]'));
    this.part("value").hidden = !filled(this.shadowRoot.querySelector("slot:not([name])"));
    this.part("actions").hidden = !filled(this.shadowRoot.querySelector('slot[name="actions"]'));
  }
}

/**
 * `<omg-divider label>`: a hairline between groups, with an optional label on it.
 *
 * @attr {string} label - Text on the line.
 * @part label - The label; hidden when empty.
 */
class OmgDivider extends OmgElement {
  static observedAttributes = ["label"];
  static styles = [
    css(`
      :host { display: flex; align-items: center; gap: var(--space-3); color: var(--color-text-tertiary); font-size: var(--text-sm); }
      :host::before, :host::after { content: ""; flex: 1; height: 1px; background: var(--color-border); }
      .label:not([hidden]) { white-space: nowrap; }
      :host(:not([label]))::after { display: none; }
    `),
  ];
  static template = `<span class="label" part="label"></span>`;

  update() {
    this.setAttribute("role", "separator");
    text(this.part("label"), this.getAttribute("label"));
  }
}

/**
 * `<omg-path path>`: a read-only path with a subdued directory and a prominent
 * filename. Narrow rows truncate the start, keeping the filename in view.
 * The full path remains selectable and available through the native title.
 *
 * @attr {string} path - File or directory path, displayed as text; never opened or resolved.
 * @part path - The full path, clipped at the start when needed.
 * @part directory - The directory prefix.
 * @part name - The filename or last directory name.
 */
class OmgPath extends OmgElement {
  static observedAttributes = ["path"];
  static styles = [css(`
    :host { display: block; min-width: 0; max-width: 100%; }
    .path { display: block; direction: rtl; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .parts { direction: ltr; unicode-bidi: isolate; }
    .directory { color: var(--color-text-tertiary); }
  `)];
  static template = `<span class="path" part="path"><span class="parts"><span class="directory" part="directory"></span><span part="name"></span></span></span>`;
  update() {
    const path = this.getAttribute("path") || "";
    const end = path.replace(/[\\/]+$/, "").length;
    const split = Math.max(path.lastIndexOf("/", end - 1), path.lastIndexOf("\\", end - 1)) + 1;
    this.part("path").title = path;
    text(this.part("directory"), path.slice(0, split));
    text(this.part("name"), path.slice(split));
  }
}

define("omg-page", OmgPage);
define("omg-section", OmgSection);
define("omg-stack", OmgStack);
define("omg-empty", OmgEmpty);
define("omg-grid", OmgGrid);
define("omg-split", OmgSplit);
define("omg-card", OmgCard);
define("omg-list", OmgList);
define("omg-list-item", OmgListItem);
define("omg-divider", OmgDivider);
define("omg-path", OmgPath);
