import { useSyncExternalStore } from "react";
import type { DesktopUpdateState } from "../shared/desktop-update.js";

// One subscription to the desktop updater, shared by the sidebar and About,
// so both show the same state and the bridge is asked only once.
let current: DesktopUpdateState | null = null;
let unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();

function publish(state: DesktopUpdateState | null): void {
  current = state;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const updates = window.ohMyGameDesktop?.updates;
  if (updates && !unsubscribe) {
    let disposed = false;
    const stop = updates.onState(publish);
    unsubscribe = () => {
      disposed = true;
      stop();
    };
    void updates
      .state()
      .then((state) => {
        if (!disposed) publish(state);
      })
      .catch(() => undefined);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    unsubscribe?.();
    unsubscribe = undefined;
    current = null;
  };
}

/** The desktop app's update state, or null in the browser and until the updater answers. */
export function useDesktopUpdate(): DesktopUpdateState | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
