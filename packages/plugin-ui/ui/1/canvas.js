// A canvas of cards joined by edges, drawn and handled as OhMyGame's own
// canvases are (src/renderer/editor-canvas.tsx and the Story canvas's styles):
// the same grid, cards, edges, tool bar and zoom controls, the same pan and
// pinch steps, and the same snapping and alignment guides (canvas-alignment.js,
// which the app's canvases import too). Keep the two in step.
import { OmgElement, css, define } from "./base.js";
import { findCanvasAlignmentGuides, snapCanvasPosition } from "./canvas-alignment.js";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
const ZOOM_STEP = 1.2;
const PAN_ON_SCROLL_SPEED = 0.5;
const GRID_GAP = 24;
const LABEL_HEIGHT = 28;
const NODE_WIDTH = 440;
const STAGE_HEIGHT = 248;
const DRAG_THRESHOLD = 3;
/** As the app's canvases: a port's press is a click until it moves this far, and an edge reaches a node whose entry is this close. */
const CONNECT_THRESHOLD = 4;
const CONNECTION_RADIUS = 28;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SVG = "http://www.w3.org/2000/svg";

// The app's canvas icons: Solar's line icons, and the hand it draws in their style (src/renderer/icons.ts).
const ICONS = {
  plus: '<path d="M4 12L20 12"/><path d="M12.0204 4L12.0205 20.0003"/>',
  minus: '<path d="M20 12L4 12"/>',
  pointer: '<path d="M16.5744 19.1999L12.6361 15.2616L11.4334 16.4643C10.2022 17.6955 9.58656 18.3111 8.92489 18.1658C8.26322 18.0204 7.96225 17.2035 7.3603 15.5696L5.3527 10.1205C4.15187 6.86106 3.55146 5.23136 4.39141 4.39141C5.23136 3.55146 6.86106 4.15187 10.1205 5.35271L15.5696 7.3603C17.2035 7.96225 18.0204 8.26322 18.1658 8.92489C18.3111 9.58656 17.6955 10.2022 16.4643 11.4334L15.2616 12.6361L19.1999 16.5744C19.6077 16.9821 19.8116 17.186 19.9058 17.4135C20.0314 17.7168 20.0314 18.0575 19.9058 18.3608C19.8116 18.5882 19.6077 18.7921 19.1999 19.1999C18.7921 19.6077 18.5882 19.8116 18.3608 19.9058C18.0575 20.0314 17.7168 20.0314 17.4135 19.9058C17.186 19.8116 16.9821 19.6077 16.5744 19.1999Z"/>',
  hand: '<path d="M19.5 12V8.25a1.75 1.75 0 0 0-3.5 0V11M16 8.25v-2a1.75 1.75 0 0 0-3.5 0V11M12.5 6.25V5a1.75 1.75 0 0 0-3.5 0v6M9 7.5a1.75 1.75 0 0 0-3.5 0V14l-1.3-1.3a1.6 1.6 0 0 0-2.3 2.3l3.4 3.4a6 6 0 0 0 4.2 1.8H14a5.5 5.5 0 0 0 5.5-5.5V12"/>',
  fit: '<path d="M9 15L2 22M2 16.1429V22H7.85714"/><path d="M15 9L22 2M22 7.85714V2H16.1429"/>',
  pen: '<path d="M14.3601 4.07866L15.2869 3.15178C16.8226 1.61607 19.3125 1.61607 20.8482 3.15178C22.3839 4.68748 22.3839 7.17735 20.8482 8.71306L19.9213 9.63993M14.3601 4.07866C14.3601 4.07866 14.4759 6.04828 16.2138 7.78618C17.9517 9.52407 19.9213 9.63993 19.9213 9.63993M19.9213 9.63993L11.4001 18.1612C10.8229 18.7383 10.5344 19.0269 10.2162 19.2751C9.84082 19.5679 9.43469 19.8189 9.00498 20.0237C8.6407 20.1973 8.25352 20.3263 7.47918 20.5844L4.19792 21.6782L3.39584 21.9456C3.01478 22.0726 2.59466 21.9734 2.31063 21.6894C2.0266 21.4053 1.92743 20.9852 2.05445 20.6042L2.32181 19.8021L3.41556 16.5208C3.67368 15.7465 3.80273 15.3593 3.97634 14.995C4.18114 14.5653 4.43213 14.1592 4.7249 13.7838C4.97308 13.4656 5.26166 13.1771 5.83882 12.5999L14.3601 4.07866M4.19792 21.6782L2.32181 19.8021"/>',
  copy: '<path d="M6 11C6 8.17157 6 6.75736 6.87868 5.87868C7.75736 5 9.17157 5 12 5H15C17.8284 5 19.2426 5 20.1213 5.87868C21 6.75736 21 8.17157 21 11V16C21 18.8284 21 20.2426 20.1213 21.1213C19.2426 22 17.8284 22 15 22H12C9.17157 22 7.75736 22 6.87868 21.1213C6 20.2426 6 18.8284 6 16V11Z"/><path d="M6 19C4.34315 19 3 17.6569 3 16V10C3 6.22876 3 4.34315 4.17157 3.17157C5.34315 2 7.22876 2 11 2H15C16.6569 2 18 3.34315 18 5"/>',
  trash: '<path d="M9.1709 4C9.58273 2.83481 10.694 2 12.0002 2C13.3064 2 14.4177 2.83481 14.8295 4"/><path d="M20.5001 6H3.5"/><path d="M18.8332 8.5L18.3732 15.3991C18.1962 18.054 18.1077 19.3815 17.2427 20.1907C16.3777 21 15.0473 21 12.3865 21H11.6132C8.95235 21 7.62195 21 6.75694 20.1907C5.89194 19.3815 5.80344 18.054 5.62644 15.3991L5.1665 8.5"/><path d="M9.5 11L10 16"/><path d="M14.5 11L14 16"/>',
  picture: '<path d="M2 12C2 7.28595 2 4.92893 3.46447 3.46447C4.92893 2 7.28595 2 12 2C16.714 2 19.0711 2 20.5355 3.46447C22 4.92893 22 7.28595 22 12C22 16.714 22 19.0711 20.5355 20.5355C19.0711 22 16.714 22 12 22C7.28595 22 4.92893 22 3.46447 20.5355C2 19.0711 2 16.714 2 12Z"/><circle cx="16" cy="8" r="2"/><path d="M2 12.5001L3.75159 10.9675C4.66286 10.1702 6.03628 10.2159 6.89249 11.0721L11.1822 15.3618C11.8694 16.0491 12.9512 16.1428 13.7464 15.5839L14.0446 15.3744C15.1888 14.5702 16.7369 14.6634 17.7765 15.599L21 18.5001"/>',
  text: '<path d="M12 7H10C9.05719 7 8.58579 7 8.29289 7.32544C8 7.65087 8 8.17466 8 9.22222V9.75M12 7H14C14.9428 7 15.4142 7 15.7071 7.32544C16 7.65087 16 8.17466 16 9.22222V9.75M12 7V17M9.5 17H15"/><path d="M2 12C2 7.28595 2 4.92893 3.46447 3.46447C4.92893 2 7.28595 2 12 2C16.714 2 19.0711 2 20.5355 3.46447C22 4.92893 22 7.28595 22 12C22 16.714 22 19.0711 20.5355 20.5355C19.0711 22 16.714 22 12 22C7.28595 22 4.92893 22 3.46447 20.5355C2 19.0711 2 16.714 2 12Z"/>',
  scissors: '<path d="M16.4013 20.5L6 2M22 19C22 20.6569 20.6569 22 19 22C17.3431 22 16 20.6569 16 19C16 17.3431 17.3431 16 19 16C20.6569 16 22 17.3431 22 19Z"/><path d="M7.59865 20.5L18 2M2 19C2 20.6569 3.34315 22 5 22C6.65685 22 8 20.6569 8 19C8 17.3431 6.65685 16 5 16C3.34315 16 2 17.3431 2 19Z"/>',
};
/** The icons a menu item may name, as the app's canvas menus show theirs. */
const MENU_ICONS = { add: "plus", copy: "copy", duplicate: "plus", delete: "trash", cut: "scissors", rename: "pen", picture: "picture", text: "text", fit: "fit" };
const icon = (name, size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** Watches the page's appearance, which the bridge sets on its root, for colours the tokens don't tell apart. */
function appearance() {
  return document.documentElement.dataset.appearance === "light" ? "light" : "dark";
}

/** A node's number attribute, or its default when missing or not a finite number. */
function numberAttribute(element, name, fallback) {
  const value = Number(element.getAttribute(name));
  return element.hasAttribute(name) && Number.isFinite(value) ? value : fallback;
}

/**
 * An edge leaving to the right and arriving from the left, as React Flow's
 * bezier edge bends: half the distance ahead, or a short loop back when the
 * target is behind the source.
 */
function bezier(sx, sy, tx, ty) {
  const offset = (distance) => (distance >= 0 ? 0.5 * distance : 0.25 * 25 * Math.sqrt(-distance));
  const c1x = sx + offset(tx - sx);
  const c2x = tx - offset(tx - sx);
  return {
    d: `M${sx},${sy} C${c1x},${sy} ${c2x},${ty} ${tx},${ty}`,
    mid: { x: sx * 0.125 + c1x * 0.375 + c2x * 0.375 + tx * 0.125, y: (sy + ty) / 2 },
  };
}

const NODE_STYLES = css(`
  :host {
    position: absolute; left: 0; top: 0; display: block;
    width: var(--omg-node-width, ${NODE_WIDTH}px);
    color: var(--color-text);
    font-family: var(--font-sans);
    -webkit-user-select: none; user-select: none;
  }
  .label {
    display: flex; height: ${LABEL_HEIGHT}px; align-items: center; gap: var(--space-2);
    padding: 0 2px; color: var(--color-text-secondary); font-size: 14px; font-weight: 400;
  }
  :host([selected]) .label { color: var(--color-text); }
  ::slotted([slot="icon"]) { flex-shrink: 0; width: 14px; height: 14px; }
  .heading { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :host([renamable]) .heading { cursor: text; }
  .title-input {
    min-width: 0; flex: 1; padding: 1px 3px; border: 1px solid var(--color-border-strong); border-radius: 3px; outline: 0;
    background: var(--color-surface); color: var(--color-text); font: inherit;
  }
  .badges { display: flex; flex: none; align-items: center; gap: 4px; }
  /* The pencil, shown while the node is hovered, as the app's node details button. */
  .rename {
    display: grid; flex: 0 0 22px; height: 22px; padding: 0; place-items: center; border: 0; border-radius: 4px;
    background: transparent; color: var(--color-text-secondary); opacity: 0; cursor: pointer;
  }
  :host(:not([renamable])) .rename, .label:has(.title-input) .rename { display: none; }
  :host(:hover) .rename, .rename:focus-visible { opacity: 1; }
  .rename:hover { background: var(--color-hover); }
  .rename:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
  .stage {
    position: relative; display: grid; height: var(--omg-stage-height, ${STAGE_HEIGHT}px);
    overflow: hidden; place-items: center;
    border: 1px solid var(--color-border); border-radius: var(--radius-lg);
    background: var(--omg-canvas-stage, var(--color-surface-raised));
    transition: border-color var(--duration-fast, 120ms), box-shadow var(--duration-fast, 120ms);
  }
  :host(:hover) .stage { border-color: var(--color-border-strong); }
  :host([selected]) .stage, :host([data-target]) .stage { border-color: var(--color-ink); box-shadow: 0 0 0 1px var(--color-ink); }
  .stage > slot::slotted(img), .stage > slot::slotted(video) { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
  .stage > slot::slotted(omg-image) { align-self: stretch; justify-self: stretch; height: 100%; --omg-image-radius: 0; pointer-events: none; }
  .stage > slot::slotted(:not(img, video, omg-image)) { max-width: 100%; padding: 16px; color: var(--color-text-secondary); font-size: 12px; }
  /* As the app's Scene card lays out its exits. */
  .exits { position: absolute; z-index: 2; right: 0; top: ${LABEL_HEIGHT}px; bottom: ${LABEL_HEIGHT}px; display: flex; width: 42%; flex-direction: column; justify-content: space-evenly; pointer-events: none; }
  .exit { position: relative; display: flex; min-width: 0; align-items: center; justify-content: flex-end; padding-right: 12px; }
  .exit-label, .exit-note {
    overflow: hidden; padding: 2px 7px; border-radius: 999px;
    background: color-mix(in srgb, var(--color-surface) 88%, transparent);
    box-shadow: 0 2px 5px rgb(0 0 0 / 5%);
    text-overflow: ellipsis; white-space: nowrap;
  }
  .exit-label { flex-shrink: 0; max-width: 60%; color: var(--color-text-secondary); font-size: 10px; font-weight: 500; }
  .exit-note { min-width: 0; margin-left: 4px; color: var(--color-text-tertiary); font-size: 9px; font-style: italic; }
  .exit.muted .exit-label { opacity: 0.55; }
  .exit-label.placeholder { color: var(--color-text-tertiary); }
  :host([renamable]) .exit-label { pointer-events: auto; cursor: text; }
  .exit-input {
    width: 60%; min-width: 0; padding: 1px 6px; border: 1px solid var(--color-border-strong); border-radius: 999px; outline: 0;
    background: var(--color-surface); color: var(--color-text); font: inherit; font-size: 10px; font-weight: 500; pointer-events: auto;
  }
  .handle {
    position: absolute; width: 9px; height: 9px; border: 2px solid var(--color-surface); border-radius: 100%;
    background: var(--color-text-tertiary); pointer-events: auto; cursor: crosshair;
  }
  .handle::after { content: ""; position: absolute; inset: -6px; border-radius: 100%; }
  .exit > .handle { top: 50%; right: 0; transform: translate(50%, -50%); }
  :host(:hover) .handle, :host([selected]) .handle { background: var(--color-ink); }
  .port {
    position: absolute; z-index: 5; top: calc(${LABEL_HEIGHT}px + var(--omg-stage-height, ${STAGE_HEIGHT}px) / 2);
    width: 16px; height: 16px; border-radius: 50%; transform: translate(-50%, -50%); cursor: crosshair;
    --size: var(--omg-canvas-port-size, 44px);
  }
  .port.in { left: 8px; --offset: calc(var(--size) / -2); }
  .port.out { left: calc(100% - 8px); --offset: calc(var(--size) / 2); }
  .port::before {
    content: ""; position: absolute; left: calc(50% + var(--offset)); top: 50%;
    width: var(--size); height: var(--size); transform: translate(-50%, -50%); border-radius: 50%;
  }
  .port-icon {
    position: absolute; left: calc(50% + var(--offset)); top: 50%; display: grid; place-items: center;
    width: calc(var(--size) / 2); height: calc(var(--size) / 2); translate: -50% -50%; scale: 0.6;
    border: 1px solid var(--color-border); border-radius: 50%; background: var(--color-surface-raised);
    color: var(--color-text-secondary); box-shadow: var(--shadow-float); opacity: 0; pointer-events: none;
    transition: opacity var(--duration-fast, 120ms), scale var(--duration-fast, 120ms), background-color var(--duration-fast, 120ms), color var(--duration-fast, 120ms);
  }
  .port-icon > svg { width: 64%; height: 64%; }
  :host(:hover) .port-icon, :host([data-only-selected]) .port-icon { opacity: 1; scale: 1; }
  .port:is(:hover, :active) .port-icon, :host([data-connecting]) .port.out .port-icon, :host([data-target]) .port.in .port-icon {
    opacity: 1; scale: 1.1; border-color: var(--color-ink); background: var(--color-ink); color: var(--color-on-ink);
  }
  @media (prefers-reduced-motion: reduce) { .port-icon { transition: none; } }
`);

/**
 * `<omg-canvas-node node-id x y heading>`: one card on an `<omg-canvas>`, drawn as
 * OhMyGame's Story canvas draws a Scene: its heading above a framed stage, and
 * its exits on the stage's right, each with the handle its edges leave from,
 * and the + ports either side that the app's canvas nodes have.
 * The canvas moves and selects it; the page sets `x` and `y` when the canvas
 * reports a move, and `heading` when the node reports a rename.
 *
 * @attr {string} node-id - The node's id, unique on its canvas; the canvas's events and edges name it by it.
 * @attr {number} x - Left edge, in canvas units.
 * @attr {number} y - Top edge, in canvas units.
 * @attr {string} heading - The title above the stage.
 * @attr {boolean} selected - Drawn selected; the canvas sets it as the selection changes.
 * @attr {boolean} renamable - The pencil beside the title, shown while the node is hovered, or a double-click on the title or an exit's label, edits it in place; Enter or leaving it saves, Escape cancels.
 * @attr {string} rename-label - The pencil's name; defaults to Rename.
 * @prop {Array<{ id: string; label: string; placeholder?: string; note?: string; muted?: boolean }>} exits - Where edges leave, top to bottom on the stage's right; `placeholder` shows, dimmed, while `label` is empty; `note` is a short line beside the label and `muted` dims it, such as for an exit that goes nowhere yet. Edges without an exit leave from the + port at the middle of its right side.
 * @fires {{ node: string; heading: string }} omg-rename - The person renamed the node; the new title, trimmed and not empty. Set `heading` to keep it.
 * @fires {{ node: string; exit: string; label: string }} omg-exit-rename - The person renamed an exit; the new label, trimmed, and empty when they cleared it. Set `exits` to keep it.
 * @slot - The stage's content, such as a picture or a few lines of text.
 * @slot icon - A 14px icon before the title, such as what kind of node it is, as the app's canvas nodes show theirs.
 * @slot badges - Small labels at the end of the heading row, such as `omg-badge`s.
 * @part heading - The title.
 * @part rename - The pencil that renames the node.
 * @part stage - The framed area under the title.
 * @part exits - The exits' column over the stage's right side.
 * @cssprop [--omg-node-width=440px] - The node's width.
 * @cssprop [--omg-stage-height=248px] - The stage's height.
 */
class OmgCanvasNode extends OmgElement {
  static observedAttributes = ["node-id", "x", "y", "heading", "selected", "renamable", "rename-label"];
  static styles = [NODE_STYLES];
  static template = `<div class="label"><slot name="icon"></slot><span class="heading" part="heading"></span><span class="badges"><slot name="badges"></slot></span><button type="button" class="rename" part="rename">${icon("pen", 12)}</button></div><div class="stage" part="stage"><slot></slot></div><span class="port in" data-port="in" aria-hidden="true"><span class="port-icon">${icon("plus", 14)}</span></span><div class="exits" part="exits"></div><span class="port out" data-port="out" data-exit="" aria-hidden="true"><span class="port-icon">${icon("plus", 14)}</span></span>`;

  #exits = [];

  constructor() {
    super();
    const heading = this.part("heading");
    const rename = () => {
      if (!this.hasAttribute("renamable") || heading.hidden) return;
      this.#edit(heading, "title-input", this.getAttribute("heading") ?? "", (value) => {
        if (value && value !== (this.getAttribute("heading") ?? "")) this.#fire("omg-rename", { node: this.nodeId, heading: value });
      });
    };
    heading.addEventListener("dblclick", (event) => {
      if (!this.hasAttribute("renamable")) return;
      event.stopPropagation();
      rename();
    });
    const pencil = this.part("rename");
    pencil.addEventListener("pointerdown", (event) => event.stopPropagation());
    pencil.addEventListener("dblclick", (event) => event.stopPropagation());
    pencil.addEventListener("click", (event) => {
      event.stopPropagation();
      rename();
    });
    this.part("exits").addEventListener("dblclick", (event) => {
      const label = event.target instanceof Element ? event.target.closest(".exit-label") : null;
      if (!label || !this.hasAttribute("renamable")) return;
      event.stopPropagation();
      const exit = this.#exits.find((item) => item.id === label.dataset.exit);
      if (!exit) return;
      this.#edit(label, "exit-input", exit.label ?? "", (value) => {
        if (value !== (exit.label ?? "")) this.#fire("omg-exit-rename", { node: this.nodeId, exit: exit.id, label: value });
      });
    });
  }

  /**
   * Edits a piece of text in place, as the app's Scene card renames its title:
   * an input takes its place until Enter or leaving it saves, or Escape cancels.
   */
  #edit(shown, kind, value, save) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = kind;
    input.maxLength = 120;
    input.value = value;
    input.setAttribute("aria-label", value || shown.textContent);
    // While editing, the input's pointer and keys are its own, not the canvas's.
    for (const type of ["pointerdown", "dblclick", "keyup", "contextmenu"]) input.addEventListener(type, (event) => event.stopPropagation());
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      input.remove();
      shown.hidden = false;
      if (keep) save(input.value.trim());
      this.closest("omg-canvas")?.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    shown.hidden = true;
    shown.after(input);
    input.focus();
    input.select();
  }

  #fire(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
  }

  get exits() {
    return this.#exits;
  }

  set exits(value) {
    this.#exits = Array.isArray(value) ? value.filter((exit) => exit && typeof exit.id === "string") : [];
    this.#drawExits();
    this.#changed();
  }

  get nodeId() {
    return this.getAttribute("node-id") ?? "";
  }

  /** Where the node sits, in canvas units. */
  get position() {
    return { x: numberAttribute(this, "x", 0), y: numberAttribute(this, "y", 0) };
  }

  /** Its size in canvas units, from what it draws. */
  get size() {
    return { width: this.offsetWidth || NODE_WIDTH, stage: this.part("stage").offsetHeight || STAGE_HEIGHT };
  }

  /** Where an edge leaves from an exit, or from the right side's middle; relative to the node, in canvas units. */
  exitPoint(exit) {
    const { width, stage } = this.size;
    const index = exit ? this.#exits.findIndex((item) => item.id === exit) : -1;
    const row = index >= 0 ? this.part("exits").children[index] : undefined;
    // Where the exits' column put the row; the stage's middle until it is laid out.
    if (row?.offsetHeight) return { x: width, y: this.part("exits").offsetTop + row.offsetTop + row.offsetHeight / 2 };
    return { x: width, y: LABEL_HEIGHT + stage / 2 };
  }

  /** Where edges arrive, relative to the node. */
  entryPoint() {
    return { x: 0, y: LABEL_HEIGHT + this.size.stage / 2 };
  }

  update() {
    this.part("heading").textContent = this.getAttribute("heading") ?? "";
    const rename = this.getAttribute("rename-label") || "Rename";
    this.part("rename").title = rename;
    this.part("rename").setAttribute("aria-label", rename);
    const { x, y } = this.position;
    this.style.transform = `translate(${x}px, ${y}px)`;
    this.#changed();
  }

  #drawExits() {
    const column = this.part("exits");
    column.replaceChildren(...this.#exits.map((exit) => {
      const row = document.createElement("div");
      row.className = `exit${exit.muted ? " muted" : ""}`;
      const label = document.createElement("span");
      const text = exit.label || exit.placeholder || "";
      label.className = `exit-label${exit.label ? "" : " placeholder"}`;
      label.dataset.exit = exit.id;
      label.textContent = label.title = text;
      row.append(label);
      if (exit.note) {
        const note = document.createElement("span");
        note.className = "exit-note";
        note.textContent = note.title = exit.note;
        row.append(note);
      }
      const handle = document.createElement("span");
      handle.className = "handle";
      handle.dataset.exit = exit.id;
      handle.setAttribute("aria-hidden", "true");
      row.append(handle);
      return row;
    }));
  }

  /** Tells its canvas to draw its edges again. */
  #changed() {
    this.dispatchEvent(new Event("omg-canvas-node-change", { bubbles: true }));
  }
}

