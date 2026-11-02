import { type MouseEvent, type ReactNode } from "react";
import { useHistoryState } from "./app-sidebar.js";
import { leave } from "./command-menu.js";
import { ArrowLeft, ArrowRight } from "./icons.js";
import { t } from "./i18n.js";

const WINDOW_MENU_LABELS = ["File", "Edit", "View", "Window"] as const;

/** Windows draws no title bar of its own here: the app's holds its menus and back and forward. */
export function hasWindowsTitleBar(): boolean {
  return window.ohMyGameDesktop?.platform === "win32" && !!window.ohMyGameDesktop.windowMenu;
}

export function DesktopWindowFrame({ children }: { children: ReactNode }) {
  if (!hasWindowsTitleBar()) return children;

  return <div className="desktop-window-frame">
    <DesktopWindowMenu />
    <div className="desktop-window-content">{children}</div>
  </div>;
}

// The title bar: the window's menus, then back and forward, which leave an
// open project through its guard so its design saves first. The system draws
// the window controls over its right end.
function DesktopWindowMenu() {
  const windowMenu = window.ohMyGameDesktop!.windowMenu!;
  const history = useHistoryState();

  function openMenu(label: typeof WINDOW_MENU_LABELS[number], event: MouseEvent<HTMLButtonElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    void windowMenu.popup(label, bounds.left, bounds.bottom).catch(() => undefined);
  }

  return <header className="desktop-window-menu-bar">
    <div role="menubar" aria-label={t("sidebar.applicationMenu")}>
      {WINDOW_MENU_LABELS.map((label) => <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        key={label}
        onClick={(event) => openMenu(label, event)}
      >{label}</button>)}
    </div>
    <nav className="desktop-window-history" aria-label={t("sidebar.history")}>
      <button type="button" aria-label={t("sidebar.back")} title={t("sidebar.back")} disabled={!history.back}
        onClick={() => leave(() => window.history.back())}><ArrowLeft size={14} /></button>
      <button type="button" aria-label={t("sidebar.forward")} title={t("sidebar.forward")} disabled={!history.forward}
        onClick={() => leave(() => window.history.forward())}><ArrowRight size={14} /></button>
    </nav>
  </header>;
}
