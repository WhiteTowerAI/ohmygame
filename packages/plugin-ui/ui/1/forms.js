// Forms: what a person fills in. Each control is a native one in the app's
// look, and carries its own label, hint and error.
import { OmgElement, css, define, text } from "./base.js";
import { Floating, FLOATING } from "./floating.js";

const FIELD = css(`
  :host { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; max-width: 100%; }
  .field { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
  .label { color: var(--color-text-secondary); font-size: var(--text-sm); }
  .hint, .error { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
  .hint { color: var(--color-text-secondary); }
  .error { color: var(--color-danger); }
  /* Editable inputs may match :focus-visible even after a pointer click.
     Suppress only pointer focus, including a segmented control's label ring. */
  .field.pointer-focus :focus-visible,
  .field.pointer-focus label.choice:has(:focus-visible) { outline: none; }
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
  // Searchable choices emit value events only when an option is picked.
  static nativeValueEvents = true;

  constructor() {
    super();
    const field = this.part("field");
    this.shadowRoot.addEventListener("pointerdown", () => field.classList.add("pointer-focus"), true);
    this.shadowRoot.addEventListener("keydown", (event) => {
      if (["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) field.classList.remove("pointer-focus");
    }, true);
    this.shadowRoot.addEventListener("focusout", () => queueMicrotask(() => {
      if (!this.shadowRoot.activeElement) field.classList.remove("pointer-focus");
    }));
    // `input` crosses the shadow boundary by itself; `change` doesn't. A box, a
    // radio or an option is chosen by the time `input` fires, so the choice is
    // recorded then: a page that changes the hint as it hears `input` mustn't
    // put back the one before.
    if (this.constructor.nativeValueEvents) {
      this.control.addEventListener("input", () => this.commit());
      this.control.addEventListener("change", () => {
        this.commit();
        this.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
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
 * @attr {number} min - Minimum for type=number; native validation does not clamp typed text.
 * @attr {number} max - Maximum for type=number.
 * @attr {number | "any"} step - Numeric increment; native default is 1.
 * @method {boolean} checkValidity - Whether the native input satisfies its constraints.
 * @part input - The native input.
 */
class OmgInput extends OmgTextField {
  static observedAttributes = [...OmgTextField.observedAttributes, "type", "min", "max", "step"];
  static control = "input";
  static styles = [...OmgTextField.styles, css(`input { height: 32px; }`)];
  static template = field(`<input class="box" part="input" />`);

  update() {
    super.update();
    this.control.type = this.getAttribute("type") ?? "text";
    for (const name of ["min", "max", "step"]) {
      const value = this.getAttribute(name);
      if (value === null) this.control.removeAttribute(name);
      else this.control.setAttribute(name, value);
    }
  }

  checkValidity() { return this.control.checkValidity(); }
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
  static styles = [...OmgTextField.styles, css(`textarea.box { display: block; padding-block: var(--space-2); line-height: 1.5; resize: vertical; }`)];
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
      :host { display: inline-flex; min-width: 0; }
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

/** Shared native radio selection, disabled state and focus retention. */
class OmgRadioChoice extends OmgChoice {
  optionContent(source) {
    const name = document.createElement("span");
    name.textContent = source.textContent;
    return name;
  }

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
    // The radios are drawn again, so one that had focus gives it to its successor.
    const focused = /** @type {HTMLInputElement | null} */ (this.shadowRoot?.activeElement ?? null);
    const had = focused?.type === "radio" ? focused.value : undefined;
    this.control.replaceChildren(
      ...sources.map((source) => {
        const label = document.createElement("label");
        label.className = "choice";
        label.setAttribute("part", this.constructor.optionPart);
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "segments";
        radio.value = source.value;
        radio.checked = source.value === chosen;
        radio.dataset.disabled = source.disabled ? "true" : "";
        label.append(radio, this.optionContent(source));
        return label;
      }),
    );
    this.#mark();
    if (had !== undefined) {
      const radios = this.#radios().filter((radio) => !radio.disabled);
      (radios.find((radio) => radio.value === had) ?? radios.find((radio) => radio.checked) ?? radios[0])?.focus();
    }
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

/**
 * `<omg-segmented label value hint error disabled>` with `<option>` children: a
 * few choices side by side, all in view. Arrow keys move between them.
 *
 * @part segments - The row of choices.
 * @part segment - One choice.
 */
class OmgSegmented extends OmgRadioChoice {
  static optionPart = "segment";
  static control = "segments";
  static styles = [
    FIELD,
    css(`
      :host { align-items: flex-start; }
      .segments { display: inline-flex; max-width: 100%; overflow-x: auto; scrollbar-width: none; gap: 2px; padding: 3px; border-radius: var(--radius-md); background: var(--color-hover); }
      label.choice {
        position: relative; display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: var(--radius-sm);
        color: var(--color-text-secondary); white-space: nowrap; cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast);
      }
      label.choice:hover { color: var(--color-text); }
      label.choice:has(:checked) { background: var(--color-surface-raised); box-shadow: var(--shadow-hairline); color: var(--color-text); font-weight: var(--weight-medium); }
      label.choice:has(:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: -2px; }
      label.choice:has(:disabled) { opacity: 0.4; cursor: default; }
      input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: inherit; }
    `),
  ];
  static template = `<div class="field" part="field"><span class="label" id="label" part="label"></span><div class="segments" part="segments" role="radiogroup"></div></div>${AFTER_FIELD}`;

}

/**
 * `<omg-radio-group label value>` with `<option>` children: visible choices,
 * optionally explained by each option's `data-description`. Native arrows and
 * Space select; separate groups keep independent selections.
 *
 * @part options - The radio group.
 * @part option - One labelled choice.
 */
class OmgRadioGroup extends OmgRadioChoice {
  static control = "options";
  static optionPart = "option";
  static styles = [FIELD, css(`
    .options { display: flex; flex-direction: column; gap: var(--space-2); }
    .choice { display: flex; align-items: flex-start; gap: var(--space-2); cursor: pointer; }
    .choice:has(:disabled) { color: var(--color-text-tertiary); cursor: default; }
    input { flex: none; appearance: none; width: 16px; height: 16px; margin: 1px 0 0; border-radius: 50%; background: var(--color-stage); box-shadow: inset 0 0 0 1px var(--color-border-strong); cursor: inherit; }
    input:checked { box-shadow: inset 0 0 0 5px var(--omg-accent, var(--color-accent)); }
    input:disabled { opacity: 0.4; }
    .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
    small { color: var(--color-text-tertiary); font-size: var(--text-sm); line-height: 1.45; }
  `)];
  static template = `<div class="field" part="field"><span class="label" id="label" part="label"></span><div class="options" part="options" role="radiogroup"></div></div>${AFTER_FIELD}`;

  optionContent(source) {
    const content = document.createElement("span");
    content.className = "text";
    content.append(super.optionContent(source));
    if (source.dataset.description) {
      const description = document.createElement("small");
      description.textContent = source.dataset.description;
      content.append(description);
    }
    return content;
  }
}

/**
 * `<omg-slider label min max step value>`: a native range with a numeric readout.
 * The browser bounds and steps the value. Input fires while adjusting; change
 * fires when committed. Programmatic changes are silent.
 *
 * @attr {number} min - Range start; defaults to 0.
 * @attr {number} max - Range end; defaults to 100.
 * @attr {number | "any"} step - Increment; defaults to 1.
 * @attr {number} value - Current value; defaults to the native range midpoint.
 * @prop {number} value - Current bounded numeric value.
 * @part input - Native range control.
 * @part output - Current numeric value.
 */
class OmgSlider extends OmgField {
  static observedAttributes = [...OmgField.observedAttributes, "min", "max", "step", "value"];
  static control = "input";
  static styles = [FIELD, css(`
    .slider { display: flex; align-items: center; gap: var(--space-3); min-height: 28px; }
    input { flex: 1; min-width: 0; height: 4px; margin: 0; border-radius: 2px; appearance: none; cursor: pointer; background: linear-gradient(to right, var(--omg-accent, var(--color-accent)) var(--fill), var(--color-border-strong) var(--fill)); }
    input::-webkit-slider-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--omg-accent, var(--color-accent)); box-shadow: 0 0 0 3px var(--color-surface); appearance: none; }
    input::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--omg-accent, var(--color-accent)); box-shadow: 0 0 0 3px var(--color-surface); }
    input:disabled { cursor: default; opacity: 0.4; }
    output { min-width: 36px; color: var(--color-text-secondary); font-family: var(--font-mono); font-size: var(--text-sm); text-align: right; }
  `)];
  static template = field(`<span class="slider"><input type="range" id="range" part="input"><output for="range" part="output" aria-hidden="true"></output></span>`);

  get value() { return Number(this.control.value); }
  set value(value) { this.setAttribute("value", String(value)); }
  commit() { this.setAttribute("value", this.control.value); }

  update() {
    super.update();
    const input = this.control;
    input.min = this.getAttribute("min") ?? "0";
    input.max = this.getAttribute("max") ?? "100";
    input.step = this.getAttribute("step") ?? "1";
    input.value = this.getAttribute("value") ?? "";
    const min = Number.isFinite(Number(input.min)) ? Number(input.min) : 0;
    const max = input.max.trim() && Number.isFinite(Number(input.max)) ? Number(input.max) : 100;
    const percent = max > min ? Math.max(0, Math.min(100, (this.value - min) / (max - min) * 100)) : 0;
    input.style.setProperty("--fill", `${percent}%`);
    this.part("output").textContent = input.value;
  }
}


/**
 * `<omg-combobox label value>` with `<option>` children: a searchable choice.
 * Query text never changes the committed value until an enabled option is
 * picked. Closing discards the query. Options can be replaced asynchronously;
 * set `manual-filter` when the caller filters them remotely.
 *
 * @attr {string} placeholder - Text shown with no selection.
 * @attr {boolean} loading - Shows loading-label; disables picking stale options.
 * @attr {boolean} manual-filter - The caller filters options using omg-query.
 * @attr {string} empty-label - Empty list message; defaults to No results.
 * @attr {string} loading-label - Loading message; defaults to Loading….
 * @readonly {string} query - Current uncommitted search text.
 * @fires {{ query: string }} omg-query - Search text changed, or a manual-filter list opened; caller owns fetching and stale-result protection.
 * @part input - Combobox input, with active-descendant keyboard navigation.
 * @part panel - Floating list surface.
 * @part options - Listbox.
 * @part status - Loading or empty message.
 */
class OmgCombobox extends OmgChoice {
  static nativeValueEvents = false;
  static observedAttributes = [...OmgChoice.observedAttributes, "placeholder", "loading", "manual-filter", "empty-label", "loading-label"];
  static control = "input";
  static styles = [FIELD, BOX, FLOATING, css(`
    .input-wrap { position: relative; }
    input { height: 32px; padding-inline-end: 28px !important; }
    .caret { position: absolute; right: 11px; top: 12px; width: 6px; height: 6px; rotate: 45deg; border: solid var(--color-text-tertiary); border-width: 0 1.5px 1.5px 0; pointer-events: none; }
    .option { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: 30px; padding: 5px var(--space-2); border-radius: var(--radius-sm); cursor: pointer; overflow-wrap: anywhere; }
    .option.active { background: var(--color-hover); }
    .option[aria-disabled="true"] { color: var(--color-text-tertiary); cursor: default; }
    .status { padding: var(--space-2); color: var(--color-text-tertiary); font-size: var(--text-sm); }
  `)];
  static template = field(`<span class="input-wrap"><input class="box" part="input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="options" autocomplete="off"><span class="caret" aria-hidden="true"></span></span>`) + `<div class="floating" part="panel" popover="manual" hidden><div id="options" part="options" role="listbox"></div><div class="status" part="status" role="status" hidden></div></div>`;
  #sources = [];
  #filtered = [];
  #chosenLabel;
  #query = "";
  #open = false;
  #active = -1;

  constructor() {
    super();
    this.floating = new Floating(this, this.control, this.part("panel"), () => this.#close());
    this.floating.matchWidth = true;
    this.control.addEventListener("focus", () => this.#show());
    this.control.addEventListener("click", () => this.#show());
    this.control.addEventListener("input", (event) => {
      // The field base does not commit a search; only a picked option commits.
      event.stopPropagation();
      this.#query = this.control.value;
      this.#active = -1;
      this.#show();
      this.dispatchEvent(new CustomEvent("omg-query", { bubbles: true, composed: true, detail: { query: this.#query } }));
    });
    this.control.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Tab") { this.#close(); return; }
      if (event.key === "Enter" && this.#open) { event.preventDefault(); this.#pick(this.#active); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if (!this.#open && ["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      this.#show();
      const enabled = this.#filtered.map((item, index) => item.disabled ? -1 : index).filter((index) => index !== -1);
      const current = enabled.indexOf(this.#active);
      this.#active = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1) : enabled[(current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length] ?? -1;
      this.#mark();
      this.part("options").children[this.#active]?.scrollIntoView({ block: "nearest" });
    });
    // Mouse selection keeps input focus, so active-descendant remains authoritative.
    this.part("panel").addEventListener("mousedown", (event) => event.preventDefault());
  }

  get value() { return this.getAttribute("value") ?? this.#sources.find((item) => item.selected)?.value ?? ""; }
  set value(value) { this.setAttribute("value", String(value ?? "")); }
  get query() { return this.#query; }

  drawOptions(sources) { this.#sources = sources; this.#draw(); this.#display(); }
  #display() {
    const selected = this.#sources.find((item) => item.value === this.value);
    if (selected) this.#chosenLabel = { value: selected.value, label: selected.textContent };
    if (!this.#open) this.control.value = this.#chosenLabel?.value === this.value ? this.#chosenLabel.label : this.value;
  }
  #show() {
    if (this.hasAttribute("disabled")) return;
    const opening = !this.#open;
    if (opening) { this.#open = true; this.control.value = this.#query; }
    this.control.setAttribute("aria-expanded", "true");
    this.#draw();
    this.floating.show();
    if (opening && this.hasAttribute("manual-filter")) this.dispatchEvent(new CustomEvent("omg-query", { bubbles: true, composed: true, detail: { query: this.#query } }));
  }
  #close() {
    this.#open = false;
    this.#query = "";
    this.#active = -1;
    this.control.setAttribute("aria-expanded", "false");
    this.control.removeAttribute("aria-activedescendant");
    this.floating.hide();
    this.#display();
  }
  #pick(index) {
    const option = this.#filtered[index];
    if (!option || option.disabled || this.hasAttribute("disabled") || this.hasAttribute("loading")) return;
    this.value = option.value;
    this.#close();
    this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  #draw() {
    const oldValue = this.#filtered[this.#active]?.value;
    const needle = this.#query.trim().toLowerCase();
    this.#filtered = this.hasAttribute("loading") ? [] : this.#sources.filter((item) => this.hasAttribute("manual-filter") || `${item.textContent} ${item.value} ${item.getAttribute("data-keywords") || ""}`.toLowerCase().includes(needle));
    this.#active = this.#filtered.findIndex((item) => item.value === oldValue && !item.disabled);
    this.part("options").replaceChildren(...this.#filtered.map((item, index) => {
      const option = document.createElement("div");
      option.id = `option-${index}`;
      option.className = "option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(item.value === this.value));
      option.setAttribute("aria-disabled", String(item.disabled));
      const label = document.createElement("span");
      label.textContent = item.textContent;
      option.append(label);
      if (item.value === this.value) { const check = document.createElement("span"); check.textContent = "✓"; check.setAttribute("aria-hidden", "true"); option.append(check); }
      option.addEventListener("click", () => this.#pick(index));
      option.addEventListener("pointermove", () => { if (!item.disabled) { this.#active = index; this.#mark(); } });
      return option;
    }));
    this.part("options").setAttribute("aria-label", this.getAttribute("label") || this.getAttribute("aria-label") || "");
    this.part("options").setAttribute("aria-busy", String(this.hasAttribute("loading")));
    text(this.part("status"), this.hasAttribute("loading") ? this.getAttribute("loading-label") || "Loading…" : !this.#filtered.length ? this.getAttribute("empty-label") || "No results" : "");
    this.#mark();
    if (this.#open) this.floating.position();
  }
  #mark() {
    [...this.part("options").children].forEach((option, index) => option.classList.toggle("active", index === this.#active));
    if (this.#open && this.#active >= 0) this.control.setAttribute("aria-activedescendant", `option-${this.#active}`);
    else this.control.removeAttribute("aria-activedescendant");
  }
  disconnectedCallback() { super.disconnectedCallback(); this.#close(); }
  update() {
    super.update();
    this.control.placeholder = this.getAttribute("placeholder") || "";
    if (this.hasAttribute("disabled")) this.#close();
    this.#draw();
    this.#display();
  }
}

/**
 * `<omg-file-picker label accept multiple>`: choose local files or drop them.
 * Selection stays local; callers own validation, persistence and uploads.
 * Accept checks filenames/MIME hints, never file contents. Invalid drops retain
 * the prior selection. Cancelling the native chooser also retains it.
 *
 * @attr {string} accept - Comma-separated extensions or MIME types, including image/*.
 * @attr {boolean} multiple - Allows more than one file.
 * @attr {string} choose-label - Picker action; defaults to Choose files.
 * @attr {string} drop-label - Drop hint; defaults to or drop files here.
 * @attr {string} clear-label - Clear action; defaults to Clear.
 * @attr {string} rejected-label - Rejection feedback; defaults to Check the file type and number of files.
 * @readonly {File[]} files - A copy of the currently selected local files.
 * @method {void} clear - Clears selection silently; user clearing emits change.
 * @fires {{ files: File[], reason: "accept" | "multiple" }} omg-reject - Rejected selection; previous files remain available.
 * @part input - Native file input.
 * @part dropzone - Clickable drop surface.
 * @part files - Selected filenames.
 * @part clear - Clear button.
 */
class OmgFilePicker extends OmgField {
  static observedAttributes = [...OmgField.observedAttributes, "accept", "multiple", "choose-label", "drop-label", "clear-label", "rejected-label"];
  static control = "input";
  static nativeValueEvents = false;
  static styles = [FIELD, css(`
    .dropzone { position: relative; display: flex; flex-direction: column; align-items: center; gap: var(--space-1); padding: var(--space-4); border: 1px dashed var(--color-border-strong); border-radius: var(--radius-lg); cursor: pointer; text-align: center; }
    .dropzone:hover, .dropzone.dragging { background: var(--color-hover); }
    .dropzone:has(:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: 2px; }
    .field.pointer-focus .dropzone:has(:focus-visible) { outline: none; }
    input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .choose { font-weight: var(--weight-medium); }
    .drop { color: var(--color-text-tertiary); font-size: var(--text-sm); }
    :host([disabled]) .dropzone { opacity: 0.4; cursor: default; background: transparent; }
    .selection { display: flex; align-items: flex-start; gap: var(--space-2); }
    ul { flex: 1; min-width: 0; margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); overflow-wrap: anywhere; }
    button { border: 0; border-radius: var(--radius-md); padding: 3px var(--space-2); background: transparent; color: var(--color-text-secondary); font: inherit; font-size: var(--text-sm); cursor: pointer; }
    button:hover { background: var(--color-hover); color: var(--color-text); }
    button:disabled { opacity: 0.4; cursor: default; }
  `)];
  static template = `<div class="field" part="field"><span class="label" id="label" part="label"></span><label class="dropzone" part="dropzone"><input type="file" part="input"><span class="choose"></span><span class="drop"></span></label><div class="selection" hidden><ul part="files"></ul><button type="button" part="clear"></button></div></div>${AFTER_FIELD}`;
  #files = [];
  #rejected = false;
  #dragDepth = 0;

  constructor() {
    super();
    this.control.addEventListener("change", (event) => {
      event.stopPropagation();
      this.#choose([...this.control.files]);
      this.control.value = ""; // Picking the same file again still reports a change.
    });
    this.control.addEventListener("input", (event) => event.stopPropagation());
    this.part("clear").addEventListener("click", () => {
      if (this.hasAttribute("disabled")) return;
      this.clear();
      this.control.focus();
      this.#changed();
    });
    const zone = this.part("dropzone");
    zone.addEventListener("dragenter", (event) => {
      if (!event.dataTransfer?.types.includes("Files") || this.hasAttribute("disabled")) return;
      event.preventDefault();
      this.#dragDepth++;
      zone.classList.add("dragging");
    });
    zone.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = this.hasAttribute("disabled") ? "none" : "copy";
    });
    zone.addEventListener("dragleave", () => {
      this.#dragDepth = Math.max(0, this.#dragDepth - 1);
      if (!this.#dragDepth) zone.classList.remove("dragging");
    });
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      this.#dragDepth = 0;
      zone.classList.remove("dragging");
      if (event.dataTransfer) this.#choose([...event.dataTransfer.files]);
    });
  }

  get files() { return [...this.#files]; }
  clear() { this.#files = []; this.#rejected = false; this.control.value = ""; this.update(); }
  #changed() {
    this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  #choose(files) {
    if (!files.length || this.hasAttribute("disabled")) return;
    const types = (this.getAttribute("accept") || "").toLowerCase().split(",").map((type) => type.trim()).filter(Boolean);
    const accepts = (file) => !types.length || types.some((type) => type.startsWith(".") ? file.name.toLowerCase().endsWith(type) : type.endsWith("/*") ? file.type.toLowerCase().startsWith(type.slice(0, -1)) : file.type.toLowerCase() === type);
    const reason = !this.hasAttribute("multiple") && files.length > 1 ? "multiple" : files.some((file) => !accepts(file)) ? "accept" : null;
    this.#rejected = Boolean(reason);
    if (reason) {
      this.update();
      this.dispatchEvent(new CustomEvent("omg-reject", { bubbles: true, composed: true, detail: { files, reason } }));
      return;
    }
    this.#files = files;
    this.update();
    this.#changed();
  }
  disconnectedCallback() { this.#dragDepth = 0; this.part("dropzone").classList.remove("dragging"); }
  update() {
    super.update();
    this.control.accept = this.getAttribute("accept") || "";
    this.control.multiple = this.hasAttribute("multiple");
    if (this.getAttribute("label")) this.control.setAttribute("aria-labelledby", "label");
    else this.control.removeAttribute("aria-labelledby");
    text(this.shadowRoot.querySelector(".choose"), this.getAttribute("choose-label") || "Choose files");
    text(this.shadowRoot.querySelector(".drop"), this.getAttribute("drop-label") || "or drop files here");
    text(this.part("clear"), this.getAttribute("clear-label") || "Clear");
    this.part("clear").disabled = this.hasAttribute("disabled");
    this.shadowRoot.querySelector(".selection").hidden = !this.#files.length;
    this.part("files").replaceChildren(...this.#files.map((file) => {
      const name = document.createElement("li");
      name.textContent = file.name;
      return name;
    }));
    if (this.#rejected && !this.getAttribute("error")) {
      text(this.part("hint"), "");
      text(this.part("error"), this.getAttribute("rejected-label") || "Check the file type and number of files.");
      this.control.setAttribute("aria-invalid", "true");
      this.control.setAttribute("aria-describedby", "error");
    }
    if (this.hasAttribute("disabled")) { this.#dragDepth = 0; this.part("dropzone").classList.remove("dragging"); }
  }
}

define("omg-file-picker", OmgFilePicker);
define("omg-slider", OmgSlider);
define("omg-radio-group", OmgRadioGroup);
define("omg-combobox", OmgCombobox);
define("omg-input", OmgInput);
define("omg-textarea", OmgTextarea);
define("omg-switch", OmgSwitch);
define("omg-checkbox", OmgCheckbox);
define("omg-select", OmgSelect);
define("omg-segmented", OmgSegmented);