const CANVAS_STYLES = css(`
  :host {
    position: relative; display: block; min-height: 200px; overflow: hidden; outline: none;
    background: var(--color-stage); color: var(--color-text); font-family: var(--font-sans);
    -webkit-user-select: none; user-select: none; touch-action: none;
    --omg-canvas-stage: var(--color-surface-raised);
  }
  :host([data-appearance="light"]) { --omg-canvas-stage: var(--color-surface); }
  .grid { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .pane { position: absolute; inset: 0; cursor: default; }
  :host([data-panning]) .pane, :host([data-panning]) ::slotted(omg-canvas-node) { cursor: grab; }
  :host([data-gesture="pan"]) .pane, :host([data-gesture="pan"]) ::slotted(omg-canvas-node),
  :host([data-gesture="drag"]) .pane, :host([data-gesture="drag"]) ::slotted(omg-canvas-node) { cursor: grabbing; }
  :host([data-gesture="connect"]) .pane, :host([data-gesture="connect"]) ::slotted(omg-canvas-node) { cursor: crosshair; }
  .world { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
  :host(:not([data-ready])) .world { visibility: hidden; }
  .world.animate { transition: transform 200ms var(--ease-out, ease-out); }
  .edges { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; pointer-events: none; }
  .edge-path { fill: none; stroke: var(--omg-edge-color, var(--color-text-tertiary)); stroke-width: 1.5; }
  .edge.dashed .edge-path { stroke-dasharray: 6 5; }
  .edge:is(.selected, .hover) .edge-path { stroke: var(--color-ink); stroke-width: 2; }
  .edge-hit { fill: none; stroke: transparent; stroke-width: 24; pointer-events: stroke; cursor: pointer; }
  .cut {
    position: absolute; left: 0; top: 0; display: grid; width: 28px; height: 28px; padding: 0; place-items: center;
    border: 1px solid var(--color-border); border-radius: 50%; background: var(--color-surface-raised);
    color: var(--color-text-secondary); box-shadow: var(--shadow-float); cursor: pointer; pointer-events: auto;
  }
  .cut:is(:hover, :focus-visible) { border-color: var(--color-danger); color: var(--color-danger); }
  .cut:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .draft { fill: none; stroke: var(--omg-edge-color, var(--color-text-tertiary)); stroke-width: 1.5; }
  :host([data-panning]) .edge-hit { pointer-events: none; }
  .edge-labels { position: absolute; left: 0; top: 0; }
  .edge-label {
    position: absolute; left: 0; top: 0; padding: 2px 6px; border-radius: 4px;
    background: var(--color-surface-raised); color: var(--color-text-secondary);
    font-size: 10px; font-weight: 500; white-space: nowrap; pointer-events: none;
  }
  .guides { position: absolute; left: 0; top: 0; pointer-events: none; }
  .guide { position: absolute; z-index: 20; background-color: transparent; }
  .guide.vertical { background-image: repeating-linear-gradient(to bottom, var(--color-ink) 0 4px, transparent 4px 8px); }
  .guide.horizontal { background-image: repeating-linear-gradient(to right, var(--color-ink) 0 4px, transparent 4px 8px); }
  .marquee {
    position: absolute; z-index: 5; pointer-events: none;
    border: 1px dotted var(--color-ink); background: color-mix(in srgb, var(--color-ink) 8%, transparent);
  }
  /* 15px from the edges: React Flow's panel margin, which the app's canvases show (its stylesheet loads after the app's 12px). */
  .float {
    position: absolute; z-index: 6; display: flex; align-items: center; gap: 2px; padding: 4px; user-select: none;
    border-radius: 12px; background: var(--color-surface-raised); box-shadow: var(--shadow-float);
  }
  .zoom { left: 15px; bottom: 15px; }
  .toolbar { left: 50%; bottom: 15px; transform: translateX(-50%); }
  .float button, .toolbar ::slotted(button) {
    position: relative; display: grid; width: 30px; height: 30px; place-items: center; padding: 0;
    border: 0; border-radius: var(--radius-md); background: transparent; color: var(--color-text-secondary);
    font: inherit; cursor: pointer; transition: background var(--duration-fast, 120ms), color var(--duration-fast, 120ms);
  }
  .float button:hover, .toolbar ::slotted(button:hover) { background: var(--color-hover); color: var(--color-text); }
  .float button.active { background: var(--color-selected, var(--color-hover)); color: var(--color-text); }
  .float button:focus-visible, .toolbar ::slotted(button:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: -2px; }
  .zoom .value { width: auto; min-width: 44px; padding: 0 4px; font-family: var(--font-mono); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .toolbar [data-tooltip]::after {
    position: absolute; z-index: 100; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
    width: max-content; padding: 6px 8px; border: 1px solid var(--color-border); border-radius: 5px;
    background: var(--color-surface-raised); color: var(--color-text); box-shadow: 0 3px 12px rgb(0 0 0 / 12%);
    font-size: 11px; line-height: 1.4; white-space: nowrap; pointer-events: none;
    visibility: hidden; opacity: 0; content: attr(data-tooltip);
  }
  .toolbar [data-tooltip]:is(:hover, :focus-visible)::after { visibility: visible; opacity: 1; }
  .menu {
    position: absolute; z-index: 30; width: 196px; padding: 4px;
    border: 1px solid var(--color-border); border-radius: 7px;
    background: var(--color-surface-raised); box-shadow: 0 2px 5px rgb(0 0 0 / 5%); outline: 0;
  }
  .menu button {
    display: grid; width: 100%; min-height: 34px; grid-template-columns: 18px minmax(0, 1fr) minmax(14px, auto); align-items: center; gap: 7px;
    padding: 0 8px; border: 0; border-radius: 5px;
    background: transparent; color: var(--color-text-secondary); font: inherit; font-size: 11px; text-align: left; cursor: pointer;
  }
  .menu button > svg { justify-self: center; }
  .menu button > span { grid-column: 2; overflow: hidden; color: inherit; text-overflow: ellipsis; white-space: nowrap; }
  .menu button > kbd { grid-column: 3; color: var(--color-text-tertiary); font: inherit; font-size: 10px; }
  .menu [role="separator"] { height: 1px; margin: 4px 6px; background: var(--color-border); }
  .menu button:hover:not(:disabled), .menu button:focus-visible { outline: 0; background: var(--color-hover); color: var(--color-text); }
  .menu button:disabled { cursor: default; opacity: 0.38; }
  .menu button.danger:not(:disabled) { color: var(--color-danger); }
  .menu button.danger:hover:not(:disabled), .menu button.danger:focus-visible { background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
`);

