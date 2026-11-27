import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cachedScrollTop, keepScrollTop } from "./community-cache.js";
import { t } from "./i18n.js";
import { ChevronLeft, TriangleAlert } from "./icons.js";
import { PageFrame } from "./page-frame.js";
import type { AppNavigationTarget } from "./routes.js";
import { Button, Empty } from "./ui/index.js";
import { WindowDragRegion } from "./window-drag-region.js";
import "./community.css";

/**
 * A Community page in the frame: one scrolling column with a title row. Pages
 * under the list (a game, a creator) lead the row with a way back to it. It
 * takes the frame's page layout, so its width and margins match the other pages.
 * Each `scrollKey` keeps its own scroll position, so going back to the list
 * returns to where it was and another game starts at the top.
 */
export function CommunityPage({
  title,
  actions,
  onBack,
  scrollKey,
  children,
  onNavigate,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
  scrollKey?: string;
  children: ReactNode;
  onNavigate: (page: AppNavigationTarget) => void;
}) {
  const scroller = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !scrollKey) return;
    node.scrollTop = cachedScrollTop(scrollKey);
    const save = () => keepScrollTop(scrollKey, node.scrollTop);
    node.addEventListener("scroll", save, { passive: true });
    return () => node.removeEventListener("scroll", save);
  }, [scrollKey]);
  return (
    <PageFrame active="community" onNavigate={onNavigate}>
      <main ref={scroller} className="sidebar-page community-page">
        <WindowDragRegion />
        <div className="sidebar-page-inner community-page-body">
          <header className="sidebar-page-header community-page-head">
            {onBack ? (
              <Button
                variant="ghost"
                className="community-back"
                icon={<ChevronLeft size="sm" />}
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

/** Empty and error states, centered where the grid would be. */
export function CommunityState({
  children,
  tone,
  art,
  icon,
  action,
}: {
  children: ReactNode;
  tone?: "error";
  /** A game icon, where there is nothing yet. */
  art?: ReactNode;
  /** A plain icon in the neutral tile, as for no matches. */
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="community-state">
      <Empty
        fill
        tone={tone}
        art={art}
        icon={tone === "error" ? <TriangleAlert size="md" /> : icon}
        title={children}
        action={action}
      />
    </div>
  );
}
