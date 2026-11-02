// Forms: what a person fills in. Each control is a native one in the app's
// look, and carries its own label, hint and error.
import { OmgElement, css, define, text } from "./base.js";

const FIELD = css(`
  :host { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; max-width: 100%; }
  .field { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
  .label { color: var(--color-text-secondary); font-size: var(--text-sm); }
  .hint, .error { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
  .hint { color: var(--color-text-secondary); }
  .error { color: var(--color-danger); }
`);

/** The surface a person types or chooses on. */
const BOX = css(`
  .box {
    width: 100%; min-width: 0; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-md);
    background: var(--color-stage); color: var(--color-text); font: inherit;
    box-shadow: inset 0 0 0 1px var(--color-border); transition: box-shadow var(--duration-fast);
  }
  .box:not(:disabled):hover { box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .box[aria-invalid="true"], .box[aria-invalid="true"]:not(:disabled):hover { box-shadow: inset 0 0 0 1px var(--color-danger); }
  .box:disabled { opacity: 0.4; cursor: default; }
  .box::placeholder { color: var(--color-text-tertiary); }
`);

const AFTER_FIELD = `<p class="hint" id="hint" part="hint"></p><p class="error" id="error" part="error"></p>`;

/** A native control under its label, then a hint or an error. */
const field = (control) => `<label class="field" part="field"><span class="label" part="label"></span>${control}</label>${AFTER_FIELD}`;

/**
 * What every form control has.
 *
 * @attr {string} label - Shown with it.
 * @attr {string} hint - A line under it; an error takes its place.
 * @attr {string} error - What's wrong with its value.
 * @attr {boolean} disabled - Can't be changed.
 * @attr {string} aria-label - Its name, without a label.
 * @fires change - The person changed it.
 * @fires input - The person is changing it.
 * @part field - The label around it.
 * @part label - The label's text.
 * @part hint - The hint; hidden when empty or when there is an error.
 * @part error - The error; hidden when empty.
 */
class OmgField extends OmgElement {
  static observedAttributes = ["label", "hint", "error", "disabled", "aria-label"];
  static delegatesFocus = true;
  /** The part that is the native control. */
  static control = "";