const LABELS = {
  "select-label": "Select",
  "pan-label": "Hand",
  "fit-label": "Fit to screen",
  "zoom-in-label": "Zoom in",
  "zoom-out-label": "Zoom out",
  "zoom-reset-label": "Zoom to 100%",
  "cut-label": "Disconnect",
};

/**
 * `<omg-canvas>`: cards joined by edges on a canvas that works as OhMyGame's
 * own: pan and zoom, a pointer and a hand tool (V and H; Space pans while
 * held), snapping to the grid and alignment guides while dragging, marquee
 * and Shift selection, and the zoom controls and tool bar. It changes nothing
 * itself: it reports what the person did, and the page sets the nodes' `x`
 * and `y` and the `edges`.
 *
 * @attr {string} label - The canvas's accessible name.
 * @attr {string} select-label - The pointer tool's name; defaults to Select.
 * @attr {string} pan-label - The hand tool's name; defaults to Hand.
 * @attr {string} fit-label - The fit button's name; defaults to Fit to screen.
 * @attr {string} zoom-in-label - Defaults to Zoom in.
 * @attr {string} zoom-out-label - Defaults to Zoom out.
 * @attr {string} zoom-reset-label - The zoom level's name, which goes back to 100%; defaults to Zoom to 100%.
 * @attr {string} cut-label - The scissors' name, which removes an edge; defaults to Disconnect.
 * @prop {Array<{ id: string; from: string; exit?: string; to: string; dashed?: boolean; label?: string }>} edges - Edges from one node's exit, or its right side, to another node; `dashed` draws it dashed and `label` names it at its middle.
 * @prop {{ nodes: string[]; edges: string[] }} selection - The selected nodes' and edges' ids; setting it is silent.
 * @prop {{ x: number; y: number; zoom: number }} viewport - The view: the canvas's origin on screen, and the zoom; setting it is silent.
 * @method {void} fit - Shows every node, at most at 100%.
 * @fires {{ nodes: Array<{ node: string; x: number; y: number }> }} omg-move - The person dropped dragged nodes; where, snapped to the grid. Set their `x` and `y` to keep them there.
 * @fires {{ nodes: Array<{ node: string; x: number; y: number }> }} omg-duplicate - ⌘D with nodes selected, each 40 units down and right, or an Option-drag, where they were dropped; the nodes stay put. Add copies there to keep them.
 * @fires {{ nodes: string[]; edges: string[] }} omg-copy - ⌘C with nodes selected: keep what they hold for a paste.
 * @fires {{ x: number; y: number }} omg-paste - ⌘V: where, under the pointer or in the middle of the view, snapped to the grid.
 * @fires {{}} omg-undo - ⌘Z. The canvas keeps no history; the page undoes its own last change.
 * @fires {{}} omg-redo - ⇧⌘Z, or Ctrl+Y.
 * @fires {{ from: string; exit?: string; to: string }} omg-connect - The person drew an edge from a node's exit, or its right side, to another node.
 * @fires {{ nodes: string[]; edges: string[] }} omg-selection-change - The person changed the selection.
 * @fires {{ nodes: string[]; edges: string[] }} omg-delete - Delete or Backspace with something selected, or the scissors on a hovered or selected edge.
 * @fires {{ x: number; y: number; from?: string; to?: string }} omg-add - A double-click on empty canvas, or a click on a node's + port: where, in canvas units, snapped to the grid; from a port, `from` names the node it would follow (its right port) or `to` the node it would lead to (its left one), to join them.
 * @fires {{ node?: string; edge?: string; x: number; y: number; items: Array<{ value: string; label: string; icon?: string; shortcut?: string; separator?: boolean; disabled?: boolean; danger?: boolean }> }} omg-context-menu - A right-click on a node, an edge or empty canvas, which it selects first. Push items onto `items` while handling it to show them in a menu there: `icon` is one of add, copy, duplicate, delete, cut, rename, picture, text or fit; `shortcut` is shown at the end, such as "⌘D"; `separator` draws a line above the item to start a group.
 * @fires {{ value: string; node?: string; edge?: string; x: number; y: number }} omg-menu-select - The person picked an item of that menu.
 * @fires {{ x: number; y: number; zoom: number }} omg-viewport-change - The person moved or zoomed the view.
 * @slot - The `omg-canvas-node`s.
 * @slot tools - Buttons at the start of the tool bar, such as one that adds a node; each a `<button>` with an icon and an `aria-label`.
 * @part toolbar - The tool bar at the bottom centre.
 * @part zoom - The zoom controls at the bottom left.
 * @part menu - The right-click menu.
 * @cssprop [--omg-edge-color=var(--color-text-tertiary)] - The edges' colour.
 */
