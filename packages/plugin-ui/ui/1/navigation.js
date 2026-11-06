// Navigation: moving between a panel's views.
import { OmgElement, css, define } from "./base.js";

/**
 * `<omg-tabs value aria-label>`: shows one of its `omg-tab` children, with a
 * row of their headings above. Arrow keys, Home and End move between tabs.
 * A page listens for `omg-tab-change`, since `change` would also come up from
 * the controls inside a tab.
 *
 * @attr {string} value - The `name` of the open tab; the first that isn't disabled without one.
 * @attr {string} aria-label - What the tabs choose between, for screen readers.
 * @prop {string} value - The open tab's name.
 * @fires {{ value: string }} omg-tab-change - The person opened a tab.
 * @slot - The `omg-tab` children.
 * @part list - The row of headings.
 * @part tab - A heading's button.
 */
class OmgTabs extends OmgElement {
  static observedAttributes = ["value", "aria-label"];
  static styles = [
    css(`
      :host { display: block; min-width: 0; }
      .list { display: flex; flex-wrap: wrap; gap: 4px; }
      button {
        height: 30px; padding: 0 var(--space-3); border: 0; border-radius: var(--radius-pill);
        background: transparent; color: var(--color-text-secondary); font: inherit; font-size: var(--text-sm); white-space: nowrap; cursor: pointer;
        transition: background var(--duration-fast), color var(--duration-fast);
      }
      button:not(:disabled):hover { background: color-mix(in srgb, var(--color-hover) 60%, transparent); color: var(--color-text); }
      button:disabled { opacity: 0.4; cursor: default; }
      button[aria-selected="true"], button[aria-selected="true"]:not(:disabled):hover { background: var(--color-hover); color: var(--color-text); font-weight: var(--weight-medium); }
      .panels { padding-top: var(--space-4); }
    `),
  ];
  static template = `<div class="list" part="list" role="tablist"></div><div class="panels"><slot></slot></div>`;

  // Tabs added or removed, or a heading changed; not what this component sets on them.
  #observer = new MutationObserver((records) => {
    if (records.some((record) => (record.type === "childList" ? record.target === this : record.target.parentElement === this))) this.update();
  });

  constructor() {
    super();
    const list = this.part("list");
    list.addEventListener("click", (event) => {
      const button = /** @type {Element} */ (event.target).closest("button");
      if (button) this.#open(button);
    });
    list.addEventListener("keydown", (event) => {
      const enabled = [...list.querySelectorAll("button:not(:disabled)")];
      const at = enabled.indexOf(/** @type {Element} */ (event.target));
      if (at < 0) return;
      const next = { ArrowRight: enabled[(at + 1) % enabled.length], ArrowLeft: enabled.at(at - 1), Home: enabled[0], End: enabled.at(-1) }[event.key];
      if (!next) return;
      event.preventDefault();
      const name = /** @type {HTMLElement} */ (next).dataset.name;
      this.#open(/** @type {HTMLElement} */ (next));
      // Opening draws the row again.
      this.#button(name)?.focus();
    });
  }

  get value() {
    return this.#current()?.getAttribute("name") ?? "";
  }

  set value(value) {
    this.setAttribute("value", String(value ?? ""));
  }

  connectedCallback() {
    this.#observer.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ["name", "heading", "disabled"] });
    super.connectedCallback();
  }

  disconnectedCallback() {
    this.#observer.disconnect();
  }

  get #tabs() {
    return [...this.children].filter((child) => child.localName === "omg-tab");
  }

  /** The tab `value` names, or the first that can open. */
  #current() {
    const tabs = this.#tabs;
    const value = this.getAttribute("value");
    return tabs.find((tab) => tab.getAttribute("name") === value && !tab.hasAttribute("disabled")) ?? tabs.find((tab) => !tab.hasAttribute("disabled"));
  }

  #button(name) {
    return [...this.part("list").children].find((button) => /** @type {HTMLElement} */ (button).dataset.name === name);
  }

  #open(button) {
    if (button.getAttribute("aria-selected") === "true") return;
    const value = button.dataset.name;
    this.setAttribute("value", value);
    this.dispatchEvent(new CustomEvent("omg-tab-change", { bubbles: true, detail: { value } }));
  }

  update() {
    const list = this.part("list");
    const label = this.getAttribute("aria-label");
    if (label) list.setAttribute("aria-label", label);
    else list.removeAttribute("aria-label");
    const current = this.#current();
    const focused = /** @type {HTMLElement | null} */ (this.shadowRoot.activeElement)?.dataset.name;
    list.replaceChildren(
      ...this.#tabs.map((tab) => {
        const button = document.createElement("button");
        const name = tab.getAttribute("name") ?? "";
        button.type = "button";
        button.dataset.name = name;
        button.setAttribute("part", "tab");
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(tab === current));
        button.tabIndex = tab === current ? 0 : -1;
        button.disabled = tab.hasAttribute("disabled");
        button.textContent = tab.getAttribute("heading") ?? "";
        return button;
      }),
    );
    // A focused tab may have gone or been disabled; focus stays in the row.
    if (focused !== undefined) {
      const button = /** @type {HTMLButtonElement | undefined} */ (this.#button(focused));
      (button && !button.disabled ? button : list.querySelector('[aria-selected="true"]'))?.focus();
    }
    for (const tab of this.#tabs) tab.hidden = tab !== current;
  }
}

/**
 * `<omg-tab name heading disabled>`: one view of an `omg-tabs`.
 *
 * @attr {string} name - What `value` on the `omg-tabs` calls it; unique among its tabs.
 * @attr {string} heading - The text of its heading, and its name for screen readers.
 * @attr {boolean} disabled - It can't be opened.
 * @slot - The view.
 */
class OmgTab extends OmgElement {
  static observedAttributes = ["heading"];
  static styles = [
    css(`
      :host { display: flex; flex-direction: column; gap: var(--space-6); min-width: 0; }
      :host(:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: 2px; }
    `),
  ];
  static template = `<slot></slot>`;

  update() {
    this.setAttribute("role", "tabpanel");
    this.tabIndex = 0;
    const heading = this.getAttribute("heading");
    if (heading) this.setAttribute("aria-label", heading);
    else this.removeAttribute("aria-label");
  }
}

define("omg-tabs", OmgTabs);
define("omg-tab", OmgTab);
