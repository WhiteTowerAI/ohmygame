import type { ReactNode } from "react";
import {
  AppSidebar,
  useSidebarLayout,
  type SidebarActive,
} from "./app-sidebar.js";
import type { AppNavigationTarget } from "./routes.js";

/**
 * Every page outside a project: the sidebar, then one sheet holding the page.
 * The page brings its own scrolling area; `aside` adds a fixed side column
 * (the settings sections).
 */
export function PageFrame({
  active,
  aside,
  inert,
  children,
  onNavigate,
}: {
  active?: SidebarActive;
  aside?: ReactNode;
  inert?: boolean;
  children: ReactNode;
  onNavigate: (page: AppNavigationTarget) => void;
}) {
  const sidebar = useSidebarLayout();
  return (
    <div
      className={`page-frame${sidebar.className}`}
      style={sidebar.style}
      inert={inert}
    >
      <AppSidebar active={active} onNavigate={onNavigate} />
      <div className={`page-sheet${aside ? " page-sheet-with-aside" : ""}`}>
        {aside ? <aside className="page-aside">{aside}</aside> : null}
        {children}
      </div>
    </div>
  );
}
