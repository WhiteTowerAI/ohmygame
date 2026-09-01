import type { ReactNode } from "react";
import { AppSidebar } from "./app-sidebar.js";
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

export function SidebarPageHeader({ actions, children, title }: {
  actions?: ReactNode;
  children?: ReactNode;
  title: string;
}) {
  return (
    <header className="sidebar-page-header">
      <div className="sidebar-page-title-row">
        <h1>{title}</h1>
        {actions}
      </div>
      {children ? <div className="sidebar-page-toolbar">{children}</div> : null}
    </header>
  );
}
