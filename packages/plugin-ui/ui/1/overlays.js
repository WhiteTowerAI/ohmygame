import {
  OmgElement,
  css,
  define,
  text,
  activeElement,
  containsFocus,
  filled,
} from "./base.js";
import { Floating, FLOATING } from "./floating.js";

const TRIGGER = css(`
  :host { display: inline-block; min-width: 0; max-width: 100%; }
  .trigger {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
    min-height: 30px; max-width: 100%; padding: 0 var(--space-2); border: 0;
    border-radius: var(--radius-md); background: transparent; color: var(--color-text);
    font: inherit; font-weight: var(--weight-medium); cursor: pointer;
  }
  .trigger:hover, .trigger[aria-expanded="true"] { background: var(--color-hover); }
  .trigger:disabled { opacity: .4; cursor: default; }
  .content { padding: var(--space-2); min-width: min(240px, calc(100vw - 16px)); }
`);

/**
 * `<omg-popover label>`: a non-modal panel opened by its labelled button.
 * Content remains mounted. Esc returns focus; outside clicks and Tab leave it
 * where the person moved. Floating content stays within the plugin viewport.
 *
 * @attr {string} label - Trigger and panel accessible name.
 * @attr {boolean} open - Shows the panel.
 * @attr {boolean} disabled - Disables the trigger and closes the panel.
 * @attr {"bottom-start" | "bottom-end" | "top-start" | "top" | "bottom"} placement - Preferred placement, bottom-start by default.
 * @prop {boolean} open - Showing state; programmatic changes are silent.
 * @fires {{ open: boolean }} omg-toggle - User opened or dismissed the panel.
 * @slot trigger - Optional text or decorative icon inside the trigger; no interactive children.
 * @part label - Default trigger label.
 * @part button - Trigger button.
 * @part panel - Floating panel.
 */
class OmgOverlay extends OmgElement {
  static observedAttributes = ["label", "open", "disabled", "placement"];
  static styles = [FLOATING, TRIGGER];
  static template = `<button class="trigger" part="button" type="button" aria-haspopup="dialog" aria-controls="panel"><slot name="trigger"><span part="label"></span></slot></button><div class="floating content" id="panel" part="panel" role="dialog" popover="manual" tabindex="-1" hidden><slot></slot></div>`;

  constructor() {
    super();
    this.floating = new Floating(
      this,
      this.part("button"),
      this.part("panel"),
      (focus) => this.toggle(false, focus),
      () => this.getAttribute("placement") || "bottom-start",
    );
    this.part("button").addEventListener("click", () => {
      if (!this.hasAttribute("disabled")) this.toggle(!this.open, true);
    });
  }

  get open() {
    return this.hasAttribute("open");
  }
  set open(value) {
    this.toggleAttribute("open", Boolean(value));
  }

  toggle(open, focus = false) {
    if (this.open === open) return;
    this.open = open;
    if (focus) (open ? this.part("panel") : this.part("button")).focus();
    this.dispatchEvent(
      new CustomEvent("omg-toggle", {
        bubbles: true,
        composed: true,
        detail: { open },
      }),
    );
  }

  disconnectedCallback() {
    this.floating.hide();
  }

  update() {
    const button = this.part("button");
    const panel = this.part("panel");
    button.disabled = this.hasAttribute("disabled");
    if (button.disabled && this.open) {
      this.open = false;
      return;
    }
    const label = this.getAttribute("label") || "";
    text(this.part("label"), label);
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", String(this.open));
    panel.setAttribute("aria-label", label);
    if (this.open) this.floating.show();
    else {
      if (
        !panel.hidden &&
        containsFocus(this) &&
        activeElement() !== button &&
        !button.disabled
      )
        button.focus();
      this.floating.hide();
    }
  }
}

/**
 * `<omg-popover label>`: a non-modal panel with a labelled trigger.
 *
 * @slot - Panel content, retained while closed.
 */
class OmgPopover extends OmgOverlay {}