  constructor() {
    super();
    // `input` crosses the shadow boundary by itself; `change` doesn't.
    this.control.addEventListener("change", () => {
      this.commit();
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  get control() {
    return this.part(/** @type {typeof OmgField} */ (this.constructor).control);
  }

  /** Records what the person chose, before the page hears of it. */
  commit() {}

  update() {
    const control = this.control;
    text(this.part("label"), this.getAttribute("label"));
    const name = this.getAttribute("aria-label");
    if (name) control.setAttribute("aria-label", name);
    else control.removeAttribute("aria-label");
    control.disabled = this.hasAttribute("disabled");
    const error = this.getAttribute("error");
    const hint = error ? null : this.getAttribute("hint");
    text(this.part("error"), error);
    text(this.part("hint"), hint);
    if (error) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
    if (error || hint) control.setAttribute("aria-describedby", error ? "error" : "hint");
    else control.removeAttribute("aria-describedby");
  }
}

/**
 * What a field to type in has.
 *
 * @attr {string} value - Its text; setting it replaces what was typed.
 * @attr {string} placeholder - Shown while it is empty.
 * @attr {boolean} readonly - Can be read and copied, not changed.
 * @prop {string} value - Its text.
 */
class OmgTextField extends OmgField {
  static observedAttributes = [...OmgField.observedAttributes, "value", "placeholder", "readonly"];
  static styles = [
    FIELD,
    BOX,
    // The caret says where typing goes, however the field got focus.
    css(`.box:focus-visible { outline: none; }`),
  ];

  get value() {
    return this.control.value;
  }

  set value(value) {
    this.control.value = String(value ?? "");
  }

  attributeChangedCallback(name, previous, value) {
    // Only here: an error appearing mustn't put back the text from before typing.
    if (name === "value") this.control.value = value ?? "";
    super.attributeChangedCallback(name, previous, value);
  }

  update() {
    super.update();
    const control = this.control;
    control.placeholder = this.getAttribute("placeholder") ?? "";
    control.readOnly = this.hasAttribute("readonly");
  }
}

/**
 * `<omg-input label value type placeholder hint error>`: one line of text.
 *
 * @attr {"text" | "search" | "password" | "number" | "email" | "url"} type - What it holds; text by default.
 * @part input - The native input.
 */
class OmgInput extends OmgTextField {
  static observedAttributes = [...OmgTextField.observedAttributes, "type"];
  static control = "input";
  static styles = [...OmgTextField.styles, css(`input { height: 32px; }`)];
  static template = field(`<input class="box" part="input" />`);

  update() {
    super.update();
    this.control.type = this.getAttribute("type") ?? "text";
  }
}

/**
 * `<omg-textarea label value rows placeholder hint error>`: several lines of text.
 *
 * @attr {number} rows - How many lines it shows; 3 by default.
 * @part textarea - The native textarea.
 */
class OmgTextarea extends OmgTextField {
  static observedAttributes = [...OmgTextField.observedAttributes, "rows"];
  static control = "textarea";
  static styles = [...OmgTextField.styles, css(`textarea { display: block; padding-block: var(--space-2); line-height: 1.5; resize: vertical; }`)];
  static template = field(`<textarea class="box" part="textarea"></textarea>`);

  update() {
    super.update();
    this.control.rows = Number(this.getAttribute("rows")) || 3;
  }
}

/**
 * What a control that is on or off has.
 *
 * @attr {boolean} checked - It is on.
 * @prop {boolean} checked - It is on.
 */
class OmgToggle extends OmgField {
  static observedAttributes = [...OmgField.observedAttributes, "checked"];
  static styles = [
    FIELD,
    css(`
      .field { flex-direction: row; align-items: center; gap: var(--space-2); cursor: pointer; }
      :host([disabled]) .field { cursor: default; }
      .label { color: var(--color-text); font-size: inherit; }
      input { flex: none; appearance: none; margin: 0; cursor: inherit; }
      input:disabled { opacity: 0.4; }
    `),
  ];

  get checked() {
    return this.control.checked;
  }

  set checked(value) {
    this.toggleAttribute("checked", Boolean(value));
  }

  commit() {
    this.toggleAttribute("checked", this.control.checked);
  }

  update() {
    super.update();
    this.control.checked = this.hasAttribute("checked");
  }
}

/**
 * `<omg-switch label checked hint>`: turns a setting on or off at once, with its
 * label at the row's start and the switch at its end.
 *
 * @cssprop --omg-accent - The plugin's brand colour, for the switch when on.
 * @cssprop --omg-on-accent - The colour of the thumb when on.
 * @part switch - The native checkbox.
 */
class OmgSwitch extends OmgToggle {
  static control = "switch";
  static styles = [
    ...OmgToggle.styles,
    css(`
      .field { justify-content: space-between; }
      input {
        position: relative; width: 34px; height: 20px; border-radius: var(--radius-pill);
        background: var(--color-text-tertiary); transition: background var(--duration-fast);
      }
      input::before {
        content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
        background: var(--color-control-thumb); box-shadow: 0 1px 2px rgb(0 0 0 / 30%);
        transition: transform var(--duration-base) var(--ease-out);
      }
      input:checked { background: var(--omg-accent, var(--color-accent)); }
      input:checked::before { background: var(--omg-on-accent, var(--color-on-accent)); transform: translateX(14px); }
    `),
  ];
  static template = field(`<input type="checkbox" role="switch" part="switch" />`);
}

/**
 * `<omg-checkbox label checked hint>`: a choice that takes effect with the rest
 * of a form, with the box before its label.
 *
 * @cssprop --omg-accent - The plugin's brand colour, for the box when checked.
 * @cssprop --omg-on-accent - The colour of the check.
 * @part checkbox - The native checkbox.
 */
class OmgCheckbox extends OmgToggle {
  static control = "checkbox";
  static styles = [
    ...OmgToggle.styles,
    css(`
      .field { flex-direction: row-reverse; justify-content: flex-end; }
      .hint, .error { padding-left: calc(16px + var(--space-2)); }
      input {
        display: grid; place-items: center; width: 16px; height: 16px; border-radius: 4px;
        background: var(--color-stage); box-shadow: inset 0 0 0 1px var(--color-border-strong);
        transition: background var(--duration-fast);
      }
      input[aria-invalid="true"] { box-shadow: inset 0 0 0 1px var(--color-danger); }
      input:checked { background: var(--omg-accent, var(--color-accent)); box-shadow: none; }
      input:checked::before {
        content: ""; width: 4px; height: 8px; margin-top: -2px; rotate: 45deg;
        border: solid var(--omg-on-accent, var(--color-on-accent)); border-width: 0 1.5px 1.5px 0;
      }
    `),
  ];
  static template = field(`<input type="checkbox" part="checkbox" />`);
}

/**
 * What a choice among `<option>` children has. The `value` attribute chooses,
 * and a choice sets it; without one, the option marked `selected` is chosen.
 *
 * @attr {string} value - The chosen option's value.
 * @prop {string} value - The chosen option's value.
 */
class OmgChoice extends OmgField {
  static observedAttributes = [...OmgField.observedAttributes, "value"];

  // Options added, removed or changed; the host's own attributes aren't options.
  #observer = new MutationObserver((records) => {
    if (records.some((record) => record.type !== "attributes" || record.target !== this)) this.#read();
  });

  connectedCallback() {
    this.#observer.observe(this, { childList: true, subtree: true, attributes: true, characterData: true });
    this.#read();
    super.connectedCallback();
  }

  disconnectedCallback() {
    this.#observer.disconnect();
  }

  /** The value to show: the attribute's, or the option marked `selected`'s. A parser may add options one at a time. */
  #read() {
    const sources = [...this.querySelectorAll("option")];
    this.drawOptions(sources, this.getAttribute("value") ?? sources.find((source) => source.hasAttribute("selected"))?.value);
  }

