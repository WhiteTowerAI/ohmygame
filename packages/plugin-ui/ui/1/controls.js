// Controls: buttons, a button bound to one of the plugin's commands, and a
// select.
import { connect } from "../../plugin-ui.js";
import { OmgElement, css, define, text } from "./base.js";

// Listens for the app's port from the start: the app sends it once, when the
// page loads, and a page may use these components without connecting itself.
const connection = connect();

const BUTTON = css(`
  :host { display: inline-flex; vertical-align: middle; max-width: 100%; }
  button {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); width: 100%;
    height: 30px; padding: 0 var(--space-3); border: 0; border-radius: var(--radius-md);
    background: var(--color-hover); color: var(--color-text);
    font: inherit; font-weight: var(--weight-medium); white-space: nowrap; cursor: pointer;
    transition: background var(--duration-fast), opacity var(--duration-fast);
  }
  button:not(:disabled):hover { background: var(--color-selected); }
  :host([variant="primary"]) button { background: var(--color-ink); color: var(--color-on-ink); }
  :host([variant="primary"]) button:not(:disabled):hover { background: var(--color-ink); opacity: 0.88; }
  :host([variant="ghost"]) button { background: transparent; }
  :host([variant="ghost"]) button:not(:disabled):hover { background: var(--color-hover); }
  :host([variant="danger"]) button { color: var(--color-danger); }
  button:disabled { opacity: 0.4; cursor: default; }
  button[aria-busy="true"] { opacity: 0.7; cursor: progress; }
`);

/**
 * `<omg-button variant="secondary|primary|ghost|danger" disabled busy>`: the
 * app's button. Primary is ink; there is one per view. A busy button shows a
 * spinner and takes no clicks.
 */
class OmgButton extends OmgElement {
  static observedAttributes = ["variant", "disabled", "busy"];
  static delegatesFocus = true;
  static styles = [BUTTON];
  static template = `<button part="button" type="button"><span class="spinner" part="spinner" hidden></span><slot></slot></button>`;

