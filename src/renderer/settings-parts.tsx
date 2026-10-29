import type { ReactNode } from "react";
import { ChevronLeft } from "./icons.js";
import { IconButton } from "./ui/index.js";
import { t } from "./i18n.js";

/** One setting: what it is on the left, the control on the right. */
export function SettingsRow({
  title,
  description,
  icon,
  onClick,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /**
   * Makes the whole row open something (a detail page). The row's controls
   * still need a button for the keyboard; a click on them doesn't reach the row.
   */
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`settings-row${onClick ? " is-link" : ""}${className ? ` ${className}` : ""}`}
      onClick={onClick}
    >
      {icon ? <span className="settings-row-icon">{icon}</span> : null}
      <div className="settings-row-text">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      {children ? (
        <div
          className="settings-row-control"
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A titled card of rows. `actions` sit at the right of the title. */
export function SettingsGroup({
  title,
  description,
  actions,
  bare = false,
  label,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** No card: for content that lays itself out (theme tiles, notes). */
  bare?: boolean;
  /** Names the group for screen readers when the title isn't plain text. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`settings-group${className ? ` ${className}` : ""}`}
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
    >
      {title || actions ? (
        <header>
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? (
            <div className="settings-group-actions">{actions}</div>
          ) : null}
        </header>
      ) : null}
      {bare ? children : <div className="settings-card">{children}</div>}
    </section>
  );
}

/**
 * The head of a page one step into a section (an agent, a provider): back to
 * the list, its mark, its name and what it is, then its own controls.
 */
export function SettingsDetailHead({
  mark,
  title,
  description,
  onBack,
  backLabel = t("common.back"),
  children,
}: {
  mark?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  onBack: () => void;
  backLabel?: string;
  children?: ReactNode;
}) {
  return (
    <header className="settings-detail-head">
      <IconButton label={backLabel} onClick={onBack}>
        <ChevronLeft size={18} />
      </IconButton>
      {mark ? <span className="settings-detail-mark">{mark}</span> : null}
      <div className="settings-detail-title">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {children ? (
        <div className="settings-detail-actions">{children}</div>
      ) : null}
    </header>
  );
}

/** A small label beside a name: 默认, 推荐, a plan. */
export function SettingsBadge({
  tone = "outline",
  children,
}: {
  tone?: "outline" | "ink" | "success" | "danger";
  children: ReactNode;
}) {
  return <span className={`settings-badge is-${tone}`}>{children}</span>;
}

/** A line that needs attention: an error, a result, or a waiting state. */
export function SettingsNote({
  tone = "neutral",
  role,
  children,
}: {
  tone?: "neutral" | "success" | "danger";
  role?: "alert" | "status";
  children: ReactNode;
}) {
  return (
    <div
      className={`settings-note is-${tone}`}
      role={role ?? (tone === "danger" ? "alert" : undefined)}
    >
      {children}
    </div>
  );
}
