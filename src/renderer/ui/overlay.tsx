import {
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, Search, X } from "../icons.js";
import { t } from "../i18n.js";
import { IconButton } from "./button.js";
import { Kbd } from "./display.js";
import "./overlay.css";

type Placement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "top"
  | "bottom"
  | "right"
  | "right-start";

/** Fixed-position coordinates for a floating element next to an anchor, flipped when it would leave the window. */
function useAnchoredPosition(
  open: boolean,
  anchor: RefObject<Element | null>,
  floating: RefObject<HTMLElement | null>,
  placement: Placement,
  offset = 6,
) {
  // Unplaced, the panel is transparent rather than hidden, so a menu can focus
  // its first item before the position lands (it does so before paint).
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const update = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const f = floating.current;
    if (!a || !f) return;
    const { width, height } = f.getBoundingClientRect();
    let top = placement.startsWith("top")
      ? a.top - height - offset
      : placement === "right"
        ? a.top + a.height / 2 - height / 2
        : placement === "right-start"
          ? a.top
          : a.bottom + offset;
    let left = placement.endsWith("end")
      ? a.right - width
      : placement === "top" || placement === "bottom"
        ? a.left + a.width / 2 - width / 2
        : placement.startsWith("right")
          ? a.right + offset
          : a.left;
    if (
      placement.startsWith("bottom") &&
      top + height > innerHeight - 8 &&
      a.top - height - offset > 8
    )
      top = a.top - height - offset;
    if (placement.startsWith("top") && top < 8) top = a.bottom + offset;
    left = Math.min(Math.max(8, left), innerWidth - width - 8);
    top = Math.min(Math.max(8, top), innerHeight - height - 8);
    setStyle({ top, left });
  }, [anchor, floating, placement, offset]);
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ opacity: 0 });
      return;
    }
    update();
    addEventListener("resize", update);
    addEventListener("scroll", update, true);
    // A panel whose content changes size, as a list switching views, is placed again.
    const resized = new ResizeObserver(update);
    if (floating.current) resized.observe(floating.current);
    return () => {
      removeEventListener("resize", update);
      removeEventListener("scroll", update, true);
      resized.disconnect();
    };
  }, [open, update]);
  return style;
}

/** Closes on a press outside `refs` or on Escape; `refs[0]` is the anchor, which gets focus back from inside. */
function useDismiss(
  open: boolean,
  onClose: () => void,
  refs: RefObject<HTMLElement | null>[],
) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (refs.some((ref) => ref.current?.contains(event.target as Node)))
        return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        const focused = refs.some((ref) => ref.current?.contains(document.activeElement));
        onClose();
        if (focused) refs[0]?.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, refs]);
}

// ---------- Popover ----------

