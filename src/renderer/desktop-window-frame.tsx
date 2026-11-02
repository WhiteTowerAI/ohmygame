import { type MouseEvent, type ReactNode } from "react";
import { useHistoryState } from "./app-sidebar.js";
import { leave } from "./command-menu.js";
import { ArrowLeft, ArrowRight } from "./icons.js";
import { t } from "./i18n.js";

// Each id names a menu in the English application menu, which the main process finds it by.
const WINDOW_MENUS = [
  { id: "File", label: () => t("windowMenu.file") },
  { id: "Edit", label: () => t("windowMenu.edit") },
  { id: "View", label: () => t("windowMenu.view") },
  { id: "Window", label: () => t("windowMenu.window") },
] as const;

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

  function openMenu(id: typeof WINDOW_MENUS[number]["id"], event: MouseEvent<HTMLButtonElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    const itemLabels = t("windowMenu.items", { returnObjects: true });
    void windowMenu.popup(id, bounds.left, bounds.bottom, itemLabels).catch(() => undefined);
  }

  return <header className="desktop-window-menu-bar">
    <div role="menubar" aria-label={t("sidebar.applicationMenu")}>
      {WINDOW_MENUS.map(({ id, label }) => <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        key={id}
        onClick={(event) => openMenu(id, event)}
      >{label()}</button>)}
    </div>
    <nav className="desktop-window-history" aria-label={t("sidebar.history")}>
      <button type="button" aria-label={t("sidebar.back")} title={t("sidebar.back")} disabled={!history.back}
        onClick={() => leave(() => window.history.back())}><ArrowLeft size={14} /></button>
      <button type="button" aria-label={t("sidebar.forward")} title={t("sidebar.forward")} disabled={!history.forward}
        onClick={() => leave(() => window.history.forward())}><ArrowRight size={14} /></button>
    </nav>
  </header>;
}
