// Media: a picture, and a tile that shows one with its name.
import "./overlays.js";
import { connect } from "../../plugin-ui.js";
import { OmgElement, css, define, text } from "./base.js";

// Listens for the app's port from the start, for pictures of the project's files.
const connection = connect();

/** The `blob:` address each picture of a project file was given, released once it is drawn or failed. */
const addresses = new WeakMap();

function release(image) {
  const address = addresses.get(image);
  if (address === undefined) return;
  addresses.delete(image);
  URL.revokeObjectURL(address);
}

/** The `w/h` or number in a `ratio` attribute, as CSS `aspect-ratio`, when it is a positive one. */
function aspect(value) {
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:\/\s*(\d+(?:\.\d+)?|\.\d+)\s*)?$/.exec(value ?? "");
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = match[2] === undefined ? 1 : Number(match[2]);
  return width > 0 && height > 0 ? `${width} / ${height}` : undefined;
}

// A picture that couldn't load: a frame with a slash through it.
const BROKEN = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m3.5 16 4.5-4.5 3 3"/><path d="m4 4 16 16"/></svg>`;

const IMAGE = css(`
  :host { display: block; min-width: 0; max-width: 100%; }
  .frame {
    position: relative; display: grid; place-items: center; overflow: hidden;
    border-radius: var(--omg-image-radius, var(--radius-lg)); background: var(--color-surface-raised);
  }
  /* Without a shape of its own, as tall as the element when something sizes it, as a list's thumbnail does. */
  .frame:not(.sized) { height: 100%; }
  :host([checker]) .frame {
    background:
      repeating-conic-gradient(var(--color-surface-raised) 0 25%, var(--color-surface) 0 50%) 0 0 / 16px 16px;
  }
  img { display: block; max-width: 100%; max-height: 100%; height: auto; transition: opacity var(--duration-fast); }
  /* Out of the flow, so the frame's shape alone sets its height. */
  .frame.sized img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  :host([fit="cover"]) .frame.sized img { object-fit: cover; }
  :host([pixelated]) img { image-rendering: pixelated; }
  /* Not yet drawn, or not drawable: kept in the page for its alt text, but not seen. */
  .frame:not(.loaded) img { opacity: 0; }
  .frame:not(.sized):not(.loaded) { min-height: 64px; }
  .frame:not(.sized):not(.loaded) img { position: absolute; }
  .broken { position: absolute; inset: 0; display: grid; place-items: center; color: var(--color-text-tertiary); }
`);

/**
 * `<omg-image src file alt ratio fit pixelated checker>`: a picture, on a raised
 * surface until it loads and with a mark when it can't. With `ratio` it fills
 * a frame of that shape; without, it is drawn at its own size, at most as wide
 * as its place.
 *
 * @attr {string} src - The picture's address: a file in the plugin's package, or a `data:` or `blob:` URL.
 * @attr {string} file - A picture in the project, by its path there, in place of `src`; the plugin needs the `project.files` capability. Set it again to show the file as it is now.
 * @attr {string} alt - What it shows, for people who can't see it; leave it empty for a decoration.
 * @attr {string} ratio - The frame's shape, such as `16/9` or `1`; the picture's own by default.
 * @attr {"contain" | "cover"} fit - How the picture fills a frame of another shape: whole, or cropped to fill it. Whole by default.
 * @attr {boolean} pixelated - Scales pixel art without smoothing it.
 * @attr {boolean} checker - Draws a checkerboard behind it, to show where it is transparent.
 * @readonly {boolean} complete - It has loaded, or failed to.
 * @readonly {number} naturalWidth - The picture's own width in pixels; 0 until it loads.
 * @readonly {number} naturalHeight - The picture's own height in pixels; 0 until it loads.
 * @fires load - The picture loaded.
 * @fires error - The picture couldn't load.
 * @part frame - The surface the picture is drawn on.
 * @part image - The picture.
 * @part broken - The mark shown when it couldn't load.
 * @cssprop --omg-image-radius - The frame's corners; the app's large radius by default.
 */
class OmgImage extends OmgElement {
  static observedAttributes = ["src", "file", "alt", "ratio"];
  static styles = [IMAGE];
  static template = `
    <div class="frame" part="frame">
      <img part="image" alt="" loading="lazy" draggable="false">
      <span class="broken" part="broken" hidden>${BROKEN}</span>
    </div>`;

  #status = "empty";
  /** The `src` or `file` attribute was set, to the same value too, which loads it again. */
  #reload = true;
  /**
   * Its connectedCallback has run. Markup upgraded in a page reports each attribute
   * first, already connected, and drawing then would read a file once per attribute.
   */
  #inPage = false;

