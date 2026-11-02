// What every OhMyGame page component shares. Components draw in their own
// Shadow DOM from the app's tokens, which the bridge sets on the page's
// :root and which reach every shadow tree. A plugin customizes them only
// through their attributes, CSS custom properties and `::part()`.
//
// `--omg-accent` is the plugin's brand colour, the app's accent by default,
// and `--omg-on-accent` the text that goes on it.
// Components use it only for progress and links; buttons stay ink.

/** A stylesheet shared by every instance of a component. */
export function css(text) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  return sheet;
}

const BASE = css(`
  :host { box-sizing: border-box; }
  :host([hidden]) { display: none !important; }
  *, *::before, *::after { box-sizing: inherit; }
  [hidden] { display: none !important; }
  /* A paragraph placed in a component is spaced by the component, not by its margins. */
  ::slotted(p) { margin: 0; }
  :focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  @keyframes omg-spin { to { transform: rotate(360deg); } }
  .spinner {
    width: 12px; height: 12px; flex: none; border-radius: var(--radius-pill);
    border: 2px solid currentColor; border-right-color: transparent;
    animation: omg-spin 0.8s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition-duration: 1ms !important; animation-duration: 1ms !important; }
  }
`);

const warned = new Set();

/** Tells a plugin's author once, in the page's console. */
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[OhMyGame] ${message}`);
}

/** A component: its template is static HTML, and attributes fill it as text. */
export class OmgElement extends HTMLElement {
  /** @type {CSSStyleSheet[]} */
  static styles = [];
  static template = "";
  static delegatesFocus = false;
  /** What to use instead, when the component is deprecated; matches its `@deprecated` tag. */
  static deprecated = undefined;
  /** What to use instead of each deprecated attribute; matches its `@deprecated attr` tags. Each must be observed, to warn when a script sets it later. */
  static deprecatedAttributes = {};

  constructor() {
    super();
    const type = /** @type {typeof OmgElement} */ (this.constructor);
    const root = this.attachShadow({ mode: "open", delegatesFocus: type.delegatesFocus });
    root.adoptedStyleSheets = [BASE, ...type.styles];
    root.innerHTML = type.template;
  }

  /** The element of this component's shadow tree with the given part. */
  part(name) {
    return this.shadowRoot.querySelector(`[part~="${name}"]`);
  }

  connectedCallback() {
    const type = /** @type {typeof OmgElement} */ (this.constructor);
    if (type.deprecated) warnOnce(`<${this.localName}> is deprecated: ${type.deprecated}`);
    for (const name of Object.keys(type.deprecatedAttributes)) if (this.hasAttribute(name)) this.#warnAttribute(name);
    this.update();
  }

  attributeChangedCallback(name, _previous, value) {
    if (value !== null && Object.hasOwn(/** @type {typeof OmgElement} */ (this.constructor).deprecatedAttributes, name)) this.#warnAttribute(name);
    if (this.isConnected) this.update();
  }

  #warnAttribute(name) {
    const reason = /** @type {typeof OmgElement} */ (this.constructor).deprecatedAttributes[name];
    warnOnce(`<${this.localName}>'s ${name} is deprecated: ${reason}`);
  }

  /** Draws the component from its attributes. */
  update() {}
}

/** Sets an element's text, hiding it when there is none. */
export function text(element, value) {
  element.textContent = value ?? "";
  element.hidden = !value;
}

/** Whether a slot has elements or non-blank text assigned. */
export function filled(slot) {
  return slot
    .assignedNodes({ flatten: true })
    .some((node) => node.nodeType === Node.ELEMENT_NODE || node.textContent.trim());
}

/** Defines a component once, so a page may load the components twice. */
export function define(name, component) {
  if (!customElements.get(name)) customElements.define(name, component);
}
