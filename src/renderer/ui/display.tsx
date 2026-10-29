import {
  useId,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  InfoCircle,
  TriangleAlert,
} from "../icons.js";
import { t } from "../i18n.js";
import "./display.css";

/** The category hues in tokens.css; a category color always means the same kind of thing. */
export type Category =
  "document" | "text" | "image" | "video" | "audio" | "model" | "code" | "data";

export function Badge({
  tone = "neutral",
  category,
  children,
}: {
  tone?: "neutral" | "success" | "danger" | "ink" | "outline";
  category?: Category;
  children: ReactNode;
}) {
  return (
    <span
      className={`ui-badge ui-badge-${tone}`}
      style={
        category
          ? ({
              "--ui-badge-color": `var(--category-${category})`,
            } as CSSProperties)
          : undefined
      }
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

/** Initials over a color derived from the name, or an image. */
export function Avatar({
  name,
  src,
  size = 28,
}: {
  name: string;
  src?: string;
  size?: number;
}) {
  const hue =
    [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return (
    <span
      className="ui-avatar"
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: src ? undefined : `oklch(0.62 0.09 ${hue})`,
      }}
    >
      {src ? <img src={src} alt="" /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AvatarStack({
  names,
  max = 3,
}: {
  names: readonly string[];
  max?: number;
}) {
  return (
    <span className="ui-avatar-stack">
      {names.slice(0, max).map((name) => (
        <Avatar key={name} name={name} size={22} />
      ))}
      {names.length > max ? (
        <span
          className="ui-avatar ui-avatar-more"
          style={{ width: 22, height: 22 }}
        >
          +{names.length - max}
        </span>
      ) : null}
    </span>
  );
}

export function Card({
  interactive = false,
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={`ui-card${interactive ? " is-interactive" : ""} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

/** One row: a leading visual, a title with a description, and trailing content. */
export function Item({
  leading,
  title,
  description,
  trailing,
  onClick,
  selected = false,
}: {
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
}) {
  const content = (
    <>
      {leading ? <span className="ui-item-leading">{leading}</span> : null}
      <span className="ui-item-text">
        <span className="ui-item-title">{title}</span>
        {description ? (
          <span className="ui-item-description">{description}</span>
        ) : null}
      </span>
      {trailing ? <span className="ui-item-trailing">{trailing}</span> : null}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={`ui-item is-interactive${selected ? " is-selected" : ""}`}
      aria-current={selected || undefined}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className="ui-item">{content}</div>
  );
}

export function Progress({
  value,
  label,
  tone = "ink",
}: {
  value: number;
  label?: string;
  tone?: "ink" | "image" | "success";
}) {
  return (
    <span
      className={`ui-progress ui-progress-${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span
        style={{
          width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`,
        }}
      />
    </span>
  );
}

export function Spinner({
  size = 16,
  label,
}: {
  size?: number;
  label?: string;
}) {
  return (
    <span
      className="ui-spinner"
      role="status"
      aria-label={label ?? t("ui.loading")}
      style={{ width: size, height: size }}
    />
  );
}

export function Skeleton({
  width = "100%",
  height = 12,
  radius = 6,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
}) {
  return (
    <span
      className="ui-skeleton"
      aria-hidden="true"
      style={{ width, height, borderRadius: radius }}
    />
  );
}

export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      {icon ? <span className="ui-empty-icon">{icon}</span> : null}
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "success" | "danger";
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon =
    tone === "success"
      ? CircleCheck
      : tone === "danger"
        ? TriangleAlert
        : InfoCircle;
  return (
    <div
      className={`ui-alert ui-alert-${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon size={16} className="ui-alert-icon" />
      <div className="ui-alert-text">
        <strong>{title}</strong>
        {children ? <span>{children}</span> : null}
      </div>
      {action ? <span className="ui-alert-action">{action}</span> : null}
    </div>
  );
}

export function Separator({ label }: { label?: ReactNode }) {
  return label ? (
    <div className="ui-separator ui-separator-label" role="separator">
      <span>{label}</span>
    </div>
  ) : (
    <hr className="ui-separator" />
  );
}

/** Tabs, underlined or as pills (for category filters); the panels are the caller's. */
export function Tabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
  variant = "underline",
}: {
  label: string;
  value: T;
  tabs: readonly {
    value: T;
    label: ReactNode;
    icon?: ReactNode;
    count?: number;
  }[];
  onChange: (value: T) => void;
  variant?: "underline" | "pills";
}) {
  return (
    <div
      className={`ui-tabs ui-tabs-${variant}`}
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        const index = tabs.findIndex((tab) => tab.value === value);
        const next =
          tabs[
            (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length
          ];
        if (!next) return;
        onChange(next.value);
        const buttons =
          event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]");
        buttons[tabs.indexOf(next)]?.focus();
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          tabIndex={tab.value === value ? 0 : -1}
          className={`ui-tab${tab.value === value ? " is-selected" : ""}`}
          onClick={() => onChange(tab.value)}
        >
          {tab.icon ? (
            <span className="ui-tab-icon" aria-hidden="true">
              {tab.icon}
            </span>
          ) : null}
          {tab.label}
          {tab.count !== undefined ? (
            <span className="ui-tab-count">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function Breadcrumb({
  items,
}: {
  items: readonly { label: ReactNode; onClick?: () => void }[];
}) {
  return (
    <nav className="ui-breadcrumb" aria-label={t("ui.breadcrumb")}>
      {items.map((item, index) => (
        <span key={index} className="ui-breadcrumb-item">
          {index ? (
            <ChevronRight size={12} className="ui-breadcrumb-separator" />
          ) : null}
          {item.onClick && index < items.length - 1 ? (
            <button type="button" onClick={item.onClick}>
              {item.label}
            </button>
          ) : (
            <span
              aria-current={index === items.length - 1 ? "page" : undefined}
            >
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** A section that folds open; several can be open at once. */
export function Collapsible({
  title,
  meta,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={`ui-collapsible${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="ui-collapsible-trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown size={14} className="ui-collapsible-caret" />
        <span className="ui-collapsible-title">{title}</span>
        {meta ? <span className="ui-collapsible-meta">{meta}</span> : null}
      </button>
      {open ? (
        <div id={id} className="ui-collapsible-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface Column<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  width?: string;
  align?: "left" | "right";
}

export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  label,
}: {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  label: string;
}) {
  return (
    <div className="ui-table-wrap">
      <table className="ui-table" aria-label={label}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={{ textAlign: column.align }}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? "is-interactive" : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td key={column.key} style={{ textAlign: column.align }}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A labelled value with an optional change, for summary rows. */
export function Stat({
  label,
  value,
  note,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="ui-stat">
      <span className="ui-stat-label">{label}</span>
      <span className="ui-stat-value">{value}</span>
      {note ? <span className="ui-stat-note">{note}</span> : null}
    </div>
  );
}
