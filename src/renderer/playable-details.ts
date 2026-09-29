import { useSyncExternalStore } from "react";

const TECHNICAL_DETAILS_KEY = "ohmygame:playable:technical-details";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(TECHNICAL_DETAILS_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === TECHNICAL_DETAILS_KEY) listener(); };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Whether the Playable editor shows engine details: IDs, file paths, types,
 * the navigation History and the Code view. Off by default; the editor's
 * words (Scene, Exit, Overlay) need none of them. Shared by every window.
 */
export function useTechnicalDetails(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

export function setTechnicalDetails(on: boolean): void {
  try {
    if (on) localStorage.setItem(TECHNICAL_DETAILS_KEY, "1");
    else localStorage.removeItem(TECHNICAL_DETAILS_KEY);
  } catch {
    // Storage may be unavailable; the toggle then only lasts this render.
  }
  for (const listener of listeners) listener();
}
