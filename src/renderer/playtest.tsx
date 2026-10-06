import { useCallback, useEffect, useRef, useState } from "react";
import { getNodeRuntime, playableSandboxUrl } from "./api.js";
import { createMemoryStorage, NodePlayer } from "./playable-player.js";
import { PlaytestOverlay, playtestSaveKey, playtestSeenKey, requestAskAgent, takePlaytestStart, usePlaytestStartRequests, type PlaytestStart } from "./playable-playtest.js";
import { PlayableStateHistory, playableDebugRecord } from "../shared/playable-debug.js";
import { loadPlayableAssets } from "./playable-assets.js";
import { WindowDragRegion } from "./window-drag-region.js";
import type { NodePlayerDefinition } from "../shared/playable-player-protocol.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";

export function PlaytestPage({ projectId }: { projectId: string }) {
  const [snapshot, setSnapshot] = useState<NodeRuntimeSnapshot>();
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [session, setSession] = useState(0);
  const [start, setStart] = useState<PlaytestStart>();
  const [storage, setStorage] = useState(createMemoryStorage);
  const history = useRef(new PlayableStateHistory());
  const [playable, setPlayable] = useState<
    | { status: "loading" }
    | { status: "ready"; definition: NodePlayerDefinition; assets: Record<string, Blob> }
    | { status: "error"; error: string }
  >({ status: "loading" });
  const saveKey = playtestSaveKey(projectId);

  useEffect(() => {
    let disposed = false;
    setPlayable({ status: "loading" });
    setSnapshot(undefined);
    setDiagnostics([]);
    // The editor's "Play from here" leaves its start waiting for this window.
    setStart(takePlaytestStart(projectId));
    history.current.reset();
    void getNodeRuntime(projectId).then(async (result) => {
      if (!result.available) throw new Error("This project has no Scenes yet.");
      const assets = await loadPlayableAssets(projectId, result.definition.graph);
      if (disposed) return;
      document.title = `${result.definition.graph.title} - Playtest`;
      setPlayable({ status: "ready", definition: result.definition, assets });
    }).catch((cause) => {
      if (!disposed) setPlayable({ status: "error", error: errorMessage(cause) });
    });
    return () => { disposed = true; };
  }, [projectId]);

  const onSnapshot = useCallback((next: NodeRuntimeSnapshot) => {
    history.current.record(next);
    setSnapshot(next);
  }, []);
  const onDiagnostic = useCallback((message: string) => setDiagnostics((current) => [...current.slice(-19), message]), []);

  usePlaytestStartRequests(projectId, (next) => restart(next, false));

  /** Starts another Runtime session; a chosen start never touches the saved game. */
  function restart(nextStart: PlaytestStart | undefined, clearSave: boolean): void {
    if (clearSave) window.localStorage.removeItem(saveKey);
    history.current.reset();
    setSnapshot(undefined);
    setDiagnostics([]);
    setStart(nextStart);
    setStorage(createMemoryStorage());
    setSession((current) => current + 1);
  }

  if (playable.status === "ready") {
    const graph = playable.definition.graph;
    const record = snapshot ? playableDebugRecord(snapshot, graph, history.current.changes) : undefined;
    return (
      <>
        <WindowDragRegion />
        <NodePlayer
          key={session}
          definition={playable.definition}
          frameUrl={playableSandboxUrl()}
          assets={playable.assets}
          saveKey={saveKey}
          {...(start ? {
            storage,
            preview: { policy: "follow" as const, startNodeId: start.nodeId },
          } : {})}
          onSnapshot={onSnapshot}
          onDiagnostic={onDiagnostic}
        />
        <PlaytestOverlay
          graph={graph}
          record={record}
          diagnostics={diagnostics}
          onRestart={() => restart(undefined, !start)}
          onForgetSeen={() => {
            window.localStorage.removeItem(playtestSeenKey(projectId));
            restart(start, false);
          }}
          onAskAgent={(text) => {
            requestAskAgent(projectId, text);
            // Bring the editor forward on the Scene the player was in.
            if (record) void window.ohMyGameDesktop?.openPlayableNode?.(projectId, record.currentNode.id).catch(() => {});
          }}
        />
      </>
    );
  }
  return (
    <main className="playable-player-page">
      <WindowDragRegion />
      <div className="playable-player-page-state" role={playable.status === "error" ? "alert" : undefined}>
        {playable.status === "error" ? playable.error : "Loading playtest..."}
      </div>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
