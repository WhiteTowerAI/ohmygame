// Feedback: a status line, a banner, a log and a list of steps.
import { OmgElement, css, define, filled, text } from "./base.js";

const TONES = css(`
  :host { --tone: var(--color-border-strong); }
  :host([tone="good"]) { --tone: var(--color-success); }
  :host([tone="warning"]) { --tone: var(--color-warning); }
  :host([tone="bad"]) { --tone: var(--color-danger); }
  /* The plugin's brand colour marks progress only; information is the app's accent. */
  :host([tone="info"]) { --tone: var(--color-accent); }
  :host([tone="busy"]) { --tone: var(--omg-accent, var(--color-accent)); }
`);

/** Gives an element a live-region role unless the page chose one. */
function announce(element, role) {
  if (!element.hasAttribute("role") || element.dataset.omgRole === element.getAttribute("role")) {
    element.setAttribute("role", role);
    element.dataset.omgRole = role;
  }
}

/**
 * `<omg-status tone="neutral|good|warning|bad|busy">`: a short state, such as
 * "Running", after a coloured dot, or a spinner while busy. It is a live
 * region, so a change is read out.
 *
 * @attr {"neutral" | "good" | "warning" | "bad" | "busy"} tone - Neutral by default.
 * @slot - The state, in a few words.
 * @part indicator - The dot.
 * @part spinner - The spinner shown while busy.
 * @part label - The state.
 * @cssprop --omg-accent - The plugin's brand colour, for the busy spinner.
 */
class OmgStatus extends OmgElement {
  static observedAttributes = ["tone"];
  static styles = [
    TONES,
    css(`
      :host { display: inline-flex; align-items: center; gap: var(--space-2); min-width: 0; }
      .dot { width: 8px; height: 8px; flex: none; border-radius: var(--radius-pill); background: var(--tone); }
      .spinner { color: var(--tone); }
    `),
  ];
  static template = `<span class="dot" part="indicator"></span><span class="spinner" part="spinner" hidden></span><span part="label"><slot></slot></span>`;

  update() {
    announce(this, "status");
    const busy = this.getAttribute("tone") === "busy";
    this.part("indicator").hidden = busy;
    this.part("spinner").hidden = !busy;
  }
}

/**
 * `<omg-banner tone="info|good|warning|bad" heading>`: a message across the
 * page, such as a failure and what to do about it. Slots: the message, and
 * `actions`. A `bad` banner is an alert; the others are a status.
 *
 * @attr {"info" | "good" | "warning" | "bad"} tone - Plain by default.
 * @attr {string} heading - A title above the message.
 * @slot - The message.
 * @slot actions - Buttons after the message.
 * @part heading - The title.
 * @part message - The message.
 * @part actions - The buttons' row; hidden when empty.
 */
class OmgBanner extends OmgElement {
  static observedAttributes = ["tone", "heading"];
  static styles = [
    TONES,
    css(`
      :host { --tone: var(--color-text-tertiary); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3);
        padding: var(--space-3); border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--tone) 12%, transparent); }
      .content { flex: 1 1 240px; min-width: 0; display: grid; gap: var(--space-1); overflow-wrap: anywhere; }
      .heading { margin: 0; font-weight: var(--weight-semibold); color: var(--tone); }
      :host(:not([tone])) .heading { color: var(--color-text); }
      .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
      /* A see-through button turns muddy on the banner's colour. */
      ::slotted(omg-button:not([variant])), ::slotted(omg-command-button:not([variant])) { --_button-background: var(--color-surface); }
    `),
  ];
  static template = `
    <div class="content"><p class="heading" part="heading"></p><div class="message" part="message"><slot></slot></div></div>
    <div class="actions" part="actions"><slot name="actions"></slot></div>`;

  constructor() {
    super();
    this.shadowRoot.addEventListener("slotchange", () => this.update());
  }

  update() {
    announce(this, this.getAttribute("tone") === "bad" ? "alert" : "status");
    text(this.part("heading"), this.getAttribute("heading"));
    this.part("actions").hidden = !filled(this.shadowRoot.querySelector('slot[name="actions"]'));
  }
}

/**
 * `<omg-log empty="No lines yet." follow>`: lines of output in the app's
 * monospace type, scrolling past `--omg-log-height` (280px). Its text is
 * its content, or set `text`. With `follow`, it keeps the latest line in
 * view unless the person scrolled up.
 *
 * @attr {string} empty - What it says with no lines.
 * @attr {boolean} follow - Keeps the latest line in view.
 * @prop {string} text - Its lines.
 * @slot - Its lines, as text.
 * @part log - The lines; hidden with none.
 * @part empty - The text shown with no lines.
 * @cssprop [--omg-log-height=280px] - How tall it grows before it scrolls.
 */