class OmgCanvas extends OmgElement {
  static observedAttributes = ["label", ...Object.keys(LABELS)];
  static styles = [CANVAS_STYLES];
  static template = `<svg class="grid" aria-hidden="true"><defs><pattern id="dots" patternUnits="userSpaceOnUse"><circle fill="var(--color-grid-dot, #333)"></circle></pattern></defs><rect width="100%" height="100%" fill="url(#dots)"></rect></svg><div class="pane"></div><div class="world"><svg class="edges"><defs><marker id="arrow" viewBox="-10 -10 20 20" refX="0" refY="0" markerWidth="12" markerHeight="12" markerUnits="strokeWidth" orient="auto-start-reverse"><polyline points="-5,-4 0,0 -5,4 -5,-4" stroke-linecap="round" stroke-linejoin="round" stroke-width="1"></polyline></marker><marker id="arrow-selected" viewBox="-10 -10 20 20" refX="0" refY="0" markerWidth="12" markerHeight="12" markerUnits="strokeWidth" orient="auto-start-reverse"><polyline points="-5,-4 0,0 -5,4 -5,-4" stroke-linecap="round" stroke-linejoin="round" stroke-width="1"></polyline></marker></defs><g class="edge-group"></g><path class="draft"></path></svg><div class="edge-labels"></div><slot></slot><div class="guides"></div></div><div class="marquee" hidden></div><div class="float zoom" part="zoom"><button type="button" data-action="zoom-out">${icon("minus", 14)}</button><button type="button" class="value" data-action="zoom-reset">100%</button><button type="button" data-action="zoom-in">${icon("plus", 14)}</button></div><div class="float toolbar" part="toolbar"><slot name="tools"></slot><button type="button" data-action="select" class="active">${icon("pointer", 18)}</button><button type="button" data-action="pan">${icon("hand", 18)}</button><button type="button" data-action="fit">${icon("fit", 18)}</button></div><div class="menu" part="menu" role="menu" tabindex="-1" hidden></div>`;

