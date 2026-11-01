// Layout: a page, its sections, stacks and an empty state.
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
 * `<omg-page heading description>`: the page's column, centred and at most
 * 720px wide. Slots: `brand` (a logo before the heading), `actions`, and the
 * page's sections.
 */
class OmgPage extends OmgElement {
  static observedAttributes = ["heading", "description"];
  static styles = [
    HEADING,
    css(`
      :host { display: block; max-width: 720px; margin: 0 auto; }
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
 */
class OmgSection extends OmgElement {
  static observedAttributes = ["heading", "description"];
  static styles = [
    HEADING,
    css(`
      :host { display: block; }
      section { display: flex; flex-direction: column; gap: var(--space-3); }
      .heading { font-size: var(--text-md); }
      .body { display: flex; flex-direction: column; gap: var(--space-2); }
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
 */
class OmgStack extends OmgElement {
  static styles = [
    css(`
      :host { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
      :host([direction="row"]) { flex-direction: row; align-items: center; }
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

define("omg-page", OmgPage);
define("omg-section", OmgSection);
define("omg-stack", OmgStack);
define("omg-empty", OmgEmpty);