class OmgLog extends OmgElement {
  static observedAttributes = ["empty"];
  static styles = [
    css(`
      :host { display: block; }
      pre {
        margin: 0; max-height: var(--omg-log-height, 280px); overflow: auto; padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-md); background: var(--color-stage); box-shadow: inset 0 0 0 1px var(--color-border);
        font-family: var(--font-mono); font-size: var(--text-sm); line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere;
      }
      .empty { margin: 0; padding: var(--space-2) 0; color: var(--color-text-tertiary); }
    `),
  ];
  static template = `<pre part="log" tabindex="0"><slot></slot></pre><p class="empty" part="empty"></p>`;

  #observer = new MutationObserver(() => this.update());
  #atEnd = true;

  constructor() {
    super();
    const log = this.part("log");
    log.addEventListener("scroll", () => {
      this.#atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
    });
  }

  get text() {
    return this.textContent;
  }

  set text(value) {
    this.textContent = value ?? "";
  }

  connectedCallback() {
    this.#observer.observe(this, { childList: true, characterData: true, subtree: true });
    super.connectedCallback();
  }

  disconnectedCallback() {
    this.#observer.disconnect();
  }

  update() {
    const empty = !this.textContent;
    this.part("log").hidden = empty;
    text(this.part("empty"), empty ? this.getAttribute("empty") : "");
    if (!empty && this.hasAttribute("follow") && this.#atEnd) {
      const log = this.part("log");
      log.scrollTop = log.scrollHeight;
    }
  }
}

const CHECK = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * `<omg-steps>`: the steps of a flow, numbered in order. Each is an
 * `<omg-step heading state="pending|current|done|error" open>`; a current or
 * failed step shows its content, and `open` shows it in any state. Slots of
 * a step: `summary`, always shown under its heading, and its content.
 *
 * @slot - Its `omg-step` elements.
 */
class OmgSteps extends OmgElement {
  static styles = [css(`:host { display: flex; flex-direction: column; }`)];
  static template = `<slot></slot>`;

  constructor() {
    super();
    this.shadowRoot.addEventListener("slotchange", () => this.update());
  }

  update() {
    this.setAttribute("role", "list");
    const steps = [...this.children].filter((child) => child.localName === "omg-step");
    steps.forEach((step, index) => step.setAttribute("number", String(index + 1)));
  }
}

/**
 * `<omg-step heading state open>`: one step of an `omg-steps` flow.
 *
 * @attr {string} heading - What the step does.
 * @attr {"pending" | "current" | "done" | "error"} state - Pending by default.
 * @attr {boolean} open - Shows its content in any state.
 * @attr {string} number - Its place in the flow, which `omg-steps` sets.
 * @slot summary - Always shown under the heading, such as what a finished step did.
 * @slot - What the step shows while it is current or failed.
 * @part marker - The number, check or failure mark.
 * @part heading - The heading.
 * @part summary - The summary; hidden when empty.
 * @part body - The content.
 */
class OmgStep extends OmgElement {
  static observedAttributes = ["heading", "state", "open", "number"];
  static styles = [
    css(`
      :host { display: grid; grid-template-columns: 24px 1fr; column-gap: var(--space-3); }
      .marker {
        position: relative; display: flex; justify-content: center;
      }
      .badge {
        position: relative; z-index: 1; width: 24px; height: 24px; display: grid; place-items: center;
        border-radius: var(--radius-pill); box-shadow: inset 0 0 0 1px var(--color-border); color: var(--color-text-secondary);
        font-size: var(--text-xs); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums;
      }
      .marker::after {
        content: ""; position: absolute; top: 28px; bottom: 4px; width: 1px; background: var(--color-border);
      }
      :host(:last-of-type) .marker::after { display: none; }
      :host([state="current"]) .badge { background: var(--color-ink); box-shadow: none; color: var(--color-on-ink); }
      :host([state="done"]) .badge { background: color-mix(in srgb, var(--color-success) 16%, transparent); box-shadow: none; color: var(--color-success); }
      :host([state="error"]) .badge { background: color-mix(in srgb, var(--color-danger) 16%, transparent); box-shadow: none; color: var(--color-danger); }
      .content { min-width: 0; display: grid; gap: var(--space-1); padding-bottom: var(--space-6); }
      :host(:last-of-type) .content { padding-bottom: 0; }
      .heading { margin: 0; min-height: 24px; display: flex; align-items: center; font-weight: var(--weight-medium); }
      :host([state="pending"]) .heading, :host(:not([state])) .heading { color: var(--color-text-secondary); }
      .summary { color: var(--color-text-secondary); }
      .body { display: flex; flex-direction: column; gap: var(--space-3); padding-top: var(--space-2); }
    `),
  ];
  static template = `
    <div class="marker"><span class="badge" part="marker"></span></div>
    <div class="content">
      <p class="heading" part="heading"></p>
      <div class="summary" part="summary"><slot name="summary"></slot></div>
      <div class="body" part="body"><slot></slot></div>
    </div>`;