  #edges = [];
  #view = { x: 0, y: 0, zoom: 1 };
  #selectedNodes = new Set();
  #selectedEdges = new Set();
  #mode = "select";
  #space = false;
  #gesture;
  #guides;
  #menuTarget;
  #drawQueued = false;
  /** The edge under the pointer, and whether it has been there long enough to show its scissors. */
  #hover = { edge: undefined, ready: false, readyTimer: undefined, leaveTimer: undefined };
  #fitted = false;
  #appearance;
  #resize;

  constructor() {
    super();
    for (const marker of this.shadowRoot.querySelectorAll("marker")) {
      const color = marker.id === "arrow" ? "var(--omg-edge-color, var(--color-text-tertiary))" : "var(--color-ink)";
      marker.firstElementChild.setAttribute("stroke", color);
      marker.firstElementChild.setAttribute("fill", color);
    }
    this.shadowRoot.addEventListener("click", (event) => this.#toolbarClick(event));
    this.shadowRoot.querySelector("slot:not([name])").addEventListener("slotchange", () => this.#nodesChanged());
    this.addEventListener("omg-canvas-node-change", () => this.#queueDraw());
    this.addEventListener("pointerdown", (event) => this.#pointerDown(event));
    this.addEventListener("dblclick", (event) => this.#doubleClick(event));
    this.addEventListener("contextmenu", (event) => this.#contextMenu(event));
    this.addEventListener("wheel", (event) => this.#wheel(event), { passive: false });
    this.addEventListener("keydown", (event) => this.#keyDown(event));
    this.addEventListener("keyup", (event) => { if (event.key === " ") this.#setSpace(false); });
    this.addEventListener("pointermove", (event) => { this.#pointer = { x: event.clientX, y: event.clientY }; });
    this.addEventListener("blur", () => this.#setSpace(false));
  }

  connectedCallback() {
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    if (!this.hasAttribute("role")) this.setAttribute("role", "application");
    this.#appearance = new MutationObserver(() => { this.dataset.appearance = appearance(); });
    this.#appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
    this.dataset.appearance = appearance();
    this.#resize = new ResizeObserver(() => {
      if (!this.#fitted && this.clientWidth && this.#nodes().length) { this.#fitted = true; this.fit(false); }
      this.#drawGrid();
      // Exits are measured, so edges drawn while the canvas was hidden are drawn again once it shows.
      this.#queueDraw();
    });
    this.#resize.observe(this);
    super.connectedCallback();
  }

  disconnectedCallback() {
    this.#appearance?.disconnect();
    this.#resize?.disconnect();
    this.#endGesture();
  }

  update() {
    const label = this.getAttribute("label");
    if (label) this.setAttribute("aria-label", label);
    for (const [action, attribute] of [["select", "select-label"], ["pan", "pan-label"], ["fit", "fit-label"], ["zoom-in", "zoom-in-label"], ["zoom-out", "zoom-out-label"], ["zoom-reset", "zoom-reset-label"]]) {
      const button = this.shadowRoot.querySelector(`[data-action="${action}"]`);
      const name = this.getAttribute(attribute) || LABELS[attribute];
      button.setAttribute("aria-label", name);
      if (button.closest(".toolbar")) button.dataset.tooltip = name;
      else button.title = name;
    }
    this.#applyView();
    this.#queueDraw();
  }

  get edges() {
    return this.#edges;
  }

  set edges(value) {
    this.#edges = Array.isArray(value) ? value.filter((edge) => edge && typeof edge.id === "string") : [];
    const ids = new Set(this.#edges.map((edge) => edge.id));
    for (const id of [...this.#selectedEdges]) if (!ids.has(id)) this.#selectedEdges.delete(id);
    this.#queueDraw();
  }

  get selection() {
    return { nodes: [...this.#selectedNodes], edges: [...this.#selectedEdges] };
  }

  set selection(value) {
    this.#selectedNodes = new Set(value?.nodes ?? []);
    this.#selectedEdges = new Set(value?.edges ?? []);
    this.#paintSelection();
  }

  get viewport() {
    return { ...this.#view };
  }

  set viewport(value) {
    if (!value || ![value.x, value.y, value.zoom].every(Number.isFinite)) return;
    this.#fitted = true;
    this.#view = { x: value.x, y: value.y, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value.zoom)) };
    this.#applyView();
  }

  /** Shows every node, at most at 100%, or the canvas's origin when there are none. */
  fit(animate = true) {
    const width = this.clientWidth;
    const height = this.clientHeight;
    const nodes = this.#nodes();
    if (!width || !height) return;
    if (!nodes.length) {
      this.#view = { x: 0, y: 0, zoom: 1 };
    } else {
      const boxes = nodes.map((node) => ({ ...node.position, ...node.size }));
      const left = Math.min(...boxes.map((box) => box.x));
      const top = Math.min(...boxes.map((box) => box.y));
      const right = Math.max(...boxes.map((box) => box.x + box.width));
      const bottom = Math.max(...boxes.map((box) => box.y + LABEL_HEIGHT + box.stage));
      // React Flow's fitView with 20% padding, never past 100%.
      const zoom = Math.min(1, Math.max(MIN_ZOOM, Math.min(width / ((right - left) * 1.2), height / ((bottom - top) * 1.2))));
      this.#view = { zoom, x: width / 2 - ((left + right) / 2) * zoom, y: height / 2 - ((top + bottom) / 2) * zoom };
    }
    const world = this.shadowRoot.querySelector(".world");
    world.classList.toggle("animate", animate);
    this.#applyView();
    if (animate) setTimeout(() => world.classList.remove("animate"), 220);
    this.#viewChanged();
  }

  // -------------------------------------------------------------------------
  // Drawing.

  #nodes() {
    return [...this.querySelectorAll(":scope > omg-canvas-node")];
  }

  #node(key) {
    return this.#nodes().find((node) => node.nodeId === key);
  }

  #nodesChanged() {
    const keys = new Set(this.#nodes().map((node) => node.nodeId));
    for (const key of [...this.#selectedNodes]) if (!keys.has(key)) this.#selectedNodes.delete(key);
    if (!this.#fitted && this.clientWidth && keys.size) { this.#fitted = true; this.fit(false); }
    this.#paintSelection();
    this.#queueDraw();
  }

  #queueDraw() {
    if (this.#drawQueued) return;
    this.#drawQueued = true;
    requestAnimationFrame(() => {
      this.#drawQueued = false;
      this.#drawEdges();
      // Shown once the first view is set (or there's nothing to fit yet), so nodes never jump into place.
      if (this.#fitted || !this.#nodes().length) this.toggleAttribute("data-ready", true);
    });
  }

  #drawEdges() {
    const group = this.shadowRoot.querySelector(".edge-group");
    const labels = this.shadowRoot.querySelector(".edge-labels");
    const nodes = new Map(this.#nodes().map((node) => [node.nodeId, node]));
    group.replaceChildren();
    labels.replaceChildren();
    for (const edge of this.#edges) {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (!from || !to) continue;
      const start = from.exitPoint(edge.exit);
      const end = to.entryPoint();
      const { d, mid } = bezier(from.position.x + start.x, from.position.y + start.y, to.position.x + end.x, to.position.y + end.y);
      const selected = this.#selectedEdges.has(edge.id);
      const hovered = this.#hover.edge === edge.id;
      const element = document.createElementNS(SVG, "g");
      element.setAttribute("class", `edge${selected ? " selected" : ""}${hovered ? " hover" : ""}${edge.dashed ? " dashed" : ""}`);
      element.dataset.edge = edge.id;
      element.addEventListener("pointerenter", () => this.#enterEdge(edge.id));
      element.addEventListener("pointerleave", () => this.#leaveEdge());
      const hit = document.createElementNS(SVG, "path");
      hit.setAttribute("class", "edge-hit");
      hit.setAttribute("d", d);
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("class", "edge-path");
      path.setAttribute("d", d);
      path.setAttribute("marker-end", `url(#${selected ? "arrow-selected" : "arrow"})`);
      element.append(hit, path);
      group.append(element);
      if (edge.label) {
        const label = document.createElement("span");
        label.className = "edge-label";
        label.textContent = edge.label;
        label.style.transform = `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`;
        labels.append(label);
      }
      if (selected || (hovered && this.#hover.ready)) labels.append(this.#cutButton(edge.id, mid));
    }
  }

  #label(attribute) {
    return this.getAttribute(attribute) || LABELS[attribute];
  }

  /** As the app's edges: it darkens at once, and offers its scissors after a moment. */
  #enterEdge(id) {
    // A redraw puts a new element under the pointer, which enters it again: that keeps the wait going.
    clearTimeout(this.#hover.leaveTimer);
    if (this.#hover.edge === id) return;
    clearTimeout(this.#hover.readyTimer);
    this.#hover = { edge: id, ready: false, readyTimer: setTimeout(() => { this.#hover.ready = true; this.#drawEdges(); }, 300), leaveTimer: undefined };
    this.#drawEdges();
  }

  #leaveEdge() {
    clearTimeout(this.#hover.leaveTimer);
    this.#hover.leaveTimer = setTimeout(() => this.#clearHover(), 250);
  }

  #clearHover() {
    clearTimeout(this.#hover.readyTimer);
    clearTimeout(this.#hover.leaveTimer);
    this.#hover = { edge: undefined, ready: false, readyTimer: undefined, leaveTimer: undefined };
    this.#drawEdges();
  }

  #cutButton(id, mid) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cut";
    button.innerHTML = icon("scissors", 16);
    const name = this.#label("cut-label");
    button.title = name;
    button.setAttribute("aria-label", name);
    button.style.transform = `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`;
    button.addEventListener("pointerenter", () => this.#enterEdge(id));
    button.addEventListener("pointerleave", () => this.#leaveEdge());
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("dblclick", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.#clearHover();
      this.#emit("omg-delete", { nodes: [], edges: [id] });
    });
    return button;
  }

  #drawGuides() {
    const layer = this.shadowRoot.querySelector(".guides");
    layer.replaceChildren();
    if (!this.#guides) return;
    const width = 1 / this.#view.zoom;
    for (const guide of this.#guides.vertical) layer.append(this.#guide("vertical", `left:${guide.x - width / 2}px;top:${guide.from}px;width:${width}px;height:${guide.to - guide.from}px`));
    for (const guide of this.#guides.horizontal) layer.append(this.#guide("horizontal", `top:${guide.y - width / 2}px;left:${guide.from}px;height:${width}px;width:${guide.to - guide.from}px`));
  }

  #guide(axis, style) {
    const element = document.createElement("div");
    element.className = `guide ${axis}`;
    element.setAttribute("style", style);
    return element;
  }

  #drawGrid() {
    const { x, y, zoom } = this.#view;
    const gap = GRID_GAP * zoom;
    const radius = Math.max(0.5, zoom / 2);
    const pattern = this.shadowRoot.querySelector("pattern");
    pattern.setAttribute("x", String(x % gap));
    pattern.setAttribute("y", String(y % gap));
    pattern.setAttribute("width", String(gap));
    pattern.setAttribute("height", String(gap));
    pattern.setAttribute("patternTransform", `translate(-${radius},-${radius})`);
    const dot = pattern.firstElementChild;
    dot.setAttribute("cx", String(radius));
    dot.setAttribute("cy", String(radius));
    dot.setAttribute("r", String(radius));
  }

  #applyView() {
    const { x, y, zoom } = this.#view;
    this.shadowRoot.querySelector(".world").style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.style.setProperty("--omg-canvas-port-size", `${Math.min(72, Math.max(28, 44 / zoom))}px`);
    this.shadowRoot.querySelector(".value").textContent = `${Math.round(zoom * 100)}%`;
    this.#drawGrid();
    if (this.#guides) this.#drawGuides();
  }

  #paintSelection() {
    for (const node of this.#nodes()) {
      node.toggleAttribute("selected", this.#selectedNodes.has(node.nodeId));
      node.toggleAttribute("data-only-selected", this.#selectedNodes.size === 1 && this.#selectedNodes.has(node.nodeId));
    }
    for (const element of this.shadowRoot.querySelectorAll(".edge")) {
      const selected = this.#selectedEdges.has(element.dataset.edge);
      element.classList.toggle("selected", selected);
      element.querySelector(".edge-path").setAttribute("marker-end", `url(#${selected ? "arrow-selected" : "arrow"})`);
    }
    // A selected edge shows its scissors.
    this.#queueDraw();
  }

  // -------------------------------------------------------------------------
  // The view.

  #toCanvas(clientX, clientY) {
    const bounds = this.getBoundingClientRect();
    return { x: (clientX - bounds.left - this.#view.x) / this.#view.zoom, y: (clientY - bounds.top - this.#view.y) / this.#view.zoom };
  }

  #zoomAround(factor, clientX, clientY) {
    const bounds = this.getBoundingClientRect();
    const px = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
    const py = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.#view.zoom * factor));
    const scale = zoom / this.#view.zoom;
    this.#view = { x: px - (px - this.#view.x) * scale, y: py - (py - this.#view.y) * scale, zoom };
    this.#applyView();
    this.#viewChanged();
  }

  #viewChanged() {
    this.#emit("omg-viewport-change", { ...this.#view });
  }

  #toolbarClick(event) {
    const button = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (button) {
      const action = button.dataset.action;
      if (action === "zoom-in") this.#zoomAround(ZOOM_STEP);
      else if (action === "zoom-out") this.#zoomAround(1 / ZOOM_STEP);
      else if (action === "zoom-reset") this.#zoomAround(1 / this.#view.zoom);
      else if (action === "fit") this.fit(true);
      else if (action === "select" || action === "pan") this.#setMode(action);
      return;
    }
    const item = event.target instanceof Element ? event.target.closest("[data-value]") : null;
    if (item && !item.disabled) {
      const target = this.#menuTarget;
      this.#closeMenu();
      this.#emit("omg-menu-select", { value: item.dataset.value, ...target });
    }
  }

  #setMode(mode) {
    this.#mode = mode;
    this.shadowRoot.querySelector('[data-action="select"]').classList.toggle("active", mode === "select");
    this.shadowRoot.querySelector('[data-action="pan"]').classList.toggle("active", mode === "pan");
    this.toggleAttribute("data-panning", mode === "pan" || this.#space);
  }

  #setSpace(down) {
    this.#space = down;
    this.toggleAttribute("data-panning", this.#mode === "pan" || down);
  }

  #wheel(event) {
    if (this.#fromFloating(event)) return;
    event.preventDefault();
    this.#closeMenu();
    if (event.ctrlKey || event.metaKey) {
      // React Flow's wheel step. A trackpad pinch comes as a wheel with ctrlKey,
      // ten times faster on a Mac; ⌘ (Ctrl elsewhere) zooms a scroll at the plain step.
      const delta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * (event.ctrlKey && isMac ? 10 : 1);
      this.#zoomAround(2 ** delta, event.clientX, event.clientY);
    } else {
      // React Flow's pan on scroll, at its default panOnScrollSpeed of 0.5;
      // Shift scrolls sideways off a mouse wheel.
      const dx = event.shiftKey && !isMac ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !isMac ? 0 : event.deltaY;
      const scale = (event.deltaMode === 1 ? 20 : 1) * PAN_ON_SCROLL_SPEED;
      this.#view = { ...this.#view, x: this.#view.x - dx * scale, y: this.#view.y - dy * scale };
      this.#applyView();
      this.#viewChanged();
    }
  }

  // -------------------------------------------------------------------------
  // The pointer.

  #fromFloating(event) {
    return event.composedPath().some((target) => target instanceof Element && (target.classList?.contains("float") || target.classList?.contains("menu")));
  }

  /** The node, exit handle and edge an event's path goes through. */
  #targets(event) {
    let node;
    let handle;
    let edge;
    for (const target of event.composedPath()) {
      if (!(target instanceof Element)) continue;
      if (!handle && (target.classList.contains("handle") || target.dataset.port) && (target.dataset.exit !== undefined || target.dataset.port)) handle = target;
      if (!edge && target.dataset?.edge !== undefined && target.localName === "g") edge = target.dataset.edge;
      if (!node && target.localName === "omg-canvas-node" && target.parentElement === this) node = target;
    }
    return { node, handle, edge };
  }

  #pointerDown(event) {
    if (this.#fromFloating(event)) return;
    this.#closeMenu();
    this.focus({ preventScroll: true });
    const panning = this.#mode === "pan" || this.#space || event.button === 1;
    if (panning && (event.button === 0 || event.button === 1)) {
      event.preventDefault();
      return this.#beginGesture({ kind: "pan", from: { x: event.clientX - this.#view.x, y: event.clientY - this.#view.y } });
    }
    if (event.button !== 0) return;
    const { node, handle, edge } = this.#targets(event);
    if (node && handle?.dataset.port === "in") {
      event.preventDefault();
      return this.#beginGesture({ kind: "port", node: node.nodeId, origin: { x: event.clientX, y: event.clientY } });
    }
    if (node && handle) {
      event.preventDefault();
      node.toggleAttribute("data-connecting", true);
      return this.#beginGesture({ kind: "connect", from: node.nodeId, exit: handle.dataset.exit || undefined, port: handle.dataset.port === "out", origin: { x: event.clientX, y: event.clientY }, moved: false });
    }
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (node) {
      const key = node.nodeId;
      if (additive) {
        if (this.#selectedNodes.has(key)) this.#selectedNodes.delete(key);
        else this.#selectedNodes.add(key);
      } else if (!this.#selectedNodes.has(key)) {
        this.#selectedNodes = new Set([key]);
        this.#selectedEdges.clear();
      }
      this.#paintSelection();
      this.#selectionChanged();
      if (!this.#selectedNodes.has(key)) return;
      const keys = [...this.#selectedNodes];
      const nodes = keys.map((each) => this.#node(each)).filter(Boolean);
      return this.#beginGesture({
        kind: "drag",
        active: key,
        nodes,
        pointer: this.#toCanvas(event.clientX, event.clientY),
        starts: new Map(nodes.map((each) => [each, each.position])),
        frames: new Map(this.#nodes().map((each) => [each, each.size])),
        copy: event.altKey,
        moved: false,
      });
    }
    if (edge) {
      if (additive) {
        if (this.#selectedEdges.has(edge)) this.#selectedEdges.delete(edge);
        else this.#selectedEdges.add(edge);
      } else {
        this.#selectedEdges = new Set([edge]);
        this.#selectedNodes.clear();
      }
      this.#paintSelection();
      this.#selectionChanged();
      return;
    }
    this.#beginGesture({ kind: "marquee", origin: { x: event.clientX, y: event.clientY }, keep: additive ? new Set(this.#selectedNodes) : new Set(), additive, moved: false });
  }

  #beginGesture(gesture) {
    this.#gesture = gesture;
    this.dataset.gesture = gesture.kind;
    // Listening on the window rather than capturing the pointer keeps a
    // double-click's target the element under the pointer.
    this.#onMove = (event) => this.#pointerMove(event);
    this.#onUp = (event) => this.#pointerUp(event);
    window.addEventListener("pointermove", this.#onMove);
    window.addEventListener("pointerup", this.#onUp);
    window.addEventListener("pointercancel", this.#onUp);
  }

  #onMove;
  #onUp;

  #endGesture() {
    this.#gesture = undefined;
    delete this.dataset.gesture;
    if (this.#onMove) window.removeEventListener("pointermove", this.#onMove);
    if (this.#onUp) {
      window.removeEventListener("pointerup", this.#onUp);
      window.removeEventListener("pointercancel", this.#onUp);
    }
  }

  #pointerMove(event) {
    const gesture = this.#gesture;
    if (!gesture) return;
    if (gesture.kind === "pan") {
      this.#view = { ...this.#view, x: event.clientX - gesture.from.x, y: event.clientY - gesture.from.y };
      this.#applyView();
      return;
    }
    const point = this.#toCanvas(event.clientX, event.clientY);
    if (gesture.kind === "drag") {
      const dx = point.x - gesture.pointer.x;
      const dy = point.y - gesture.pointer.y;
      if (!gesture.moved && Math.hypot(dx, dy) * this.#view.zoom < DRAG_THRESHOLD) return;
      gesture.moved = true;
      for (const node of gesture.nodes) {
        const start = gesture.starts.get(node);
        const at = snapCanvasPosition({ x: start.x + dx, y: start.y + dy });
        node.setAttribute("x", String(at.x));
        node.setAttribute("y", String(at.y));
      }
      // Guides line up the stages, as on the app's canvases.
      const frame = (node) => {
        const size = gesture.frames.get(node);
        return { id: node.nodeId, alignmentFrame: { x: node.position.x, y: node.position.y + LABEL_HEIGHT, width: size.width, height: size.stage } };
      };
      const active = this.#node(gesture.active);
      const others = this.#nodes().filter((node) => !gesture.nodes.includes(node)).map(frame);
      this.#guides = active ? findCanvasAlignmentGuides(frame(active), others) : undefined;
      this.#drawGuides();
      return;
    }
    if (gesture.kind === "port") return;
    if (gesture.kind === "connect") {
      const from = this.#node(gesture.from);
      if (!from) return;
      if (!gesture.moved && Math.hypot(event.clientX - gesture.origin.x, event.clientY - gesture.origin.y) <= CONNECT_THRESHOLD) return;
      gesture.moved = true;
      const start = from.exitPoint(gesture.exit);
      this.shadowRoot.querySelector(".draft").setAttribute("d", bezier(from.position.x + start.x, from.position.y + start.y, point.x, point.y).d);
      const over = this.#connectTarget(event.clientX, event.clientY);
      for (const node of this.#nodes()) node.toggleAttribute("data-target", node === over && node.nodeId !== gesture.from);
      return;
    }
    if (gesture.kind === "marquee") {
      const left = Math.min(gesture.origin.x, event.clientX);
      const top = Math.min(gesture.origin.y, event.clientY);
      const width = Math.abs(event.clientX - gesture.origin.x);
      const height = Math.abs(event.clientY - gesture.origin.y);
      if (!gesture.moved && width + height < 4) return;
      gesture.moved = true;
      const bounds = this.getBoundingClientRect();
      const box = this.shadowRoot.querySelector(".marquee");
      Object.assign(box.style, { left: `${left - bounds.left}px`, top: `${top - bounds.top}px`, width: `${width}px`, height: `${height}px` });
      box.hidden = false;
      const a = this.#toCanvas(left, top);
      const b = this.#toCanvas(left + width, top + height);
      const inside = this.#nodes().filter((node) => {
        const { x, y } = node.position;
        const { width: w, stage } = node.size;
        return x < b.x && x + w > a.x && y < b.y && y + LABEL_HEIGHT + stage > a.y;
      }).map((node) => node.nodeId);
      this.#selectedNodes = new Set([...gesture.keep, ...inside]);
      if (!gesture.additive) this.#selectedEdges.clear();
      this.#paintSelection();
    }
  }

  #pointerUp(event) {
    const gesture = this.#gesture;
    this.#endGesture();
    if (!gesture) return;
    if (gesture.kind === "pan") return this.#viewChanged();
    if (gesture.kind === "drag") {
      this.#guides = undefined;
      this.#drawGuides();
      if (!gesture.moved) return;
      const dropped = gesture.nodes.map((node) => ({ node: node.nodeId, ...node.position }));
      if (!gesture.copy) return void this.#emit("omg-move", { nodes: dropped });
      // Option-drag leaves the nodes where they were and asks for copies where they were dropped.
      for (const node of gesture.nodes) {
        const start = gesture.starts.get(node);
        node.setAttribute("x", String(start.x));
        node.setAttribute("y", String(start.y));
      }
      this.#emit("omg-duplicate", { nodes: dropped });
      return;
    }
    if (gesture.kind === "port") {
      if (Math.hypot(event.clientX - gesture.origin.x, event.clientY - gesture.origin.y) <= CONNECT_THRESHOLD) this.#addFromPort(gesture.node, "to");
      return;
    }
    if (gesture.kind === "connect") {
      this.shadowRoot.querySelector(".draft").removeAttribute("d");
      for (const node of this.#nodes()) node.removeAttribute("data-target");
      this.#node(gesture.from)?.removeAttribute("data-connecting");
      if (!gesture.moved) {
        if (gesture.port) this.#addFromPort(gesture.from, "from");
        return;
      }
      const to = this.#connectTarget(event.clientX, event.clientY);
      if (to && to.nodeId !== gesture.from) this.#emit("omg-connect", { from: gesture.from, ...(gesture.exit ? { exit: gesture.exit } : {}), to: to.nodeId });
      return;
    }
    if (gesture.kind === "marquee") {
      this.shadowRoot.querySelector(".marquee").hidden = true;
      if (!gesture.moved && !gesture.additive) {
        if (!this.#selectedNodes.size && !this.#selectedEdges.size) return;
        this.#selectedNodes.clear();
        this.#selectedEdges.clear();
        this.#paintSelection();
      }
      this.#selectionChanged();
    }
  }

  #nodeAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const node = element?.closest?.("omg-canvas-node");
    return node?.parentElement === this ? node : undefined;
  }

  /** The node an edge drawn to here would reach: the one under the pointer, or one whose entry is within the app's connection radius. */
  #connectTarget(clientX, clientY) {
    const under = this.#nodeAt(clientX, clientY);
    if (under) return under;
    const bounds = this.getBoundingClientRect();
    const { x, y, zoom } = this.#view;
    let nearest;
    let best = CONNECTION_RADIUS;
    for (const node of this.#nodes()) {
      const entry = node.entryPoint();
      const distance = Math.hypot(bounds.left + x + (node.position.x + entry.x) * zoom - clientX, bounds.top + y + (node.position.y + entry.y) * zoom - clientY);
      if (distance <= best) { best = distance; nearest = node; }
    }
    return nearest;
  }

  /** A click on a port: a node to add joined there, after the node or before it, beside it a node's width and a gap away. */
  #addFromPort(id, side) {
    const node = this.#node(id);
    if (!node) return;
    const { width } = node.size;
    const gap = 120;
    const x = side === "from" ? node.position.x + width + gap : node.position.x - width - gap;
    this.#emit("omg-add", { ...snapCanvasPosition({ x, y: node.position.y }), [side]: id });
  }

  #doubleClick(event) {
    if (this.#fromFloating(event) || this.#mode === "pan" || this.#space) return;
    // A double-click opens nothing; a node's title renames it, when the node lets it.
    const { node, edge } = this.#targets(event);
    if (node || edge) return;
    this.#emit("omg-add", snapCanvasPosition(this.#toCanvas(event.clientX, event.clientY)));
  }

  #contextMenu(event) {
    if (this.#fromFloating(event)) return;
    event.preventDefault();
    const { node, edge } = this.#targets(event);
    if (node && !this.#selectedNodes.has(node.nodeId)) {
      this.#selectedNodes = new Set([node.nodeId]);
      this.#selectedEdges.clear();
      this.#paintSelection();
      this.#selectionChanged();
    } else if (edge && !this.#selectedEdges.has(edge)) {
      this.#selectedEdges = new Set([edge]);
      this.#selectedNodes.clear();
      this.#paintSelection();
      this.#selectionChanged();
    }
    const at = snapCanvasPosition(this.#toCanvas(event.clientX, event.clientY));
    const target = { ...(node ? { node: node.nodeId } : edge ? { edge } : {}), ...at };
    const items = [];
    this.#emit("omg-context-menu", { ...target, items });
    this.#openMenu(items, target, event.clientX, event.clientY);
  }

  #openMenu(items, target, clientX, clientY) {
    const menu = this.part("menu");
    const valid = items.filter((item) => item && typeof item.value === "string" && typeof item.label === "string");
    if (!valid.length) return this.#closeMenu();
    menu.replaceChildren(...valid.flatMap((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.dataset.value = item.value;
      button.disabled = Boolean(item.disabled);
      if (item.danger) button.className = "danger";
      if (MENU_ICONS[item.icon]) button.insertAdjacentHTML("beforeend", icon(MENU_ICONS[item.icon], 15));
      const words = document.createElement("span");
      words.textContent = item.label;
      button.append(words);
      if (typeof item.shortcut === "string" && item.shortcut) {
        const keys = document.createElement("kbd");
        keys.textContent = item.shortcut;
        button.append(keys);
      }
      if (!item.separator || index === 0) return [button];
      const line = document.createElement("div");
      line.setAttribute("role", "separator");
      return [line, button];
    }));
    this.#menuTarget = target;
    menu.hidden = false;
    const bounds = this.getBoundingClientRect();
    const x = Math.min(clientX - bounds.left, bounds.width - menu.offsetWidth - 8);
    const y = Math.min(clientY - bounds.top, bounds.height - menu.offsetHeight - 8);
    Object.assign(menu.style, { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` });
    menu.querySelector("button:not(:disabled)")?.focus();
  }

  #closeMenu() {
    const menu = this.part("menu");
    if (menu.hidden) return;
    menu.hidden = true;
    this.#menuTarget = undefined;
  }

  // -------------------------------------------------------------------------
  // Keys.

  #keyDown(event) {
    const inside = event.composedPath().find((target) => target instanceof Element);
    // Leave the keys of what the page put in a node, and of the menu, alone.
    if (inside && inside !== this && inside.closest?.("input, textarea, select, [contenteditable]")) return;
    const menu = this.part("menu");
    if (!menu.hidden) {
      const items = [...menu.querySelectorAll("button:not(:disabled)")];
      const index = items.indexOf(this.shadowRoot.activeElement);
      if (event.key === "Escape") { event.preventDefault(); this.#closeMenu(); this.focus(); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (!this.#space) this.#setSpace(true);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      if (!this.#selectedNodes.size && !this.#selectedEdges.size) return;
      event.preventDefault();
      this.#emit("omg-delete", this.selection);
    } else if (event.key === "Escape") {
      if (!this.#selectedNodes.size && !this.#selectedEdges.size) return;
      this.#selectedNodes.clear();
      this.#selectedEdges.clear();
      this.#paintSelection();
      this.#selectionChanged();
    } else if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === "z" || (event.key.toLowerCase() === "y" && !event.metaKey))) {
      event.preventDefault();
      this.#emit(event.key.toLowerCase() === "y" || event.shiftKey ? "omg-redo" : "omg-undo", {});
    } else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c") {
      if (!this.#selectedNodes.size) return;
      event.preventDefault();
      this.#emit("omg-copy", this.selection);
    } else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "v") {
      event.preventDefault();
      this.#emit("omg-paste", snapCanvasPosition(this.#pasteAt()));
    } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      const nodes = [...this.#selectedNodes].map((key) => this.#node(key)).filter(Boolean);
      if (nodes.length) this.#emit("omg-duplicate", { nodes: nodes.map((node) => ({ node: node.nodeId, ...snapCanvasPosition({ x: node.position.x + 40, y: node.position.y + 40 }) })) });
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.#selectedNodes = new Set(this.#nodes().map((node) => node.nodeId));
      this.#selectedEdges.clear();
      this.#paintSelection();
      this.#selectionChanged();
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") this.#setMode("select");
    else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "h") this.#setMode("pan");
  }

  /** Where the pointer last was over the canvas, or the middle of the view. */
  #pasteAt() {
    const bounds = this.getBoundingClientRect();
    const pointer = this.#pointer;
    const inside = pointer && pointer.x >= bounds.left && pointer.x <= bounds.right && pointer.y >= bounds.top && pointer.y <= bounds.bottom;
    return inside ? this.#toCanvas(pointer.x, pointer.y) : this.#toCanvas(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  }

  #pointer;

  #selectionChanged() {
    this.#emit("omg-selection-change", this.selection);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
  }
}

define("omg-canvas-node", OmgCanvasNode);
define("omg-canvas", OmgCanvas);