  /** Copies the page's options into the control. */
  drawOptions(_sources, _chosen) {}
}

/**
 * `<omg-select label value hint error disabled>` with `<option>` children: the
 * app's dropdown. Its list stays inside the panel and scrolls.
 *
 * @part select - The native select.
 */
class OmgSelect extends OmgChoice {
  static control = "select";
  static styles = [
    FIELD,
    BOX,
    css(`
      :host { display: inline-flex; min-width: 160px; }
      /* Still a native select, so the browser keeps its keyboard, its form and its
         screen reader behaviour; a browser without base-select draws its own list. */
      select, ::picker(select) { appearance: base-select; }
      select { height: 32px; display: flex; align-items: center; gap: var(--space-2); cursor: pointer; }
      select::picker-icon {
        content: ""; width: 6px; height: 6px; margin: -3px 2px 0 auto; rotate: 45deg;
        border: solid var(--color-text-tertiary); border-width: 0 1.5px 1.5px 0; transition: none;
      }
      ::picker(select) {
        margin-block: var(--space-1); padding: var(--space-1); border: 0; border-radius: var(--radius-lg);
        /* The browser opens it on the side with more room and limits it to that room. */
        overflow: auto;
        background: var(--color-surface-raised); color: var(--color-text); box-shadow: var(--shadow-float);
      }
      option {
        display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
        min-height: 28px; padding: var(--space-1) var(--space-2); border-radius: var(--radius-md); cursor: pointer;
      }
      option:not(:disabled):hover, option:focus-visible { outline: none; background: var(--color-hover); }
      option:disabled { color: var(--color-text-tertiary); cursor: default; }
      option::checkmark { order: 1; color: var(--color-text-secondary); }
    `),
  ];
  static template = field(`<select class="box" part="select"></select>`);

