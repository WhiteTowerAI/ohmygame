import type { ReactNode } from "react";
import { ChevronRight } from "./icons.js";
import { PageFrame } from "./page-frame.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { t } from "./i18n.js";

/** A page in the frame that scrolls as one column under its header. */
export function SidebarPageLayout({ active, children, onNavigate }: {
  active: SidebarPage;
  children: ReactNode;
  onNavigate: (page: AppNavigationTarget) => void;
}) {
  return (
    <PageFrame active={active} onNavigate={onNavigate}>
      <main className="sidebar-page">
        <WindowDragRegion />
        <div className="sidebar-page-inner">{children}</div>
      </main>
    </PageFrame>
  );
}

export function SidebarPageHeader({ actions, breadcrumb, children, title }: {
  actions?: ReactNode;
  breadcrumb?: { label: string; onClick: () => void };
  children?: ReactNode;
  title: string;
}) {
  return (
    <header className={`sidebar-page-header${breadcrumb ? " sidebar-page-header-breadcrumb" : ""}`}>
      <div className="sidebar-page-title-row">
        {breadcrumb ? (
          <nav className="sidebar-page-breadcrumb" aria-label={t("nodeWorkbench.breadcrumb")}>
            <button type="button" onClick={breadcrumb.onClick}>{breadcrumb.label}</button>
            <ChevronRight size={14} aria-hidden="true" />
            <h1>{title}</h1>
          </nav>
        ) : <h1>{title}</h1>}
        {actions}
      </div>
      {children ? <div className="sidebar-page-toolbar">{children}</div> : null}
    </header>
  );
}