/** A floating panel anchored to `anchor`. The caller owns `open`. */
export function Popover({
  open,
  onClose,
  anchor,
  placement = "bottom-start",
  matchWidth = false,
  className = "",
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  placement?: Placement;
  matchWidth?: boolean;
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const style = useAnchoredPosition(open, anchor, panel, placement);
  const refs = useRef([anchor, panel]).current;
  useDismiss(open, onClose, refs);
  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      className={`ui-popover ${className}`}
      role="dialog"
      aria-label={label}
      style={{
        ...style,
        ...(matchWidth && anchor.current
          ? { minWidth: anchor.current.offsetWidth }
          : {}),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------- Tooltip ----------

/** Shows `content` after a short hover or on keyboard focus. The child must accept a ref and event props. */
// A tooltip waits before showing, so passing over a control shows nothing. Once
// one has shown, the next shows at once while the pointer moves along a row of
// controls; after a short rest away from them, the wait comes back.
const TOOLTIP_DELAY = 350;
const TOOLTIP_WARM = 300;
let tooltipsWarmUntil = 0;

export function Tooltip({
  content,
  placement = "top",
  children,
}: {
  content: ReactNode;
  placement?: Placement;
  children: ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  const id = useId();
  const style = useAnchoredPosition(open, anchor, tip, placement);
  const show = () => {
    window.clearTimeout(timer.current);
    if (Date.now() < tooltipsWarmUntil) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), TOOLTIP_DELAY);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    if (open) tooltipsWarmUntil = Date.now() + TOOLTIP_WARM;
    setOpen(false);
  };
  // A tooltip that goes away while showing, as when the page changes, warms the next too.
  const shown = useRef(false);
  shown.current = open;
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (shown.current) tooltipsWarmUntil = Date.now() + TOOLTIP_WARM;
  }, []);
  if (!isValidElement(children)) return children;
  return (
    <>
      {cloneElement(children, {
        ref: (node: HTMLElement | null) => {
          anchor.current = node;
        },
        onPointerEnter: show,
        onPointerLeave: hide,
        onFocus: () => setOpen(true),
        onBlur: hide,
        "aria-describedby": open ? id : undefined,
      })}
      {open
        ? createPortal(
            <div
              ref={tip}
              id={id}
              role="tooltip"
              className="ui-tooltip"
              style={style}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ---------- Menu ----------

export interface MenuItem {
  label: ReactNode;
  /** A second line under the label. */
  description?: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Makes it a checkbox item; a check shows while it is on. */
  checked?: boolean;
  onSelect?: () => void;
}
export type MenuEntry = MenuItem | "separator" | { heading: string };

function MenuList({
  items,
  onClose,
}: {
  items: readonly MenuEntry[];
  onClose: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Labels line up past an icon column only when some item has an icon.
  const hasIcons = items.some((item) => typeof item === "object" && "label" in item && item.icon);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, []);
  const move = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[
      (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
        buttons.length
    ]?.focus();
  };
  return (
    <div ref={list} className="ui-menu" role="menu" onKeyDown={move}>
      {items.map((item, index) =>
        item === "separator" ? (
          <div key={index} className="ui-menu-separator" role="separator" />
        ) : "heading" in item ? (
          <div key={index} className="ui-menu-heading">
            {item.heading}
          </div>
        ) : (
          <button
            key={index}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            disabled={item.disabled}
            className={`ui-menu-item${item.danger ? " is-danger" : ""}${item.description ? " has-description" : ""}`}
            onClick={() => {
              item.onSelect?.();
              onClose();
            }}
          >
            {hasIcons ? (
              <span className="ui-menu-icon" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            <span className="ui-menu-label">
              {item.label}
              {item.description ? (
                <small className="ui-menu-description">
                  {item.description}
                </small>
              ) : null}
            </span>
            {item.shortcut ? (
              <kbd className="ui-menu-shortcut">{item.shortcut}</kbd>
            ) : null}
            {item.checked ? (
              <Check size={14} className="ui-menu-check" aria-hidden="true" />
            ) : null}
          </button>
        ),
      )}
    </div>
  );
}

/** A dropdown menu opened by `trigger`, which receives the toggle props. */
export function DropdownMenu({
  trigger,
  items,
  placement = "bottom-start",
}: {
  trigger: (props: {
    ref: RefObject<HTMLButtonElement | null>;
    onClick: () => void;
    "aria-expanded": boolean;
    "aria-haspopup": "menu";
  }) => ReactNode;
  items: readonly MenuEntry[];
  placement?: Placement;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      {trigger({
        ref: anchor,
        onClick: () => setOpen((value) => !value),
        "aria-expanded": open,
        "aria-haspopup": "menu",
      })}
      <Popover
        open={open}
        onClose={close}
        anchor={anchor}
        placement={placement}
        className="ui-popover-menu"
      >
        <MenuList
          items={items}
          onClose={() => {
            close();
            anchor.current?.focus();
          }}
        />
      </Popover>
    </>
  );
}

/** Opens `items` at the pointer on right-click inside `children`. */
export function ContextMenu({
  items,
  children,
}: {
  items: readonly MenuEntry[];
  children: ReactNode;
}) {
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setPoint(undefined), []);
  return (
    <div
      className="ui-context-area"
      onContextMenu={(event) => {
        event.preventDefault();
        setPoint({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      {point
        ? createPortal(
            <span
              ref={anchor}
              className="ui-context-anchor"
              style={{ left: point.x, top: point.y }}
            />,
            document.body,
          )
        : null}
      <Popover
        open={!!point}
        onClose={close}
        anchor={anchor}
        placement="bottom-start"
        className="ui-popover-menu"
      >
        <MenuList items={items} onClose={close} />
      </Popover>
    </div>
  );
}

// ---------- Dialog and Sheet ----------

// The open modals' panels. Only the one holding focus answers Escape and Tab
// (the innermost, when one holds another), so a menu opened over a dialog
// closes alone; with focus outside them all, the last opened answers.
const openModals: RefObject<HTMLDivElement | null>[] = [];

function modalFor(target: EventTarget | null): RefObject<HTMLDivElement | null> | undefined {
  const holding = openModals.filter((modal) => target instanceof Node && modal.current?.contains(target));
  return holding.find((modal) => holding.every((other) => other === modal || !modal.current?.contains(other.current))) ?? openModals.at(-1);
}

function useModal(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  // Read the latest onClose without re-running the effect, which would move
  // focus back to the first field on every render of an inline handler.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    openModals.push(panel);
    const previous = document.activeElement as HTMLElement | null;
    // Content that focused its own field on mount keeps it.
    if (!panel.current?.contains(document.activeElement))
      panel.current
        ?.querySelector<HTMLElement>(
          "[autofocus], input, textarea, select, button:not(.ui-dialog-close)",
        )
        ?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (modalFor(event.target) !== panel) return;
      if (event.key === "Escape" && !event.isComposing) {
        // Handled here, so a page's own Escape listener doesn't close it too.
        event.stopPropagation();
        close.current();
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [
        ...panel.current.querySelectorAll<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((el) => !el.hasAttribute("disabled"));
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openModals.splice(openModals.indexOf(panel), 1);
      previous?.focus();
    };
  }, [open]);
  return panel;
}

/** A centered modal. Closes on Esc, the close button, or a click on the backdrop. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  size = "md",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  children?: ReactNode;
}) {
  const panel = useModal(open, onClose);
  const id = useId();
  if (!open) return null;
  return createPortal(
    <div
      className="ui-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={`ui-dialog ui-dialog-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <div className="ui-dialog-head">
          <div>
            <h2 id={id} className="ui-dialog-title">
              {title}
            </h2>
            {description ? (
              <p className="ui-dialog-description">{description}</p>
            ) : null}
          </div>
          <IconButton
            size="sm"
            label={t("common.close")}
            className="ui-dialog-close"
            onClick={onClose}
          >
            <X size={16} />
          </IconButton>
        </div>
        {children ? <div className="ui-dialog-body">{children}</div> : null}
        {footer ? <div className="ui-dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface Command {
  id: string;
  label: string;
  /** The heading it lists under; commands keep their order within it. */
  group: string;
  icon?: ReactNode;
  shortcut?: string;
  /** More words it matches, such as an English name. */
  keywords?: string;
  run: () => void;
}

/**
 * The command menu: type to filter, arrows to move, Enter to run. Commands list
 * under their group's heading, in the order given.
 */
export function CommandMenu({
  open,
  onClose,
  commands,
  placeholder,
}: {
  open: boolean;
  onClose: () => void;
  commands: readonly Command[];
  placeholder?: string;
}) {
  const panel = useModal(open, onClose);
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle
      ? commands.filter((command) => `${command.label} ${command.group} ${command.keywords ?? ""}`.toLowerCase().includes(needle))
      : commands;
    // Grouped in the order the groups first appear, so the list reads top to bottom.
    const groups = [...new Set(matching.map((command) => command.group))];
    return groups.flatMap((group) => matching.filter((command) => command.group === group));
  }, [commands, query]);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  if (!open) return null;
  const run = (command?: Command) => {
    if (!command) return;
    onClose();
    command.run();
  };
  const option = (index: number) => `${id}-option-${index}`;
  return createPortal(
    <div
      className="ui-backdrop ui-command-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panel} className="ui-command" role="dialog" aria-modal="true" aria-label={t("commandMenu.label")}>
        <div className="ui-command-input">
          <Search size={16} aria-hidden="true" />
          <input
            value={query}
            placeholder={placeholder ?? t("commandMenu.placeholder")}
            aria-label={t("commandMenu.label")}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={filtered[active] ? option(active) : undefined}
            aria-autocomplete="list"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(filtered.length - 1, index + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                run(filtered[active]);
              } else if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                // Closes the menu before Escape reaches a dialog beneath that
                // listens for it on the document or window.
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={list} id={`${id}-list`} className="ui-command-list" role="listbox" aria-label={t("commandMenu.label")}>
          {filtered.length ? filtered.map((command, index) => (
            <Fragment key={command.id}>
              {command.group !== filtered[index - 1]?.group ? <div className="ui-command-heading" role="presentation">{command.group}</div> : null}
              <div
                id={option(index)}
                data-index={index}
                role="option"
                aria-selected={index === active}
                className={`ui-command-item${index === active ? " is-active" : ""}`}
                onPointerMove={() => setActive(index)}
                onClick={() => run(command)}
              >
                <span className="ui-command-icon" aria-hidden="true">{command.icon}</span>
                <span className="ui-command-label">{command.label}</span>
                {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
              </div>
            </Fragment>
          )) : <p className="ui-command-empty">{t("commandMenu.empty", { query: query.trim() })}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A panel that slides in from the right edge for details that need room. */
export function Sheet({
  open,
  onClose,
  title,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const panel = useModal(open, onClose);
  const id = useId();
  if (!open) return null;
  return createPortal(
    <div
      className="ui-backdrop ui-backdrop-sheet"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="ui-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <div className="ui-dialog-head">
          <h2 id={id} className="ui-dialog-title">
            {title}
          </h2>
          <IconButton
            size="sm"
            label={t("common.close")}
            className="ui-dialog-close"
            onClick={onClose}
          >
            <X size={16} />
          </IconButton>
        </div>
        <div className="ui-sheet-body">{children}</div>
        {footer ? <div className="ui-dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Toast ----------

interface ToastItem {
  id: number;
  title: ReactNode;
  description?: ReactNode;
  tone?: "default" | "success" | "danger";
  action?: { label: string; onClick: () => void };
}
const ToastContext = createContext<(toast: Omit<ToastItem, "id">) => void>(
  () => {},
);

/** Holds the toast stack; `useToast()` returns the function that shows one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const show = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = (next.current += 1);
    setToasts((list) => [...list.slice(-2), { ...toast, id }]);
    window.setTimeout(
      () => setToasts((list) => list.filter((item) => item.id !== id)),
      4000,
    );
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {createPortal(
        <ol className="ui-toasts" aria-live="polite">
          {toasts.map((toast) => (
            <li
              key={toast.id}
              className={`ui-toast ui-toast-${toast.tone ?? "default"}`}
              role="status"
            >
              <div className="ui-toast-text">
                <strong>{toast.title}</strong>
                {toast.description ? <span>{toast.description}</span> : null}
              </div>
              {toast.action ? (
                <button
                  type="button"
                  className="ui-toast-action"
                  onClick={toast.action.onClick}
                >
                  {toast.action.label}
                </button>
              ) : null}
            </li>
          ))}
        </ol>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
