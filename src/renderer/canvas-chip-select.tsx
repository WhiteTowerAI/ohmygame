import { Check, ChevronDown } from "./icons.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { menuPlacement } from "./popover-placement.js";

export interface CanvasChipOption<Value extends string> {
  value: Value;
  label: string;
}

/**
 * The pill-shaped picker used in canvas node composers, matching the Home
 * composer's chips. The menu renders in body so the canvas cannot clip it.
 */
export function CanvasChipSelect<Value extends string>({ label, value, options, placeholder, disabled = false, wide = false, onChange }: {
  label: string;
  value: Value | undefined;
  options: readonly CanvasChipOption<Value>[];
  placeholder?: string;
  disabled?: boolean;
  /** Lets the chip take the spare width, as the model picker does. */
  wide?: boolean;
  onChange: (value: Value) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; minWidth: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);
  const text = current?.label ?? placeholder ?? "Select";

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // The menu is fixed to the viewport, so panning or zooming the canvas would leave it behind.
    document.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("wheel", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    const anchor = trigger.current?.getBoundingClientRect();
    const popup = menu.current?.getBoundingClientRect();
    if (!anchor || !popup) return;
    const minWidth = Math.max(anchor.width, 120);
    const placement = menuPlacement(anchor, { width: Math.max(popup.width, minWidth), height: popup.height }, { width: window.innerWidth, height: window.innerHeight }, "start");
    setPosition({ ...placement, minWidth });
  }, [open]);

  useEffect(() => {
    if (!open || !position) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [open, position]);

  return <>
    <button
      ref={trigger}
      className={`canvas-chip${wide ? " is-wide" : ""}`}
      type="button"
      title={`${label}: ${text}`}
      aria-label={`${label}: ${text}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled || options.length === 0}
      onClick={() => setOpen((next) => !next)}
    >
      <span>{text}</span>
      <ChevronDown size={12} />
    </button>
    {open ? createPortal(
      <div
        ref={menu}
        className="canvas-chip-menu nodrag nowheel"
        role="listbox"
        aria-label={label}
        style={position ?? { top: 0, left: 0, visibility: "hidden" }}
        onKeyDown={(event) => moveFocus(event, menu.current)}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return <button
            type="button"
            role="option"
            aria-selected={selected}
            key={option.value}
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
              if (!selected) onChange(option.value);
            }}
          >
            <span>{option.label}</span>
            {selected ? <Check size={13} /> : null}
          </button>;
        })}
      </div>,
      document.body,
    ) : null}
  </>;
}

function moveFocus(event: React.KeyboardEvent, menu: HTMLDivElement | null): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
  items[next]?.focus();
}
