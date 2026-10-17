import { type MouseEvent, type ReactNode } from "react";
import appIcon from "../../build/icon-windows.svg";
import { t } from "./i18n.js";

const WINDOW_MENU_LABELS = ["File", "Edit", "View", "Window"] as const;

export function DesktopWindowFrame({ children }: { children: ReactNode }) {
  const windowMenu = window.ohMyGameDesktop?.windowMenu;
  if (window.ohMyGameDesktop?.platform !== "win32" || !windowMenu) return children;

  return <div className="desktop-window-frame">
    <DesktopWindowMenu />
    <div className="desktop-window-content">{children}</div>
  </div>;
}

function DesktopWindowMenu() {
  const windowMenu = window.ohMyGameDesktop!.windowMenu!;

  function openMenu(label: typeof WINDOW_MENU_LABELS[number], event: MouseEvent<HTMLButtonElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    void windowMenu.popup(label, bounds.left, bounds.bottom).catch(() => undefined);
  }

  return <header className="desktop-window-menu-bar" role="menubar" aria-label={t("sidebar.applicationMenu")}>
    <span className="desktop-window-menu-icon" aria-hidden="true">
      <img src={appIcon} alt="" draggable={false} />
    </span>
    {WINDOW_MENU_LABELS.map((label) => <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      key={label}
      onClick={(event) => openMenu(label, event)}
    >{label}</button>)}
  </header>;
}