/**
 * `<omg-menu label>`: an action menu. Arrow keys, Home/End and typeahead move
 * through enabled actions. Enter/Space selects, Esc returns to the trigger.
 *
 * @prop {Array<{ value: string; label: string; description?: string; disabled?: boolean; danger?: boolean; checked?: boolean }>} items - Actions; values must be unique. Setting items preserves the focused action by value when possible.
 * @fires {{ value: string }} omg-select - Selected action, after closing the menu.
 */
class OmgMenu extends OmgOverlay {
  static styles = [
    ...OmgOverlay.styles,
    css(`
    .content { min-width: min(200px, calc(100vw - 16px)); padding: var(--space-1); }
    .item { display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: 30px; padding: 5px var(--space-2); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text); font: inherit; text-align: start; cursor: pointer; }
    .item:hover, .item:focus-visible { outline: none; background: var(--color-hover); }
    .item:disabled { color: var(--color-text-tertiary); cursor: default; }
    .item.danger { color: var(--color-danger); }
    .words { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    small { display: block; color: var(--color-text-secondary); font-size: var(--text-sm); }
  `),
  ];
  static template = `<button class="trigger" part="button" type="button" aria-haspopup="menu" aria-controls="panel"><slot name="trigger"><span part="label"></span></slot></button><div class="floating content" id="panel" part="panel" role="menu" popover="manual" tabindex="-1" hidden></div>`;
  #items = [];
  #search = "";
  #typedAt = 0;

  constructor() {
    super();
    this.part("button").addEventListener("keydown", (event) => {
      if (
        ["ArrowDown", "ArrowUp"].includes(event.key) &&
        !this.hasAttribute("disabled")
      ) {
        event.preventDefault();
        this.toggle(true);
        this.#buttons()[
          event.key === "ArrowUp" ? this.#buttons().length - 1 : 0
        ]?.focus();
      }
    });
    this.part("panel").addEventListener("keydown", (event) => {
      const buttons = this.#buttons();
      const index = buttons.indexOf(this.shadowRoot.activeElement);
      let next;
      if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
      if (event.key === "ArrowUp")
        next = (index - 1 + buttons.length) % buttons.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = buttons.length - 1;
      if (
        event.key.length === 1 &&
        event.key !== " " &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        this.#search =
          Date.now() - this.#typedAt > 500
            ? event.key
            : this.#search + event.key;
        this.#typedAt = Date.now();
        next = buttons.findIndex((button) =>
          button.textContent
            .toLowerCase()
            .startsWith(this.#search.toLowerCase()),
        );
      }
      if (next !== undefined) {
        event.preventDefault();
        buttons[next]?.focus();
      }
    });
  }

  get items() {
    return this.#items;
  }
  set items(value) {
    this.#items = value;
    const focused = this.shadowRoot.activeElement?.dataset.value;
    this.part("panel").replaceChildren(
      ...value.map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `item${item.danger ? " danger" : ""}`;
        button.dataset.value = item.value;
        button.disabled = Boolean(item.disabled);
        button.setAttribute(
          "role",
          item.checked === undefined ? "menuitem" : "menuitemcheckbox",
        );
        if (item.checked !== undefined)
          button.setAttribute("aria-checked", String(item.checked));
        const words = document.createElement("span");
        words.className = "words";
        words.textContent = item.label;
        if (item.description) {
          const small = document.createElement("small");
          small.textContent = item.description;
          words.append(small);
        }
        button.append(words);
        if (item.checked) {
          const check = document.createElement("span");
          check.textContent = "✓";
          check.setAttribute("aria-hidden", "true");
          button.append(check);
        }
        button.addEventListener("click", () => {
          if (button.disabled) return;
          this.toggle(false, true);
          this.dispatchEvent(
            new CustomEvent("omg-select", {
              bubbles: true,
              composed: true,
              detail: { value: item.value },
            }),
          );
        });
        return button;
      }),
    );
    if (focused !== undefined && this.open)
      (
        this.#buttons().find((button) => button.dataset.value === focused) ??
        this.#buttons()[0] ??
        this.part("panel")
      ).focus();
    if (this.open) this.floating.position();
  }

  #buttons() {
    return [...this.part("panel").querySelectorAll("button:not(:disabled)")];
  }
  toggle(open, focus = false) {
    super.toggle(open, focus);
    if (open) this.#buttons()[0]?.focus();
  }
}

