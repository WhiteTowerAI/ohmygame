import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

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
  const [icon, setIcon] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void windowMenu.icon().then((url) => {
      if (!disposed) setIcon(url);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [windowMenu]);

  function openMenu(label: typeof WINDOW_MENU_LABELS[number], event: MouseEvent<HTMLButtonElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    void windowMenu.popup(label, bounds.left, bounds.bottom).catch(() => undefined);
  }

  return <header className="desktop-window-menu-bar" role="menubar" aria-label="Application menu">
    <span className="desktop-window-menu-icon" aria-hidden="true">
      {icon ? <img src={icon} alt="" draggable={false} /> : null}
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
