import { useSyncExternalStore } from "react";
import type { DesktopRuntimeState } from "../shared/desktop-runtime.js";

const WEB_RUNTIME: DesktopRuntimeState = {
  status: "ready",
  generation: 0,
  recovered: false,
};
const listeners = new Set<() => void>();
let snapshot: DesktopRuntimeState = WEB_RUNTIME;
let readyGeneration = 0;
let initialization: Promise<void> | undefined;

export function initializeRuntimeConnection(): Promise<void> {
  return initialization ??= initialize();
}

async function initialize(): Promise<void> {
  const desktop = window.ohMyGameDesktop;
  if (!desktop) return;
  snapshot = {
    status: "ready",
    generation: 0,
    recovered: false,
    runtime: { url: desktop.runtime.daemonUrl, token: desktop.runtime.token },
  };
  if (!desktop.runtimeService) return;
  let events = 0;
  desktop.runtimeService.onState((state) => {
    events++;
    updateRuntimeConnection(state);
  });
  try {
    const state = await desktop.runtimeService.state();
    if (events === 0) updateRuntimeConnection(state);
  } catch { /* The preload address remains available if the state request fails. */ }
}

export function updateRuntimeConnection(state: DesktopRuntimeState): void {
  if (state.generation < snapshot.generation) return;
  snapshot = state;
  if (state.status === "ready") readyGeneration = state.generation;
  for (const listener of listeners) listener();
}

export function runtimeConnection(): DesktopRuntimeState {
  return snapshot;
}
export function subscribeRuntimeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useRuntimeConnection(): DesktopRuntimeState {
  return useSyncExternalStore(
    subscribeRuntimeConnection,
    runtimeConnection,
    runtimeConnection,
  );
}

/** Refresh read requests after recovery while retaining the view and its unsaved input. */
export function useReadyRuntimeGeneration(): number {
  return useSyncExternalStore(subscribeRuntimeConnection, lastReadyGeneration, lastReadyGeneration);
}

function lastReadyGeneration(): number { return readyGeneration; }