let warmUntil = 0;
/**
 * `<omg-tooltip content>` around a focusable control: a brief non-interactive
 * hint after 350ms hover, or immediately on focus. Esc dismisses it. The text
 * is also attached as aria-description to the actual focused control, across
 * custom-element shadow roots, preserving any existing description.
 *
 * @attr {string} content - Plain text hint; never essential instructions.
 * @attr {"top" | "bottom" | "top-start" | "bottom-start" | "bottom-end"} placement - Preferred placement; top by default.
 * @slot - One focusable control.
 * @part tooltip - Floating hint.
 */
class OmgTooltip extends OmgElement {
  static observedAttributes = ["content", "placement"];
  static styles = [
    FLOATING,
    css(`
    :host { display: inline-flex; max-width: 100%; }
    .floating { max-width: min(260px, calc(100vw - 16px)); padding: 5px var(--space-2); border-radius: var(--radius-sm); background: var(--color-ink); color: var(--color-on-ink); font-size: var(--text-sm); line-height: 1.4; pointer-events: none; box-shadow: none; }
  `),
  ];
  static template = `<slot></slot><div class="floating" part="tooltip" role="tooltip" popover="manual" hidden></div>`;
  #timer;
  #described;
  #previous;
  #description;
  #hover = false;
  #focused = false;

  constructor() {
    super();
    this.floating = new Floating(
      this,
      this,
      this.part("tooltip"),
      () => this.#hide(),
      () => this.getAttribute("placement") || "top",
    );
    this.addEventListener("pointerenter", () => {
      this.#hover = true;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(
        () => this.#show(),
        Date.now() < warmUntil ? 0 : 350,
      );
    });
    this.addEventListener("pointerleave", () => {
      this.#hover = false;
      if (!this.#focused) this.#hide();
    });
    this.addEventListener("focusin", (event) => {
      this.#focused = true;
      this.#restore();
      this.#described = event.composedPath()[0];
      this.#previous = this.#described.getAttribute("aria-description");
      this.#describe();
      this.#show();
    });
    this.addEventListener("focusout", () => {
      this.#focused = false;
      this.#restore();
      if (!this.#hover) this.#hide();
    });
  }

  #describe() {
    if (!this.#described) return;
    this.#description = [this.#previous, this.getAttribute("content")]
      .filter(Boolean)
      .join(". ");
    this.#described.setAttribute("aria-description", this.#description);
  }
  #restore() {
    if (
      this.#described &&
      this.#described.getAttribute("aria-description") === this.#description
    ) {
      if (this.#previous === null)
        this.#described.removeAttribute("aria-description");
      else this.#described.setAttribute("aria-description", this.#previous);
    }
    this.#described = undefined;
  }
  #show() {
    clearTimeout(this.#timer);
    if (this.isConnected && this.getAttribute("content")) this.floating.show();
  }
  #hide() {
    clearTimeout(this.#timer);
    if (!this.part("tooltip").hidden) warmUntil = Date.now() + 300;
    this.floating.hide();
  }
  disconnectedCallback() {
    this.#hide();
    this.#restore();
    this.#hover = false;
    this.#focused = false;
  }
  update() {
    this.part("tooltip").textContent = this.getAttribute("content") || "";
    this.#describe();
    if (!this.getAttribute("content")) this.#hide();
    else if (!this.part("tooltip").hidden) this.floating.position();
  }
}

define("omg-popover", OmgPopover);
define("omg-menu", OmgMenu);
define("omg-tooltip", OmgTooltip);

/**
 * `<omg-dialog heading open>`: custom modal content inside the plugin iframe.
 * Native dialog owns focus trapping and Escape; content remains mounted.
 * Programmatic open changes are silent. Simple host confirmations still use ui.confirm.
 *
 * @attr {string} heading - Dialog title and accessible name.
 * @attr {string} description - Optional description below the title.
 * @attr {boolean} open - Shows the modal.
 * @attr {string} close-label - Close button name; defaults to Close.
 * @prop {boolean} open - Modal visibility.
 * @fires {{ reason: "escape" | "backdrop" | "button" }} omg-close - Cancelable user close request; preventDefault keeps the dialog open.
 * @slot - Modal content, retained while closed.
 * @slot footer - Action buttons, aligned at the end.
 * @part panel - Native modal; set max-width for custom sizing.
 * @part heading - Title.
 * @part description - Optional description.
 * @part body - Scrollable content area.
 * @part footer - Action area, hidden when empty.
 * @part close - Close button.
 */
class OmgDialog extends OmgElement {
  static observedAttributes = ["heading", "description", "open", "close-label"];
  static styles = [
    css(`
    :host { display: contents; }
    dialog { width: calc(100% - 32px); max-width: 520px; max-height: calc(100% - 32px); margin: auto; padding: 0; border: 0; border-radius: 14px; background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-float); font: inherit; overflow: hidden; }
    dialog[open] { display: flex; flex-direction: column; }
    dialog::backdrop { background: rgb(0 0 0 / 45%); }
    header { display: flex; flex: none; align-items: flex-start; justify-content: space-between; gap: var(--space-3); padding: var(--space-4) var(--space-4) var(--space-2); }
    h2 { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
    p { margin: var(--space-1) 0 0; color: var(--color-text-secondary); font-size: var(--text-md); line-height: 1.55; }
    .body { display: flex; flex-direction: column; gap: var(--space-3); min-height: 0; padding: var(--space-2) var(--space-4) var(--space-4); overflow: auto; }
    footer { display: flex; flex: none; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--color-border); }
    button { flex: none; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--color-text-secondary); cursor: pointer; }
    button:hover { background: var(--color-hover); color: var(--color-text); }
    button svg { width: 16px; height: 16px; }
  `),
  ];
  static template = `<dialog part="panel" aria-labelledby="heading"><header><div><h2 id="heading" part="heading"></h2><p id="description" part="description"></p></div><button type="button" part="close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="body" part="body"><slot></slot></div><footer part="footer"><slot name="footer"></slot></footer></dialog>`;
  #opener;

