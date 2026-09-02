import type { ReactNode } from "react";
import { AppSidebar } from "./app-sidebar.js";
import { ChevronRight } from "./icons.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { WindowDragRegion } from "./window-drag-region.js";

export function SidebarPageLayout({ active, children, onNavigate }: {
  active: SidebarPage;
  children: ReactNode;
  onNavigate: (page: AppNavigationTarget) => void;
}) {
  return (
    <main className="home-shell">
      <AppSidebar active={active} onNavigate={onNavigate} />
      <section className="sidebar-page">
        <WindowDragRegion />
        <div className="sidebar-page-inner">{children}</div>
      </section>
    </main>
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
          <nav className="sidebar-page-breadcrumb" aria-label="Breadcrumb">
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
