import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, ensureProjectPreview, getNodeRuntime, playableSandboxUrl } from "./api.js";
import { createMemoryStorage, NodePlayer } from "./playable-player.js";
import { askToFixPlaytest, askToFixPlaytestStart, PlaytestOverlay, PlaytestProblem, playtestSaveKey, playtestSeenKey, requestAskAgent, takePlaytestRequest, usePlaytestRequests, type PlaytestProblemState, type PlaytestRequest, type PlaytestStart } from "./playable-playtest.js";
import { PlayableStateHistory, playableDebugRecord } from "../shared/playable-debug.js";
import { playableNodeById } from "../shared/playable-graph.js";
import { loadPlayableAssets } from "./playable-assets.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import type { NodePlayerDefinition } from "../shared/playable-player-protocol.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import { t } from "./i18n.js";

export function PlaytestPage({ projectId }: { projectId: string }) {
  const [snapshot, setSnapshot] = useState<NodeRuntimeSnapshot>();
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [session, setSession] = useState(0);
  const [start, setStart] = useState<PlaytestStart>();
  const [storage, setStorage] = useState(createMemoryStorage);
  /** What a web story's page should do first this session, as its query parameters. */
  const [pageStart, setPageStart] = useState<Record<string, string>>({});
  const history = useRef(new PlayableStateHistory());
  /** Counts how often the story was loaded, so a request can load it again. */
  const [revision, setRevision] = useState(0);
  /** Why this session's game stopped. */
  const [failed, setFailed] = useState<string>();
  /** Whether this session's game got past starting, so a stop is not a failure to start. */
  const [played, setPlayed] = useState(false);
  const [playable, setPlayable] = useState<
    | { status: "loading" }
    | { status: "ready"; definition: NodePlayerDefinition; assets: Record<string, Blob>; page?: string }
    | { status: "error"; problem: PlaytestProblemState }
  >({ status: "loading" });
  const saveKey = playtestSaveKey(projectId);

  useEffect(() => {
    let disposed = false;
    // Once the story is known, a failure is the project's preview or its assets.
    let loadingStory = true;
    setPlayable({ status: "loading" });
    void getNodeRuntime(projectId).then(async (result) => {
      if (!result.available) {
        if (!disposed) setPlayable({ status: "error", problem: { kind: "no-scenes" } });
        return;
      }
      loadingStory = false;
      if (result.web) {
        // A web story plays its own page, which keeps its saves on the preview's origin.
        const { url } = await ensureProjectPreview(projectId);
        if (disposed) return;
        setPlayable({ status: "ready", definition: result.definition, assets: {}, page: url });
        return;
      }
      const assets = await loadPlayableAssets(projectId, result.definition.graph);
      if (disposed) return;
      setPlayable({ status: "ready", definition: result.definition, assets });
    }).catch((cause) => {
      if (!disposed) setPlayable({ status: "error", problem: loadingStory ? storyProblem(cause) : { kind: "unavailable", detail: errorMessage(cause) } });
    });
    return () => { disposed = true; };
  }, [projectId, revision]);

  // Editor actions may arrive before the Playtest window is open.
  useEffect(() => restart(takePlaytestRequest(projectId)), [projectId]);

  const title = playable.status === "ready" ? playable.definition.graph.title : undefined;
  useEffect(() => {
    if (playable.status !== "loading") document.title = title ? `${title} - Playtest` : t("storyEditor.playtest");
  }, [playable.status, title]);

  const onSnapshot = useCallback((next: NodeRuntimeSnapshot) => {
    history.current.record(next);
    setSnapshot(next);
    // A web story reports itself before it starts, so only a running game
    // counts as played; a page that reloads itself starts over.
    if (next.status === "running" || next.status === "transitioning") setPlayed(true);
    else if (next.status === "starting") setPlayed(false);
  }, []);
  const onDiagnostic = useCallback((message: string) => setDiagnostics((current) => [...current.slice(-19), message]), []);

  const problem: PlaytestProblemState | undefined = playable.status === "error" ? playable.problem
    : playable.status === "ready" ? startProblem(playable.definition.graph, start) ?? (failed === undefined ? undefined : { kind: played ? "stopped" : "invalid", detail: failed })
    : undefined;

  usePlaytestRequests(projectId, (request) => {
    // Bringing a playing or loading window forward keeps its game. Anything
    // else loads the story again, since the editor may have changed or fixed it.
    if (request.action === "open" && playable.status !== "error" && !problem) return;
    // Playtest without a chosen Scene starts the story as a newly opened window does.
    restart(request, request.action === "open" ? undefined : start);
    setRevision((current) => current + 1);
  });

  /** Applies an editor request and starts a fresh Runtime session. */
  function restart(request?: PlaytestRequest, currentStart?: PlaytestStart): void {
    const nextStart = request?.action === "start" ? request.start : currentStart;
    if (request?.action === "replay" && !nextStart) window.localStorage.removeItem(saveKey);
    if (request?.action === "forget-seen") window.localStorage.removeItem(playtestSeenKey(projectId));
    // A web story's page keeps its own storage, so it is asked to do the same.
    setPageStart({
      ...(request?.action === "replay" && !nextStart ? { "ohmygame-new-game": "1" } : {}),
      ...(request?.action === "forget-seen" ? { "ohmygame-forget-seen": "1" } : {}),
      // Play from here leaves the saved game as it was.
      ...(nextStart ? { "ohmygame-save": "none" } : {}),
    });
    history.current.reset();
    setSnapshot(undefined);
    setDiagnostics([]);
    setFailed(undefined);
    setPlayed(false);
    setStart(nextStart);
    setStorage(createMemoryStorage());
    setSession((current) => current + 1);
  }

  const desktop = window.ohMyGameDesktop;
  // A browser does not bring another tab forward; closing this window returns to the editor there.
  const openEditor = desktop?.showPlaytestEditor
    ? () => void desktop.showPlaytestEditor!(projectId).catch(() => {})
    : undefined;

  const record = playable.status === "ready" && snapshot ? playableDebugRecord(snapshot, playable.definition.graph, history.current.changes) : undefined;

  if (problem) {
    return (
      <PlaytestProblem
        problem={problem}
        {...(openEditor ? { onOpenEditor: openEditor } : {})}
        onRetry={() => {
          restart(undefined, start);
          setRevision((current) => current + 1);
        }}
        onPlayFromStart={() => restart()}
        onAskAgent={() => {
          // A game that stopped tells the AI what the player was doing, as the overlay does.
          const text = playable.status === "ready"
            ? askToFixPlaytest(playable.definition.graph, record, [...new Set([...(record?.errors ?? []).map((error) => error.message), ...diagnostics, problem.detail ?? ""].filter(Boolean))])
            : askToFixPlaytestStart(problem.detail ?? "");
          requestAskAgent(projectId, text);
          openEditor?.();
        }}
        onClose={() => window.close()}
      />
    );
  }
  if (playable.status === "ready") {
    const graph = playable.definition.graph;
    return (
      <>
        <NodePlayer
          key={session}
          definition={playable.definition}
          frameUrl={playableSandboxUrl()}
          assets={playable.assets}
          {...(playable.page ? { page: withParameters(playable.page, pageStart) } : {})}
          saveKey={saveKey}
          {...(start ? {
            storage,
            preview: { policy: "follow" as const, startNodeId: start.nodeId },
          } : {})}
          loadingLabel={t("playtest.loading")}
          onSnapshot={onSnapshot}
          onDiagnostic={onDiagnostic}
          onError={setFailed}
        />
        <PlaytestOverlay
          graph={graph}
          record={record}
          diagnostics={diagnostics}
          onAskAgent={(text) => {
            requestAskAgent(projectId, text);
            // Bring the editor forward on the Scene the player was in.
            if (record) void desktop?.openPlayableNode?.(projectId, record.currentNode.id).catch(() => {});
          }}
        />
      </>
    );
  }
  return (
    <main className="playable-player-page">
      <div className="playable-player-page-state">{t("playtest.loading")}</div>
    </main>
  );
}

/** Why a loaded story cannot start where Playtest was asked to start it. */
function startProblem(graph: NodeGraph, start: PlaytestStart | undefined): PlaytestProblemState | undefined {
  if (!graph.nodes.length) return { kind: "no-scenes" };
  if (start && !playableNodeById(graph, start.nodeId)) return { kind: "missing-start" };
  return undefined;
}

/** What a failure to load the story means for the author. */
function storyProblem(cause: unknown): PlaytestProblemState {
  const detail = errorMessage(cause);
  if (cause instanceof ApiError && cause.status === 404) return { kind: "not-found", detail };
  // The service read the story and refused it: its files need fixing.
  if (cause instanceof ApiError && cause.status === 400) return { kind: "invalid", detail };
  return { kind: "unavailable", detail };
}

function withParameters(page: string, parameters: Record<string, string>): string {
  const url = new URL(page);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.href;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
