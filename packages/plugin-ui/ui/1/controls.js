// Controls: buttons, command buttons, and collapsible content.
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
    background: var(--_button-background, var(--color-hover)); color: var(--color-text);
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
 *
 * @attr {"secondary" | "primary" | "ghost" | "danger"} variant - Secondary by default.
 * @attr {boolean} disabled - Takes no clicks.
 * @attr {boolean} busy - Shows a spinner and takes no clicks.
 * @prop {boolean} disabled - The `disabled` attribute.
 * @prop {boolean} busy - The `busy` attribute.
 * @slot - The label.
 * @part button - The button.
 * @part spinner - The spinner shown while busy.
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

/**
 * `<omg-disclosure heading open disabled>`: a plain title row with a leading
 * arrow that shows or hides content. Closing keeps the content mounted and
 * returns focus to the button when focus was inside. Enter and Space use the
 * button's native activation.
 *
 * @attr {string} heading - The button's label.
 * @attr {boolean} open - Shows the content; closed by default.
 * @attr {boolean} disabled - Disables the button, without changing the content's state.
 * @prop {boolean} open - The `open` attribute; setting it does not emit an event.
 * @prop {boolean} disabled - The `disabled` attribute.
 * @fires {{ open: boolean }} omg-toggle - The person opened or closed the content; bubbles across shadow roots.
 * @slot - The content, retained while closed.
 * @part button - The toggle button.
 * @part heading - The button's label.
 * @part icon - The expansion arrow.
 * @part body - The content, hidden while closed.
 */
class OmgDisclosure extends OmgElement {
  static observedAttributes = ["heading", "open", "disabled"];
  static delegatesFocus = true;
  static styles = [
    css(`
      :host { display: block; min-width: 0; }
      button {
        display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: 30px;
        padding: var(--space-1) 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text);
        font: inherit; font-weight: var(--weight-medium); text-align: start; cursor: pointer;
        transition: background var(--duration-fast);
      }
      button:not(:disabled):hover { background: color-mix(in srgb, var(--color-hover) 60%, transparent); }
      button:disabled { opacity: 0.4; cursor: default; }
      .heading { min-width: 0; overflow-wrap: anywhere; }
      .icon { width: 14px; height: 14px; flex: none; color: var(--color-text-secondary); transform: rotate(-90deg); transition: transform var(--duration-fast); }
      :host([open]) .icon { transform: rotate(0deg); }
      .body { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; padding-top: var(--space-2); padding-inline-start: calc(14px + var(--space-2)); }
    `),
  ];
  static template = `
    <button part="button" type="button" aria-expanded="false" aria-controls="body">
      <svg class="icon" part="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      <span class="heading" part="heading"></span>
    </button>
    <div id="body" class="body" part="body" hidden><slot></slot></div>`;

  constructor() {
    super();
    this.part("button").addEventListener("click", () => {
      if (this.disabled) return;
      this.open = !this.open;
      this.dispatchEvent(new CustomEvent("omg-toggle", { bubbles: true, composed: true, detail: { open: this.open } }));
    });
  }

  get open() {
    return this.hasAttribute("open");
  }

  set open(value) {
    this.toggleAttribute("open", Boolean(value));
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(value) {
    this.toggleAttribute("disabled", Boolean(value));
  }

  update() {
    const button = this.part("button");
    const body = this.part("body");
    const active = this.getRootNode().activeElement;
    if (!this.open && !body.hidden && active !== this && this.contains(active)) button.focus();
    text(this.part("heading"), this.getAttribute("heading"));
    button.disabled = this.disabled;
    button.setAttribute("aria-expanded", String(this.open));
    body.hidden = !this.open;
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
 *
 * @attr {string} command - The command's id in the manifest.
 * @attr {string} input - The command's input, as JSON.
 * @attr {boolean} concurrent - Runs while other command buttons run, and doesn't make them wait.
 * @attr {boolean} quiet - Doesn't show a failure beside it.
 * @attr {string} error - The last run's failure, until the next run.
 * @prop {unknown} input - The command's input; it takes the place of the attribute.
 * @method {Promise<unknown>} run - Runs the command, as a click does; resolves to its result, or undefined when it didn't run or failed.
 * @fires {{ command: string; input: unknown }} omg-command-start - Before it runs; cancel it to not run.
 * @fires {{ command: string; result: unknown }} omg-command-result - The command's result.
 * @fires {{ command: string; error: string }} omg-command-error - The command failed; cancel it to show the failure yourself.
 * @part progress - The command's progress while it runs.
 * @part error - The failure.
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
      this.#fail(command, new Error(`The input of command button "${command}" isn't JSON`));
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
      this.#fail(command, error instanceof Error ? error : new Error(String(error)));
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

  /** Reports a failure of the run of `command`, whatever the attribute says now. */
  #fail(command, error) {
    const event = new CustomEvent("omg-command-error", { bubbles: true, composed: true, cancelable: true, detail: { command, error: error.message } });
    if (this.dispatchEvent(event) && !this.hasAttribute("quiet")) this.setAttribute("error", error.message);
  }
}

define("omg-button", OmgButton);
define("omg-disclosure", OmgDisclosure);
define("omg-command-button", OmgCommandButton);