  constructor() {
    super();
    const panel = this.part("panel");
    this.part("close").addEventListener("click", () => this.#dismiss("button"));
    panel.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.#dismiss("escape");
    });
    panel.addEventListener("pointerdown", (event) => {
      if (event.target !== panel) return;
      const bounds = panel.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        this.#dismiss("backdrop");
    });
    panel.addEventListener("close", () => {
      if (this.isConnected && !panel.open) this.open = false;
    });
    this.shadowRoot.addEventListener("slotchange", () => this.update());
  }
  get open() {
    return this.hasAttribute("open");
  }
  set open(value) {
    this.toggleAttribute("open", Boolean(value));
  }
  #dismiss(reason) {
    if (
      this.dispatchEvent(
        new CustomEvent("omg-close", {
          bubbles: true,
          composed: true,
          cancelable: true,
          detail: { reason },
        }),
      )
    )
      this.open = false;
  }
  disconnectedCallback() {
    this.part("panel").close();
    this.#opener = undefined;
  }
  update() {
    const panel = this.part("panel");
    text(this.part("heading"), this.getAttribute("heading"));
    text(this.part("description"), this.getAttribute("description"));
    if (this.getAttribute("description"))
      panel.setAttribute("aria-describedby", "description");
    else panel.removeAttribute("aria-describedby");
    this.part("close").setAttribute(
      "aria-label",
      this.getAttribute("close-label") || "Close",
    );
    this.part("footer").hidden = !filled(
      this.shadowRoot.querySelector('slot[name="footer"]'),
    );
    if (this.open && !panel.open) {
      this.#opener = activeElement(this.ownerDocument);
      panel.showModal();
    } else if (!this.open && panel.open) {
      panel.close();
      if (this.#opener?.isConnected)
        this.#opener.focus({ preventScroll: true });
      this.#opener = undefined;
    }
  }
}

define("omg-dialog", OmgDialog);
