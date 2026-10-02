const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * Places a popup under its trigger, flipping above when there is no room below,
 * and keeps it inside the viewport. `align` picks which trigger edge it lines up with.
 */
export function menuPlacement(
  anchor: Pick<DOMRect, "top" | "bottom" | "right"> & Partial<Pick<DOMRect, "left">>,
  popup: Pick<DOMRect, "width" | "height">,
  viewport: { width: number; height: number },
  align: "start" | "end" = "end",
): { top: number; left: number } {
  const below = anchor.bottom + MENU_GAP;
  const above = anchor.top - MENU_GAP - popup.height;
  const fitsBelow = below + popup.height <= viewport.height - VIEWPORT_MARGIN;
  const top = fitsBelow || above < VIEWPORT_MARGIN ? Math.max(VIEWPORT_MARGIN, Math.min(below, viewport.height - VIEWPORT_MARGIN - popup.height)) : above;
  const preferredLeft = align === "start" ? anchor.left ?? anchor.right - popup.width : anchor.right - popup.width;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, viewport.width - VIEWPORT_MARGIN - popup.width));
  return { top, left };
}