  constructor() {
    super();
    // Neither a disabled nor a busy button reports a click.
    this.addEventListener(
      "click",
      (event) => {
        if (this.#inactive()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(value) {
    this.toggleAttribute("disabled", Boolean(value));
  }

  get busy() {
    return this.hasAttribute("busy");
  }

  set busy(value) {
    this.toggleAttribute("busy", Boolean(value));
  }

  /** Whether the button takes no clicks now; a command button adds its own reasons. */
  blocked() {
    return false;
  }

  #inactive() {
    return this.disabled || this.busy || this.blocked();
  }

  update() {
    const button = this.part("button");
    button.disabled = this.disabled || (!this.busy && this.blocked());
    button.setAttribute("aria-busy", String(this.busy));
    // A busy button keeps its focus, so it stays enabled but inert.
    button.setAttribute("aria-disabled", String(this.#inactive()));
    this.part("spinner").hidden = !this.busy;
  }
}

/** Commands running now from command buttons that wait for one another. */
const running = new Set();
const changes = new EventTarget();
const changed = () => changes.dispatchEvent(new Event("change"));

/**
 * `<omg-command-button command input variant concurrent quiet>`: runs one of
 * the plugin's commands, by its manifest id, when clicked. `input` is JSON,
 * or set the `input` property. While it runs, the button is busy and shows
 * the command's progress beside it, and other command buttons wait unless
 * they are `concurrent`. A failure shows beside it unless it is `quiet`,
 * and is its `error` attribute until the next run, so a page that draws the
 * button again can pass it on.
 *
 * Events: `omg-command-start` (cancelable, before it runs),
 * `omg-command-result` with `detail.result`, and `omg-command-error` with
 * `detail.error`, cancelable to show the failure yourself.
 */
class OmgCommandButton extends OmgButton {
  static observedAttributes = [...OmgButton.observedAttributes, "command", "input", "concurrent", "quiet", "error"];
  static styles = [
    BUTTON,
    css(`
      :host { flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
      button { width: auto; }
      .progress { color: var(--color-text-secondary); }
      .error { color: var(--color-danger); white-space: pre-wrap; overflow-wrap: anywhere; }
    `),
  ];
  static template = `${OmgButton.template}<span class="progress" part="progress" role="status" hidden></span><span class="error" part="error" role="alert" hidden></span>`;

  #input;
  #running = false;
  #stopProgress;
  #onChange = () => this.update();

  constructor() {
    super();
    // Only the button runs the command, not its progress or error beside it.
    this.part("button").addEventListener("click", () => void this.run());
  }

  get input() {
    if (this.#input !== undefined) return this.#input;
    const value = this.getAttribute("input");
    return value === null ? undefined : JSON.parse(value);
  }

  set input(value) {
    this.#input = value;
  }

  connectedCallback() {
    changes.addEventListener("change", this.#onChange);
    super.connectedCallback();
  }

  disconnectedCallback() {
    changes.removeEventListener("change", this.#onChange);
  }

  blocked() {
    return !this.hasAttribute("concurrent") && !this.#running && [...running].some((button) => button !== this);
  }

  /** Runs the command, as a click does; resolves to its result, or undefined when it didn't run or failed. */
  async run() {
    const command = this.getAttribute("command");
    if (!command || this.#running || this.disabled || this.busy || this.blocked()) return undefined;
    let input;
    try {
      input = this.input;
    } catch {
      this.#fail(new Error(`The input of command button "${command}" isn't JSON`));
      return undefined;
    }
    const start = new CustomEvent("omg-command-start", { bubbles: true, composed: true, cancelable: true, detail: { command, input } });
    if (!this.dispatchEvent(start)) return undefined;
    // Taken before anything waits, so a second click can't start another run.
    this.#running = true;
    if (!this.hasAttribute("concurrent")) running.add(this);
    this.busy = true;
    this.removeAttribute("error");
    changed();
    try {
      const host = await connection;
      this.#stopProgress = host.on("progress", (value) => {
        if (value.command === command) text(this.part("progress"), value.message);
      });
      const result = await host.request("command.run", input === undefined ? { command } : { command, input });
      this.dispatchEvent(new CustomEvent("omg-command-result", { bubbles: true, composed: true, detail: { command, result } }));
      return result;
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    } finally {
      this.#stopProgress?.();
      this.#stopProgress = undefined;
      this.#running = false;
      running.delete(this);
      this.busy = false;
      text(this.part("progress"), "");
      changed();
    }
  }

  update() {
    super.update();
    text(this.part("error"), this.getAttribute("error"));
  }

  #fail(error) {
    const command = this.getAttribute("command");
    const event = new CustomEvent("omg-command-error", { bubbles: true, composed: true, cancelable: true, detail: { command, error: error.message } });
    if (this.dispatchEvent(event) && !this.hasAttribute("quiet")) this.setAttribute("error", error.message);
  }
}

/**
 * `<omg-select label value disabled>` with `<option>` children: the app's
 * select. `label` is shown above it; without one, give it `aria-label`. It
 * fires `change` and `input` as a native select does.
 */
class OmgSelect extends OmgElement {
  static observedAttributes = ["label", "value", "disabled", "aria-label"];
  static delegatesFocus = true;
  static styles = [
    css(`
      :host { display: inline-flex; flex-direction: column; gap: var(--space-1); min-width: 160px; max-width: 100%; }
      .label { color: var(--color-text-secondary); font-size: var(--text-sm); }
      select {
        width: 100%; height: 32px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-md);
        background: var(--color-stage); color: var(--color-text); font: inherit;
        box-shadow: inset 0 0 0 1px var(--color-border); transition: box-shadow var(--duration-fast);
      }
      select:not(:disabled):hover { box-shadow: inset 0 0 0 1px var(--color-border-strong); }
      select:focus { box-shadow: inset 0 0 0 1px var(--color-text-tertiary); }
      select:disabled { opacity: 0.4; }
    `),
  ];
  static template = `<label part="field"><span class="label" part="label"></span><select part="select"></select></label>`;

  // Options added, removed or changed; the select's own attributes aren't options.
  #observer = new MutationObserver((records) => {
    if (records.some((record) => record.type !== "attributes" || record.target !== this)) this.#copyOptions();
  });

  constructor() {
    super();
    const select = this.part("select");
    // `input` crosses the shadow boundary by itself; `change` doesn't.
    select.addEventListener("input", () => this.setAttribute("value", select.value));
    select.addEventListener("change", () => {
      this.setAttribute("value", select.value);
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  get value() {
    return this.part("select").value;
  }

  set value(value) {
    this.setAttribute("value", String(value ?? ""));
  }

  connectedCallback() {
    this.#observer.observe(this, { childList: true, subtree: true, attributes: true, characterData: true });
    this.#copyOptions();
    super.connectedCallback();
  }

  disconnectedCallback() {
    this.#observer.disconnect();
  }

  /**
   * The page's options, copied into the select. The `value` attribute
   * chooses, and a choice sets it; without one, the option marked
   * `selected` is chosen, as in a native select. A parser may add the
   * options one at a time.
   */
  #copyOptions() {
    const select = this.part("select");
    const sources = [...this.querySelectorAll("option")];
    select.replaceChildren(
      ...sources.map((source) => {
        const option = document.createElement("option");
        option.value = source.value;
        option.textContent = source.textContent;
        option.disabled = source.disabled;
        return option;
      }),
    );
    const chosen = this.getAttribute("value") ?? sources.find((source) => source.hasAttribute("selected"))?.value;
    if (chosen !== undefined) select.value = chosen;
  }

  update() {
    const select = this.part("select");
    text(this.part("label"), this.getAttribute("label"));
    const name = this.getAttribute("aria-label");
    if (name) select.setAttribute("aria-label", name);
    else select.removeAttribute("aria-label");
    select.disabled = this.hasAttribute("disabled");
    // As a native select: a value no option has leaves nothing chosen.
    const value = this.getAttribute("value");
    if (value !== null && select.value !== value) select.value = value;
  }
}

define("omg-button", OmgButton);
define("omg-command-button", OmgCommandButton);
define("omg-select", OmgSelect);
