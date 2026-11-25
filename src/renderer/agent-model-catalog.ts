import { useCallback, useSyncExternalStore } from "react";
import type { AccountProfileIds } from "../shared/agent-runtimes.js";
import type { AgentModelCatalog } from "../shared/contracts.js";
import { listModels, streamModelChanges, waitForRuntime } from "./api.js";
import { subscribeAgentModelsChanged } from "./model-settings-events.js";
import { runtimeConnection, subscribeRuntimeConnection } from "./runtime-connection.js";

export type AgentModelCatalogStatus = "loading" | "ready" | "error";
export type AgentModelCatalogState = AgentModelCatalog & { status: AgentModelCatalogStatus };

type CatalogOptions = { agentRuntimes: boolean; accountProfiles?: AccountProfileIds };
interface CatalogEntry {
  options: CatalogOptions;
  snapshot: AgentModelCatalogState;
  updatedAt?: number;
  request?: Promise<AgentModelCatalog>;
  poll?: ReturnType<typeof setTimeout>;
  listeners: Set<() => void>;
}

const EMPTY_CATALOG: AgentModelCatalogState = { models: [], defaultReasoningLevel: "medium", status: "loading" };
const REFRESH_AFTER_MS = 60_000;
const DISCOVERY_POLL_MS = 3_000;
const catalogs = new Map<string, CatalogEntry>();
let observing = false;

function publish(entry: CatalogEntry, snapshot: AgentModelCatalogState): void {
  entry.snapshot = snapshot;
  for (const listen of entry.listeners) listen();
}

function pollDiscovery(entry: CatalogEntry): void {
  const { loadingRuntimes, loadingProviders } = entry.snapshot;
  if (!entry.listeners.size || entry.poll !== undefined || entry.request ||
    (!loadingRuntimes?.length && !loadingProviders?.length)) return;
  entry.poll = setTimeout(() => {
    entry.poll = undefined;
    load(entry);
  }, DISCOVERY_POLL_MS);
}

function load(entry: CatalogEntry): void {
  if (entry.request) return;
  clearTimeout(entry.poll);
  entry.poll = undefined;
  const read = () => listModels({ ...entry.options, background: true });
  const request = entry.updatedAt === undefined ? waitForRuntime().then(read) : read();
  entry.request = request;
  void request.then((catalog) => {
    if (entry.request !== request) return;
    entry.request = undefined;
    entry.updatedAt = Date.now();
    const pending = catalog.loadingRuntimes?.length || catalog.loadingProviders?.length;
    publish(entry, { ...catalog, status: pending && !catalog.models.length ? "loading" : "ready" });
    pollDiscovery(entry);
  }, () => {
    if (entry.request !== request) return;
    entry.request = undefined;
    if (entry.updatedAt === undefined || entry.snapshot.status === "loading") {
      publish(entry, { ...EMPTY_CATALOG, status: "error" });
    }
  });
}

function invalidateCatalogs(): void {
  for (const [key, entry] of catalogs) {
    clearTimeout(entry.poll);
    entry.poll = undefined;
    entry.request = undefined;
    entry.updatedAt = undefined;
    if (!entry.listeners.size) {
      catalogs.delete(key);
      continue;
    }
    publish(entry, EMPTY_CATALOG);
    load(entry);
  }
}

function observeCatalogChanges(): void {
  if (observing) return;
  observing = true;
  subscribeAgentModelsChanged(invalidateCatalogs);
  // A coding agent announced that its models changed. The lists in use stay until the new ones are read.
  void streamModelChanges(
    new AbortController().signal,
    () => {
      for (const entry of catalogs.values()) if (entry.listeners.size) load(entry);
    },
  );
  let generation = runtimeConnection().generation;
  subscribeRuntimeConnection(() => {
    const runtime = runtimeConnection();
    if (runtime.status !== "ready" || runtime.generation === generation) return;
    generation = runtime.generation;
    invalidateCatalogs();
  });
}

function subscribeCatalog(key: string, options: CatalogOptions, listen: () => void): () => void {
  observeCatalogChanges();
  let entry = catalogs.get(key);
  if (!entry) {
    entry = { options, snapshot: EMPTY_CATALOG, listeners: new Set() };
    catalogs.set(key, entry);
  }
  entry.listeners.add(listen);
  if (entry.snapshot.status === "error" || entry.updatedAt === undefined || Date.now() - entry.updatedAt >= REFRESH_AFTER_MS) load(entry);
  else pollDiscovery(entry);
  return () => {
    entry.listeners.delete(listen);
    if (!entry.listeners.size) {
      clearTimeout(entry.poll);
      entry.poll = undefined;
    }
  };
}

/** All pickers with the same runtime and account selection share the same catalog and request. */
export function useAgentModels(options: { agentRuntimes?: boolean; accountProfiles?: AccountProfileIds; enabled?: boolean } = {}): AgentModelCatalogState {
  const enabled = options.enabled !== false;
  const agentRuntimes = options.agentRuntimes === true;
  const claude = agentRuntimes ? options.accountProfiles?.["claude-code-cli"] : undefined;
  const codex = agentRuntimes ? options.accountProfiles?.["codex-cli"] : undefined;
  // An omitted account follows the runtime default. "system" names an account explicitly.
  const key = JSON.stringify([agentRuntimes, claude, codex]);
  const subscribe = useCallback((listen: () => void) => enabled ? subscribeCatalog(key, {
    agentRuntimes,
    accountProfiles: claude || codex ? { "claude-code-cli": claude, "codex-cli": codex } : undefined,
  }, listen) : () => {}, [enabled, key, agentRuntimes, claude, codex]);
  const snapshot = useCallback(() => (enabled ? catalogs.get(key)?.snapshot : undefined) ?? EMPTY_CATALOG, [enabled, key]);
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY_CATALOG);
}
