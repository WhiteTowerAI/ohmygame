import { Check, ChevronDown, Search, Settings, type IconComponent } from "./icons.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { menuPlacement } from "./popover-placement.js";

export interface CanvasChipOption<Value extends string> {
  value: Value;
  label: string;
  /** A compact label for the trigger; the menu keeps the full label. */
  shortLabel?: string;
  /** Options sharing a group are listed under its heading, like the Home model picker's providers. */
  group?: string;
}

/** A line under a group heading, such as why a connected provider has no models. */
export interface CanvasChipNote {
  group: string;
  message: string;
}

const SEARCH_THRESHOLD = 10;

/**
 * The pill-shaped picker used in canvas node composers, matching the Home
 * composer's chips. The menu renders in body so the canvas cannot clip it.
 */
export function CanvasChipSelect<Value extends string>({ label, value, options, placeholder, disabled = false, wide = false, notes = [], action, optionAction, menuContainer, onChange }: {
  label: string;
  value: Value | undefined;
  options: readonly CanvasChipOption<Value>[];
  placeholder?: string;
  disabled?: boolean;
  /** Lets the chip take the spare width, as the model picker does. */
  wide?: boolean;
  notes?: readonly CanvasChipNote[];
  /** A footer entry, such as opening provider settings. */
  action?: { label: string; icon?: IconComponent; onSelect: () => void };
  optionAction?: { label: (option: CanvasChipOption<Value>) => string; icon: IconComponent; onSelect: (value: Value, anchor: DOMRect) => void };
  /** Keeps a nested picker inside its parent overlay's focus and dismissal boundary. */
  menuContainer?: HTMLElement | null;
  onChange: (value: Value) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<{ top: number; left: number; minWidth: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = options.find((option) => option.value === value);
  const text = current?.shortLabel ?? current?.label ?? placeholder ?? "Select";
  const searchable = options.length > SEARCH_THRESHOLD;
  const ActionIcon = action?.icon ?? Settings;
  const OptionActionIcon = optionAction?.icon;
  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery
    ? options.filter((option) => `${option.label} ${option.group ?? ""}`.toLowerCase().includes(normalizedQuery))
    : options;
  const groups = groupOptions(visible, normalizedQuery ? [] : notes);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    // Scrolling a long list must stay in the menu; only wheel elsewhere moves the canvas.
    const closeOnCanvasWheel = (event: WheelEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        close();
        trigger.current?.focus();
      }
    };
    // The menu is fixed to the viewport, so panning or zooming the canvas would leave it behind.
    document.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("wheel", closeOnCanvasWheel, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("wheel", closeOnCanvasWheel, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      setQuery("");
      return;
    }
    const anchor = trigger.current?.getBoundingClientRect();
    const popup = menu.current?.getBoundingClientRect();
    if (!anchor || !popup) return;
    const minWidth = Math.max(anchor.width, groups.length > 1 || notes.length ? 220 : optionAction ? 180 : 120);
    const placement = menuPlacement(anchor, { width: Math.max(popup.width, minWidth), height: popup.height }, { width: window.innerWidth, height: window.innerHeight }, "start");
    setPosition({ ...placement, minWidth });
    // Placement only depends on the menu as it first opens; filtering must not move it.
  }, [open]);

  useEffect(() => {
    if (!open || !position) return;
    if (searchable) search.current?.focus();
    else menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"], [aria-checked="true"]')?.focus();
  }, [open, position, searchable]);

  function choose(option: CanvasChipOption<Value>): void {
    setOpen(false);
    trigger.current?.focus();
    if (option.value !== value) onChange(option.value);
  }

  return <>
    <button
      ref={trigger}
      className={`canvas-chip${wide ? " is-wide" : ""}`}
      type="button"
      title={`${label}: ${current?.group ? `${current.group} · ` : ""}${current?.label ?? text}`}
      aria-label={`${label}: ${current?.label ?? text}`}
      aria-haspopup={optionAction ? "menu" : "listbox"}
      aria-expanded={open}
      disabled={disabled || (options.length === 0 && notes.length === 0 && !action)}
      onClick={() => setOpen((next) => !next)}
    >
      <span>{text}</span>
      <ChevronDown size={12} />
    </button>
    {open ? createPortal(
      <div
        ref={menu}
        className="canvas-chip-menu nodrag nowheel"
        style={position ?? { top: 0, left: 0, visibility: "hidden" }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          } else moveFocus(event, menu.current, search.current);
        }}
      >
        {searchable ? <label className="canvas-chip-menu-search">
          <Search size={13} />
          <input
            ref={search}
            value={query}
            placeholder={`Search ${label.toLowerCase()}s`}
            aria-label={`Search ${label.toLowerCase()}s`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const first = visible[0];
              if (first) choose(first);
            }}
          />
        </label> : null}
        <div className="canvas-chip-menu-list" role={optionAction ? "menu" : "listbox"} aria-label={label}>
          {groups.map((group) => (
            <div className="canvas-chip-menu-group" role={group.name ? "group" : undefined} aria-label={group.name} key={group.name ?? ""}>
              {group.name && (groups.length > 1 || group.notes.length) ? <div className="canvas-chip-menu-heading">{group.name}</div> : null}
              {group.options.map((option) => {
                const selected = option.value === value;
                const choice = <button type="button" role={optionAction ? "menuitemradio" : "option"} aria-selected={optionAction ? undefined : selected} aria-checked={optionAction ? selected : undefined} key={option.value} onClick={() => choose(option)}>
                  <span>{option.label}</span>
                  {selected ? <Check size={13} /> : null}
                </button>;
                return optionAction && OptionActionIcon ? <div className="canvas-chip-menu-row" key={option.value}>
                  {choice}
                  <button type="button" className="canvas-chip-option-action" role="menuitem" title={optionAction.label(option)} aria-label={optionAction.label(option)} onClick={(event) => {
                    const anchor = event.currentTarget.getBoundingClientRect();
                    setOpen(false);
                    optionAction.onSelect(option.value, anchor);
                  }}><OptionActionIcon size={14} /></button>
                </div> : choice;
              })}
              {group.notes.map((note) => <p className="canvas-chip-menu-note" key={note}>{note}</p>)}
            </div>
          ))}
          {normalizedQuery && visible.length === 0 ? <p className="canvas-chip-menu-note">No matches</p> : null}
          {!normalizedQuery && options.length === 0 && notes.length === 0 ? <p className="canvas-chip-menu-note">{placeholder ?? "Nothing to choose"}</p> : null}
        </div>
        {action ? <button
          type="button"
          className="canvas-chip-menu-action"
          onClick={() => {
            setOpen(false);
            action.onSelect();
          }}
        ><ActionIcon size={13} /><span>{action.label}</span></button> : null}
      </div>,
      menuContainer ?? document.body,
    ) : null}
  </>;
}

function groupOptions<Value extends string>(options: readonly CanvasChipOption<Value>[], notes: readonly CanvasChipNote[]) {
  const groups = new Map<string | undefined, { name?: string; options: CanvasChipOption<Value>[]; notes: string[] }>();
  const groupFor = (name: string | undefined) => {
    let group = groups.get(name);
    if (!group) {
      group = { ...(name ? { name } : {}), options: [], notes: [] };
      groups.set(name, group);
    }
    return group;
  };
  for (const option of options) groupFor(option.group).options.push(option);
  for (const note of notes) groupFor(note.group).notes.push(note.message);
  return [...groups.values()];
}

function moveFocus(event: React.KeyboardEvent, menu: HTMLDivElement | null, search: HTMLInputElement | null): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="option"], [role="menuitemradio"], [role="menuitem"], .canvas-chip-menu-action') ?? [])];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowUp" && index <= 0) {
    search?.focus();
    return;
  }
  const next = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : index - 1;
  items[next]?.focus();
}
