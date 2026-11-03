import { type ReactNode, useEffect, useState } from "react";
import { t } from "./i18n.js";

/** Windows draws no title bar of its own here: the app lays the window's controls over its content. */
function hasWindowsWindowControls(): boolean {
  return window.ohMyGameDesktop?.platform === "win32" && !!window.ohMyGameDesktop.windowControls;
}

/** Puts the application menu in the app's language. A language change reloads the page, which sends it again. */
export function sendApplicationMenuLabels(): void {
  void window.ohMyGameDesktop?.windowMenu?.setLabels(t("windowMenu", { returnObjects: true })).catch(() => undefined);
}

export function DesktopWindowFrame({ children }: { children: ReactNode }) {
  if (!hasWindowsWindowControls()) return children;

  return <div className="desktop-window-frame">
    <div className="desktop-window-content">{children}</div>
    <DesktopWindowControls />
  </div>;
}

// The window's controls, over the content's top right corner. The page's own
// rows stay in place and start at the window's top; the controls take no space.
function DesktopWindowControls() {
  const controls = window.ohMyGameDesktop!.windowControls!;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    void controls.state().then((state) => {
      if (active) setMaximized(state.maximized);
    }, () => undefined);
    const stop = controls.onState((state) => setMaximized(state.maximized));
    return () => {
      active = false;
      stop();
    };
  }, [controls]);

  return <div className="desktop-window-controls">
    <button type="button" aria-label={t("windowControls.minimize")} title={t("windowControls.minimize")}
      onClick={() => void controls.minimize().catch(() => undefined)}>
      <svg className="desktop-window-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5 5.5h9" /></svg>
    </button>
    <button type="button" aria-label={maximized ? t("windowControls.restore") : t("windowControls.maximize")}
      title={maximized ? t("windowControls.restore") : t("windowControls.maximize")}
      onClick={() => void controls.toggleMaximize().catch(() => undefined)}>
      {maximized
        ? <svg className="desktop-window-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5v-2h7v7h-2" /><rect x=".5" y="2.5" width="7" height="7" /></svg>
        : <svg className="desktop-window-glyph" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" /></svg>}
    </button>
    <button type="button" className="desktop-window-close" aria-label={t("windowControls.close")}
      title={t("windowControls.close")} onClick={() => void controls.close().catch(() => undefined)}>
      <svg className="desktop-window-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="m1 1 8 8m0-8-8 8" /></svg>
    </button>
  </div>;
}
