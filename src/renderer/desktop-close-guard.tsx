import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { desktopSave } from "./desktop-save.js";
import { CanvasNotice } from "./canvas-notice.js";
import { LoaderCircle } from "./icons.js";

export function useDesktopClosing(): boolean {
  return useSyncExternalStore(desktopSave.subscribe, desktopSave.getSnapshot, desktopSave.getSnapshot).closing;
}

export function useDesktopSave(save: () => Promise<void>): void {
  const latest = useRef(save);
  latest.current = save;
  useLayoutEffect(() => desktopSave.register(() => latest.current()), []);
}

export function DesktopCloseGuard({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(desktopSave.subscribe, desktopSave.getSnapshot, desktopSave.getSnapshot);
  useEffect(() => {
    const bridge = window.ohMyGameDesktop;
    const prepare = bridge?.onPrepareClose?.(() => desktopSave.prepare());
    const cancel = bridge?.onCancelClose?.((error) => desktopSave.cancel(error));
    return () => { prepare?.(); cancel?.(); };
  }, []);
  return <>
    <div className="desktop-close-content" inert={state.closing || undefined}>{children}</div>
    {state.closing ? <div className="desktop-close-status" role="status"><LoaderCircle size={12} className="spin" />Saving before closing…</div> : state.error ?
      <CanvasNotice className="desktop-close-notice" message="Could not close. Your workspace is still open." detail={state.error} onDismiss={() => desktopSave.cancel()} /> : null}
  </>;
}
