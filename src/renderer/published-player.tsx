import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { isCompiledPlayableGraph } from "../shared/playable-compiled.js";
import { isPlayableGraph } from "../shared/playable-graph-validation.js";
import type { PlayablePlayerDefinition } from "../shared/playable-player-protocol.js";
import {
  isPublishedPlayableManifest,
  type PublishedPlayableManifest,
} from "../shared/playable-publish.js";
import { PlayablePlayer } from "./playable-player.js";
import "./playable-player.css";

function PublishedPlayer() {
  const [manifest, setManifest] = useState<PublishedPlayableManifest>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void fetch("./manifest.json").then(requireJson).then((value) => {
      if (!isPublishedPlayableManifest(value)) {
        throw new Error("The published Playable manifest is invalid.");
      }
      if (!disposed) setManifest(value);
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    });
    return () => { disposed = true; };
  }, []);

  if (error) return <PublishedState error={error} />;
  if (!manifest) return <PublishedState />;
  return <PublishedPlayablePlayer manifest={manifest} />;
}

function PublishedPlayablePlayer({ manifest }: { manifest: PublishedPlayableManifest }) {
  const [state, setState] = useState<
    | { loading: true }
    | { loading: false; definition: PlayablePlayerDefinition; assets: Record<string, Blob> }
    | { loading: false; error: string }
  >({ loading: true });

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      fetchVerified(manifest.definition.path, manifest.definition.integrity, "Playable definition")
        .then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown),
      mapConcurrent(Object.entries(manifest.assets), 4, async ([id, asset]) => {
        const bytes = await fetchVerified(asset.path, asset.integrity, `Asset "${id}"`);
        if (bytes.byteLength !== asset.size) throw new Error(`Asset "${id}" has an invalid size.`);
        return [id, new Blob([bytes], { type: asset.contentType })] as const;
      }),
    ]).then(([definition, assets]) => {
      if (disposed) return;
      if (!isPublishedPlayableDefinition(definition, manifest)) {
        throw new Error("The published Playable definition does not match its manifest.");
      }
      document.title = definition.graph.title;
      setState({ loading: false, definition, assets: Object.fromEntries(assets) });
    }).catch((cause) => {
      if (!disposed) setState({ loading: false, error: errorMessage(cause) });
    });
    return () => { disposed = true; };
  }, [manifest]);

  if (state.loading) return <PublishedState />;
  if ("error" in state) return <PublishedState error={state.error} />;
  return <PlayablePlayer
    definition={state.definition}
    assets={state.assets}
    saveKey={`ohmygame:playable:${manifest.scope}`}
  />;
}

function isPublishedPlayableDefinition(
  value: unknown,
  manifest: PublishedPlayableManifest,
): value is PlayablePlayerDefinition {
  if (!isRecord(value) || value.version !== 1 || value.graphSignature !== manifest.graphSignature ||
    !isPlayableGraph(value.graph) || !isCompiledPlayableGraph(value.compiled, value.graph)) return false;
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
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<unknown>;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<StrictMode><PublishedPlayer /></StrictMode>);
