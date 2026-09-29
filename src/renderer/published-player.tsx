import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { StoryDocument, StoryInteractionCommand } from "../shared/contracts.js";
import {
  advanceSceneTime,
  advanceOpenUi,
  chooseOption,
  completeSceneMedia,
  createStorySave,
  resolveInteractionNode,
  restartGame,
  shouldCreateStoryCheckpoint,
  shouldPersistStoryCheckpoint,
  storyDiscoveries,
  type PlayerRuntimeState,
  type PlayingRuntimeState,
} from "../shared/story.js";
import { InteractiveDramaPlayer } from "./playtest.js";
import { loadStoryProgress, saveStoryProgress, storyProgressKey, storySignature } from "./story-progress.js";
import "./story-player.css";
import { isCompiledNodeGraph } from "../shared/playable-compiled.js";
import { isNodeGraph } from "../shared/playable-graph-validation.js";
import { PlayableStateHistory, playableDebugRecord } from "../shared/playable-debug.js";
import type { NodePlayerDefinition } from "../shared/playable-player-protocol.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import { isPublishedNodeManifest, type PublishedNodeManifest } from "../shared/playable-publish.js";
import { NodePlayer } from "./playable-player.js";
import "./playable-player.css";

interface PublishedStoryManifest {
  version: 1;
  story: string;
  scope: string;
  assets: Record<string, string>;
}