  constructor() {
    super();
    this.#listen(this.#image());
  }

  attributeChangedCallback(name, previous, value) {
    // While there's a file, `src` isn't the picture, so setting it changes nothing.
    const source = name === "file" || (name === "src" && !this.getAttribute("file"));
    if (source) this.#reload = true;
    super.attributeChangedCallback(name, previous, value);
    // Out of the page, the old picture goes at once, so its late load or error doesn't count; the new one loads once in the page.
    if (source && !this.#inPage) this.#replace();
  }

  connectedCallback() {
    this.#inPage = true;
    super.connectedCallback();
  }

  disconnectedCallback() {
    this.#inPage = false;
    // A file still loading might never finish out of the page, and would keep its address. It loads again if it comes back.
    if (this.#status !== "loading" || !this.getAttribute("file")) return;
    this.#reload = true;
    this.#replace();
  }

  get complete() {
    return this.#status === "load" || this.#status === "error";
  }

  get naturalWidth() {
    return this.#status === "load" ? this.#image().naturalWidth : 0;
  }

  get naturalHeight() {
    return this.#status === "load" ? this.#image().naturalHeight : 0;
  }

  #image() {
    return /** @type {HTMLImageElement} */ (this.part("image"));
  }

  update() {
    if (!this.#inPage) return;
    const image = this.#image();
    const frame = this.part("frame");
    const ratio = aspect(this.getAttribute("ratio"));
    frame.classList.toggle("sized", Boolean(ratio));
    frame.style.aspectRatio = ratio ?? "";
    image.alt = this.getAttribute("alt") ?? "";
    if (!this.#reload) return;
    this.#reload = false;
    const file = this.getAttribute("file") ?? "";
    const src = this.getAttribute("src") ?? "";
    const next = this.#replace();
    if (!file && !src) return;
    this.#show("loading");
    if (!file) {
      next.src = src;
      return;
    }
    void connection
      // A picture replaced by now, as setting several attributes at once does, has nothing to read.
      .then((host) => (next === this.#image() ? host.files.url(file) : undefined))
      .then(
        (address) => {
          if (address === undefined) return;
          addresses.set(next, address);
          // Replaced while the file was read: its address isn't needed.
          if (next !== this.#image()) release(next);
          else next.src = address;
        },
        () => {
          if (next === this.#image() && this.#status === "loading") this.#settle("error");
        },
      );
  }

  /** Each address gets a picture of its own, so the old one's late load or error is told apart. */
  #replace() {
    const image = this.#image();
    const next = /** @type {HTMLImageElement} */ (image.cloneNode(false));
    next.removeAttribute("src");
    this.#listen(next);
    image.replaceWith(next);
    release(image);
    this.#show("empty");
    return next;
  }

  #listen(image) {
    for (const type of ["load", "error"])
      image.addEventListener(type, () => {
        // Drawn or not, the picture no longer needs its file's address.
        release(image);
        if (image === this.#image() && this.#status === "loading") this.#settle(type);
      });
  }

  #settle(type) {
    this.#show(type);
    this.dispatchEvent(new Event(type));
  }

  #show(status) {
    this.#status = status;
    this.part("frame").classList.toggle("loaded", status === "load");
    this.part("broken").hidden = status !== "error";
  }
}

/**
 * `<omg-tile heading description badge src file ratio selected disabled>`: a
 * picture with its name and a line under it, such as an asset in a grid. It
 * is a button: a click on it is the person picking it, and `selected` marks
 * the one picked.
 *
 * @attr {string} heading - Its name, on one line.
 * @attr {string} description - A line under the name, such as its size or kind.
 * @attr {string} badge - A few words over the picture's corner, such as a duration.
 * @attr {string} src - The picture, as for `omg-image`.
 * @attr {string} file - A picture in the project, as for `omg-image`.
 * @attr {string} alt - What the picture shows, when the name doesn't say; empty by default.
 * @attr {string} ratio - The picture's shape, as for `omg-image`; `4/3` by default.
 * @attr {"contain" | "cover"} fit - As for `omg-image`; cropped to fill by default.
 * @attr {boolean} pixelated - As for `omg-image`.
 * @attr {boolean} checker - As for `omg-image`.
 * @attr {boolean} selected - It is the one picked.
 * @attr {boolean} disabled - It can't be picked.
 * @prop {boolean} disabled - The `disabled` attribute.
 * @prop {boolean} selected - The `selected` attribute.
 * @slot media - Drawn in place of the picture, such as a video or a canvas.
 * @part tile - The button.
 * @part preview - The picture's frame.
 * @part image - The `omg-image`, when there's no `media`.
 * @part badge - The badge; hidden when empty.
 * @part heading - The name.
 * @part description - The line under the name; hidden when empty.
 */
class OmgTile extends OmgElement {
  static observedAttributes = ["heading", "description", "badge", "src", "file", "alt", "ratio", "fit", "pixelated", "checker", "selected", "disabled"];
  static delegatesFocus = true;
  static styles = [
    css(`
      :host { display: block; min-width: 0; }
      button {
        display: flex; flex-direction: column; gap: var(--space-2); width: 100%; min-width: 0;
        padding: 0; border: 0; border-radius: var(--radius-lg); background: none;
        color: var(--color-text); font: inherit; text-align: left; cursor: pointer;
      }
      button:disabled { opacity: 0.4; cursor: default; }
      .preview {
        position: relative; display: block; overflow: hidden; border-radius: var(--radius-lg);
        background: var(--color-surface-raised);
        transition: box-shadow var(--duration-fast), filter var(--duration-fast);
      }
      button:not(:disabled):hover .preview { filter: brightness(1.06); }
      :host([selected]) .preview { box-shadow: 0 0 0 2px var(--color-ink); }
      /* The picture fills the preview, whose shape the tile sets. */
      omg-image { position: absolute; inset: 0; --omg-image-radius: 0; }
      omg-image::part(frame) { width: 100%; height: 100%; }
      ::slotted(*) { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
      .badge {
        position: absolute; top: var(--space-2); right: var(--space-2); max-width: calc(100% - 2 * var(--space-2));
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        height: 18px; padding: 0 6px; border-radius: var(--radius-pill); line-height: 18px;
        background: color-mix(in srgb, var(--color-app) 78%, transparent); color: var(--color-text);
        font-family: var(--font-mono); font-size: var(--text-xs);
      }
      .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 0 2px; }
      .heading, .description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .heading { font-size: var(--text-md); font-weight: var(--weight-medium); }
      .description { color: var(--color-text-tertiary); font-size: var(--text-sm); }
    `),
  ];
  static template = `
    <button type="button" part="tile">
      <span class="preview" part="preview">
        <slot name="media"><omg-image part="image" fit="cover"></omg-image></slot>
        <span class="badge" part="badge" hidden></span>
      </span>
      <span class="text">
        <span class="heading" part="heading"></span>
        <span class="description" part="description"></span>
      </span>
    </button>`;

  /** The picture's attributes set since it was last drawn, to the same value too. */
  #reload = new Set();
  /** Its connectedCallback has run; see `omg-image`. */
  #inPage = false;

  constructor() {
    super();
    // A disabled tile reports no click, not even one a script sends it.
    this.addEventListener(
      "click",
      (event) => {
        if (this.disabled) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  }

  attributeChangedCallback(name, previous, value) {
    if (name === "src" || name === "file") this.#reload.add(name);
    super.attributeChangedCallback(name, previous, value);
  }

  connectedCallback() {
    this.#inPage = true;
    super.connectedCallback();
  }

  disconnectedCallback() {
    this.#inPage = false;
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(value) {
    this.toggleAttribute("disabled", Boolean(value));
  }

  get selected() {
    return this.hasAttribute("selected");
  }

  set selected(value) {
    this.toggleAttribute("selected", Boolean(value));
  }

  update() {
    if (!this.#inPage) return;
    const button = /** @type {HTMLButtonElement} */ (this.part("tile"));
    button.disabled = this.disabled;
    if (this.selected) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
    const heading = this.getAttribute("heading");
    text(this.part("heading"), heading);
    // The name may be cut short; its whole shows on hover.
    if (heading) this.part("heading").title = heading;
    else this.part("heading").removeAttribute("title");
    text(this.part("description"), this.getAttribute("description"));
    text(this.part("badge"), this.getAttribute("badge"));
    this.part("preview").style.aspectRatio = aspect(this.getAttribute("ratio")) ?? "4 / 3";
    const image = this.part("image");
    // Only the source in use, so a tile with both reads its file once. It's set again
    // only when it changed, or was set again, which loads it again.
    const [source, unused] = this.getAttribute("file") ? ["file", "src"] : ["src", "file"];
    image.removeAttribute(unused);
    const value = this.getAttribute(source);
    if (this.#reload.has(source) || image.getAttribute(source) !== value) {
      if (value === null) image.removeAttribute(source);
      else image.setAttribute(source, value);
    }
    this.#reload.clear();
    for (const name of ["alt", "pixelated", "checker"]) {
      const value = this.getAttribute(name);
      if (value === null) image.removeAttribute(name);
      else image.setAttribute(name, value);
    }
    image.setAttribute("fit", this.getAttribute("fit") === "contain" ? "contain" : "cover");
    // A framed picture fills its frame, which fills the preview, whatever shape the tile gives it.
    image.setAttribute("ratio", "1");
  }
}

define("omg-image", OmgImage);
define("omg-tile", OmgTile);

/**
 * `<omg-image-preview src file alt>`: an image button that opens the whole
 * picture in a modal. Reuses omg-image loading and omg-dialog focus/closing.
 * It never changes a selection or uploads a file.
 *
 * @attr {string} src - Same sources as omg-image.
 * @attr {string} file - A project image; requires project.files and takes precedence over src.
 * @attr {string} alt - Image description and default preview title.
 * @attr {string} label - Trigger's accessible name; defaults to alt or Preview image.
 * @attr {string} close-label - Close button name; defaults to Close.
 * @attr {string} ratio - Thumbnail aspect ratio; image's own by default.
 * @attr {"contain" | "cover"} fit - Thumbnail fit; contain by default. The modal always shows the whole image.
 * @attr {boolean} pixelated - Preserve pixel-art edges in both views.
 * @attr {boolean} checker - Show transparency in both views.
 * @attr {boolean} open - Show the preview modal.
 * @prop {boolean} open - Preview visibility.
 * @fires {{ reason: "escape" | "backdrop" | "button" }} omg-close - Cancelable close request, forwarded from omg-dialog.
 * @part trigger - Image button.
 * @part thumbnail - The omg-image in the page.
 * @part dialog - The omg-dialog holding the full image.
 * @part image - The full omg-image, loaded only while open.
 */
class OmgImagePreview extends OmgElement {
  static observedAttributes = ["src", "file", "alt", "label", "close-label", "ratio", "fit", "pixelated", "checker", "open"];
  static styles = [css(`
    :host { display: block; min-width: 0; max-width: 100%; }
    button { display: block; width: 100%; padding: 0; border: 0; border-radius: var(--radius-lg); background: transparent; cursor: zoom-in; }
    button:disabled { cursor: default; }
    button:hover:not(:disabled) { opacity: .9; }
    omg-dialog::part(panel) { max-width: 960px; }
    omg-image[part="image"]::part(image) { width: 100%; height: auto; max-height: calc(100vh - 144px); object-fit: contain; }
  `)];
  static template = `<button part="trigger" type="button" aria-haspopup="dialog"><omg-image part="thumbnail"></omg-image></button><omg-dialog part="dialog"><omg-image part="image"></omg-image></omg-dialog>`;
  #reload = true;
  constructor() {
    super();
    this.part("trigger").addEventListener("click", () => { this.open = true; });
    this.part("dialog").addEventListener("omg-close", (event) => {
      // Let outer listeners cancel the shared dialog's close before reflecting it.
      queueMicrotask(() => { if (!event.defaultPrevented) this.open = false; });
    });
  }
  get open() { return this.hasAttribute("open"); }
  set open(value) { this.toggleAttribute("open", Boolean(value)); }
  attributeChangedCallback(name, previous, value) {
    if (name === "file" || (name === "src" && !this.getAttribute("file"))) this.#reload = true;
    super.attributeChangedCallback(name, previous, value);
  }
  update() {
    const thumbnail = this.part("thumbnail");
    const image = this.part("image");
    const dialog = this.part("dialog");
    const sync = (target, name, value, force = false) => {
      if (!force && target.getAttribute(name) === value) return;
      if (value === null) target.removeAttribute(name);
      else target.setAttribute(name, value);
    };
    for (const name of ["alt", "ratio", "fit", "pixelated", "checker", "file", "src"]) {
      const source = name === "file" || name === "src";
      const value = this.getAttribute(name);
      sync(thumbnail, name, value, this.#reload && source);
      if (name !== "ratio" && name !== "fit")
        sync(image, name, source && !this.open ? null : value, this.open && this.#reload && source);
    }
    this.#reload = false;
    const label = this.getAttribute("alt") || this.getAttribute("label") || "Preview image";
    this.part("trigger").setAttribute("aria-label", this.getAttribute("label") || label);
    this.part("trigger").disabled = !(this.getAttribute("src") || this.getAttribute("file"));
    sync(dialog, "heading", label);
    sync(dialog, "close-label", this.getAttribute("close-label"));
    dialog.open = this.open;
  }
}

define("omg-image-preview", OmgImagePreview);
