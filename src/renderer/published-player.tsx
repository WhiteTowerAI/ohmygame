import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { StoryDocument } from "../shared/contracts.js";
import {
  advanceSceneTime,
  chooseOption,
  completeSceneClip,
  continueSceneEvent,
  createPlayerState,
  createStoryCheckpoint,
  DEFAULT_STORY_PLAYER_CONFIG,
  resolveSceneInteraction,
  restartGame,
  shouldCreateStoryCheckpoint,
  type PlayerRuntimeState,
  type PlayingRuntimeState,
} from "../shared/story.js";
import { InteractiveDramaPlayer } from "./playtest.js";
import { clearStoryProgress, loadStoryProgress, saveStoryProgress, storyProgressKey, storySignature } from "./story-progress.js";
import "./story-player.css";

interface PublishedStoryManifest {
  version: 1;
  story: string;
  scope: string;
  assets: Record<string, string>;
}

function PublishedPlayer() {
  const [story, setStory] = useState<StoryDocument>();
  const [runtime, setRuntime] = useState<PlayerRuntimeState>();
  const [paused, setPaused] = useState(false);
  const [playerKey, setPlayerKey] = useState(0);
  const [hasCheckpoint, setHasCheckpoint] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "error">();
  const [manifest, setManifest] = useState<PublishedStoryManifest>();
  const [error, setError] = useState<string>();
  const progress = useRef<{ key: string; signature: string } | undefined>(undefined);
  const checkpoint = useRef<PlayingRuntimeState | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      fetch("./manifest.json").then(requireJson),
      fetch("./story.json").then(requireJson),
    ]).then(async ([manifestValue, storyValue]) => {
      const loadedManifest = manifestValue as PublishedStoryManifest;
      const loadedStory = storyValue as StoryDocument;
      if (loadedManifest.version !== 1 || loadedManifest.story !== "story.json" || !loadedStory.chapters[0]) throw new Error("The published game is invalid.");
      const signature = await storySignature(loadedStory);
      if (disposed) return;
      const chapter = loadedStory.chapters[0];
      const key = storyProgressKey(loadedManifest.scope, chapter.id);
      const saved = loadStoryProgress(localStorage, key, signature, chapter, loadedStory.variables ?? [], loadedStory.overlays ?? []);
      progress.current = { key, signature };
      checkpoint.current = saved;
      setManifest(loadedManifest);
      setStory(loadedStory);
      setHasCheckpoint(Boolean(saved));
      setRuntime(createPlayerState(chapter.id, loadedStory.variables ?? []));
      document.title = loadedStory.player?.title || chapter.title;
    }).catch((cause) => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const storage = progress.current;
    if (!storage || !runtime || !shouldCreateStoryCheckpoint(checkpoint.current, runtime)) return;
    const save = createStoryCheckpoint(storage.signature, runtime);
    checkpoint.current = save.checkpoint;
    setHasCheckpoint(true);
    try {
      saveStoryProgress(localStorage, storage.key, save);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }, [runtime]);

  useEffect(() => {
    if (saveStatus !== "saved") return;
    const timeout = window.setTimeout(() => setSaveStatus(undefined), 1_600);
    return () => window.clearTimeout(timeout);
  }, [saveStatus]);

  const chapter = story?.chapters[0];
  const variables = useMemo(() => story?.variables ?? [], [story]);
  const resetPlayer = useCallback(() => setPlayerKey((value) => value + 1), []);
  const startNewGame = useCallback(() => {
    if (!chapter) return;
    if (checkpoint.current && !window.confirm("Start a new game? Your current progress will be replaced.")) return;
    if (progress.current) clearStoryProgress(localStorage, progress.current.key);
    checkpoint.current = undefined;
    setHasCheckpoint(false);
    setRuntime(restartGame(chapter, variables));
    setPaused(false);
    resetPlayer();
  }, [chapter, resetPlayer, variables]);
  const restore = useCallback(() => {
    if (!checkpoint.current) return;
    setRuntime(checkpoint.current);
    setPaused(false);
    resetPlayer();
  }, [resetPlayer]);
  const menu = useCallback(() => {
    if (!chapter) return;
    setRuntime(createPlayerState(chapter.id, variables));
    setPaused(false);
    resetPlayer();
  }, [chapter, resetPlayer, variables]);
  const onSceneTime = useCallback((clipId: string, timeMs: number) => {
    if (chapter) setRuntime((current) => current ? advanceSceneTime(chapter, current, clipId, timeMs) : current);
  }, [chapter]);
  const onClipComplete = useCallback((clipId: string, durationMs: number) => {
    if (chapter) setRuntime((current) => current ? completeSceneClip(chapter, current, clipId, durationMs) : current);
  }, [chapter]);
  const onContinue = useCallback((ended: boolean, durationMs: number) => {
    if (!chapter) return;
    setRuntime((current) => {
      if (!current || current.mode !== "playing") return current;
      const resolved = continueSceneEvent(chapter, current);
      return ended && resolved.scenePlayback ? completeSceneClip(chapter, resolved, resolved.scenePlayback.clipId, durationMs) : resolved;
    });
  }, [chapter]);
  const onInteraction = useCallback((eventId: string, result: "success" | "timeout", ended: boolean, durationMs: number) => {
    if (!chapter) return;
    setRuntime((current) => {
      if (!current || current.mode !== "playing") return current;
      const nodeId = current.nodeId;
      const clipId = current.scenePlayback?.clipId;
      const resolved = resolveSceneInteraction(chapter, current, eventId, result);
      return ended && clipId && resolved.nodeId === nodeId && resolved.scenePlayback?.clipId === clipId
        ? completeSceneClip(chapter, resolved, clipId, durationMs)
        : resolved;
    });
  }, [chapter]);
  const onChoice = useCallback((optionId: string) => {
    if (!chapter) return;
    setRuntime((current) => current ? chooseOption(chapter, current, optionId) : current);
    resetPlayer();
  }, [chapter, resetPlayer]);

  if (error) return <main className="story-playtest-page"><div className="story-playtest-state" role="alert">{error}</div></main>;
  if (!story || !chapter || !runtime || !manifest) return <main className="story-playtest-page"><div className="story-playtest-state">Loading game...</div></main>;
  const config = story.player ?? { ...DEFAULT_STORY_PLAYER_CONFIG, title: chapter.title };
  const style = {
    "--story-player-accent": config.theme.accentColor,
    "--story-player-text": config.theme.textColor,
    "--story-player-font": config.theme.font === "serif" ? "Georgia, 'Times New Roman', serif" : "Inter, system-ui, sans-serif",
  } as CSSProperties;
  const node = chapter.nodes.find((candidate) => candidate.id === runtime.nodeId);
  return <main className="story-playtest-page" style={style}><InteractiveDramaPlayer
    key={playerKey}
    chapter={chapter}
    config={config}
    characters={story.characters ?? []}
    overlays={story.overlays ?? []}
    node={node}
    runtime={runtime}
    paused={paused}
    hasCheckpoint={hasCheckpoint}
    saveStatus={saveStatus}
    assetUrls={manifest.assets}
    onStart={startNewGame}
    onContinueGame={restore}
    onPause={() => setPaused(true)}
    onResume={() => setPaused(false)}
    onRestartCheckpoint={restore}
    onRestartGame={startNewGame}
    onMenu={menu}
    onSceneTime={onSceneTime}
    onClipComplete={onClipComplete}
    onContinue={onContinue}
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