function PublishedPlayer() {
  const [manifest, setManifest] = useState<PublishedNodeManifest | "story">();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void fetch("./manifest.json").then(requireJson).then((value) => {
      // Story archives have no runtime field. They go away with the Story runtime.
      const runtime = isRecord(value) ? value.runtime : undefined;
      if (runtime === undefined) {
        if (!disposed) setManifest("story");
        return;
      }
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
  if (manifest === "story") return <PublishedStoryPlayer />;
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

function PublishedStoryPlayer() {
  const [story, setStory] = useState<StoryDocument>();
  const [runtime, setRuntime] = useState<PlayerRuntimeState>();
  const [paused, setPaused] = useState(false);
  const [playbackKey, setPlaybackKey] = useState(0);
  const [hasCheckpoint, setHasCheckpoint] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "error">();
  const [manifest, setManifest] = useState<PublishedStoryManifest>();
  const [error, setError] = useState<string>();
  const progress = useRef<{ key: string; signature: string } | undefined>(undefined);
  const checkpoint = useRef<PlayingRuntimeState | undefined>(undefined);
  const chapter = story?.chapter;
  const variables = useMemo(() => story?.variables ?? [], [story]);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      fetch("./manifest.json").then(requireJson),
      fetch("./story.json").then(requireJson),
    ]).then(async ([manifestValue, storyValue]) => {
      const loadedManifest = manifestValue as PublishedStoryManifest;
      const loadedStory = storyValue as StoryDocument;
      if (loadedManifest.version !== 1 || loadedManifest.story !== "story.json" || !loadedStory.chapter) throw new Error("The published game is invalid.");
      const signature = await storySignature(loadedStory);
      if (disposed) return;
      const chapter = loadedStory.chapter;
      const key = storyProgressKey(loadedManifest.scope, chapter.id);
      const saved = loadStoryProgress(localStorage, key, signature, chapter, loadedStory.variables ?? []);
      progress.current = { key, signature };
      checkpoint.current = saved?.checkpoint;
      setManifest(loadedManifest);
      setStory(loadedStory);
      setHasCheckpoint(Boolean(saved?.checkpoint));
      setRuntime(restartGame(chapter, loadedStory.variables ?? [], saved?.discoveries));
      document.title = loadedStory.player.title || chapter.title;
    }).catch((cause) => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const storage = progress.current;
    const runtimeNode = chapter?.nodes.find((candidate) => candidate.id === runtime?.nodeId);
    if (!storage || !runtime || runtimeNode?.type === "open-ui") return;
    const showSaved = shouldCreateStoryCheckpoint(checkpoint.current, runtime);
    if (!shouldPersistStoryCheckpoint(checkpoint.current, runtime)) return;
    const save = createStorySave(storage.signature, runtime.progress, runtime);
    checkpoint.current = save.checkpoint;
    setHasCheckpoint(true);
    try {
      saveStoryProgress(localStorage, storage.key, save);
      if (showSaved) setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }, [chapter, runtime]);

  useEffect(() => {
    if (saveStatus !== "saved") return;
    const timeout = window.setTimeout(() => setSaveStatus(undefined), 1_600);
    return () => window.clearTimeout(timeout);
  }, [saveStatus]);

  const resetPlayer = useCallback(() => setPlaybackKey((value) => value + 1), []);
  const startNewGame = useCallback(() => {
    if (!chapter) return;
    if (checkpoint.current && !window.confirm("Start a new game? Your checkpoint will be replaced. Discovered routes will stay unlocked.")) return;
    const discoveries = storyDiscoveries(runtime?.progress ?? checkpoint.current?.progress);
    if (progress.current) {
      try {
        saveStoryProgress(localStorage, progress.current.key, createStorySave(progress.current.signature, discoveries));
      } catch {
        setSaveStatus("error");
      }
    }
    checkpoint.current = undefined;
    setHasCheckpoint(false);
    setRuntime(advanceOpenUi(chapter, restartGame(chapter, variables, discoveries)));
    setPaused(false);
    resetPlayer();
  }, [chapter, resetPlayer, runtime?.progress, variables]);
  const restore = useCallback(() => {
    if (!checkpoint.current) return;
    setRuntime(checkpoint.current);
    setPaused(false);
    resetPlayer();
  }, [resetPlayer]);
  const menu = useCallback(() => {
    if (!chapter) return;
    setRuntime((current) => restartGame(chapter, variables, storyDiscoveries(current?.progress)));
    setPaused(false);
    resetPlayer();
  }, [chapter, resetPlayer, variables]);
  const advanceUi = useCallback((sourceHandle?: string) => {
    if (!chapter) return;
    setRuntime((current) => current ? advanceOpenUi(chapter, current, sourceHandle) : current);
    setPaused(false);
    resetPlayer();
  }, [chapter, resetPlayer]);
  const onSceneTime = useCallback((mediaId: string, timeMs: number) => {
    if (chapter) setRuntime((current) => current ? advanceSceneTime(chapter, current, mediaId, timeMs) : current);
  }, [chapter]);
  const onMediaComplete = useCallback((mediaId: string, durationMs: number) => {
    if (!chapter) return;
    setRuntime((current) => current ? completeSceneMedia(chapter, current, mediaId, durationMs) : current);
    resetPlayer();
  }, [chapter, resetPlayer]);
  const onChoice = useCallback((optionId: string) => {
    if (!chapter) return;
    setRuntime((current) => current ? chooseOption(chapter, current, optionId) : current);
    resetPlayer();
  }, [chapter, resetPlayer]);
  const onInteraction = useCallback((result: string, commands: StoryInteractionCommand[]) => {
    if (!chapter) return;
    setRuntime((current) => current ? resolveInteractionNode(chapter, current, result, commands, variables) : current);
    resetPlayer();
  }, [chapter, resetPlayer, variables]);

  if (error) return <main className="story-playtest-page"><div className="story-playtest-state" role="alert">{error}</div></main>;
  if (!story || !chapter || !runtime || !manifest) return <main className="story-playtest-page"><div className="story-playtest-state">Loading game...</div></main>;
  const config = story.player;
  const style = {
    "--story-player-accent": config.theme.accentColor,
    "--story-player-text": config.theme.textColor,
    "--story-player-font": config.theme.font === "serif" ? "Georgia, 'Times New Roman', serif" : "Inter, system-ui, sans-serif",
  } as CSSProperties;
  const node = chapter.nodes.find((candidate) => candidate.id === runtime.nodeId);
  return <main className="story-playtest-page" style={style}><InteractiveDramaPlayer
    chapter={chapter}
    variables={variables}
    config={config}
    node={node}
    runtime={runtime}
    playbackKey={playbackKey}
    paused={paused}
    hasCheckpoint={hasCheckpoint}
    saveStatus={saveStatus}
    assetUrls={manifest.assets}
    onAdvanceOpenUi={advanceUi}
    onContinueGame={restore}
    onPause={() => setPaused(true)}
    onResume={() => setPaused(false)}
    onRestartCheckpoint={restore}
    onRestartGame={startNewGame}
    onMenu={menu}
    onSceneTime={onSceneTime}
    onMediaComplete={onMediaComplete}
    onInteraction={onInteraction}
    onChoice={onChoice}
  /></main>;
}

async function requireJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("The published game could not be loaded.");
  return response.json();
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

createRoot(document.getElementById("root")!).render(<StrictMode><PublishedPlayer /></StrictMode>);