  constructor() {
    super();
    this.shadowRoot.addEventListener("slotchange", () => this.update());
  }

  update() {
    this.setAttribute("role", "listitem");
    const state = this.getAttribute("state") ?? "pending";
    if (state === "current") this.setAttribute("aria-current", "step");
    else this.removeAttribute("aria-current");
    const badge = this.part("marker");
    if (state === "done") badge.innerHTML = CHECK;
    else badge.textContent = state === "error" ? "!" : (this.getAttribute("number") ?? "");
    text(this.part("heading"), this.getAttribute("heading"));
    this.part("summary").hidden = !filled(this.shadowRoot.querySelector('slot[name="summary"]'));
    this.part("body").hidden = !(state === "current" || state === "error" || this.hasAttribute("open"));
  }
}

/**
 * `<omg-badge tone>`: a short label for what something is or how it stands.
 *
 * @attr {"neutral" | "info" | "good" | "warning" | "bad"} tone - Its colour; neutral by default.
 * @slot - The label.
 */
class OmgBadge extends OmgElement {
  static styles = [
    TONES,
    css(`
      :host {
        --tone: var(--color-text-secondary); display: inline-flex; align-items: center; height: 20px; padding: 0 7px; width: fit-content;
        border-radius: var(--radius-pill); background: color-mix(in srgb, var(--tone) 16%, transparent); color: var(--tone);
        font-size: var(--text-xs); font-weight: var(--weight-medium); white-space: nowrap;
      }
    `),
  ];
  static template = `<slot></slot>`;
}

/**
 * `<omg-progress value max label>`: how far something has got, or a moving bar
 * while nobody knows yet.
 *
 * @attr {number} value - How far it has got; without one, the bar just moves.
 * @attr {number} max - What finished means; 100 by default.
 * @attr {string} label - What is in progress, above the bar and for screen readers.
 * @part label - The label; hidden when empty.
 * @part track - The whole bar.
 * @part bar - The part that is done.
 */
class OmgProgress extends OmgElement {
  static observedAttributes = ["value", "max", "label"];
  static styles = [
    css(`
      :host { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
      .label { color: var(--color-text-secondary); font-size: var(--text-sm); }
      .track { height: 4px; overflow: hidden; border-radius: 2px; background: var(--color-border-strong); }
      .bar { height: 100%; border-radius: inherit; background: var(--color-ink); transition: width var(--duration-base) var(--ease-out); }
      @keyframes omg-progress { from { translate: -100%; } to { translate: 250%; } }
      .bar.moving { width: 40%; animation: omg-progress 1.4s ease-in-out infinite; }
    `),
  ];
  static template = `<span class="label" part="label"></span><div class="track" part="track" role="progressbar"><div class="bar" part="bar"></div></div>`;

  update() {
    const track = this.part("track");
    const bar = this.part("bar");
    const label = this.getAttribute("label");
    text(this.part("label"), label);
    if (label) track.setAttribute("aria-label", label);
    else track.removeAttribute("aria-label");
    const given = this.getAttribute("value");
    const value = given === null || given === "" ? NaN : Number(given);
    const max = Number(this.getAttribute("max")) > 0 ? Number(this.getAttribute("max")) : 100;
    const known = Number.isFinite(value);
    bar.classList.toggle("moving", !known);
    if (known) {
      const done = Math.min(Math.max(value, 0), max);
      bar.style.width = `${(done / max) * 100}%`;
      track.setAttribute("aria-valuenow", String(done));
      track.setAttribute("aria-valuemax", String(max));
    } else {
      bar.style.removeProperty("width");
      track.removeAttribute("aria-valuenow");
      track.removeAttribute("aria-valuemax");
    }
  }
}

define("omg-status", OmgStatus);
define("omg-banner", OmgBanner);
define("omg-log", OmgLog);
define("omg-steps", OmgSteps);
define("omg-step", OmgStep);
define("omg-badge", OmgBadge);
define("omg-progress", OmgProgress);
