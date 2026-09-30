import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isCompiledNodeGraph } from "../shared/playable-compiled.js";
import { isNodeGraph } from "../shared/playable-graph-validation.js";
import { PlayableStateHistory, playableDebugRecord } from "../shared/playable-debug.js";
import type { NodePlayerDefinition } from "../shared/playable-player-protocol.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import { isPublishedNodeManifest, type PublishedNodeManifest } from "../shared/playable-publish.js";
import { NodePlayer } from "./playable-player.js";
import "./playable-player.css";

function PublishedPlayer() {
  const [manifest, setManifest] = useState<PublishedNodeManifest>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void fetch("./manifest.json").then(requireJson).then((value) => {
      if (!isPublishedNodeManifest(value)) {
        throw new Error("The Published Player manifest is invalid.");
      }
      if (!disposed) setManifest(value);
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    });
    return () => { disposed = true; };
  }, []);

  if (error) return <PublishedState error={error} />;
  if (!manifest) return <PublishedState />;
  return <PublishedNodePlayer manifest={manifest} />;
}

function PublishedNodePlayer({ manifest }: { manifest: PublishedNodeManifest }) {
  const [state, setState] = useState<
    | { loading: true }
    | { loading: false; definition: NodePlayerDefinition; assets: Record<string, Blob> }
    | { loading: false; error: string }
  >({ loading: true });

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      fetchVerified(manifest.definition.path, manifest.definition.integrity, "Published Node definition")
        .then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown),
      mapConcurrent(Object.entries(manifest.assets), 4, async ([id, asset]) => {
        const bytes = await fetchVerified(asset.path, asset.integrity, `Asset "${id}"`);
        if (bytes.byteLength !== asset.size) throw new Error(`Asset "${id}" has an invalid size.`);
        return [id, new Blob([bytes], { type: asset.contentType })] as const;
      }),
    ]).then(([definition, assets]) => {
      if (disposed) return;
      if (!isPublishedNodeDefinition(definition, manifest)) {
        throw new Error("The Published Node definition does not match its manifest.");
      }
      document.title = definition.graph.title;
      setState({ loading: false, definition, assets: Object.fromEntries(assets) });
    }).catch((cause) => {
      if (!disposed) setState({ loading: false, error: errorMessage(cause) });
    });
    return () => { disposed = true; };
  }, [manifest]);

  const saveKey = `ohmygame:playable:${manifest.scope}`;
  const [session, setSession] = useState(0);
  const onSnapshot = usePlaytestBridge(state.loading || "error" in state ? undefined : state.definition, () => {
    window.localStorage.removeItem(saveKey);
    setSession((value) => value + 1);
  });

  if (state.loading) return <PublishedState />;
  if ("error" in state) return <PublishedState error={state.error} />;
  return <NodePlayer
    key={session}
    definition={state.definition}
    assets={state.assets}
    saveKey={saveKey}
    onSnapshot={onSnapshot}
  />;
}

/**
 * When an agent plays the project through game_use, the page exposes the
 * Runtime's debug record as the playtest bridge: the current Node, back
 * stack, followed Signals, State changes, and errors. `reset()` starts a new
 * game without the save.
 */
function usePlaytestBridge(
  definition: NodePlayerDefinition | undefined,
  reset: () => void,
): ((snapshot: NodeRuntimeSnapshot) => void) | undefined {
  const enabled = useMemo(() => new URLSearchParams(window.location.search).get("ohmygamePlaytest") === "1", []);
  const latest = useRef<NodeRuntimeSnapshot | undefined>(undefined);
  const history = useRef(new PlayableStateHistory());
  const resetRef = useRef(reset);
  resetRef.current = reset;

  useEffect(() => {
    if (!enabled || !definition) return;
    const bridge = {
      snapshot: () => latest.current
        ? playableDebugRecord(latest.current, definition.graph, history.current.changes)
        : { status: "loading" },
      reset: () => {
        latest.current = undefined;
        history.current.reset();
        resetRef.current();
      },
    };
    Object.assign(globalThis, { __OHMYGAME_PLAYTEST__: bridge });
    return () => {
      if ((globalThis as { __OHMYGAME_PLAYTEST__?: unknown }).__OHMYGAME_PLAYTEST__ === bridge) {
        delete (globalThis as { __OHMYGAME_PLAYTEST__?: unknown }).__OHMYGAME_PLAYTEST__;
      }
    };
  }, [enabled, definition]);

  const onSnapshot = useCallback((snapshot: NodeRuntimeSnapshot) => {
    latest.current = snapshot;
    history.current.record(snapshot);
  }, []);
  return enabled ? onSnapshot : undefined;
}

function isPublishedNodeDefinition(
  value: unknown,
  manifest: PublishedNodeManifest,
): value is NodePlayerDefinition {
  if (!isRecord(value) || value.version !== 1 || value.graphSignature !== manifest.graphSignature ||
    !isNodeGraph(value.graph) || !isCompiledNodeGraph(value.compiled, value.graph)) return false;
  const graphAssets = Object.entries(value.graph.assets).sort(([left], [right]) => left.localeCompare(right));
  const manifestAssets = Object.entries(manifest.assets).sort(([left], [right]) => left.localeCompare(right));
  return graphAssets.length === manifestAssets.length && graphAssets.every(([id, asset], index) => (
    id === manifestAssets[index]?.[0] && asset.type === manifestAssets[index]?.[1].type
  ));
}

async function fetchVerified(url: string, integrity: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} could not be loaded (${response.status}).`);
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = `sha256-${bytesToBase64(new Uint8Array(digest))}`;
  if (actual !== integrity) throw new Error(`${label} failed integrity validation.`);
  return bytes;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]!);
    }
  }));
  return results;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PublishedState({ error }: { error?: string }) {
  return <main className="playable-player-page">
    <div className="playable-player-page-state" role={error ? "alert" : undefined}>{error ?? "Loading game..."}</div>
  </main>;
}

async function requireJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("The published game could not be loaded.");
  return response.json();
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

createRoot(document.getElementById("root")!).render(<StrictMode><PublishedPlayer /></StrictMode>);