  constructor() {
    super();
    this.control.addEventListener("input", () => this.commit());
  }

  get value() {
    return this.control.value;
  }

  set value(value) {
    this.setAttribute("value", String(value ?? ""));
  }

  commit() {
    this.setAttribute("value", this.control.value);
  }

  drawOptions(sources, chosen) {
    const select = this.control;
    select.replaceChildren(
      ...sources.map((source) => {
        const option = document.createElement("option");
        option.value = source.value;
        option.textContent = source.textContent;
        option.disabled = source.disabled;
        return option;
      }),
    );
    if (chosen !== undefined) select.value = chosen;
  }

  update() {
    super.update();
    // As a native select: a value no option has leaves nothing chosen.
    const value = this.getAttribute("value");
    if (value !== null && this.control.value !== value) this.control.value = value;
  }
}

/**
 * `<omg-segmented label value hint error disabled>` with `<option>` children: a
 * few choices side by side, all in view. Arrow keys move between them.
 *
 * @part segments - The row of choices.
 * @part segment - One choice.
 */
class OmgSegmented extends OmgChoice {
  static control = "segments";
  static styles = [
    FIELD,
    css(`
      :host { align-items: flex-start; }
      .segments { display: inline-flex; max-width: 100%; overflow-x: auto; scrollbar-width: none; gap: 2px; padding: 3px; border-radius: var(--radius-md); background: var(--color-hover); }
      label.segment {
        position: relative; display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: var(--radius-sm);
        color: var(--color-text-secondary); white-space: nowrap; cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast);
      }
      label.segment:hover { color: var(--color-text); }
      label.segment:has(:checked) { background: var(--color-surface-raised); box-shadow: var(--shadow-hairline); color: var(--color-text); font-weight: var(--weight-medium); }
      label.segment:has(:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: -2px; }
      label.segment:has(:disabled) { opacity: 0.4; cursor: default; }
      input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: inherit; }
    `),
  ];
  static template = `<div class="field" part="field"><span class="label" id="label" part="label"></span><div class="segments" part="segments" role="radiogroup"></div></div>${AFTER_FIELD}`;

  #radios() {
    return [.../** @type {NodeListOf<HTMLInputElement>} */ (this.control.querySelectorAll("input"))];
  }

  get value() {
    return this.#radios().find((radio) => radio.checked)?.value ?? "";
  }

  set value(value) {
    this.setAttribute("value", String(value ?? ""));
  }

  commit() {
    this.setAttribute("value", this.value);
  }

  drawOptions(sources, chosen) {
    this.control.replaceChildren(
      ...sources.map((source) => {
        const label = document.createElement("label");
        label.className = "segment";
        label.setAttribute("part", "segment");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "segments";
        radio.value = source.value;
        radio.checked = source.value === chosen;
        radio.dataset.disabled = source.disabled ? "true" : "";
        const name = document.createElement("span");
        name.textContent = source.textContent;
        label.append(radio, name);
        return label;
      }),
    );
    this.#mark();
  }

  #mark() {
    const value = this.getAttribute("value");
    for (const radio of this.#radios()) {
      radio.disabled = this.hasAttribute("disabled") || radio.dataset.disabled === "true";
      if (value !== null) radio.checked = radio.value === value;
    }
  }

  update() {
    super.update();
    const control = this.control;
    if (this.getAttribute("label")) control.setAttribute("aria-labelledby", "label");
    else control.removeAttribute("aria-labelledby");
    this.#mark();
  }
}

define("omg-input", OmgInput);
define("omg-textarea", OmgTextarea);
define("omg-switch", OmgSwitch);
define("omg-checkbox", OmgCheckbox);
define("omg-select", OmgSelect);
define("omg-segmented", OmgSegmented);
