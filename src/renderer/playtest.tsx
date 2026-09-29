import { useEffect, useState } from "react";
import type { PlayablePlayerDefinition } from "../shared/playable-player-protocol.js";
import type { PlayableRuntimeSnapshot } from "../shared/playable-runtime.js";
import { getLibraryAsset, getPlayableProjectRuntime, getWorkspaceAsset } from "./api.js";
import { PlayablePlayer } from "./playable-player.js";
import { WindowDragRegion } from "./window-drag-region.js";

export function PlaytestPage({ projectId }: { projectId: string; chapterId: string }) {
  const [snapshot, setSnapshot] = useState<PlayableRuntimeSnapshot>();
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [playable, setPlayable] = useState<
    | { status: "loading" }
    | { status: "ready"; definition: PlayablePlayerDefinition; assets: Record<string, Blob> }
    | { status: "error"; error: string }
  >({ status: "loading" });

  useEffect(() => {
    let disposed = false;
    setPlayable({ status: "loading" });
    setSnapshot(undefined);
    setDiagnostics([]);
    void getPlayableProjectRuntime(projectId).then(async (result) => {
      const assets = await mapConcurrent(
        Object.entries(result.definition.graph.assets),
        4,
        async ([id, asset]) => {
          try {
            const blob = asset.source.kind === "library"
              ? await getLibraryAsset(asset.source.assetId)
              : await getWorkspaceAsset(projectId, asset.source.path);
            return [id, blob] as const;
          } catch (cause) {
            throw new Error(`Could not load Asset "${id}": ${errorMessage(cause)}`);
          }
        },
      );
      if (disposed) return;
      document.title = `${result.definition.graph.title} - Playtest`;
      setPlayable({ status: "ready", definition: result.definition, assets: Object.fromEntries(assets) });
    }).catch((cause) => {
      if (!disposed) setPlayable({ status: "error", error: errorMessage(cause) });
    });
    return () => { disposed = true; };
  }, [projectId]);

  if (playable.status === "ready") return (
    <>
      <WindowDragRegion />
      <PlayablePlayer
        definition={playable.definition}
        assets={playable.assets}
        saveKey={`ohmygame:playable:project:${projectId}`}
        onSnapshot={setSnapshot}
        onDiagnostic={(message) => setDiagnostics((current) => [...current.slice(-19), message])}
      />
      <aside className="playable-playtest-diagnostics" aria-label="Runtime diagnostics">
        <header><strong>Runtime</strong><span>{snapshot?.failed ? "Failed" : snapshot?.transitioning ? "Transitioning" : "Running"}</span></header>
        <dl>
          <dt>Node</dt><dd>{snapshot?.currentNodeId ?? "Starting..."}</dd>
          <dt>Back stack</dt><dd>{snapshot?.backStack.join(" -> ") || "Empty"}</dd>
          <dt>Recent signals</dt><dd>{snapshot?.recentSignals.map((entry) => `${entry.nodeId}.${entry.signal}`).join(", ") || "None"}</dd>
          <dt>Save</dt><dd>{snapshot?.hasSave ? "Available" : "None"}</dd>
        </dl>
        <details open><summary>State</summary><pre>{JSON.stringify(snapshot?.state ?? {}, null, 2)}</pre></details>
        {diagnostics.length ? <details open><summary>Diagnostics ({diagnostics.length})</summary><ol>{diagnostics.map((message, index) => <li key={`${index}:${message}`} role="alert">{message}</li>)}</ol></details> : null}
      </aside>
    </>
  );
  return (
    <main className="playable-player-page">
      <WindowDragRegion />
      <div className="playable-player-page-state" role={playable.status === "error" ? "alert" : undefined}>
        {playable.status === "error" ? playable.error : "Loading playtest..."}
      </div>
    </main>
  );
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

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
