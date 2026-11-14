// Shared mechanics for panel-local overlays. The browser's top layer escapes
// clipping ancestors, but deliberately stays within the plugin's iframe.
import { css, containsFocus } from "./base.js";

export const FLOATING = css(`
  .floating {
    position: fixed; inset: auto; margin: 0; border: 0; padding: var(--space-1);
    max-width: calc(100vw - 16px); max-height: min(420px, calc(100vh - 16px)); overflow: auto;
    border-radius: var(--radius-lg); background: var(--color-surface-raised);
    color: var(--color-text); box-shadow: var(--shadow-float); font: inherit;
  }
`);

const opened = [];

/** One overlay's listeners and observers live exactly as long as it is open. */
export class Floating {
  constructor(host, anchor, panel, dismiss, placement = () => "bottom-start") {
    this.host = host;
    this.anchor = anchor;
    this.panel = panel;
    this.dismiss = dismiss;
    this.placement = placement;
  }

  show() {
    if (this.stop) {
      this.position();
      return;
    }
    this.panel.hidden = false;
    this.panel.showPopover();
    opened.push(this);
    const dismissOutside = (event) => {
      if (opened.at(-1) === this && !event.composedPath().includes(this.host))
        this.dismiss(false);
    };
    const key = (event) => {
      if (opened.at(-1) === this && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.dismiss(containsFocus(this.host));
      }
    };
    const position = () => this.position();
    const win = this.host.ownerDocument.defaultView;
    const resized = new ResizeObserver(position);
    resized.observe(this.anchor);
    resized.observe(this.panel);
    win.addEventListener("resize", position);
    win.addEventListener("scroll", position, true);
    this.host.ownerDocument.addEventListener(
      "pointerdown",
      dismissOutside,
      true,
    );
    this.host.ownerDocument.addEventListener("keydown", key, true);
    // Observe the destination, not activeElement during focusout: Chromium can
    // temporarily report body between a top-layer panel and its slotted input.
    this.host.ownerDocument.addEventListener("focusin", dismissOutside, true);
    this.stop = () => {
      resized.disconnect();
      win.removeEventListener("resize", position);
      win.removeEventListener("scroll", position, true);
      this.host.ownerDocument.removeEventListener(
        "pointerdown",
        dismissOutside,
        true,
      );
      this.host.ownerDocument.removeEventListener("keydown", key, true);
      this.host.ownerDocument.removeEventListener(
        "focusin",
        dismissOutside,
        true,
      );
      const index = opened.indexOf(this);
      if (index !== -1) opened.splice(index, 1);
    };
    this.position();
  }

  position() {
    const panel = this.panel;
    const win = this.host.ownerDocument.defaultView;
    const a = this.anchor.getBoundingClientRect();
    const placement = this.placement();
    if (this.matchWidth)
      panel.style.width = `${Math.min(a.width, Math.max(0, win.innerWidth - 16))}px`;
    const below = Math.max(0, win.innerHeight - a.bottom - 14);
    const above = Math.max(0, a.top - 14);
    const up = placement.startsWith("top")
      ? above >= panel.scrollHeight || above > below
      : below < panel.scrollHeight && above > below;
    panel.style.maxHeight = `${Math.min(420, up ? above : below)}px`;
    const { width, height } = panel.getBoundingClientRect();
    const left = placement.endsWith("end")
      ? a.right - width
      : placement === "top" || placement === "bottom"
        ? a.left + (a.width - width) / 2
        : a.left;
    panel.style.left = `${Math.max(8, Math.min(left, win.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(up ? a.top - height - 6 : a.bottom + 6, win.innerHeight - height - 8))}px`;
  }

  hide() {
    this.stop?.();
    this.stop = undefined;
    if (this.panel.isConnected && !this.panel.hidden) this.panel.hidePopover();
    this.panel.hidden = true;
  }
}
