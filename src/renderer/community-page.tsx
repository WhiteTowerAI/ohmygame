import type { ReactNode } from "react";
import { t } from "./i18n.js";
import { ChevronLeft } from "./icons.js";
import { PageFrame } from "./page-frame.js";
import type { AppNavigationTarget } from "./routes.js";
import { Button } from "./ui/index.js";
import { WindowDragRegion } from "./window-drag-region.js";
import "./community.css";

/**
 * A Community page in the frame: one scrolling column with a title row. Pages
 * under the list (a game, a creator) lead the row with a way back to it. It
 * takes the frame's page layout, so its width and margins match the other pages.
 */
export function CommunityPage({
  title,
  actions,
  onBack,
  children,
  onNavigate,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
  children: ReactNode;
  onNavigate: (page: AppNavigationTarget) => void;
}) {
  return (
    <PageFrame active="community" onNavigate={onNavigate}>
      <main className="sidebar-page community-page">
        <WindowDragRegion />
        <div className="sidebar-page-inner community-page-body">
          <header className="sidebar-page-header community-page-head">
            {onBack ? (
              <Button
                variant="ghost"
                className="community-back"
                icon={<ChevronLeft size={14} />}
                onClick={onBack}
              >
                {t("community.title")}
              </Button>
            ) : null}
            {title ? <h1>{title}</h1> : null}
            <span className="community-spacer" />
            {actions}
          </header>
          {children}
        </div>
      </main>
    </PageFrame>
  );
}

/** Loading, empty and error states, centered where the grid would be. */
export function CommunityState({
  children,
  tone,
  action,
}: {
  children: ReactNode;
  tone?: "error";
  action?: ReactNode;
}) {
  return (
    <div
      className={`community-state${tone ? ` is-${tone}` : ""}`}
      role={tone === "error" ? "alert" : undefined}
    >
      <span>{children}</span>
      {action}
    </div>
  );
}
