import { AppSidebar } from "./app-sidebar.js";
import type { SidebarPage } from "./routes.js";

export function EmptyPage({ page, onNavigate }: { page: SidebarPage; onNavigate: (page: SidebarPage) => void }) {
  return (
    <main className="home-shell">
      <AppSidebar active={page} onNavigate={onNavigate} />
      <section className="home-content" aria-label={`${page} page`} />
    </main>
  );
}
